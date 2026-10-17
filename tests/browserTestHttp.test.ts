import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import sharp from 'sharp';
import { createApiServer } from '../server/http.ts';
import { createMaterialPreparationQueue } from '../server/materialPreparation.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { TryOnService } from '../server/service.ts';
import { MirrorCredentialStore } from '../server/mirrorCredentials.ts';
import { ReferenceAssets } from '../server/referenceAssets.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { KeyStatus, Provider } from '../server/types.ts';
import type { ExhibitionMirrorSummary, ExhibitionState } from '../shared/exhibition.ts';
import { createStaticRequestHandler } from '../scripts/static-web.mjs';
import { createCameraRequestHandler } from '../scripts/camera-https.mjs';
import { BROWSER_TEST_IDLE_MS, BROWSER_TEST_TTL_MS } from '../server/browserTests.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const origin = 'https://xuminghong.local:10202';
const sourceKey = 'uk-isolated-browser-test-source';
const defaultKey = 'uk-isolated-browser-test-default';
const rootPath = (id = 'default') => `/api/exhibition/mirrors/${id}`;
function address(server: Server) { return (server.address() as { port: number }).port; }
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { const closing = once(server, 'close'); server.closeAllConnections(); server.close(); await closing; });
  return server;
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mirror-browser-http-'));
  let now = Date.now();
  const store = new SessionStore(':memory:');
  cleanups.push(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const secrets = new SecretBox(randomBytes(32));
  const credentials = new MirrorCredentialStore(directory, secrets);
  const keys = new Map<string, KeyStatus>();
  const issue = vi.fn(async (key: string, credits: number, seconds: number) => {
    const token = `tk-browser-http-${keys.size + 1}`; const expiresAt = new Date(now + seconds * 1000).toISOString();
    keys.set(token, { status: 'active', consumedCredit: 0, expireTimestamp: expiresAt });
    return { token, expiresAt };
  });
  const revoke = vi.fn(async (_key: string, token: string) => {
    const value = { ...keys.get(token)!, status: 'inactive' as const }; keys.set(token, value); return value;
  });
  const provider = (key: string): Provider => ({ configured: true, region: 'global', credentialSnapshot: () => key,
    issueKey: (credits, seconds) => issue(key, credits, seconds), keyStatus: async token => keys.get(token)!,
    deactivate: token => revoke(key, token), sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'ACTIVE', consumedCredit: 0 }) });
  const upload = vi.fn(async () => 'https://fixture-123.cos.ap-test.myqcloud.com/browser-test.png');
  const storage = vi.fn(() => ({ upload, check: async () => true }));
  const service = new TryOnService({ provider: provider(defaultKey), providerForApiKey: provider, store, secrets, mirrorCredentials: credentials,
    referenceAssets: new ReferenceAssets(directory), referenceStorage: storage, resolveHost: async () => ['93.184.216.34'] });
  credentials.save('default', sourceKey, 0);
  const mirrors = new ExhibitionMirrors(directory, { now: () => now });
  const allowedOrigins = [origin, 'http://127.0.0.1:5173'];
  const server = await listen(createApiServer(service, allowedOrigins, undefined, mirrors));
  const base = `http://127.0.0.1:${address(server)}`;
  const request = (path: string, input?: unknown, options: { cookie?: string; method?: string; origin?: string; signal?: AbortSignal } = {}) => fetch(base + path, {
    method: options.method ?? (input === undefined ? 'GET' : 'POST'), signal: options.signal,
    headers: { Origin: options.origin ?? origin, 'X-Miror-Protocol': '2', 'X-Miror-Material': 'catalog-v2', 'Content-Type': 'application/json', ...(options.cookie ? { Cookie: options.cookie } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const source = mirrors.getMirror();
  source.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
  async function create() {
    const response = await request(rootPath() + '/browser-tests', {}); expect(response.status).toBe(201);
    const result = await response.json() as { mirror: ExhibitionMirrorSummary; expiresAt: number };
    expect(result).not.toHaveProperty('token');
    const setCookie = response.headers.get('set-cookie')!; const cookie = setCookie.split(';')[0];
    return { ...result, cookie, setCookie, path: rootPath(result.mirror.id), token: cookie.slice(cookie.indexOf('=') + 1) };
  }
  return { directory, mirrors, source, service, store, credentials, issue, revoke, upload, storage, server, allowedOrigins, request, create,
    advance: (milliseconds: number) => { now += milliseconds; }, now: () => now };
}
async function start(f: Awaited<ReturnType<typeof fixture>>, test: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['create']>>) {
  const context = f.mirrors.browserTests.resolve(test.mirror.id, test.token);
  await context.exhibition.prepareReference(context.exhibition.read().selectedLookId ?? context.exhibition.read().looks.find(look => look.mode === context.exhibition.read().experienceMode)!.id);
  const begun = await f.request(test.path + '/command', { action: 'begin' }, test); expect(begun.status).toBe(200);
  const state = await begun.json() as ExhibitionState;
  const response = await f.request(test.path + '/live/session', { deviceId: 'isolated-browser', lookId: state.selectedLookId, generationNumber: state.generationNumber }, test);
  expect(response.status).toBe(201); return response.json();
}

describe('isolated browser test HTTP context', () => {
  it('renews the scoped cookie and server lease while active, but does not renew invalid or idle contexts', async () => {
    const f = await fixture(); const test = await f.create();
    const end = f.now() + BROWSER_TEST_TTL_MS + BROWSER_TEST_IDLE_MS;
    while (f.now() < end) {
      f.advance(BROWSER_TEST_IDLE_MS - 1);
      const response = await f.request(test.path + '/browser-test', undefined, test);
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toBe(test.setCookie);
      expect((await response.json()).expiresAt).toBe(f.now() + BROWSER_TEST_TTL_MS);
      await f.mirrors.sweepLive();
    }
    const invalid = await f.request(test.path + '/browser-test', undefined, { cookie: 'miror_browser_test=' + '0'.repeat(64) });
    expect(invalid.status).toBe(401); expect(invalid.headers.get('set-cookie')).toBeNull();
    f.advance(BROWSER_TEST_IDLE_MS);
    const expired = await f.request(test.path + '/browser-test', undefined, test);
    expect(expired.status).toBe(410); expect(expired.headers.get('set-cookie')).toBeNull();
    await f.mirrors.sweepLive();
    const closed = await f.request(test.path + '/browser-test/close', {}, test);
    expect(closed.status).toBe(200); expect(closed.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('automatically makes an upload available in an already-open test and wakes its change feed', async () => {
    const f = await fixture(); const test = await f.create();
    const queue = createMaterialPreparationQueue(f.mirrors, f.service, f.now);
    const imageBase64 = (await sharp({ create: { width: 512, height: 512, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64');
    const uploadResponse = await f.request(rootPath() + '/looks', { name: 'Automatic upload', mode: 'clothx', imageBase64, referenceImageBase64: imageBase64 });
    expect(uploadResponse.status, await uploadResponse.clone().text()).toBe(201);
    const uploaded = await uploadResponse.json() as ExhibitionState; const look = uploaded.looks[0]!;
    expect(uploaded.enabledLookIds).toContain(look.id);
    const before = await (await f.request(test.path, undefined, test)).json() as ExhibitionState;
    expect(before.catalog!.availableLookIds).not.toContain(look.id);
    const changed = f.request(test.path + '/changes?after=' + before.revision, undefined, test);
    for (let i = 0; i < uploaded.looks.length + 2; i++) await queue.runOnce();
    const notified = await (await changed).json() as ExhibitionState;
    expect(notified.revision).toBeGreaterThan(before.revision);
    const latest = await (await f.request(test.path, undefined, test)).json() as ExhibitionState;
    expect(latest.catalog!.availableLookIds).toContain(look.id);
    const source = f.source.read();
    expect(latest.catalog!.looks.find(row => row.id === look.id)).toEqual(source.catalog!.looks.find(row => row.id === look.id));
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.upload).toHaveBeenCalled();
  });

  it('creates an independent experience behind a scoped secure cookie without changing the real mirror or registering a terminal', async () => {
    const f = await fixture();
    const device = { terminalId: `terminal-${randomUUID()}`, token: randomBytes(32).toString('hex'), label: '真实镜端', platform: 'android' };
    const connected = f.mirrors.connectDevice(device); f.mirrors.bindDevice('default', { code: connected.code });
    await f.source.prepareReference('commute');
    const before = f.source.read(); const registry = f.mirrors.list();
    const test = await f.create();
    expect(test.mirror.id).toMatch(/^test-[a-f0-9-]{36}$/); expect(test.mirror.binding).toBeNull();
    expect(test.expiresAt).toBe(f.now() + 3_600_000);
    expect(test.setCookie).toContain(`Path=/v1.1/api/exhibition/mirrors/${test.mirror.id}`);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=3600']) expect(test.setCookie).toContain(flag);
    expect(JSON.stringify(test.mirror)).not.toContain(test.token);
    expect(f.mirrors.list()).toEqual(registry); expect(f.source.read()).toEqual(before); expect(f.issue).not.toHaveBeenCalled();
    expect(() => f.mirrors.getMirror(test.mirror.id)).toThrow();
    expect(await (await f.request(test.path + '/browser-test', undefined, test)).json()).toMatchObject({ mirror: test.mirror, expiresAt: test.expiresAt });
    expect((await f.request(test.path)).status).toBe(401);
    const other = await f.create(); expect((await f.request(test.path, undefined, other)).status).toBe(401);
    expect((await f.request(test.path, undefined, { cookie: `${test.cookie}; ${test.cookie}` })).status).toBe(401);
    const session = await start(f, test); expect(session.exhibition.mirrorId).toBe(test.mirror.id);
    expect(f.issue).toHaveBeenCalledWith(sourceKey, 3000, 120); expect(f.source.read()).toEqual(before);
  });

  it('keeps origin protection and rejects every administration route and command for a test context', async () => {
    const f = await fixture();
    expect((await f.request(rootPath() + '/browser-tests', {}, { origin: 'https://foreign.example' })).status).toBe(403);
    expect((await f.request(rootPath() + '/browser-tests', { apiKey: 'not-accepted' })).status).toBe(400);
    const test = await f.create(); const before = await (await f.request(test.path, undefined, test)).json();
    const denied: [string, string, unknown?][] = [
      ['GET', '/credentials'], ['PUT', '/credentials', { apiKey: 'not-accepted' }], ['PATCH', '', { name: 'not-accepted' }], ['DELETE', '', {}],
      ['POST', '/copy', {}], ['POST', '/looks/copy', {}], ['POST', '/binding', {}], ['DELETE', '/binding', {}], ['GET', '/camera'], ['POST', '/camera', {}],
      ['POST', '/looks', {}], ['PATCH', '/looks/commute', {}], ['DELETE', '/looks/commute', {}], ['POST', '/taxonomy', {}], ['POST', '/skin', {}], ['DELETE', '/skin', {}],
      ['POST', '/browser-tests', {}], ['POST', '/command', { action: 'configure', providerMode: 'demo' }], ['POST', '/command', { action: 'reorder', lookIds: [] }],
    ];
    for (const [method, path, input] of denied) {
      const response = await f.request(test.path + path, input, { ...test, method });
      expect(response.status, `${method} ${path}`).toBe(403); expect(await response.json()).toMatchObject({ code: 'BROWSER_TEST_OPERATION_FORBIDDEN' });
    }
    expect((await f.request(test.path + '/command', { action: 'begin' }, { ...test, origin: 'https://foreign.example' })).status).toBe(403);
    expect(await (await f.request(test.path, undefined, test)).json()).toEqual(before); expect(f.issue).not.toHaveBeenCalled();
  });

  it('reads source assets without copying while keeping test routes authenticated', async () => {
    const f = await fixture();
    const image = async (color: string) => (await sharp({ create: { width: 512, height: 512, channels: 3, background: color } }).png().toBuffer()).toString('base64');
    const uploaded = await f.source.upload({ name: '双图隔离', mode: 'clothx', imageBase64: await image('red'), referenceImageBase64: await image('blue') });
    const look = uploaded.looks[0]!;
    await f.source.prepareReference(look.id);
    f.source.command({ action: 'configure', enabledLookIds: [look.id] });
    const test = await f.create(); const state = await (await f.request(test.path, undefined, test)).json() as ExhibitionState;
    const copied = state.looks.find(row => row.name === look.name)!;
    expect(copied.image).toBe(look.image); expect(copied.referenceImage).toBe(look.referenceImage);
    const display = await f.request(copied.image, undefined, test); const reference = await f.request(copied.referenceImage!, undefined, test);
    expect(display.status).toBe(200); expect(reference.status).toBe(200);
    expect(Buffer.from(await display.arrayBuffer())).not.toEqual(Buffer.from(await reference.arrayBuffer()));
    expect((await f.request(test.path + `/assets/${copied.id}/reference/${copied.referenceImage!.split('/').at(-1)}`)).status).toBe(401);
    expect((await f.request(copied.referenceImage!, undefined, { ...test, method: 'HEAD' })).status).toBe(200);
    const prepared = await f.request(test.path + `/references/${copied.id}`, {}, test); expect(prepared.status).toBe(200);
    expect((await prepared.json()).reference).toMatchObject({ scope: expect.any(String), sha256: expect.any(String) });
    expect(f.storage).toHaveBeenCalledWith(sourceKey, 'global'); const uploadCount = f.upload.mock.calls.length; expect(uploadCount).toBeGreaterThan(0);
    expect((await f.request(test.path + `/references/${copied.id}`, undefined, test)).status).toBe(200);
    expect((await f.request(test.path + '/references', undefined, test)).status).toBe(200); expect(f.upload).toHaveBeenCalledTimes(uploadCount);
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('routes session reads, links, first frames and stopping through the isolated service and rejects foreign session IDs', async () => {
    const f = await fixture();
    await f.source.prepareReference(f.source.read().selectedLookId ?? 'commute');
    const running = f.source.command({ action: 'begin' });
    const realSession = await f.source.createLiveSession({ deviceId: 'real-screen', lookId: running.selectedLookId, generationNumber: running.generationNumber });
    const realState = f.source.read();
    const test = await f.create(); const session = await start(f, test);
    const other = await f.create(); const otherSession = await start(f, other);
    const context = f.mirrors.browserTests.resolve(test.mirror.id, test.token);
    const sessionMethods = ['assertSessionMirror', 'get', 'stop', 'link', 'firstFrame'] as const;
    const spies = sessionMethods.map(method => vi.spyOn(context.service, method));
    const rootSpies = sessionMethods.map(method => vi.spyOn(f.service, method));
    const foreign = await f.request(test.path + `/sessions/${otherSession.id}`, undefined, test);
    expect(foreign.status).toBe(409); expect(await foreign.json()).toMatchObject({ code: 'EXHIBITION_MIRROR_MISMATCH' });
    expect((await f.request(test.path + `/sessions/${session.id}`, undefined, test)).status).toBe(200);
    expect((await f.request(test.path + `/live/session/${session.id}/reference`, { deviceId: 'isolated-browser', lookId: session.exhibition.lookId, bindingId: context.exhibition.readyReference(session.exhibition.lookId, true)!.bindingId }, test)).status).toBe(409);
    expect((await f.request(test.path + `/sessions/${session.id}/link`, { providerSessionId: 'ums-browser-test-fixture' }, test)).status).toBe(200);
    expect((await f.request(test.path + `/sessions/${session.id}/first-frame`, { firstFrameMs: 100 }, test)).status).toBe(200);
    expect((await f.request(test.path + '/live/heartbeat', { deviceId: 'isolated-browser', sessionId: session.id }, test)).status).toBe(200);
    expect((await f.request(test.path + '/live/status', undefined, test)).status).toBe(200);
    expect((await f.request(test.path + '/diagnostics', undefined, test)).status).toBe(200);
    expect((await f.request(test.path + `/sessions/${session.id}/stop`, {}, test)).status).toBe(200);
    for (const spy of spies) expect(spy).toHaveBeenCalled();
    for (const spy of rootSpies) expect(spy).not.toHaveBeenCalled();
    expect(f.store.get(session.id).status).toBe('stopped'); expect(f.store.get(otherSession.id).status).toBe('active');
    expect(f.store.get(realSession.id).status).toBe('active'); expect(f.source.read()).toEqual(realState);
  });

  it('keeps a failed close authenticated for retry and removes the cookie only after revocation succeeds', async () => {
    const f = await fixture(); const test = await f.create(); const session = await start(f, test);
    f.revoke.mockRejectedValueOnce(new Error('isolated stop outage'));
    const failed = await f.request(test.path + '/browser-test/close', {}, test);
    expect(failed.status).toBe(409); expect(failed.headers.get('set-cookie')).toBeNull();
    expect(f.store.get(session.id).status).not.toBe('stopped');
    expect((await f.request(test.path, undefined, test)).status).toBe(410);
    const retry = await f.request(test.path + '/browser-test/close', {}, test);
    expect(retry.status).toBe(200); expect(await retry.json()).toEqual({ closed: true });
    expect(retry.headers.get('set-cookie')).toContain('Max-Age=0'); expect(retry.headers.get('set-cookie')).toContain(`Path=/v1.1/api/exhibition/mirrors/${test.mirror.id}`);
    expect(f.store.get(session.id).status).toBe('stopped');
    expect((await f.request(test.path + '/browser-test/close', {}, test)).status).toBe(200);
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.mirrors.list().mirrors).toHaveLength(1);
  });

  it('expires through the registry watchdog and wakes an authenticated long poll when the test closes', async () => {
    const f = await fixture(); const test = await f.create();
    const context = f.mirrors.browserTests.resolve(test.mirror.id, test.token); const subscribed = vi.spyOn(context.exhibition, 'subscribe');
    const waiting = f.request(test.path + `/changes?after=${context.exhibition.read().revision}`, undefined, test);
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce());
    expect((await f.request(test.path + '/browser-test/close', {}, test)).status).toBe(200);
    expect((await waiting).status).toBe(410);
    const next = await f.create(); await start(f, next); f.advance(3_600_001);
    await f.mirrors.sweepLive();
    expect((await f.request(next.path, undefined, next)).status).toBe(410);
    expect(f.store.list().every(row => row.status === 'stopped')).toBe(true);
    expect(f.source.read().live).toBeNull();
  });

  it('passes the cookie unchanged through the camera and static API proxies', async () => {
    const f = await fixture();
    const web = await listen(createServer(createStaticRequestHandler({ distDirectory: f.directory, apiPort: address(f.server) })));
    f.allowedOrigins.push(`http://127.0.0.1:${address(web)}`);
    const gateway = await listen(createServer());
    const port = address(gateway); gateway.on('request', createCameraRequestHandler({ port, targetPort: address(web), allowedHosts: new Set(['127.0.0.1']) }));
    const headers = { Origin: `https://127.0.0.1:${port}`, 'Content-Type': 'application/json' };
    const base = `http://127.0.0.1:${port}/v1.1`;
    const response = await fetch(base + rootPath() + '/browser-tests', { method: 'POST', headers, body: '{}' });
    expect(response.status, response.ok ? '' : await response.clone().text()).toBe(201); const test = await response.json(); const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain(`Path=/v1.1/api/exhibition/mirrors/${test.mirror.id}`); expect(setCookie).toContain('Secure');
    const read = await fetch(base + rootPath(test.mirror.id) + '/browser-test', { headers: { ...headers, Cookie: setCookie.split(';')[0] } });
    expect(read.status).toBe(200); expect((await read.json()).mirror.id).toBe(test.mirror.id);
  });
});
