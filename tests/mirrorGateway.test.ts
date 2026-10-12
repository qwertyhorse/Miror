import http, { type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanRequestHandler, validateLanRequest } from '../scripts/lan-preview.mjs';
import { cameraHostsForCertificate, createCameraRequestHandler, validateCameraRequest } from '../scripts/camera-https.mjs';

const mirrorId = 'mirror-12345678-1234-1234-1234-123456789abc';
const credentialsPath = `/v1.1/api/exhibition/mirrors/${mirrorId}/credentials`;
const servers: Server[] = [];
async function listen(handler?: (request: IncomingMessage, response: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); done(); });
  });
  return { server, port: (server.address() as AddressInfo).port };
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  }
});
function rawRequest(port: number, path: string, { method = 'GET', body = '', headers = {} }: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((done, fail) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { content += chunk; });
      response.on('error', fail);
      response.on('end', () => done({ status: response.statusCode ?? 0, headers: response.headers, body: content }));
    });
    request.on('error', fail);
    request.end(body);
  });
}
function guardRequest({ port = 10200, method = 'GET', path = '/v1.1/exhibition/control', headers = {}, remoteAddress = '192.168.1.10' } = {}) {
  return { method, url: path, headers: { host: `xuminghong.local:${port}`, ...headers }, socket: { remoteAddress } };
}

