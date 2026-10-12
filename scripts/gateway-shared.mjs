import http from 'node:http';

export const HOP_HEADERS = new Set(['connection', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
export const HOSTNAME = 'xuminghong.local';
export const WEB_PORT = 5173;
export const HTTP_PORT = 10200;
export const HTTP_COMPAT_PORT = 10201;
export const EXHIBITION_PORT = 10601;
export const CAMERA_PORT = 10202;

export function isPrivateAddress(address = '') {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  if (ip === '::1' || /^(?:fc|fd)[0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip)) return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (parts.some(value => value < 0 || value > 255)) return false;
  return parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 169 && parts[1] === 254);
}

export function requestPath(request, origin) {
  if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) return null;
  try {
    const rawPath = new URL(request.url, origin).pathname;
    const path = decodeURIComponent(rawPath);
    if (path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)) return null;
    return { rawPath, path };
  } catch { return null; }
}

export function proxyHeaders(request, websocket = false, targetHost = `127.0.0.1:${WEB_PORT}`) {
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())));
  headers.host = targetHost;
  if (headers.origin) headers.origin = `http://${targetHost}`;
  if (websocket) { headers.connection = 'Upgrade'; headers.upgrade = request.headers.upgrade; }
  return headers;
}

export function reject(response, code, message) {
  response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(message + '\n');
}

export function proxyRequest(request, response, { targetPort = WEB_PORT, targetHost = `127.0.0.1:${targetPort}`, protocol = 'http', camera = false, responseHeaders = {} } = {}) {
  const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: request.url, method: request.method, headers: proxyHeaders(request, false, targetHost) }, incoming => {
    const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== 'strict-transport-security'));
    headers['cache-control'] = 'no-store';
    headers['x-content-type-options'] = 'nosniff';
    if (camera) headers['permissions-policy'] = 'camera=(self), microphone=(), geolocation=()';
    Object.assign(headers, responseHeaders);
    if (typeof headers.location === 'string' && headers.location.startsWith(`http://${targetHost}/`)) {
      headers.location = headers.location.replace(`http://${targetHost}`, `${protocol}://${request.headers.host}`);
    }
    response.writeHead(incoming.statusCode ?? 502, headers);
    incoming.on('error', () => response.destroy());
    incoming.pipe(response);
  });
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else reject(response, 502, '智能镜服务暂时未连接。');
  });
  request.on('aborted', () => upstream.destroy());
  request.on('error', () => upstream.destroy());
  response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
}

export function proxyUpgrade(request, socket, head, { failure, targetPort = WEB_PORT } = {}) {
  if (failure) { socket.end(`HTTP/1.1 ${failure.code} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: request.url, method: 'GET', headers: proxyHeaders(request, true, `127.0.0.1:${targetPort}`) });
  upstream.on('upgrade', (response, connection, upstreamHead) => {
    const lines = [];
    for (let index = 0; index < response.rawHeaders.length; index += 2) lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) connection.write(head);
    socket.on('error', () => connection.destroy());
    connection.on('error', () => socket.destroy());
    socket.on('close', () => connection.destroy());
    connection.on('close', () => socket.destroy());
    socket.pipe(connection).pipe(socket);
  });
  upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
}
