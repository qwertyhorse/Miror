import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMERA_PORT, HOSTNAME, WEB_PORT, HTTP_PORT, HTTP_COMPAT_PORT, EXHIBITION_PORT, isPrivateAddress, proxyHeaders, proxyRequest, proxyUpgrade, reject, requestPath } from './gateway-shared.mjs';

export { CAMERA_PORT, isPrivateAddress, proxyHeaders };
export const CAMERA_URL = `https://${HOSTNAME}:${CAMERA_PORT}/v1.1/exhibition/screen`;
const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(import.meta.url);
const defaultCameraHosts = new Set([HOSTNAME, 'localhost', '127.0.0.1']);

export function cameraHostsForCertificate(certificate, interfaces = networkInterfaces()) {
  const hosts = new Set([...defaultCameraHosts].filter(host => isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host)));
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === 'IPv4' && isPrivateAddress(address.address) && certificate.checkIP(address.address)) hosts.add(address.address);
    }
  }
  return hosts;
}

export function validateCameraRequest(request, { port = CAMERA_PORT, websocket = false, allowedHosts = defaultCameraHosts } = {}) {
  const host = (request.headers.host ?? '').toLowerCase();
  if (!new Set([...allowedHosts].map(value => `${value}:${port}`)).has(host)) return { code: 403, message: '请使用证书覆盖且属于本机的摄像头入口地址。' };
  if (!isPrivateAddress(request.socket.remoteAddress ?? '')) return { code: 403, message: '此摄像头入口仅用于本机和局域网。' };
  const origin = request.headers.origin;
  if (origin && origin !== `https://${host}`) return { code: 403, message: '请求来源不被允许。' };
  if ((!['GET', 'HEAD'].includes(request.method ?? '') || websocket) && (!origin || request.headers['sec-fetch-site'] === 'cross-site')) return { code: 403, message: '写入与 WebSocket 请求必须来自同源 HTTPS 页面。' };
  const parsed = requestPath(request, `https://${host}`);
  if (!parsed) return { code: 400, message: '无效请求路径。' };
  if (!['/', '/__camera_health', '/openbuy-local-ca.crt'].includes(parsed.path) && (!/^\/v1\.1(?:\/|$)/.test(parsed.path) || !/^\/v1\.1(?:\/|$)/.test(parsed.rawPath))) return { code: 404, message: '摄像头入口仅提供 V1.1 智能镜页面。' };
  // The standalone API has no main-site API-key route.
  if (/^\/v1\.1\/api\/(?!exhibition(?:\/|$))/.test(parsed.path)) return { code: 404, message: '未找到智能镜接口。' };
  return null;
}

export function createCameraRequestHandler({ port = CAMERA_PORT, targetPort = WEB_PORT, credentialsPort = targetPort, allowedHosts = defaultCameraHosts } = {}) {
  return (request, response) => {
    const failure = validateCameraRequest(request, { port, allowedHosts });
    if (failure) { reject(response, failure.code, failure.message); return; }
    const url = new URL(request.url, `https://${request.headers.host}`);
    if (url.pathname === '/') {
      response.writeHead(302, { Location: `/v1.1/exhibition/screen${url.search}`, 'Cache-Control': 'no-store' }); response.end(); return;
    }
    if (url.pathname === '/__camera_health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ gateway: 'camera-https', protocol: 'https', cameraUrl: CAMERA_URL, cameraIpUrls: [...allowedHosts].filter(host => isIP(host) && host !== '127.0.0.1').map(host => `https://${host}:${port}/v1.1/exhibition/screen`) })); return;
    }
    const credentials = /^\/v1\.1\/api\/exhibition\/mirrors\/[a-z0-9][a-z0-9-]{0,63}\/(?:credentials|provider-settings(?:\/(?:verify|apply))?)$/.test(decodeURIComponent(url.pathname));
    const credentialForm = url.pathname === '/v1.1/exhibition/control' && url.searchParams.get('credentialForm') === '1';
    const responseHeaders = credentialForm ? { 'content-security-policy': `frame-ancestors 'self' ${[HTTP_PORT, HTTP_COMPAT_PORT, EXHIBITION_PORT].map(httpPort => `http://${url.hostname}:${httpPort}`).join(' ')}` } : {};
    proxyRequest(request, response, { targetPort: credentials ? credentialsPort : targetPort, protocol: 'https', camera: true, responseHeaders });
  };
}

export async function tlsOptions() {
  const directory = resolve(root, '.data/lan-tls');
  let key, cert, ca;
  try { [key, cert, ca] = await Promise.all(['server.key', 'server.crt', 'root-ca.crt'].map(name => readFile(resolve(directory, name)))); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('本机摄像头 HTTPS 证书尚未配置。请先运行 npm run setup，再运行 npm start。'); throw error; }
  try {
    const certificate = new X509Certificate(cert);
    const authority = new X509Certificate(ca);
    if (!certificate.checkHost(HOSTNAME) || !certificate.checkPrivateKey(createPrivateKey(key)) || !certificate.verify(authority.publicKey)
      || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()
      || Date.parse(authority.validFrom) > Date.now() || Date.parse(authority.validTo) <= Date.now()) throw new Error('invalid certificate');
    return { key, cert, ca, minVersion: 'TLSv1.2', certificate };
  } catch { throw new Error('局域网证书无效、过期或与私钥不匹配。请运行 npm run setup；未修改系统信任。'); }
}

async function serve() {
  const { certificate, ...options } = await tlsOptions();
  const allowedHosts = cameraHostsForCertificate(certificate);
  const server = https.createServer(options, createCameraRequestHandler({ allowedHosts }));
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => proxyUpgrade(request, socket, head, { failure: validateCameraRequest(request, { websocket: true, allowedHosts }) }));
  await new Promise((done, fail) => { server.once('error', fail); server.listen(CAMERA_PORT, '0.0.0.0', done); });
  // Drop stale IP hosts after network changes; newly added IPs must also be in the certificate.
  const networkTimer = setInterval(() => { const next = cameraHostsForCertificate(certificate); allowedHosts.clear(); for (const host of next) allowedHosts.add(host); }, 10000);
  const stop = () => { clearInterval(networkTimer); server.close(); for (const socket of sockets) socket.destroy(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  console.log(`摄像头 HTTPS：${CAMERA_URL}`);
}

async function main(command) {
  if (command === 'serve') return serve();
  if (command === 'check') {
    const { certificate, ca } = await tlsOptions();
    console.log(JSON.stringify({ cameraUrl: CAMERA_URL, allowedHosts: [...cameraHostsForCertificate(certificate)], subjectAltName: certificate.subjectAltName, expires: certificate.validTo, caFingerprint256: new X509Certificate(ca).fingerprint256, trustChanged: false }, null, 2)); return;
  }
  if (['start', 'status', 'stop'].includes(command)) {
    const { main: manage } = await import('./lan-managed.mjs'); return manage(command);
  }
  throw new Error('Usage: node scripts/camera-https.mjs check|serve|start|status|stop');
}
if (process.argv[1] && resolve(process.argv[1]) === script) main(process.argv[2] ?? 'check').catch(error => { console.error(error.message); process.exitCode = 1; });
