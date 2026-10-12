import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createStaticRequestHandler } from './static-web.mjs';
import { createLanRequestHandler } from './lan-preview.mjs';
import { createCameraRequestHandler } from './camera-https.mjs';
import { assertPortAvailable } from './start.mjs';

test('prebuilt frontend, API proxy and public gateways work without Vite or fixed listeners', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'openbuy-runtime-'));
  const servers = [];
  const listen = async handler => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    return server.address().port;
  };
  const request = (port, path, headers = {}, method = 'GET', body) => new Promise((done, fail) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path, method, headers }, incoming => {
      let data = '';
      incoming.on('data', chunk => { data += chunk; });
      incoming.on('error', fail);
      incoming.on('end', () => done({ code: incoming.statusCode, headers: incoming.headers, data }));
    });
    outgoing.on('error', fail);
    outgoing.end(body);
  });
  try {
    await mkdir(resolve(temporary, 'dist/assets'), { recursive: true });
    await writeFile(resolve(temporary, 'dist/index.html'), '<html>production</html>');
    await writeFile(resolve(temporary, 'dist/assets/app.js'), 'console.log(1)');
    await writeFile(resolve(temporary, 'secret'), 'secret');
    await symlink(resolve(temporary, 'secret'), resolve(temporary, 'dist/assets/leak.txt')).catch(error => {
      // Windows may require Developer Mode for symlinks; source isolation and
      // ordinary missing-file checks still run on that machine.
      if (process.platform !== 'win32' || !['EPERM', 'ENOSYS'].includes(error.code)) throw error;
    });
    await writeFile(resolve(temporary, 'ca.crt'), 'fresh-ca');
    const apiPort = await listen((incoming, outgoing) => {
      outgoing.setHeader('Content-Type', 'application/json');
      outgoing.end(JSON.stringify({ path: incoming.url, origin: incoming.headers.origin, method: incoming.method }));
    });
    const webPort = await listen(createStaticRequestHandler({ distDirectory: resolve(temporary, 'dist'), apiPort, caPath: resolve(temporary, 'ca.crt') }));
    assert.equal((await request(webPort, '/v1.1/exhibition/control')).data, '<html>production</html>');
    assert.equal((await request(webPort, '/v1.1/exhibition/screen?mirror=abc')).code, 200);
    assert.equal((await request(webPort, '/v1.1/assets/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await request(webPort, '/v1.1/assets/app.js', {}, 'HEAD')).data, '');
    for (const path of ['/.env', '/.data/secret', '/server/index.ts', '/v1.1/.env', '/v1.1/server/index.ts', '/v1.1/assets/missing.js', '/v1.1/assets/missing', '/v1.1/assets/leak.txt', '/v1.1/%2e%2e/.env']) {
      const response = await request(webPort, path);
      assert.equal(response.code, 404, path);
      assert.equal(response.headers['cache-control'], 'no-store', path);
    }
    assert.equal((await request(webPort, '/openbuy-local-ca.crt')).data, 'fresh-ca');
    await writeFile(resolve(temporary, 'ca.crt'), 'updated-ca');
    assert.equal((await request(webPort, '/v1.1/openbuy-local-ca.crt')).data, 'updated-ca');

    const lanPort = await listen(createLanRequestHandler({ targetPort: webPort }));
    for (const port of [10200, 10201, 10601]) {
      const response = await request(lanPort, '/?mirror=abc', { Host: `xuminghong.local:${port}` });
      assert.equal(response.code, 302);
      assert.equal(response.headers.location, '/v1.1/exhibition/control?mirror=abc');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    const headers = { Host: 'xuminghong.local:10601', Origin: 'http://xuminghong.local:10601', 'Sec-Fetch-Site': 'same-origin' };
    const api = await request(lanPort, '/v1.1/api/exhibition/mirrors?test=1', headers, 'POST', '{}');
    assert.equal(api.code, 200);
    assert.deepEqual(JSON.parse(api.data), { path: '/api/exhibition/mirrors?test=1', origin: `http://127.0.0.1:${webPort}`, method: 'POST' });
    assert.equal((await request(lanPort, '/v1.1/api/exhibition/mirrors/abc/credentials', headers, 'PUT', '{}')).code, 403);
    assert.equal((await request(lanPort, '/v1.1/api/exhibition/mirrors', { ...headers, Origin: 'http://example.com' }, 'POST', '{}')).code, 403);
    assert.equal((await request(lanPort, '/', { Host: 'example.com:10601' })).code, 403);

    // The handler is exercised on an ephemeral HTTP server here. The separate
    // package smoke check verifies TLS using the newly generated certificate.
    const cameraPort = await listen(createCameraRequestHandler({ targetPort: webPort }));
    const frame = await request(cameraPort, '/v1.1/exhibition/control?credentialForm=1', { Host: 'xuminghong.local:10202' });
    assert.equal(frame.code, 200);
    assert.equal(frame.headers['cache-control'], 'no-store');
    assert.equal(frame.headers['content-security-policy'], "frame-ancestors 'self' http://xuminghong.local:10200 http://xuminghong.local:10201 http://xuminghong.local:10601");
    assert.equal((await request(cameraPort, '/openbuy-local-ca.crt', { Host: 'xuminghong.local:10202' })).data, 'updated-ca');

    await assert.rejects(assertPortAvailable(webPort), /未停止任何已有程序/);
    assert.equal((await request(webPort, '/v1.1/exhibition/control')).code, 200);
  } finally {
    await Promise.all(servers.map(server => new Promise(done => server.close(done))));
    await rm(temporary, { recursive: true, force: true });
  }
});