describe('standalone mirror gateway boundaries', () => {
  it('accepts only current local hosts, LAN clients and exact HTTP origins', () => {
    expect(validateLanRequest(guardRequest())).toBeNull();
    expect(validateLanRequest(guardRequest({ headers: { host: '192.168.1.4:10200' } }), '192.168.1.4')).toBeNull();
    for (const headers of [
      { host: 'outside.example:10200' }, { host: '192.168.1.5:10200' }, { host: 'xuminghong.local:10202' },
      { origin: 'http://outside.example:10200' }, { origin: 'https://xuminghong.local:10200' },
    ]) expect(validateLanRequest(guardRequest({ headers }), '192.168.1.4')?.code).toBe(403);
    expect(validateLanRequest(guardRequest({ remoteAddress: '8.8.8.8' }))?.code).toBe(403);
    const write = { method: 'POST', path: `/v1.1/api/exhibition/mirrors/${mirrorId}/command` };
    expect(validateLanRequest(guardRequest(write))?.code).toBe(403);
    expect(validateLanRequest(guardRequest({ ...write, headers: { origin: 'http://xuminghong.local:10200' } }))).toBeNull();
    expect(validateLanRequest(guardRequest({ ...write, headers: { origin: 'http://xuminghong.local:10200', 'sec-fetch-site': 'cross-site' } }))?.code).toBe(403);
    expect(validateLanRequest(guardRequest(), null, true)?.code).toBe(403);
  });

  it('requires certificate coverage, a current local address and the exact HTTPS origin', () => {
    const certificate = { checkHost: (host: string) => host === 'xuminghong.local', checkIP: (host: string) => ['127.0.0.1', '192.168.1.4', '192.168.1.5'].includes(host) };
    const allowedHosts = cameraHostsForCertificate(certificate, { en0: [{ address: '192.168.1.4', family: 'IPv4', internal: false }] });
    expect([...allowedHosts]).toEqual(['xuminghong.local', '127.0.0.1', '192.168.1.4']);
    const request = (headers: Record<string, string> = {}, method = 'GET') => guardRequest({ port: 10202, method, path: credentialsPath, headers });
    expect(validateCameraRequest(request(), { allowedHosts })).toBeNull();
    expect(validateCameraRequest(request({ host: '192.168.1.5:10202' }), { allowedHosts })?.code).toBe(403);
    expect(validateCameraRequest(request({}, 'POST'), { allowedHosts })?.code).toBe(403);
    expect(validateCameraRequest(request({ origin: 'https://xuminghong.local:10202' }, 'POST'), { allowedHosts })).toBeNull();
    for (const origin of ['http://xuminghong.local:10200', 'https://outside.example:10202', 'https://192.168.1.4:10202']) expect(validateCameraRequest(request({ origin }, 'POST'), { allowedHosts })?.code).toBe(403);
    expect(validateCameraRequest(request({ origin: 'https://xuminghong.local:10202', 'sec-fetch-site': 'cross-site' }, 'POST'), { allowedHosts })?.code).toBe(403);
    expect(validateCameraRequest(request(), { allowedHosts, websocket: true })?.code).toBe(403);
  });

  it('blocks encoded HTTP credential writes before they can reach the API', async () => {
    let forwarded = 0;
    const upstream = await listen((_request, response) => { forwarded++; response.end('unexpected'); });
    const gateway = await listen();
    gateway.server.on('request', createLanRequestHandler({ ports: [gateway.port], targetPort: upstream.port }));
    const headers = { origin: `http://127.0.0.1:${gateway.port}`, 'content-type': 'application/json' };
    for (const path of [credentialsPath, credentialsPath.replace('/credentials', '/%63redentials'), `${credentialsPath}%2f`, `${credentialsPath}/`]) {
      const response = await rawRequest(gateway.port, path, { method: 'POST', headers, body: '{"apiKey":"test-only"}' });
      expect(response.status, path).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(forwarded).toBe(0);
  });

  it('rejects malformed or encoded version paths and main-site API routes', () => {
    for (const path of ['//outside.example/path', '/v1.1/\\other', '/v1.1/%5cother', '/v1.1/%zz', '/v1.1/%00']) {
      expect(validateLanRequest(guardRequest({ path }))?.code, path).toBe(400);
      expect(validateCameraRequest(guardRequest({ port: 10202, path }))?.code, path).toBe(400);
    }
    for (const path of ['/%761.1/api/exhibition/mirrors', '/v1.1%2fapi/exhibition/mirrors', '/api/exhibition/mirrors', '/v1.0/exhibition', '/v1.1/api/settings/api-key', '/v1.1/api%2fsettings/api-key']) {
      expect(validateLanRequest(guardRequest({ path }))?.code, path).toBe(404);
      expect(validateCameraRequest(guardRequest({ port: 10202, path }))?.code, path).toBe(404);
    }
  });

  it('redirects HTTP and camera roots with the full mirror query and no cache', async () => {
    const query = `?mirror=${mirrorId}&view=camera`;
    const lan = await listen();
    lan.server.on('request', createLanRequestHandler({ ports: [lan.port] }));
    // HTTP transport isolates the HTTPS handler from local certificate trust setup.
    const camera = await listen();
    camera.server.on('request', createCameraRequestHandler({ port: camera.port }));
    for (const [port, destination] of [[lan.port, '/v1.1/exhibition/control'], [camera.port, '/v1.1/exhibition/screen']] as const) {
      const response = await rawRequest(port, `/${query}`);
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(destination + query);
      expect(response.headers['cache-control']).toBe('no-store');
      expect((await rawRequest(port, '/v1.1/api/settings/api-key')).status).toBe(404);
    }
  });

  it('proxies secure credentials with body, rewritten Host and Origin, and no forwarded identity', async () => {
    const seen: Array<{ url?: string; body: string; headers: http.IncomingHttpHeaders }> = [];
    const ordinary = await listen((_request, response) => { response.writeHead(418); response.end(); });
    const credentials = await listen((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        seen.push({ url: request.url, body, headers: request.headers });
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public,max-age=600', 'strict-transport-security': 'max-age=100' });
        response.end('{"saved":true}');
      });
    });
    const gateway = await listen();
    gateway.server.on('request', createCameraRequestHandler({ port: gateway.port, targetPort: ordinary.port, credentialsPort: credentials.port }));
    const origin = `https://127.0.0.1:${gateway.port}`;
    const path = `${credentialsPath}?request=mirror%20test`;
    const body = '{"apiKey":"test-only","region":"international"}';
    const response = await rawRequest(gateway.port, path, { method: 'POST', body, headers: { origin, 'content-type': 'application/json', cookie: 'device=test-only', 'x-forwarded-for': '8.8.8.8', forwarded: 'for=8.8.8.8' } });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ saved: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['strict-transport-security']).toBeUndefined();
    expect(response.headers['permissions-policy']).toBe('camera=(self), microphone=(), geolocation=()');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(path);
    expect(seen[0].body).toBe(body);
    expect(seen[0].headers.host).toBe(`127.0.0.1:${credentials.port}`);
    expect(seen[0].headers.origin).toBe(`http://127.0.0.1:${credentials.port}`);
    expect(seen[0].headers.cookie).toBe('device=test-only');
    expect(seen[0].headers['x-forwarded-for']).toBeUndefined();
    expect(seen[0].headers.forwarded).toBeUndefined();
    expect((await rawRequest(gateway.port, path, { method: 'POST', body, headers: { origin: `http://127.0.0.1:${gateway.port}` } })).status).toBe(403);
    expect(seen).toHaveLength(1);
  });
});
