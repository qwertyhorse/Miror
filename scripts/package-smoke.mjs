import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { register } from 'tsx/esm/api';
import { createStaticRequestHandler } from './static-web.mjs';
import { createLanRequestHandler } from './lan-preview.mjs';
import { createCameraRequestHandler } from './camera-https.mjs';
import { seedMaterials } from './seed-materials.mjs';
import { HOSTNAME as hostname, EXHIBITION_PORT } from './gateway-shared.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(import.meta.url);
const apiPath = '/v1.1/api/exhibition';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? filesIn(resolve(directory, entry.name)) : [resolve(directory, entry.name)]))).flat();
}

/** Check the shipped source graph as well as the built module graph. */
async function checkLocalImports() {
  const sources = (await filesIn(resolve(root, 'src'))).filter(path => /\.(?:ts|tsx|css)$/.test(path));
  let checked = 0;
  for (const source of sources) {
    const code = await readFile(source, 'utf8');
    const paths = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|@import\s*)['"](\.[^'"]+)['"]/g)].map(match => match[1]);
    for (const path of paths) {
      const target = resolve(dirname(source), path.split('?')[0]);
      const candidates = [target, ...['.ts', '.tsx', '.js', '.mjs', '.css', '.json', '/index.ts', '/index.tsx'].map(suffix => target + suffix)];
      const exists = await Promise.all(candidates.map(candidate => stat(candidate).then(value => value.isFile(), () => false)));
      assert(exists.some(Boolean), `Missing import ${relative(root, source)} -> ${path}`);
      checked++;
    }
  }
  return checked;
}

async function listen(server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); done(); });
  });
  return { server, sockets, port: server.address().port };
}

async function close(unit) {
  if (!unit) return;
  await new Promise(done => {
    unit.server.close(done);
    for (const socket of unit.sockets) socket.destroy();
  });
}

function request(unit, path, { publicPort = EXHIBITION_PORT, secure = false, ca, method = 'GET', body, origin, headers = {} } = {}) {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((done, fail) => {
    const call = (secure ? https : http).request({
      hostname: '127.0.0.1', port: unit.port, method, path,
      ...(secure ? { ca, servername: hostname, rejectUnauthorized: true } : {}),
      headers: { Host: `${hostname}:${publicPort}`, Connection: 'close',
        ...(origin ? { Origin: origin } : {}),
        ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {}), ...headers },
      timeout: 10000,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', fail);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        done({ status: response.statusCode, headers: response.headers, bytes, text: bytes.toString('utf8'),
          json() { return JSON.parse(bytes.toString('utf8')); } });
      });
    });
    call.on('error', fail);
    call.on('timeout', () => call.destroy(new Error(`Request timed out: ${path}`)));
    call.end(encoded);
  });
}

function expectStatus(result, status, path) {
  assert.equal(result.status, status, `${path}: HTTP ${result.status}, expected ${status}`);
  assert.equal(result.headers['cache-control'], 'no-store', `${path}: cache must be disabled`);
  return result;
}

