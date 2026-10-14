import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { TryOnService } from '../server/service.ts';
import { createApiServer } from '../server/http.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { IssuedKey, KeyStatus, Provider } from '../server/types.ts';

const resources: { directory: string; server: Server; store: SessionStore }[] = [];
afterEach(async () => {
  for (const { directory, server, store } of resources.splice(0)) {
    const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
    store.close(); await rm(directory, { recursive: true, force: true });
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}
async function fixture(options: { mode?: 'clothx' | 'free' | 'mox' } = {}) {
  let time = Date.now();
  const directory = await mkdtemp(join(tmpdir(), 'openbuy-seamless-http-'));
  const store = new SessionStore(':memory:'); const keys = new Map<string, KeyStatus>();
  const issue = vi.fn(async (): Promise<IssuedKey> => {
    const token = `tk-isolated-seamless-${keys.size + 1}`; const expiresAt = new Date(time + 120_000).toISOString();
    keys.set(token, { status: 'active', consumedCredit: 1, expireTimestamp: expiresAt }); return { token, expiresAt };
  });
  const deactivate = vi.fn(async (token: string): Promise<KeyStatus> => {
    const result = { ...keys.get(token)!, status: 'inactive' as const }; keys.set(token, result); return result;
  });
  const provider: Provider = { configured: true, issueKey: issue, deactivate,
    keyStatus: async token => keys.get(token)!, sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'active', consumedCredit: 1 }) };
  const resolveHost = vi.fn(async (_host: string): Promise<string[]> => ['8.8.8.8']);
  const service = new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), resolveHost });
  const mirrors = new ExhibitionMirrors(directory, { now: () => time }); mirrors.attachLiveService(service);
  const mirror = mirrors.getMirror();
  if (options.mode && options.mode !== 'clothx') {
    for (const look of mirror.get().looks) mirror.updateLook(look.id, { mode: options.mode,
      ...(options.mode === 'free' ? { prompt: `水彩效果 ${look.id}`, referenceKind: 'none' } : {}) });
  }
  mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0, ...(options.mode ? { experienceMode: options.mode } : {}) }); mirror.command({ action: 'begin' });
  const server = createApiServer(service, undefined, undefined, mirrors);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); resources.push({ directory, server, store });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors/default`;
  const postAt = (mirrorId: string, path: string, input: unknown) => fetch(base.replace(/default$/u, mirrorId) + path, { method: 'POST', headers: { origin: 'http://127.0.0.1:5173', 'X-Miror-Protocol': '2', 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(3_000) });
  const post = (path: string, input: unknown) => postAt('default', path, input);
  const deviceId = 'isolated-seamless-screen';
  const started = await post('/live/session', { deviceId, lookId: 'commute', generationNumber: mirror.get().generationNumber });
  expect(started.status).toBe(201); const session = await started.json();
  if (options.mode !== 'free') expect((await post(`/live/session/${session.id}/reference`, { deviceId, lookId: 'commute', refImageUrl: 'https://uploads.example/commute.webp' })).status).toBe(200);
  expect((await post(`/sessions/${session.id}/link`, { providerSessionId: 'ums-isolated-seamless' })).status).toBe(200);
  expect((await post(`/sessions/${session.id}/first-frame`, { firstFrameMs: 125 })).status).toBe(200);
  const intent = () => ({ deviceId, lookId: mirror.get().selectedLookId, sessionNumber: mirror.get().sessionNumber, generationNumber: mirror.get().generationNumber });
  return { mirror, mirrors, service, store, issue, deactivate, resolveHost, post, postAt, session, intent, now: () => time, advance: (ms: number) => { time += ms; } };
}

describe('same-session exhibition material conditions over HTTP', () => {
  it('keeps the camera lease and previous result through bind, then acknowledges the new material without another first frame', async () => {
    const f = await fixture(); const before = f.store.get(f.session.id);
    const switched = await f.post('/command', { action: 'switch', lookId: 'evening' }); expect(switched.status).toBe(200);
    const state = await switched.json();
    expect(state).toMatchObject({ phase: 'generating', selectedLookId: 'evening', displayedLookId: 'commute', generationNumber: 2,
      live: { sessionId: f.session.id, lookId: 'commute', generationNumber: 1, status: 'running' } });
    await f.mirror.reconcileLive(); expect(f.deactivate).not.toHaveBeenCalled();
    expect((await f.post('/live/session', { ...f.intent() })).status).toBe(409);
    const boundResponse = await f.post(`/live/session/${f.session.id}/condition`, { ...f.intent(), refImageUrl: 'https://uploads.example/evening.webp' });
    expect(boundResponse.status).toBe(200); const bound = await boundResponse.json();
    expect(bound).toMatchObject({ id: f.session.id, providerSessionId: before.providerSessionId, firstFrameMs: 125, referenceVersion: 2,
      exhibition: { lookId: 'evening', generationNumber: 2 }, referenceAsset: '/assets/exhibition/evening-cutout.png' });
    expect(bound).not.toHaveProperty('token'); expect(bound).not.toHaveProperty('tokenCipher');
    expect(f.mirror.get()).toMatchObject({ phase: 'generating', displayedLookId: 'commute', live: { lookId: 'commute' } });
    f.mirror.liveFirstFrame(f.session.id, 999); expect(f.mirror.get().phase).toBe('generating');
    const applied = await f.post(`/live/session/${f.session.id}/condition/applied`, { ...f.intent(), referenceVersion: bound.referenceVersion });
    expect(applied.status).toBe(200); const shown = await applied.json();
    expect(shown).toMatchObject({ phase: 'showcase', selectedLookId: 'evening', displayedLookId: 'evening', sessionNumber: 1, generationNumber: 2,
      live: { sessionId: f.session.id, generationNumber: 2, lookId: 'evening', status: 'running', firstFrameMs: 125 } });
    expect(await (await f.post(`/live/session/${f.session.id}/condition/applied`, { ...f.intent(), referenceVersion: bound.referenceVersion })).json()).toEqual(shown);
    const after = f.store.get(f.session.id);
    expect(after.tokenCipher).toBe(before.tokenCipher); expect(after.expiresAt).toBe(before.expiresAt); expect(after.pointsLimit).toBe(before.pointsLimit);
    expect(f.store.list()).toHaveLength(1); expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).not.toHaveBeenCalled();
  });

  it('rejects stale uploads and acknowledgements when a newer material wins during DNS validation', async () => {
    const f = await fixture(); await f.post('/command', { action: 'switch', lookId: 'city' }); const middleIntent = f.intent();
    const lookup = deferred<string[]>(); const entered = deferred<void>();
    f.resolveHost.mockImplementationOnce(() => { entered.resolve(); return lookup.promise; });
    const pending = f.post(`/live/session/${f.session.id}/condition`, { ...middleIntent, refImageUrl: 'https://uploads.example/city.webp' }); await entered.promise;
    expect((await f.post('/command', { action: 'switch', lookId: 'evening' })).status).toBe(200);
    const latest = await f.post(`/live/session/${f.session.id}/condition`, { ...f.intent(), refImageUrl: 'https://uploads.example/evening.webp' });
    expect(latest.status).toBe(200); const bound = await latest.json(); lookup.resolve(['8.8.8.8']);
    const stale = await pending; expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: { code: 'EXHIBITION_STALE_GENERATION' } });
    expect((await f.post(`/live/session/${f.session.id}/condition/applied`, { ...middleIntent, referenceVersion: bound.referenceVersion })).status).toBe(409);
    expect((await f.post(`/live/session/${f.session.id}/condition/applied`, { ...f.intent(), referenceVersion: bound.referenceVersion })).status).toBe(200);
    expect(f.mirror.get()).toMatchObject({ phase: 'showcase', displayedLookId: 'evening', generationNumber: 3 });
    expect(f.store.get(f.session.id)).toMatchObject({ referenceVersion: 2, exhibition: { lookId: 'evening', generationNumber: 3 } });
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).not.toHaveBeenCalled();
  });

  it('checks device, round, selection and exact reference version before exposing a new result', async () => {
    const f = await fixture(); await f.post('/command', { action: 'next' });
    for (const change of [{ deviceId: 'other-screen' }, { sessionNumber: 2 }, { generationNumber: 1 }, { lookId: 'evening' }]) {
      const response = await f.post(`/live/session/${f.session.id}/condition`, { ...f.intent(), ...change, refImageUrl: 'https://uploads.example/city.webp' });
      expect(response.status).toBe(409);
    }
    const invalid = await f.post(`/live/session/${f.session.id}/condition`, { ...f.intent(), refImageUrl: 'http://uploads.example/city.webp' }); expect(invalid.status).toBe(400);
    const bound = await (await f.post(`/live/session/${f.session.id}/condition`, { ...f.intent(), refImageUrl: 'https://uploads.example/city.webp' })).json();
    for (const referenceVersion of [0, 1, 3, '2']) expect((await f.post(`/live/session/${f.session.id}/condition/applied`, { ...f.intent(), referenceVersion })).status).toBe(409);
    expect(f.mirror.get()).toMatchObject({ phase: 'generating', displayedLookId: 'commute' });
    expect((await f.post(`/live/session/${f.session.id}/condition/applied`, { ...f.intent(), referenceVersion: bound.referenceVersion })).status).toBe(200);
    expect(f.issue).toHaveBeenCalledOnce();
  });

  it('cannot complete a pending condition after an explicit stop', async () => {
    const f = await fixture(); await f.post('/command', { action: 'next' }); const intent = f.intent();
    const lookup = deferred<string[]>(); const entered = deferred<void>();
    f.resolveHost.mockImplementationOnce(() => { entered.resolve(); return lookup.promise; });
    const pending = f.post(`/live/session/${f.session.id}/condition`, { ...intent, refImageUrl: 'https://uploads.example/city.webp' }); await entered.promise;
    expect((await f.post('/command', { action: 'end' })).status).toBe(200); lookup.resolve(['8.8.8.8']);
    expect((await pending).status).toBe(409); expect(f.mirror.get()).toMatchObject({ phase: 'select', displayedLookId: null, live: null });
    expect(f.store.get(f.session.id)).toMatchObject({ status: 'stopped', referenceVersion: 1, exhibition: { lookId: 'commute' } });
    expect((await f.post(`/live/session/${f.session.id}/condition/applied`, { ...intent, referenceVersion: 1 })).status).toBe(409);
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).toHaveBeenCalledOnce();
  });

  it('applies automatic material rotation on the same lease and starts its next interval only after acknowledgement', async () => {
    const f = await fixture(); f.mirror.command({ action: 'configure', switchMode: 'auto', autoSwitchSeconds: 5 });
    f.advance(5_000); await f.mirror.sweepLive();
    expect(f.mirror.get()).toMatchObject({ phase: 'generating', selectedLookId: 'city', displayedLookId: 'commute', autoSwitchAt: null,
      live: { sessionId: f.session.id, lookId: 'commute', status: 'running' } });
    f.advance(4_000); await f.mirror.sweepLive(); expect(f.mirror.get().generationNumber).toBe(2);
    const bound = await (await f.post(`/live/session/${f.session.id}/condition`, { ...f.intent(), refImageUrl: 'https://uploads.example/city.webp' })).json();
    const acknowledged = await (await f.post(`/live/session/${f.session.id}/condition/applied`, { ...f.intent(), referenceVersion: bound.referenceVersion })).json();
    expect(acknowledged).toMatchObject({ phase: 'showcase', displayedLookId: 'city', autoSwitchAt: f.now() + 5_000 });
    f.advance(2_000);
    expect(await (await f.post(`/live/session/${f.session.id}/condition/applied`, { ...f.intent(), referenceVersion: bound.referenceVersion })).json()).toEqual(acknowledged);
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).not.toHaveBeenCalled();
  });

  it('changes prompt-only Free conditions without uploading their cover or allocating another lease', async () => {
    const f = await fixture({ mode: 'free' }); expect(f.resolveHost).not.toHaveBeenCalled();
    expect((await f.post('/command', { action: 'next' })).status).toBe(200);
    const response = await f.post(`/live/session/${f.session.id}/condition`, f.intent()); expect(response.status).toBe(200);
    const bound = await response.json();
    expect(bound).toMatchObject({ referenceAsset: '', refImageUrl: '', referenceVersion: 1, exhibition: { mode: 'free', lookId: 'city', prompt: '水彩效果 city' } });
    expect((await f.post(`/live/session/${f.session.id}/condition/applied`, { ...f.intent(), referenceVersion: 1 })).status).toBe(200);
    expect(f.mirror.get()).toMatchObject({ phase: 'showcase', displayedLookId: 'city' });
    expect(f.resolveHost).not.toHaveBeenCalled(); expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).not.toHaveBeenCalled();
  });

  it('retains the stop-and-recreate boundary for MoX and rejects changing camera mode during an active round', async () => {
    const f = await fixture({ mode: 'mox' });
    expect((await f.post('/command', { action: 'configure', experienceMode: 'clothx' })).status).toBe(409);
    expect((await f.post('/command', { action: 'next' })).status).toBe(200); await f.mirror.reconcileLive();
    expect(f.store.get(f.session.id).status).toBe('stopped'); expect(f.mirror.get()).toMatchObject({ phase: 'generating', selectedLookId: 'city', live: null });
    expect((await f.post(`/live/session/${f.session.id}/condition`, { ...f.intent(), refImageUrl: 'https://uploads.example/city.webp' })).status).toBe(409);
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).toHaveBeenCalledOnce();
  });

  it('rejects condition preparation and application through another mirror before touching provider or state', async () => {
    const f = await fixture(); await f.post('/command', { action: 'next' });
    const other = f.mirrors.create({ name: '另一个镜端' }); const before = f.store.get(f.session.id); const beforeState = f.mirror.get();
    f.resolveHost.mockClear();
    for (const suffix of ['condition', 'condition/applied']) {
      const response = await f.postAt(other.id, `/live/session/${f.session.id}/${suffix}`, { ...f.intent(), refImageUrl: 'https://uploads.example/city.webp', referenceVersion: 2 });
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'EXHIBITION_MIRROR_MISMATCH' });
    }
    expect(f.store.get(f.session.id)).toEqual(before); expect(f.mirror.get()).toEqual(beforeState);
    expect(f.resolveHost).not.toHaveBeenCalled(); expect(f.deactivate).not.toHaveBeenCalled(); expect(f.issue).toHaveBeenCalledOnce();
  });

  it.each(['expiry', 'quota', 'heartbeat'] as const)('pauses a pending material switch on %s without allocating another credential', async reason => {
    const f = await fixture(); await f.post('/command', { action: 'next' });
    if (reason === 'quota') f.store.update(f.session.id, { consumedCredits: f.session.pointsLimit });
    else f.advance(reason === 'expiry' ? 120_001 : 20_001);
    await f.mirror.reconcileLive();
    expect(f.mirror.get()).toMatchObject({ phase: 'paused', selectedLookId: 'city', displayedLookId: 'commute', generationNumber: 2, live: null });
    expect((await f.post('/live/session', f.intent())).status).toBe(409);
    expect(f.store.get(f.session.id).status).toBe('stopped'); expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).toHaveBeenCalledOnce();
  });
});
