import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApiServer } from '../server/http.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { IssuedKey, KeyStatus, Provider } from '../server/types.ts';

const resources: { server: Server; store: SessionStore; directory: string }[] = [];
const origin = 'http://127.0.0.1:5173';
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}
afterEach(async () => {
  for (const { server, store, directory } of resources.splice(0)) {
    const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
    store.close(); await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const now = Date.now();
  const expiresAt = new Date(now + 120_000).toISOString();
  const inactive: KeyStatus = { status: 'inactive', consumedCredit: 1, expireTimestamp: expiresAt };
  const directory = await mkdtemp(join(tmpdir(), 'openbuy-continuous-switch-http-'));
  const store = new SessionStore(':memory:');
  let issued = 0;
  const issue = vi.fn(async (): Promise<IssuedKey> => ({ token: `tk-isolated-continuous-switch-${++issued}`, expiresAt }));
  const deactivate = vi.fn(async (_token: string): Promise<KeyStatus> => inactive);
  const provider: Provider = { configured: true, issueKey: issue, deactivate,
    keyStatus: async () => ({ status: 'active', consumedCredit: 1, expireTimestamp: expiresAt }),
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'active', consumedCredit: 1 }) };
  const service = new LifecycleTryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)) });
  const mirrors = new ExhibitionMirrors(directory, { now: () => now });
  const mirror = mirrors.getMirror(); mirrors.attachLiveService(service);
  mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
  mirror.command({ action: 'begin' });
  const server = createApiServer(service, undefined, undefined, mirrors);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  resources.push({ server, store, directory });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors/default`;
  const post = (path: string, input: unknown) => fetch(base + path, { method: 'POST',
    headers: { origin, 'X-Miror-Protocol': '2', 'X-Miror-Material': 'catalog-v2', 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(1_500) });
  const get = (path = '') => fetch(base + path, { signal: AbortSignal.timeout(1_500) });
  const start = (lookId = mirror.get().selectedLookId, generationNumber = mirror.get().generationNumber) =>
    post('/live/session', { deviceId: 'continuous-http-screen', lookId, generationNumber });
  return { mirror, service, store, issue, deactivate, inactive, expiresAt, post, get, start };
}

describe('continuous material switching over HTTP', () => {
  it('accepts B then C while stopping A, responds to reads, and signs only the final C after A stops', async () => {
    const f = await fixture(); const original = await (await f.start()).json();
    f.mirror.liveFirstFrame(original.id, 100);
    const stopping = deferred<KeyStatus>(); const entered = deferred<void>();
    f.deactivate.mockImplementationOnce(() => { entered.resolve(); return stopping.promise; });

    const middleResponse = await f.post('/command', { action: 'switch', lookId: 'city' });
    expect(middleResponse.status).toBe(200); const middle = await middleResponse.json(); await entered.promise;
    expect(middle).toMatchObject({ phase: 'generating', selectedLookId: 'city', displayedLookId: 'commute', live: { sessionId: original.id, status: 'stopping' } });
    const latestResponse = await f.post('/command', { action: 'switch', lookId: 'evening' });
    expect(latestResponse.status).toBe(200); const latest = await latestResponse.json();
    expect(latest).toMatchObject({ selectedLookId: 'evening', generationNumber: middle.generationNumber + 1, live: { sessionId: original.id, status: 'stopping' } });
    expect(await (await f.post('/command', { action: 'switch', lookId: 'evening' })).json()).toEqual(latest);
    expect(await (await f.get()).json()).toEqual(latest);
    expect(await (await f.get('/live/status')).json()).toMatchObject({ live: { sessionId: original.id, status: 'stopping' } });

    const creating = vi.spyOn(f.mirror, 'createLiveSession');
    const middleStart = f.start('city', middle.generationNumber);
    const latestStart = f.start('evening', latest.generationNumber);
    await vi.waitFor(() => expect(creating).toHaveBeenCalledTimes(2));
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).toHaveBeenCalledOnce();
    expect(f.store.list()).toHaveLength(1); expect(f.store.get(original.id).status).toBe('stopping');

    stopping.resolve(f.inactive);
    const stale = await middleStart; expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'EXHIBITION_STALE_GENERATION' } });
    const final = await latestStart; expect(final.status).toBe(201); const session = await final.json();
    expect(session.exhibition).toMatchObject({ lookId: 'evening', generationNumber: latest.generationNumber });
    expect(f.store.get(original.id).status).toBe('stopped'); expect(f.issue).toHaveBeenCalledTimes(2);
    expect(f.store.list().map(record => record.exhibition!.lookId)).toEqual(['commute', 'evening']);
    f.mirror.liveFirstFrame(original.id, 500);
    expect(f.mirror.get()).toMatchObject({ phase: 'generating', selectedLookId: 'evening', live: { sessionId: session.id } });
  });

  it('keeps the old lease after failed revocation and continues accepting next and previous choices', async () => {
    const f = await fixture(); const original = await (await f.start()).json();
    f.deactivate.mockRejectedValue(new Error('isolated revocation outage'));
    const next = await f.post('/command', { action: 'next' }); expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ phase: 'generating', selectedLookId: 'city' });
    await f.mirror.reconcileLive();
    const previous = await f.post('/command', { action: 'previous' }); expect(previous.status).toBe(200);
    expect(await previous.json()).toMatchObject({ phase: 'generating', selectedLookId: 'commute' });
    const final = await f.post('/command', { action: 'switch', lookId: 'evening' }); expect(final.status).toBe(200);
    const blocked = await f.start(); expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: 'EXHIBITION_DEVICE_BUSY' } });
    expect(f.mirror.get()).toMatchObject({ phase: 'generating', selectedLookId: 'evening', live: { sessionId: original.id, status: 'error' } });
    expect(f.store.get(original.id).status).toBe('stopping'); expect(f.issue).toHaveBeenCalledOnce();
  });

  it('still waits for explicit end confirmation while allowing reads of the pending stop', async () => {
    const f = await fixture(); const original = await (await f.start()).json();
    const stopping = deferred<KeyStatus>(); const entered = deferred<void>();
    f.deactivate.mockImplementationOnce(() => { entered.resolve(); return stopping.promise; });
    let confirmed = false;
    const ending = f.post('/command', { action: 'end' }).then(response => { confirmed = true; return response; });
    await entered.promise;
    expect(await (await f.get()).json()).toMatchObject({ phase: 'select', live: { sessionId: original.id, status: 'stopping' } });
    expect(await (await f.get('/live/status')).json()).toMatchObject({ live: { sessionId: original.id, status: 'stopping' } });
    expect(confirmed).toBe(false);
    const blocked = await f.post('/command', { action: 'begin' }); expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: 'EXHIBITION_LIVE_STOP_PENDING' } });
    stopping.resolve(f.inactive);
    const ended = await ending; expect(ended.status).toBe(200); expect(await ended.json()).toMatchObject({ phase: 'select', live: null });
    expect(f.store.get(original.id).status).toBe('stopped'); expect(f.issue).toHaveBeenCalledOnce();
  });

  it('revokes a late A credential after B and C selections without signing B', async () => {
    const f = await fixture(); const issuing = deferred<IssuedKey>(); const entered = deferred<void>();
    f.issue.mockImplementationOnce(() => { entered.resolve(); return issuing.promise; });
    const originalStart = f.start(); await entered.promise;
    const originalId = f.mirror.get().live!.sessionId!;
    expect((await f.post('/command', { action: 'switch', lookId: 'city' })).status).toBe(200);
    expect((await f.post('/command', { action: 'switch', lookId: 'evening' })).status).toBe(200);
    const blocked = await f.start(); expect(blocked.status).toBe(409);
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).not.toHaveBeenCalled();
    issuing.resolve({ token: 'tk-isolated-late-continuous-a', expiresAt: f.expiresAt });
    const cancelled = await originalStart; expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: { code: 'SESSION_CANCELLED' } });
    expect(f.store.get(originalId).status).toBe('stopped');
    expect(f.deactivate).toHaveBeenCalledWith('tk-isolated-late-continuous-a');
    const final = await f.start(); expect(final.status).toBe(201);
    expect((await final.json()).exhibition.lookId).toBe('evening');
    expect(f.issue).toHaveBeenCalledTimes(2);
    expect(f.store.list().map(record => record.exhibition!.lookId)).toEqual(['commute', 'evening']);
  });
});
