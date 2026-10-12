import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareLaunchRuntime, previewRuntime } from './launchd-runtime.mjs';
import { CAMERA_URL } from './camera-https.mjs';
import { HOSTNAME, HTTP_PORT, HTTP_COMPAT_PORT, EXHIBITION_PORT, CAMERA_PORT, WEB_PORT } from './gateway-shared.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(import.meta.url);
const runtime = previewRuntime(root);
const domain = `gui/${process.getuid?.() ?? 0}`;
const launchDirectory = resolve(homedir(), 'Library/LaunchAgents');
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
export function managedUnits(runtime, launchDirectory) {
  return [
    { name: 'api', ports: [3002], args: ['--import', resolve(runtime.app, 'node_modules/tsx/dist/loader.mjs'), `--env-file=${resolve(runtime.app, '.env')}`, resolve(runtime.app, 'server/index.ts')] },
    { name: 'web', ports: [WEB_PORT], args: [resolve(runtime.app, 'scripts/static-web.mjs')] },
    { name: 'lan', ports: [HTTP_PORT, HTTP_COMPAT_PORT, EXHIBITION_PORT], args: [resolve(runtime.app, 'scripts/lan-preview.mjs'), 'serve'] },
    { name: 'camera-https', ports: [CAMERA_PORT], args: [resolve(runtime.app, 'scripts/camera-https.mjs'), 'serve'] },
  ].map(unit => ({ ...unit, label: `${runtime.prefix}.${unit.name}`, log: resolve(runtime.logs, `${unit.name}.log`), path: resolve(launchDirectory, `${runtime.prefix}.${unit.name}.plist`) }));
}
const units = managedUnits(runtime, launchDirectory);

function run(command, args) { return spawnSync(command, args, { encoding: 'utf8', timeout: 5000 }); }
function requireSuccess(result, message) { if (result.error || result.status !== 0) throw new Error(`${message}：${result.error?.message ?? result.stderr?.trim() ?? result.status}`); }
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function managedPlist(unit, runtime) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(unit.label)}</string>
<key>ProgramArguments</key><array>${[runtime.node, ...unit.args].map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(runtime.app)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(resolve(runtime.node, '..'))}:/usr/bin:/bin:/usr/sbin:/sbin</string><key>OPENBUY_API_PORT</key><string>3002</string><key>OPENBUY_DATA_DIR</key><string>.data</string><key>OPENBUY_ENV_FILE</key><string>.env</string><key>OPENBUY_ALLOWED_ORIGINS</key><string>http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(unit.log)}</string><key>StandardErrorPath</key><string>${xml(unit.log)}</string>
</dict></plist>\n`;
}
const plist = unit => managedPlist(unit, runtime);

function job(unit) {
  const result = run('/bin/launchctl', ['print', `${domain}/${unit.label}`]);
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  const argv = result.stdout.match(/^\s*arguments = \{\s*\n([\s\S]*?)^\s*\}/m)?.[1].split('\n').map(value => value.trim()).filter(Boolean);
  const workingDirectory = result.stdout.match(/^\s*working directory = (.+)$/m)?.[1].trim();
  if (JSON.stringify(argv) !== JSON.stringify([runtime.node, ...unit.args]) || workingDirectory !== runtime.app) throw new Error(`后台服务 ${unit.label} 的命令或目录不属于当前独立智能镜工程，未修改它。`);
  return { pid: Number(result.stdout.match(/^\s*pid = (\d+)/m)?.[1]) || null };
}

function listeners(port) {
  const result = run('/usr/sbin/lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (result.error || ![0, 1].includes(result.status)) throw new Error(`无法检查端口 ${port}。`);
  return [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
}

function requestReady(port, path, { secure = false, ca, host = `127.0.0.1:${port}`, expected, html = false } = {}) {
  return new Promise((done, fail) => {
    const options = { hostname: '127.0.0.1', port, path, headers: { Host: host }, timeout: 1500, ...(secure ? { ca, servername: HOSTNAME } : {}) };
    const request = (secure ? https : http).get(options, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 65536) response.destroy(); });
      response.on('error', fail);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`端口 ${port} 返回 HTTP ${response.statusCode}`);
          if (expected && JSON.parse(body).gateway !== expected) throw new Error(`端口 ${port} 返回了其他服务。`);
          if (html && (!/text\/html/i.test(response.headers['content-type'] ?? '') || !/<div\s+id=["']root["']/i.test(body) || !/<script\b[^>]*type=["']module["']/i.test(body))) throw new Error(`端口 ${port} 未返回可运行的展会前端。`);
          done();
        } catch (error) { fail(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`端口 ${port} 健康检查超时`)));
    request.on('error', fail);
  });
}

async function ready() {
  const { tlsOptions } = await import(pathToFileURL(resolve(runtime.app, 'scripts/camera-https.mjs')).href);
  const { ca } = await tlsOptions();
  // Mirror listing proves the HTTP gateway -> prebuilt frontend -> API chain.
  await Promise.all([
    requestReady(HTTP_PORT, '/__mirror_health', { host: `${HOSTNAME}:${HTTP_PORT}`, expected: 'miror-http' }),
    requestReady(HTTP_COMPAT_PORT, '/__mirror_health', { host: `${HOSTNAME}:${HTTP_COMPAT_PORT}`, expected: 'miror-http' }),
    requestReady(EXHIBITION_PORT, '/__mirror_health', { host: `${HOSTNAME}:${EXHIBITION_PORT}`, expected: 'miror-http' }),
    requestReady(EXHIBITION_PORT, '/v1.1/exhibition/control', { host: `${HOSTNAME}:${EXHIBITION_PORT}`, html: true }),
    requestReady(HTTP_PORT, '/v1.1/api/exhibition/mirrors', { host: `${HOSTNAME}:${HTTP_PORT}` }),
    requestReady(CAMERA_PORT, '/__camera_health', { secure: true, ca, host: `${HOSTNAME}:${CAMERA_PORT}`, expected: 'camera-https' }),
  ]);
}

export function preflight() {
  // Preflight all fixed ports before creating or starting any service.
  const state = new Map(units.map(unit => [unit.name, job(unit)]));
  for (const unit of units) for (const port of unit.ports) {
    const pids = listeners(port);
    if (pids.length && (pids.length !== 1 || pids[0] !== state.get(unit.name)?.pid)) throw new Error(`端口 ${port} 已被另一份服务占用。运行此独立包前，请先停止原服务；现有服务未被修改或停止。`);
  }
  return state;
}

function announceReady() {
  console.log(`工作人员后台：http://${HOSTNAME}:${EXHIBITION_PORT}/\n固定入口：http://${HOSTNAME}:${HTTP_PORT}/\n镜端入口：${CAMERA_URL}\n登录自启、退出恢复和防闲置睡眠已启用。\n运行数据：${runtime.data}\n后台环境配置：${runtime.environment}\n日志：${runtime.logs}`);
}

