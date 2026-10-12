import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tlsOptions } from './camera-https.mjs';
import { HOSTNAME, WEB_PORT, HTTP_PORT, HTTP_COMPAT_PORT, EXHIBITION_PORT, CAMERA_PORT } from './gateway-shared.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(import.meta.url);
export const requiredPorts = [3002, WEB_PORT, HTTP_PORT, HTTP_COMPAT_PORT, EXHIBITION_PORT, CAMERA_PORT];
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));

export async function assertPortAvailable(port) {
  // macOS can allow a wildcard probe beside an existing loopback listener.
  // Probe both bindings used by this package instead of relying on one bind.
  for (const host of ['127.0.0.1', '0.0.0.0']) await new Promise((done, fail) => {
    const probe = net.createServer();
    probe.once('error', error => fail(new Error(error.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用。请先停止占用服务或另一份会展包；本次未停止任何已有程序。`
      : `无法使用端口 ${port}：${error.message}`)));
    probe.listen({ port, host, exclusive: true }, () => probe.close(error => error ? fail(error) : done()));
  });
}

export function requestReady(port, path, { secure = false, ca, host = `127.0.0.1:${port}`, expected } = {}) {
  return new Promise((done, fail) => {
    const request = (secure ? https : http).get({ hostname: '127.0.0.1', port, path, headers: { Host: host }, timeout: 1500,
      ...(secure ? { ca, servername: HOSTNAME } : {}) }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 65536) response.destroy(new Error('健康检查响应过大。')); });
      response.on('error', fail);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`端口 ${port} 返回 HTTP ${response.statusCode}`);
          if (expected && JSON.parse(body).gateway !== expected) throw new Error(`端口 ${port} 返回了其他服务。`);
          done();
        } catch (error) { fail(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`端口 ${port} 健康检查超时。`)));
    request.on('error', fail);
  });
}

async function preflight() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('需要 Node.js 22.13 或更高版本，建议安装 Node.js 24 LTS。');
  // Nothing has been spawned or registered before every preflight succeeds.
  await Promise.all(requiredPorts.map(assertPortAvailable));
  await access(resolve(root, 'node_modules/tsx/dist/loader.mjs')).catch(() => { throw new Error('缺少 API 运行依赖。请先运行 npm ci，再运行 npm run setup。'); });
  await stat(resolve(root, 'dist/index.html')).catch(() => { throw new Error('缺少 dist/index.html。请重新解压完整交付包，或先运行 npm run build。'); });
  await access(resolve(root, '.env')).catch(() => { throw new Error('尚未完成本机配置。请先运行 npm run setup，再运行 npm start。'); });
  return tlsOptions();
}

export async function start() {
  const { ca } = await preflight();
  const children = [];
  let stopping = false;
  let fatal;
  let finish;
  const finished = new Promise(done => { finish = done; });

  async function stop(error) {
    if (stopping) return finished;
    stopping = true;
    if (error) { console.error(error.message); process.exitCode = 1; }
    // Terminate only the children this invocation created. Never discover or
    // kill a process by its port number.
    const exits = children.filter(child => child.pid && child.exitCode === null && child.signalCode === null).map(child => new Promise(done => {
      child.once('exit', done);
      child.once('error', done);
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 8000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
      child.kill('SIGTERM');
    }));
    await Promise.all(exits);
    finish();
  }
  function launch(name, args, env = {}) {
    if (stopping || fatal) throw fatal ?? new Error('启动已取消。');
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
    children.push(child);
    const fail = message => { if (stopping) return; fatal = new Error(`${name} ${message}，已回退本次启动。`); void stop(fatal); };
    child.once('error', error => fail(`无法启动：${error.message}`));
    child.once('exit', (code, signal) => fail(`已退出（${code ?? signal}）`));
  }
  async function waitUntil(check) {
    let lastError;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (fatal || stopping) throw fatal ?? new Error('启动已取消。');
      try { await check(); return; }
      catch (error) { lastError = error; await delay(250); }
    }
    throw new Error(`服务启动超时：${lastError?.message}`);
  }
  const onSignal = () => { void stop(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    launch('API', ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'server/index.ts')], {
      OPENBUY_API_PORT: '3002', OPENBUY_ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}`,
    });
    await waitUntil(() => requestReady(3002, '/api/exhibition/mirrors'));
    launch('静态前端', [resolve(root, 'scripts/static-web.mjs')]);
    await waitUntil(() => requestReady(WEB_PORT, '/__static_health', { expected: 'mirror-static' }));
    await waitUntil(() => requestReady(WEB_PORT, '/v1.1/api/exhibition/mirrors'));
    launch('HTTP 网关', [resolve(root, 'scripts/lan-preview.mjs'), 'serve']);
    await waitUntil(() => Promise.all([HTTP_PORT, HTTP_COMPAT_PORT, EXHIBITION_PORT].map(port =>
      requestReady(port, '/__mirror_health', { host: `${HOSTNAME}:${port}`, expected: 'miror-http' }))));
    launch('摄像头 HTTPS', [resolve(root, 'scripts/camera-https.mjs'), 'serve']);
    await waitUntil(() => requestReady(CAMERA_PORT, '/__camera_health', { secure: true, ca, host: `${HOSTNAME}:${CAMERA_PORT}`, expected: 'camera-https' }));
    await waitUntil(() => Promise.all([
      requestReady(EXHIBITION_PORT, '/v1.1/api/exhibition/mirrors', { host: `${HOSTNAME}:${EXHIBITION_PORT}` }),
      requestReady(CAMERA_PORT, '/v1.1/api/exhibition/mirrors', { secure: true, ca, host: `${HOSTNAME}:${CAMERA_PORT}` }),
    ]));
    if (fatal || stopping) throw fatal ?? new Error('启动已取消。');
    console.log(`\n会展包已就绪\n工作人员后台：http://${HOSTNAME}:${EXHIBITION_PORT}/\n固定入口：http://${HOSTNAME}:${HTTP_PORT}/\n镜端摄像头：https://${HOSTNAME}:${CAMERA_PORT}/v1.1/exhibition/screen\n按 Ctrl+C 停止本次启动的服务。`);
    await finished;
  } catch (error) { await stop(error); }
  finally { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
}

if (process.argv[1] && resolve(process.argv[1]) === script) start().catch(error => { console.error(error.message); process.exitCode = 1; });
