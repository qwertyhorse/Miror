import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTNAME, HTTP_PORT, HTTP_COMPAT_PORT, EXHIBITION_PORT, isPrivateAddress, proxyRequest, proxyUpgrade, reject, requestPath } from './gateway-shared.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(import.meta.url);
export const LAN_URL = `http://${HOSTNAME}:${HTTP_PORT}/`;
const defaultHosts = [HOSTNAME, '127.0.0.1', 'localhost'];
const httpPorts = [HTTP_PORT, HTTP_COMPAT_PORT, EXHIBITION_PORT];

export function validateLanRequest(request, ip = null, websocket = false, { ports = httpPorts } = {}) {
  const ips = Array.isArray(ip) ? ip : ip ? [ip] : [];
  const hosts = new Set(ports.flatMap(port => [...defaultHosts, ...ips].map(host => `${host}:${port}`)));
  const host = (request.headers.host ?? '').toLowerCase();
  if (!hosts.has(host) || !isPrivateAddress(request.socket.remoteAddress ?? '')) return { code: 403, message: '此入口仅用于本机和局域网。' };
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) return { code: 403, message: '请求来源不被允许。' };
  const writing = !['GET', 'HEAD'].includes(request.method ?? '');
  if ((writing || websocket) && (!origin || request.headers['sec-fetch-site'] === 'cross-site')) return { code: 403, message: '写入与 WebSocket 请求必须来自同源页面。' };
  const parsed = requestPath(request, `http://${host}`);
  if (!parsed) return { code: 400, message: '无效请求路径。' };
  if (!['/', '/__mirror_health', '/openbuy-local-ca.crt'].includes(parsed.path) && (!/^\/v1\.1(?:\/|$)/.test(parsed.path) || !/^\/v1\.1(?:\/|$)/.test(parsed.rawPath))) return { code: 404, message: '未找到智能镜页面。' };
  if (/^\/v1\.1\/api\/(?!exhibition(?:\/|$))/.test(parsed.path)) return { code: 404, message: '未找到智能镜接口。' };
  if (writing && /^\/v1\.1\/api\/exhibition\/mirrors\/[a-z0-9][a-z0-9-]{0,63}\/credentials(?:\/|$)/.test(parsed.path)) return { code: 403, message: '密钥请通过安全连接保存。' };
  return null;
}

export function createLanRequestHandler({ getIPs = () => [], targetPort = 5173, ports = httpPorts } = {}) {
  return (request, response) => {
    const failure = validateLanRequest(request, getIPs(), false, { ports });
    if (failure) { reject(response, failure.code, failure.message); return; }
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/') {
      response.writeHead(302, { Location: `/v1.1/exhibition/control${url.search}`, 'Cache-Control': 'no-store' }); response.end(); return;
    }
    if (url.pathname === '/__mirror_health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ gateway: 'miror-http', url: LAN_URL, ips: getIPs() })); return;
    }
    proxyRequest(request, response, { targetPort });
  };
}

export function lanIPv4() {
  const interfaces = networkInterfaces();
  let preferred;
  if (process.platform === 'darwin') {
    const route = spawnSync('/sbin/route', ['-n', 'get', 'default'], { encoding: 'utf8', timeout: 1500 });
    preferred = route.stdout?.match(/^\s*interface:\s*(\S+)/m)?.[1];
  }
  const entries = Object.entries(interfaces).sort(([a], [b]) => Number(b === preferred) - Number(a === preferred));
  return [...new Set(entries.flatMap(([, addresses]) => addresses ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address) && !entry.address.startsWith('169.254.')).map(entry => entry.address))];
}

async function writeAddresses(ips) {
  const directory = resolve(root, '.data');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `lan-addresses.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify({ url: LAN_URL, ips, ipUrls: ips.map(ip => `http://${ip}:${HTTP_PORT}/`), updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, resolve(directory, 'lan-addresses.json'));
}

async function serve() {
  let ips = lanIPv4();
  const sockets = new Set();
  const handler = createLanRequestHandler({ getIPs: () => ips });
  const servers = httpPorts.map(port => ({ server: http.createServer(handler), port }));
  let closing = false;
  let awake;
  let registration;
  let networkTimer;
  let networkRefresh = false;
  let retryAt = 0;
  let retries = 0;
  function stopRegistration() { const current = registration; registration = null; if (current && current.exitCode === null && current.signalCode === null) current.kill('SIGTERM'); }
  function stop(error) {
    if (closing) return; closing = true;
    if (error) { console.error(error.message ?? error); process.exitCode = 1; }
    clearInterval(networkTimer); stopRegistration();
    if (awake && awake.exitCode === null && awake.signalCode === null) awake.kill('SIGTERM');
    for (const { server } of servers) server.close();
    for (const socket of sockets) socket.destroy();
  }
  for (const { server } of servers) {
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', (request, socket, head) => proxyUpgrade(request, socket, head, { failure: validateLanRequest(request, ips, true) }));
    server.on('error', stop);
  }
  try {
    for (const { server, port } of servers) await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '0.0.0.0', () => { server.removeListener('error', fail); done(); }); });
  } catch (error) { stop(error); throw error; }
  if (process.platform === 'darwin') {
    awake = spawn('/usr/bin/caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'inherit' });
    awake.once('error', stop);
    awake.once('exit', (code, signal) => { if (!closing) stop(new Error(`防睡眠进程已退出 (${code ?? signal})。`)); });
  }
  function broadcast() {
    if (process.platform !== 'darwin' || closing || registration || !ips.length || Date.now() < retryAt) return;
    const current = spawn('/usr/bin/dns-sd', ['-P', 'Miror', '_http._tcp', 'local', String(HTTP_PORT), HOSTNAME, ips[0]], { stdio: 'inherit' });
    registration = current;
    const startedAt = Date.now();
    function retry() {
      if (closing || registration !== current) return;
      registration = null;
      if (Date.now() - startedAt > 60000) retries = 0;
      retryAt = Date.now() + Math.min(30000, 1000 * 2 ** ++retries);
    }
    current.once('error', retry); current.once('exit', retry);
  }
  async function refreshNetwork() {
    if (closing || networkRefresh) return; networkRefresh = true;
    try {
      const next = lanIPv4();
      if (JSON.stringify(next) !== JSON.stringify(ips)) {
        stopRegistration(); ips = next; retries = 0; retryAt = 0; await writeAddresses(ips);
        console.log(`${new Date().toISOString()} 局域网地址：${ips.join(', ') || '等待联网'}`);
      }
      broadcast();
    } catch (error) { stop(error); }
    finally { networkRefresh = false; }
  }
  await writeAddresses(ips); broadcast();
  networkTimer = setInterval(() => { void refreshNetwork(); }, 10000);
  process.once('SIGTERM', () => stop()); process.once('SIGINT', () => stop());
  console.log(`工作人员后台：http://${HOSTNAME}:${EXHIBITION_PORT}/；智能镜入口：${LAN_URL}；兼容入口：http://${HOSTNAME}:${HTTP_COMPAT_PORT}/`);
  console.log('锁屏与熄屏期间继续运行；停止后释放防睡眠。');
}

async function main(command) {
  if (command === 'serve') return serve();
  if (['start', 'status', 'stop'].includes(command)) { const { main: manage } = await import('./lan-managed.mjs'); return manage(command); }
  throw new Error('Usage: node scripts/lan-preview.mjs serve|start|status|stop');
}
if (process.argv[1] && resolve(process.argv[1]) === script) main(process.argv[2] ?? 'status').catch(error => { console.error(error.message); process.exitCode = 1; });