async function start() {
  const state = preflight();
  if (units.every(unit => state.get(unit.name))) { await ready(); announceReady(); return; }
  if (!units.some(unit => state.get(unit.name))) {
    await Promise.all(['.env', 'dist/index.html', 'scripts/static-web.mjs', 'node_modules/tsx/dist/loader.mjs', 'server/index.ts'].map(path => readFile(resolve(root, path))));
    await prepareLaunchRuntime(root);
    // Renew the leaf in the persistent runtime, keeping its trusted CA when
    // network addresses change. No credentials or data are copied back.
    const { prepareCertificates } = await import(pathToFileURL(resolve(runtime.app, 'scripts/setup.mjs')).href);
    await prepareCertificates(runtime.app);
  }
  const { tlsOptions } = await import(pathToFileURL(resolve(runtime.app, 'scripts/camera-https.mjs')).href);
  await tlsOptions();
  await mkdir(launchDirectory, { recursive: true });
  const started = [];
  try {
    for (const unit of units) {
      if (state.get(unit.name)) continue;
      const desired = plist(unit);
      let installed;
      try { installed = await readFile(unit.path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (installed && installed !== desired) throw new Error(`已有后台配置 ${unit.path} 与当前工程不符，未覆盖。`);
      const temporary = `${unit.path}.${process.pid}.tmp`;
      await writeFile(temporary, desired, { mode: 0o600 }); await rename(temporary, unit.path);
      requireSuccess(run('/bin/launchctl', ['enable', `${domain}/${unit.label}`]), `无法启用 ${unit.name}`);
      requireSuccess(run('/bin/launchctl', ['bootstrap', domain, unit.path]), `无法启动 ${unit.name}`);
      started.push(unit);
    }
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await ready(); announceReady(); return; }
      catch (error) { lastError = error; await delay(300); }
    }
    throw new Error(`智能镜服务未就绪：${lastError?.message}。日志：${runtime.logs}`);
  } catch (error) {
    // Roll back only units started by this command. Existing managed units stay intact.
    for (const unit of started.reverse()) {
      if (job(unit)) requireSuccess(run('/bin/launchctl', ['bootout', `${domain}/${unit.label}`]), `无法回退 ${unit.name}`);
      await rm(unit.path, { force: true });
    }
    throw error;
  }
}

async function stop() {
  // Resolve ownership for every unit before stopping any one of them.
  const state = units.map(unit => ({ unit, state: job(unit) }));
  for (const { unit, state: current } of state.reverse()) {
    if (current) { job(unit); requireSuccess(run('/bin/launchctl', ['bootout', `${domain}/${unit.label}`]), `无法停止 ${unit.name}`); }
    let installed;
    try { installed = await readFile(unit.path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (installed === plist(unit)) await rm(unit.path, { force: true });
  }
  console.log('独立智能镜后台服务已停止；登录自启与防睡眠已解除。');
}

async function status() {
  const state = new Map();
  for (const unit of units) {
    const current = job(unit);
    state.set(unit.name, current);
    console.log(`${unit.name}：${current?.pid ? `运行中 (PID ${current.pid})` : current ? '已注册，等待启动' : '未启用'}`);
  }
  try {
    if (!units.every(unit => state.get(unit.name)?.pid)) throw new Error('此独立包的后台服务尚未全部运行');
    await ready(); console.log(`检查通过：http://${HOSTNAME}:${HTTP_PORT}/；${CAMERA_URL}`);
  }
  catch (error) { console.log(`服务尚未就绪：${error.message}`); process.exitCode = 1; }
  console.log(`日志：${runtime.logs}`);
}

export async function main(command) {
  if (process.platform !== 'darwin') throw new Error('登录自启与后台托管需要 macOS；其他系统请运行 npm start。');
  if (command === 'start') return start();
  if (command === 'stop') return stop();
  if (command === 'status') return status();
  if (command === 'preflight') { preflight(); console.log('端口与后台服务归属检查通过。'); return; }
  throw new Error('Usage: node scripts/lan-managed.mjs start|stop|status|preflight');
}
if (process.argv[1] && resolve(process.argv[1]) === script) main(process.argv[2] ?? 'status').catch(error => { console.error(error.message); process.exitCode = 1; });
