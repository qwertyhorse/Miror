import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOP_HEADERS, WEB_PORT, reject, requestPath } from './gateway-shared.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(import.meta.url);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wasm': 'application/wasm',
};
const forbiddenDirectories = new Set(['src', 'server', 'scripts', 'shared', 'tests', 'node_modules']);
const within = (directory, file) => { const path = relative(directory, file); return path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep); };

function proxyApi(request, response, apiPort) {
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())));
  headers.host = `127.0.0.1:${apiPort}`;
  // Keep the incoming same-origin Origin: the LAN gateways already rewrote it
  // to this loopback web origin, which the API explicitly accepts.
  const upstream = http.request({ hostname: '127.0.0.1', port: apiPort, method: request.method,
    path: request.url.replace(/^\/v1\.1(?=\/)/, ''), headers }, incoming => {
    const incomingHeaders = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())));
    incomingHeaders['cache-control'] = 'no-store';
    incomingHeaders['x-content-type-options'] = 'nosniff';
    response.writeHead(incoming.statusCode ?? 502, incomingHeaders);
    incoming.on('error', () => response.destroy());
    incoming.pipe(response);
  });
  upstream.on('error', () => { if (response.headersSent) response.destroy(); else reject(response, 502, '智能镜 API 暂时未连接。'); });
  request.on('aborted', () => upstream.destroy());
  request.on('error', () => upstream.destroy());
  response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
}

export function createStaticRequestHandler({ distDirectory = resolve(root, 'dist'), apiPort = 3002,
  caPath = resolve(root, '.data/lan-tls/root-ca.crt') } = {}) {
  const directory = resolve(distDirectory);
  async function fileInfo(file) {
    try {
      const [actualDirectory, actualFile, info] = await Promise.all([realpath(directory), realpath(file), stat(file)]);
      return info.isFile() && within(actualDirectory, actualFile) ? { actualFile, info } : null;
    } catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return null; throw error; }
  }
  return (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    void (async () => {
      const parsed = requestPath(request, 'http://127.0.0.1');
      if (!parsed) { reject(response, 400, '无效请求路径。'); return; }
      if (parsed.path === '/__static_health' && ['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ gateway: 'mirror-static', version: '1.1' })); return;
      }
      if (['/openbuy-local-ca.crt', '/v1.1/openbuy-local-ca.crt'].includes(parsed.path)) {
        if (!['GET', 'HEAD'].includes(request.method)) { reject(response, 405, '此资源只支持读取。'); return; }
        // Never serve a stale CA copied into dist, and never expose its key.
        let ca;
        try { ca = await readFile(caPath); } catch (error) { if (error.code === 'ENOENT') { reject(response, 404, '请先运行 npm run setup 生成本机证书。'); return; } throw error; }
        response.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="openbuy-local-ca.crt"', 'Content-Length': ca.length });
        response.end(request.method === 'HEAD' ? undefined : ca); return;
      }
      if (!/^\/v1\.1(?:\/|$)/.test(parsed.path) || !/^\/v1\.1(?:\/|$)/.test(parsed.rawPath)) { reject(response, 404, '未找到智能镜页面。'); return; }
      if (/^\/v1\.1\/api(?:\/|$)/.test(parsed.path)) { proxyApi(request, response, apiPort); return; }
      if (!['GET', 'HEAD'].includes(request.method)) { reject(response, 405, '此资源只支持读取。'); return; }
      const local = parsed.path.replace(/^\/v1\.1\/?/, '');
      const segments = local.split('/');
      if (segments.some(part => part.startsWith('.') || forbiddenDirectories.has(part)) || /\.(?:map|ts|tsx|jsx|key|pem|sqlite|db)$/i.test(local)) { reject(response, 404, '未找到资源。'); return; }
      let file = await fileInfo(resolve(directory, local || 'index.html'));
      // Missing assets must return 404; only extensionless page routes fall back.
      if (!file && !extname(local) && segments[0] !== 'assets') file = await fileInfo(resolve(directory, 'index.html'));
      if (!file) { reject(response, 404, '未找到资源。'); return; }
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(file.actualFile).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': file.info.size });
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = createReadStream(file.actualFile);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    })().catch(error => { console.error(`静态资源读取失败：${error.code ?? error.message}`); if (response.headersSent) response.destroy(); else reject(response, 500, '资源暂时不可用。'); });
  };
}

export async function serve() {
  await stat(resolve(root, 'dist/index.html')).catch(() => { throw new Error('缺少预构建前端 dist/index.html。请使用完整交付包，或先运行 npm run build。'); });
  const server = http.createServer(createStaticRequestHandler());
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(WEB_PORT, '127.0.0.1', () => { server.removeListener('error', fail); done(); }); });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
  function stop() { server.close(); for (const socket of sockets) socket.destroy(); }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  console.log(`预构建前端已就绪（内部端口 ${WEB_PORT}）。`);
}

if (process.argv[1] && resolve(process.argv[1]) === script) serve().catch(error => { console.error(error.message); process.exitCode = 1; });
