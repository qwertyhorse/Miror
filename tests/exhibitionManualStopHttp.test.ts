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
import { CONTINUOUS_SEGMENT_CREDITS } from '../shared/sessionLimits.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import { ApiError, type Provider } from '../server/types.ts';

const resources: { server: Server; store: SessionStore; directory: string }[] = [];
const key = 'uk-isolated-manual-stop-http-fixture';
const origin = 'http://127.0.0.1:5173';
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
afterEach(async () => {
  for (const { server, store, directory } of resources.splice(0)) {
    const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
    store.close(); await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  let now = 1_800_000_000_000;
  const directory = await mkdtemp(join(tmpdir(), 'openbuy-manual-stop-http-'));
  const store = new SessionStore(':memory:'); store.activateApiKeyBudget(key);
  const issue = vi.fn(async () => ({ token: 'tk-isolated-manual-stop-http', expiresAt: new Date(now + 120_000).toISOString() }));
  const deactivate = vi.fn(async (_key: string, _token: string) => ({ status: 'inactive' as const, consumedCredit: 7, expireTimestamp: new Date(now + 120_000).toISOString() }));
  const provider = (credential: string): Provider => ({ configured: true, credentialSnapshot: () => credential,
    issueKey: issue, keyStatus: async () => ({ status: 'active', consumedCredit: 1, expireTimestamp: new Date(now + 120_000).toISOString() }),
    deactivate: token => deactivate(credential, token), sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'active', consumedCredit: 1 }),
  });
  const service = new TryOnService({ provider: provider(key), providerForApiKey: provider, store, secrets: new SecretBox(randomBytes(32)), catalog: async () => [] });
  const mirrors = new ExhibitionMirrors(directory, { now: () => now });
  mirrors.attachLiveService(service);
  const mirror = mirrors.getMirror('default');
  mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
  const server = createApiServer(service, undefined, undefined, mirrors);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  resources.push({ server, store, directory });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors/default`;
  const post = (path: string, input: unknown) => fetch(base + path, { method: 'POST', headers: { origin, 'X-Miror-Protocol': '2', 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const begin = async () => { const response = await post('/command', { action: 'begin' }); expect(response.status).toBe(200); return response.json(); };
  const start = () => post('/live/session', { deviceId: 'manual-http-screen', lookId: mirror.get().selectedLookId, generationNumber: mirror.get().generationNumber });
  return { directory, store, service, mirror, mirrors, issue, deactivate, base, post, begin, start, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('manual stop over the backend API', () => {
  it('stops an offline mirror from the backend without needing a mirror SDK or heartbeat response', async () => {
    const f = await fixture(); await f.begin();
    const response = await f.start(); expect(response.status).toBe(201); const session = await response.json();
    f.advance(20_000);
    const stopped = await f.post('/command', { action: 'end' });
    expect(stopped.status).toBe(200); expect(await stopped.json()).toMatchObject({ phase: 'select', live: null });
    expect(f.deactivate).toHaveBeenCalledWith(key, session.token);
    expect(f.store.get(session.id)).toMatchObject({ status: 'stopped', consumedCredits: 7 });
    expect(f.issue).toHaveBeenCalledOnce();
  });

  it('cancels a pending issuance and revokes the late credential through its original signing key', async () => {
    const f = await fixture(); const entered = deferred<void>(); const issued = deferred<Awaited<ReturnType<typeof f.issue>>>();
    f.issue.mockImplementationOnce(() => { entered.resolve(); return issued.promise; });
    await f.begin(); const starting = f.start(); await entered.promise;
    const id = f.mirror.get().live!.sessionId!;
    const stopping = await f.post('/command', { action: 'end' });
    expect(stopping.status).toBe(200); const pending = await stopping.json();
    expect(pending).toMatchObject({ phase: 'select', live: { sessionId: id, status: 'stopping' } }); expect(pending.live).not.toHaveProperty('localEnded');
    expect(f.deactivate).not.toHaveBeenCalled();
    issued.resolve({ token: 'tk-isolated-late-manual-stop', expiresAt: new Date(Date.now() + 120_000).toISOString() });
    const late = await starting; expect(late.status).toBe(409); expect(await late.json()).toMatchObject({ error: { code: 'SESSION_CANCELLED' } });
    const refreshed = await fetch(f.base); expect(await refreshed.json()).toMatchObject({ phase: 'select', live: null });
    expect(f.deactivate).toHaveBeenCalledWith(key, 'tk-isolated-late-manual-stop');
    expect(f.store.get(id).status).toBe('stopped'); expect(f.issue).toHaveBeenCalledOnce();
  });

  it('retries a failed stop from the backend while keeping the old lease and budget allocated', async () => {
    const f = await fixture(); await f.begin(); const started = await f.start(); const session = await started.json();
    f.deactivate.mockRejectedValueOnce(new Error('isolated provider outage'));
    const first = await f.post('/command', { action: 'end' }); expect(first.status).toBe(200);
    const unconfirmed = await first.json();
    expect(unconfirmed).toMatchObject({ phase: 'select', live: { sessionId: session.id, status: 'error' } }); expect(unconfirmed.live).not.toHaveProperty('localEnded');
    expect(f.store.get(session.id).status).toBe('stopping'); expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
    const retry = await f.post('/command', { action: 'end' }); expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ phase: 'select', live: null });
    expect(f.deactivate).toHaveBeenCalledTimes(2); expect(f.issue).toHaveBeenCalledOnce(); expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it.each(['end', 'idle'] as const)('confirms local %s for unknown issuance without releasing its cloud protection', async action => {
    const f = await fixture(); await f.begin(); f.issue.mockRejectedValue(new ApiError('PROVIDER_NETWORK_ERROR', 'isolated timeout', 502));
    const start = await f.start(); expect(start.status).toBe(502); const record = f.store.list()[0];
    expect(f.mirror.get()).toMatchObject({ phase: 'paused', live: { sessionId: record.id, status: 'error' } });
    const response = await f.post('/command', { action }); expect(response.status).toBe(200);
    const ended = await response.json(); const phase = action === 'end' ? 'select' : 'idle';
    expect(ended).toMatchObject({ phase, live: { sessionId: record.id, status: 'error', localEnded: true, error: '本地体验已结束，云端凭证状态待确认。' } });
    expect(f.mirror.credentialsEditable()).toBe(true);
    for (let index = 0; index < 3; index++) {
      f.advance(15_000);
      expect(await (await f.post('/command', { action })).json()).toEqual(ended);
      expect(await (await fetch(f.base)).json()).toEqual(ended);
    }
    const blocked = await f.post('/command', { action: 'begin' }); expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: 'EXHIBITION_LIVE_STOP_PENDING' } });
    const restarted = new ExhibitionMirrors(f.directory, { now: () => ended.updatedAt + 45_000 }); restarted.attachLiveService(f.service);
    await f.service.recover(); await restarted.sweepLive();
    expect(restarted.getMirror().get()).toEqual(ended);
    expect(f.store.get(record.id)).toEqual(record); expect(f.store.get(record.id).status).toBe('issuance_unknown');
    expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).not.toHaveBeenCalled();
  });

  it.each(['end', 'idle'] as const)('explicitly recovers a locally ended unknown %s lease without issuing or refunding credits', async action => {
    const f = await fixture(); await f.begin(); f.issue.mockRejectedValue(new ApiError('PROVIDER_NETWORK_ERROR', 'isolated timeout', 502));
    expect((await f.start()).status).toBe(502);
    const ended = await (await f.post('/command', { action })).json(); const record = f.store.list()[0];
    const response = await f.post('/command', { action: 'recover', expectedRevision: ended.revision });
    expect(response.status).toBe(200); const recovered = await response.json();
    expect(recovered).toMatchObject({ phase: action === 'end' ? 'select' : 'idle', live: null,
      sessionNumber: ended.sessionNumber, generationNumber: ended.generationNumber + 1, generationReadyAt: null, autoSwitchAt: null });
    expect(f.store.get(record.id)).toEqual(record); expect(record.providerKeyCipher).toBeTruthy();
    expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).not.toHaveBeenCalled();
    expect(await (await f.post('/command', { action: 'recover' })).json()).toEqual(recovered);
    const restarted = new ExhibitionMirrors(f.directory); restarted.attachLiveService(f.service);
    await f.service.recover(); await restarted.sweepLive();
    expect(restarted.getMirror().get()).toEqual(recovered); expect(f.store.get(record.id)).toEqual(record);
    const settings = await f.post('/command', { action: 'configure', uiSkinPreset: 'brand', experienceMode: 'free' });
    expect(settings.status).toBe(200); expect(await settings.json()).toMatchObject({ live: null, experienceMode: 'free', settings: { uiSkinPreset: 'brand' } });
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).not.toHaveBeenCalled();
  });

  it('rejects recovery before local end and while a known-token stop is unconfirmed', async () => {
    const f = await fixture(); await f.begin(); const created = await f.start(); const session = await created.json();
    const active = f.mirror.get(); const activeResponse = await f.post('/command', { action: 'recover' });
    expect(activeResponse.status).toBe(409); expect(f.mirror.get()).toEqual(active); expect(f.deactivate).not.toHaveBeenCalled();
    f.deactivate.mockRejectedValue(new Error('isolated provider outage'));
    const ended = await (await f.post('/command', { action: 'end' })).json();
    const pending = f.store.get(session.id);
    const response = await f.post('/command', { action: 'recover' });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'EXHIBITION_RECOVERY_UNAVAILABLE' } });
    expect(f.mirror.get()).toEqual(ended); expect(f.store.get(session.id)).toEqual(pending);
    expect(f.deactivate).toHaveBeenCalledOnce(); expect(f.issue).toHaveBeenCalledOnce(); expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('rejects recovery of paused unknown issuance until its local experience is ended', async () => {
    const f = await fixture(); await f.begin(); f.issue.mockRejectedValue(new ApiError('PROVIDER_NETWORK_ERROR', 'isolated timeout', 502));
    expect((await f.start()).status).toBe(502); const paused = f.mirror.get(); const record = f.store.list()[0];
    expect(paused.phase).toBe('paused');
    expect((await f.post('/command', { action: 'recover' })).status).toBe(409);
    expect(f.mirror.get()).toEqual(paused); expect(f.store.get(record.id)).toEqual(record);
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).not.toHaveBeenCalled();
  });

  it('keeps a failed known-token revocation pending without confirming local-only completion', async () => {
    const f = await fixture(); await f.begin(); const created = await f.start(); const session = await created.json();
    f.store.update(session.id, { status: 'issuance_unknown' });
    f.deactivate.mockRejectedValue(new Error('isolated provider outage'));
    const response = await f.post('/command', { action: 'end' }); const next = await response.json();
    expect(response.status).toBe(200); expect(next).toMatchObject({ phase: 'select', live: { sessionId: session.id, status: 'error' } });
    expect(next.live).not.toHaveProperty('localEnded'); expect(f.store.get(session.id).status).toBe('stopping');
    expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).toHaveBeenCalledOnce();
  });

  it('releases the live lease only after successfully revoking a known token with unknown issuance status', async () => {
    const f = await fixture(); await f.begin(); const created = await f.start(); const session = await created.json();
    f.store.update(session.id, { status: 'issuance_unknown' });
    const response = await f.post('/command', { action: 'end' });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ phase: 'select', live: null });
    expect(f.store.get(session.id).status).toBe('stopped'); expect(f.deactivate).toHaveBeenCalledOnce();
    expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(f.issue).toHaveBeenCalledOnce();
  });

  it('ends automatic switching at its deadline without advancing or allocating another outfit', async () => {
    const f = await fixture(); f.mirror.command({ action: 'configure', switchMode: 'auto', autoSwitchSeconds: 5 });
    await f.begin(); const started = await f.start(); const session = await started.json();
    f.mirror.liveFirstFrame(session.id, 100); const before = f.mirror.get();
    f.advance(5_000);
    const ended = await f.post('/command', { action: 'end' }); expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ phase: 'select', generationNumber: before.generationNumber, selectedLookId: before.selectedLookId, autoSwitchAt: null, live: null });
    f.advance(30_000); await f.mirror.sweepLive();
    expect(f.mirror.get()).toMatchObject({ phase: 'select', generationNumber: before.generationNumber, autoSwitchAt: null });
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).toHaveBeenCalledOnce();
  });
});