/** Uses only temporary loopback listeners and a mock provider; never loads .env. */
export async function runPackageSmoke({ distDirectory = resolve(root, 'dist') } = {}) {
  const started = Date.now();
  await stat(resolve(distDirectory, 'index.html')).catch(() => { throw new Error('缺少 dist/index.html，请先运行 npm run build。'); });
  const importsChecked = await checkLocalImports();
  const unregister = register();
  const [{ createApiServer }, { ExhibitionMirrors }, { TryOnService }, { MirrorCredentialStore }, { SecretBox, SessionStore }] = await Promise.all([
    import('../server/http.ts'), import('../server/exhibitionMirrors.ts'), import('../server/service.ts'),
    import('../server/mirrorCredentials.ts'), import('../server/store.ts'),
  ]);
  const temporary = await mkdtemp(resolve(tmpdir(), 'openbuy-package-smoke-'));
  const units = [];
  let store;
  let providerCalls = 0;
  try {
    const dataDirectory = resolve(temporary, 'data');
    const seeded = seedMaterials({ dataDirectory });
    assert.equal(seeded.installed, true, 'Bundled material seed must install in a fresh directory');
    assert.equal(seeded.lookCount, 99);
    const blockedProviderCall = async () => { providerCalls++; throw new Error('Smoke validation must never call XMAX'); };
    const provider = { configured: false, region: 'global', issueKey: blockedProviderCall,
      keyStatus: blockedProviderCall, deactivate: blockedProviderCall, sessionStatus: blockedProviderCall };
    const secrets = SecretBox.forDirectory(dataDirectory);
    store = new SessionStore(':memory:');
    const service = new TryOnService({ provider, store, secrets, mirrorCredentials: new MirrorCredentialStore(dataDirectory, secrets) });
    const mirrors = new ExhibitionMirrors(dataDirectory);
    const origins = [];
    const api = await listen(createApiServer(service, origins, undefined, mirrors)); units.push(api);
    const pems = await selfsigned.generate([{ name: 'commonName', value: hostname }], {
      days: 1, keySize: 2048,
      extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] }],
    });
    const caPath = resolve(temporary, 'public-test-ca.crt');
    await writeFile(caPath, pems.cert, { mode: 0o600 });
    const web = await listen(http.createServer(createStaticRequestHandler({ distDirectory, apiPort: api.port, caPath }))); units.push(web);
    origins.push(`http://127.0.0.1:${web.port}`);
    const lan = await listen(http.createServer(createLanRequestHandler({ targetPort: web.port }))); units.push(lan);
    const camera = await listen(https.createServer({ key: pems.private, cert: pems.cert },
      createCameraRequestHandler({ targetPort: web.port, credentialsPort: web.port }))); units.push(camera);
    const secureOptions = { publicPort: 10202, secure: true, ca: pems.cert };
    const report = { passed: false, temporaryListenersOnly: true, providerCalls: 0, importsChecked,
      httpPorts: [], deepLinks: 0, bundleAssets: 0, materialAssets: 0, securityChecks: 0 };

    for (const publicPort of [10200, 10201, EXHIBITION_PORT]) {
      const entry = expectStatus(await request(lan, '/?mirror=default', { publicPort }), 302, 'HTTP root');
      assert.equal(entry.headers.location, '/v1.1/exhibition/control?mirror=default');
      const list = expectStatus(await request(lan, `${apiPath}/mirrors`, { publicPort }), 200, 'mirror list').json();
      assert.equal(list.defaultMirrorId, 'default'); assert.equal(list.mirrors.length, 1);
      report.httpPorts.push(publicPort);
    }
    const secureRoot = expectStatus(await request(camera, '/?mirror=default', secureOptions), 302, 'HTTPS root');
    assert.equal(secureRoot.headers.location, '/v1.1/exhibition/screen?mirror=default');

    const html = await readFile(resolve(distDirectory, 'index.html'), 'utf8');
    const pagePaths = ['/v1.1/exhibition', '/v1.1/exhibition/control?mirror=default', '/v1.1/exhibition/screen?mirror=default'];
    for (const path of pagePaths) {
      const response = expectStatus(await request(lan, path), 200, path);
      assert.match(response.headers['content-type'], /^text\/html/); assert.equal(response.text, html);
      report.deepLinks++;
    }
    const framePath = `/v1.1/exhibition/control?mirror=default&credentialForm=1&parentOrigin=${encodeURIComponent(`http://${hostname}:${EXHIBITION_PORT}`)}`;
    const frame = expectStatus(await request(camera, framePath, secureOptions), 200, 'HTTPS credential iframe');
    assert.equal(frame.text, html);
    assert.match(frame.headers['content-security-policy'], /frame-ancestors 'self'/);
    for (const port of [10200, 10201, EXHIBITION_PORT]) assert(frame.headers['content-security-policy'].includes(`http://${hostname}:${port}`));
    assert.equal(frame.headers['x-frame-options'], undefined, 'The intended HTTPS iframe must not be blocked');
    assert.equal(frame.headers['permissions-policy'], 'camera=(self), microphone=(), geolocation=()');

    assert.match(html, /<script[^>]+src="\/v1\.1\/assets\/[^" ]+\.js"/);
    assert.match(html, /<link[^>]+href="\/v1\.1\/assets\/[^" ]+\.css"/);
    const bundleFiles = (await filesIn(resolve(distDirectory, 'assets'))).filter(file => ['.js', '.css'].includes(extname(file)));
    let combinedScripts = '';
    for (const filename of bundleFiles) {
      const path = `/v1.1/${relative(distDirectory, filename).split('\\').join('/')}`;
      const response = expectStatus(await request(lan, path), 200, path);
      assert.match(response.headers['content-type'], extname(filename) === '.css' ? /^text\/css/ : /^text\/javascript/);
      const expected = await readFile(filename); assert.equal(hash(response.bytes), hash(expected), `Wrong bundle bytes: ${path}`);
      if (extname(filename) === '.js') combinedScripts += response.text;
      report.bundleAssets++;
    }
    assert(combinedScripts.includes('credentialForm') && combinedScripts.includes('parentOrigin'), 'Built app must include the current iframe flow');
    const cameraCheck = expectStatus(await request(camera, '/v1.1/camera-check.html', secureOptions), 200, 'camera check page');
    assert.match(cameraCheck.text, /getUserMedia/);

    const M = `${apiPath}/mirrors/default`;
    const state = expectStatus(await request(lan, M), 200, 'seeded mirror state').json();
    assert.equal(state.looks.length, 99); assert.equal(state.live, null); assert.equal(state.providerMode, 'demo');
    const seedManifest = JSON.parse(await readFile(resolve(root, 'seed/manifest.json'), 'utf8'));
    const seedHashes = new Map(seedManifest.files.map(file => [file.path, file.sha256]));
    for (const look of state.looks) {
      const path = look.image.startsWith('/v1.1/') ? look.image : `/v1.1${look.image}`;
      const response = expectStatus(await request(lan, path), 200, path);
      assert.match(response.headers['content-type'], /^image\/webp/);
      assert.equal(response.bytes.toString('ascii', 0, 4), 'RIFF');
      assert.equal(response.bytes.toString('ascii', 8, 12), 'WEBP');
      const expectedHash = seedHashes.get(`exhibition-mirrors/default/exhibition-assets/${look.id}.webp`);
      assert(expectedHash, `Seed manifest missing material ${look.id}`); assert.equal(hash(response.bytes), expectedHash);
      report.materialAssets++;
    }
    const firstAsset = state.looks[0].image;
    const secureAsset = expectStatus(await request(camera, `/v1.1${firstAsset}`, secureOptions), 200, 'HTTPS material');
    assert.equal(hash(secureAsset.bytes), seedHashes.get(`exhibition-mirrors/default/exhibition-assets/${state.looks[0].id}.webp`));

    // A same-origin staff write must survive both proxy layers and reach the API.
    const write = expectStatus(await request(lan, M, { method: 'PATCH', body: { name: '封装验收镜' }, origin: `http://${hostname}:${EXHIBITION_PORT}` }), 200, 'HTTP staff write');
    assert.equal(write.json().name, '封装验收镜');
    const command = expectStatus(await request(lan, `${M}/command`, { method: 'POST', body: { action: 'idle', expectedRevision: state.revision }, origin: `http://${hostname}:${EXHIBITION_PORT}` }), 200, 'HTTP command');
    assert.equal(command.json().phase, 'idle');
    for (const options of [{}, { origin: `http://example.invalid:${EXHIBITION_PORT}` }, { origin: `http://${hostname}:${EXHIBITION_PORT}`, headers: { 'Sec-Fetch-Site': 'cross-site' } }]) {
      expectStatus(await request(lan, M, { method: 'PATCH', body: { name: '不应保存' }, ...options }), 403, 'Rejected cross-origin/missing-origin write');
      report.securityChecks++;
    }
    const invalidCredential = { apiKey: 'invalid', region: 'global', expectedRevision: 0 };
    expectStatus(await request(lan, `${M}/credentials`, { method: 'PUT', body: invalidCredential, origin: `http://${hostname}:${EXHIBITION_PORT}` }), 403, 'HTTP credentials blocked');
    report.securityChecks++;
    const credentialStatus = expectStatus(await request(camera, `${M}/credentials`, secureOptions), 200, 'HTTPS credential status').json();
    assert.equal(credentialStatus.configured, false); assert(!Object.hasOwn(credentialStatus, 'apiKey'));
    const invalidSecure = expectStatus(await request(camera, `${M}/credentials`, { ...secureOptions, method: 'PUT', body: invalidCredential, origin: `https://${hostname}:10202` }), 400, 'HTTPS credential input validation');
    assert.equal(invalidSecure.json().code, 'INVALID_API_KEY'); report.securityChecks++;
    for (const path of ['/v1.1/.env', '/v1.1/server/index.ts', '/v1.1/.data/secret.key', '/v1.1/assets/missing.js', '/v1.1/api/status']) {
      expectStatus(await request(lan, path), 404, path); report.securityChecks++;
    }
    const downloadedCA = expectStatus(await request(lan, '/openbuy-local-ca.crt'), 200, 'public CA download');
    assert.equal(downloadedCA.text, pems.cert);
    assert.equal(store.list().length, 0, 'Smoke validation must not create supplier sessions');
    assert.equal(providerCalls, 0, 'Smoke validation must not invoke a paid provider');
    report.providerCalls = providerCalls; report.passed = true; report.durationMs = Date.now() - started;
    return report;
  } finally {
    for (const unit of units.reverse()) await close(unit);
    store?.close();
    unregister();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const args = process.argv.slice(2);
  const reportPath = args[0] === '--report' && args.length === 2 ? resolve(args[1]) : undefined;
  if (args.length && !reportPath) { console.error('用法：node scripts/package-smoke.mjs [--report 验证结果.json]'); process.exitCode = 1; }
  else runPackageSmoke().then(async report => {
    if (reportPath) { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
    console.log(JSON.stringify(report, null, 2));
  }).catch(error => { console.error(`封装检查失败：${error.message}`); process.exitCode = 1; });
}
