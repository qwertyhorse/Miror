import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTINUOUS_SEGMENT_CREDITS } from '../shared/sessionLimits';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionService } from '../server/exhibition.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import { createApiServer } from '../server/http.ts';
import { ApiError, type Provider, type IssuedKey, type KeyStatus } from '../server/types.ts';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
function fixture() {
  let time = Date.now();
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-exhibition-live-'));
  const store = new SessionStore(':memory:'); const keys = new Map<string, KeyStatus>();
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const issue = vi.fn(async (_limit: number, _seconds: number): Promise<IssuedKey> => {
    const token = `tk-exhibition-${keys.size + 1}`; const expiresAt = new Date(time + 120000).toISOString();
    keys.set(token, { status: 'active', consumedCredit: 1, expireTimestamp: expiresAt }); return { token, expiresAt };
  });
  const deactivate = vi.fn(async (token: string) => { const value = { ...keys.get(token)!, status: 'inactive' as const }; keys.set(token, value); return value; });
  const provider: Provider = { configured: true, issueKey: issue, keyStatus: async token => keys.get(token)!, deactivate,
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'ACTIVE', consumedCredit: 1 }) };
  const service = new LifecycleTryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)),
    resolveHost: async host => host === 'private.example' ? ['127.0.0.1'] : ['8.8.8.8'] });
  const exhibition = new ExhibitionService(directory, { now: () => time }); exhibition.attachLiveService(service);
  return { exhibition, service, provider, store, issue, deactivate, keys, directory, now: () => time, advance: (amount: number) => { time += amount; } };
}
const deviceId = 'screen-test-001';
function start(exhibition: ExhibitionService) {
  exhibition.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
  exhibition.command({ action: 'begin' });
}
async function create(exhibition: ExhibitionService) { return exhibition.createLiveSession({ deviceId, lookId: exhibition.get().selectedLookId, generationNumber: exhibition.get().generationNumber }); }

describe('explicit exhibition XMAX path', () => {
  it('requires explicit live mode and rejects main-site session APIs without allocating credentials', async () => {
    const { exhibition, service, issue, store } = fixture();
    expect(exhibition.get().settings.sessionLimits).toEqual({ credits: null, expireSeconds: 120 });
    expect(exhibition.liveStatus()).toMatchObject({ mode: 'demo', configured: true, perSessionLimit: CONTINUOUS_SEGMENT_CREDITS, live: null });
    for (const field of ['totalLimit', 'allocatedCredits', 'remainingCredits']) expect(exhibition.liveStatus()).not.toHaveProperty(field);
    await expect(create(exhibition)).rejects.toMatchObject({ code: 'EXHIBITION_LIVE_DISABLED' });
    exhibition.command({ action: 'configure', providerMode: 'xmax' });
    await expect(create(exhibition)).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' });
    const before = exhibition.get();
    const server = createApiServer(service, ['http://xuminghong.local:10200'], undefined, exhibition);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      for (const sourceKind of ['photo', 'camera']) {
        const response = await fetch(base + '/api/sessions', {
          method: 'POST', headers: { 'X-Miror-Protocol': '2', 'X-Miror-Material': 'binding-v1', 'Content-Type': 'application/json', Origin: 'http://xuminghong.local:10200' },
          body: JSON.stringify({ targetItemId: 'real-inner', sourceId: 'test', sourceKind, sourceName: 'test' }),
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
      }
    } finally { server.close(); await once(server, 'close'); }
    expect(exhibition.get()).toEqual(before);
    expect(issue).not.toHaveBeenCalled(); expect(store.allocated()).toBe(0);
  });

  it('binds only the selected library asset, publishes no token in shared state and waits for a genuine first-frame event', async () => {
    const { exhibition, service, store, issue, advance, directory } = fixture(); start(exhibition);
    const started = exhibition.get();
    expect(started).toMatchObject({ phase: 'generating', sessionNumber: 1, generationNumber: 1, generationReadyAt: null, displayedLookId: null });
    expect(() => exhibition.command({ action: 'begin' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
    expect(exhibition.get()).toEqual(started); expect(issue).not.toHaveBeenCalled();
    await expect(exhibition.createLiveSession({ deviceId, lookId: 'city', generationNumber: exhibition.get().generationNumber })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_LOOK' });
    const session = await create(exhibition);
    expect(session).toMatchObject({ model: 'x2.0', referenceAsset: '/assets/exhibition/commute-cutout.png', refImageUrl: expect.stringMatching(/^https:/), sourceKind: 'camera', pointsLimit: CONTINUOUS_SEGMENT_CREDITS, exhibition: { lookId: 'commute', deviceId, sessionNumber: 1, continuous: true } });
    expect(issue).toHaveBeenCalledWith(CONTINUOUS_SEGMENT_CREDITS, 120); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
    expect(JSON.stringify(exhibition.get())).not.toContain(session.token); expect(readFileSync(join(directory, 'exhibition.json'), 'utf8')).not.toContain(session.token);
    advance(5000); expect(exhibition.get().phase).toBe('generating');
    await service.link(session.id, 'ums-test'); await service.firstFrame(session.id, 750); exhibition.liveFirstFrame(session.id, 750);
    expect(exhibition.get()).toMatchObject({ phase: 'showcase', displayedLookId: 'commute', live: { status: 'running', firstFrameMs: 750 } });
  });

  it('serializes simultaneous owners before credential allocation, including duplicate requests by the same device', async () => {
    const { exhibition, issue, store } = fixture(); start(exhibition);
    const results = await Promise.allSettled([create(exhibition), exhibition.createLiveSession({ deviceId: 'screen-test-002', lookId: 'commute', generationNumber: exhibition.get().generationNumber }), create(exhibition)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').map(result => result.reason.code)).toEqual(['EXHIBITION_DEVICE_BUSY', 'EXHIBITION_DEVICE_BUSY']);
    expect(issue).toHaveBeenCalledTimes(1); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('appends during live first-frame and heartbeat updates without replacing or extending the active session', async () => {
    const { exhibition, service, store, issue, deactivate, advance } = fixture();
    const bytes = await sharp({ create: { width: 512, height: 768, channels: 4, background: '#bfbcff88' } }).png().toBuffer();
    const input = { name: '现场新增服装', category: '通勤', tags: ['简约'], imageBase64: bytes.toString('base64'), referenceImageBase64: bytes.toString('base64'), expectedRevision: 0 };
    start(exhibition); const session = await create(exhibition);
    await service.link(session.id, 'ums-active-upload');
    const pending = exhibition.upload(input);
    advance(5000); exhibition.heartbeat({ deviceId, sessionId: session.id });
    await service.firstFrame(session.id, 750); exhibition.liveFirstFrame(session.id, 750);
    const latest = exhibition.get(); const activeRecord = store.get(session.id);
    expect(latest).toMatchObject({ phase: 'showcase', live: { status: 'running', sessionId: session.id, firstFrameMs: 750 } });
    const appended = await pending;
    const { looks: _looks, revision: _revision, updatedAt: _updatedAt, logs: _logs, ...visitor } = appended;
    const { looks: _previousLooks, revision: _previousRevision, updatedAt: _previousUpdatedAt, logs: _previousLogs, ...expectedVisitor } = latest;
    expect(visitor).toEqual(expectedVisitor); expect(appended.looks).toHaveLength(4);
    expect(appended.enabledLookIds).not.toContain(appended.looks.at(-1)!.id);
    expect(store.get(session.id)).toEqual(activeRecord); expect(store.list()).toHaveLength(1);
    expect(issue).toHaveBeenCalledTimes(1); expect(deactivate).not.toHaveBeenCalled(); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
    advance(14000); const another = await exhibition.upload({ ...input, name: '继续上传' });
    expect(another.live).toEqual(latest.live); expect(store.get(session.id).expiresAt).toBe(session.expiresAt);
    advance(6000); await exhibition.sweepLive();
    expect(exhibition.get()).toMatchObject({ phase: 'paused', live: null });
    expect(deactivate).toHaveBeenCalledTimes(1); expect(issue).toHaveBeenCalledTimes(1); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('checks reference and heartbeat ownership and rejects all URL rebinding of the prepared reference', async () => {
    const { exhibition } = fixture(); start(exhibition); const session = await create(exhibition);
    expect(() => exhibition.heartbeat({ deviceId: 'other-screen', sessionId: session.id })).toThrow(expect.objectContaining({ code: 'EXHIBITION_OWNER_MISMATCH' }));
    await expect(exhibition.bindLiveReference(session.id, { deviceId: 'other-screen', lookId: 'commute', refImageUrl: 'https://uploads.example/a.webp' })).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    await expect(exhibition.bindLiveReference(session.id, { deviceId, lookId: 'commute', refImageUrl: 'http://uploads.example/a.webp' })).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_LOCKED' });
    await expect(exhibition.bindLiveReference(session.id, { deviceId, lookId: 'commute', refImageUrl: 'https://private.example/a.webp' })).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_LOCKED' });
    await expect(exhibition.bindLiveReference(session.id, { deviceId, lookId: 'commute', refImageUrl: 'https://uploads.example/b.webp' })).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_LOCKED' });
  });

  it('stops a disconnected camera after heartbeat expiry and requires manual resume before another allocation', async () => {
    const { exhibition, deactivate, advance, store } = fixture(); start(exhibition); const session = await create(exhibition);
    advance(14000); exhibition.heartbeat({ deviceId, sessionId: session.id }); await exhibition.sweepLive(); expect(deactivate).not.toHaveBeenCalled();
    advance(20000); await exhibition.sweepLive();
    expect(deactivate).toHaveBeenCalledWith(session.token); expect(store.get(session.id).status).toBe('stopped');
    expect(exhibition.get()).toMatchObject({ phase: 'paused', live: null });
    await expect(create(exhibition)).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' });
    exhibition.command({ action: 'resume' }); await create(exhibition); expect(store.allocated()).toBe(2 * CONTINUOUS_SEGMENT_CREDITS);
  });

  it('stops paused/ended/idle/replaced sessions, and permits the new outfit only after the old key stops', async () => {
    const { exhibition, deactivate, store } = fixture(); start(exhibition); let session = await create(exhibition);
    exhibition.command({ action: 'pause' }); await exhibition.reconcileLive(); expect(store.get(session.id).status).toBe('stopped');
    exhibition.command({ action: 'resume' }); session = await create(exhibition); exhibition.liveFirstFrame(session.id, 100);
    exhibition.command({ action: 'next' }); await exhibition.reconcileLive();
    expect(exhibition.get()).toMatchObject({ phase: 'generating', selectedLookId: 'city', live: null });
    session = await create(exhibition); expect(session.exhibition?.lookId).toBe('city');
    exhibition.command({ action: 'end' }); await exhibition.reconcileLive(); expect(exhibition.get()).toMatchObject({ phase: 'select', live: null });
    exhibition.command({ action: 'begin' }); session = await create(exhibition);
    exhibition.command({ action: 'idle' }); await exhibition.reconcileLive(); expect(exhibition.get()).toMatchObject({ phase: 'idle', live: null });
    expect(deactivate).toHaveBeenCalledTimes(4); expect(store.allocated()).toBe(4 * CONTINUOUS_SEGMENT_CREDITS);
  });

  it('switches a running camera outfit in the same experience and requires a current condition acknowledgement', async () => {
    const { exhibition, service, store, issue, deactivate, advance } = fixture(); start(exhibition);
    const previous = await create(exhibition);
    await service.link(previous.id, 'ums-direct-switch-old');
    await service.firstFrame(previous.id, 100); exhibition.liveFirstFrame(previous.id, 100);
    const showcased = exhibition.get();
    expect(exhibition.command({ action: 'switch', lookId: 'commute' })).toEqual(showcased);
    await exhibition.reconcileLive();
    expect(deactivate).not.toHaveBeenCalled(); expect(issue).toHaveBeenCalledTimes(1); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);

    const switching = exhibition.command({ action: 'switch', lookId: 'evening', expectedRevision: showcased.revision });
    expect(switching).toMatchObject({ phase: 'generating', selectedLookId: 'evening', displayedLookId: 'commute',
      sessionNumber: showcased.sessionNumber, generationNumber: showcased.generationNumber + 1, generationReadyAt: null });
    exhibition.liveFirstFrame(previous.id, 200);
    await expect(exhibition.reportLiveError({ deviceId, sessionId: previous.id, lookId: 'commute', sessionNumber: showcased.sessionNumber,
      generationNumber: showcased.generationNumber, message: '迟到的上一套错误' })).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    expect(exhibition.get()).toEqual(switching);
    await exhibition.reconcileLive();
    await expect(create(exhibition)).rejects.toMatchObject({ code: 'EXHIBITION_DEVICE_BUSY' });
    expect(deactivate).not.toHaveBeenCalled(); expect(store.get(previous.id).status).toBe('active');
    expect(issue).toHaveBeenCalledTimes(1); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
    advance(5_000); exhibition.liveFirstFrame(previous.id, 300);
    expect(exhibition.get()).toMatchObject({ phase: 'generating', displayedLookId: 'commute', live: { sessionId: previous.id } });
    const intent = { deviceId, lookId: 'evening', sessionNumber: switching.sessionNumber, generationNumber: switching.generationNumber };
    const updated = await exhibition.updateLiveCondition(previous.id, { ...intent, bindingId: exhibition.readyReference('evening', true)!.bindingId });
    expect(updated).toMatchObject({ id: previous.id, providerSessionId: 'ums-direct-switch-old', referenceVersion: 2,
      exhibition: { lookId: 'evening', sessionNumber: showcased.sessionNumber, generationNumber: switching.generationNumber } });
    expect(exhibition.get()).toMatchObject({ phase: 'generating', displayedLookId: 'commute' });
    await exhibition.liveConditionApplied(previous.id, { ...intent, referenceVersion: updated.referenceVersion });
    expect(exhibition.get()).toMatchObject({ phase: 'showcase', selectedLookId: 'evening', displayedLookId: 'evening',
      sessionNumber: showcased.sessionNumber, generationNumber: switching.generationNumber, live: { status: 'running', sessionId: previous.id, firstFrameMs: 100 } });
    expect(store.list()).toHaveLength(1); expect(issue).toHaveBeenCalledTimes(1); expect(deactivate).not.toHaveBeenCalled();
  });

  it('does not allocate the chosen outfit until the previous live credential is confirmed stopped', async () => {
    const { exhibition, provider, issue, store } = fixture(); start(exhibition);
    const previous = await create(exhibition); exhibition.liveFirstFrame(previous.id, 100);
    provider.deactivate = async () => { throw new Error('network failure'); };
    exhibition.command({ action: 'switch', lookId: 'evening' });
    await expect(create(exhibition)).rejects.toMatchObject({ code: 'EXHIBITION_DEVICE_BUSY' });
    expect(exhibition.get()).toMatchObject({ phase: 'generating', selectedLookId: 'evening', displayedLookId: 'commute',
      live: { sessionId: previous.id, status: 'error' } });
    expect(store.get(previous.id).status).toBe('stopping'); expect(issue).toHaveBeenCalledTimes(1); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('retains ownership and allocation when stop is not confirmed, preventing a second screen from charging', async () => {
    const { exhibition, provider, store } = fixture(); start(exhibition); const session = await create(exhibition);
    provider.deactivate = async () => { throw new Error('network failure'); };
    exhibition.command({ action: 'end' }); await exhibition.reconcileLive();
    expect(exhibition.get().live).toMatchObject({ status: 'error', sessionId: session.id }); expect(store.get(session.id).status).toBe('stopping');
    expect(() => exhibition.command({ action: 'begin' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_LIVE_STOP_PENDING' }));
    await expect(exhibition.createLiveSession({ deviceId: 'screen-test-002', lookId: 'commute', generationNumber: exhibition.get().generationNumber })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' });
    expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('revokes late credentials when the visitor ends during issuance', async () => {
    const { exhibition, provider, store, keys, deactivate } = fixture(); start(exhibition);
    let resolve!: (issued: IssuedKey) => void;
    provider.issueKey = () => new Promise(done => { resolve = done; });
    const pending = create(exhibition); await vi.waitFor(() => expect(exhibition.get().live?.sessionId).toBeTruthy());
    exhibition.command({ action: 'end' }); await exhibition.reconcileLive();
    const issued = { token: 'tk-late', expiresAt: new Date(Date.now() + 120000).toISOString() };
    keys.set(issued.token, { status: 'active', consumedCredit: 0, expireTimestamp: issued.expiresAt }); resolve(issued);
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
    expect(deactivate).toHaveBeenCalledWith('tk-late'); expect(store.list()[0].status).toBe('stopped'); expect(exhibition.get().live).toBeNull();
  });

  it('continues explicitly finite sessions beyond the former local test limit without resetting history', async () => {
    const { exhibition, store, issue } = fixture();
    exhibition.command({ action: 'configure', sessionLimits: { credits: 30, expireSeconds: 120 } }); start(exhibition);
    const sessions: string[] = [];
    for (let index = 0; index < 13; index++) {
      const session = await create(exhibition); sessions.push(session.id);
      exhibition.command({ action: 'end' }); await exhibition.reconcileLive();
      if (index < 12) exhibition.command({ action: 'begin' });
    }
    expect(issue).toHaveBeenCalledTimes(13);
    expect(issue.mock.calls.every(([limit, seconds]) => limit === 30 && seconds === 120)).toBe(true);
    expect(store.allocated()).toBe(390); expect(store.list()).toHaveLength(13);
    expect(sessions.every(id => store.get(id).status === 'stopped')).toBe(true);
    for (const field of ['totalLimit', 'allocatedCredits', 'remainingCredits']) expect(exhibition.liveStatus()).not.toHaveProperty(field);
  });

  it('retains unknown issuance records and ownership without claiming cloud revocation', async () => {
    const ambiguous = fixture(); start(ambiguous.exhibition); ambiguous.provider.issueKey = async () => { throw new ApiError('PROVIDER_NETWORK_ERROR', 'timeout', 502); };
    await expect(create(ambiguous.exhibition)).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    expect(ambiguous.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(ambiguous.exhibition.get().live).not.toBeNull(); expect(ambiguous.store.list()[0].status).toBe('issuance_unknown');
    const before = ambiguous.store.list()[0];
    await ambiguous.service.stop(before.id); await ambiguous.service.recover();
    expect(ambiguous.store.get(before.id)).toEqual(before); expect(ambiguous.store.list()).toHaveLength(1);
    expect(ambiguous.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(ambiguous.deactivate).not.toHaveBeenCalled();
  });

  it('pauses unknown issuance once and retains its lease and allocation through repeated sweeps', async () => {
    const { exhibition, issue, deactivate, store, advance } = fixture(); start(exhibition);
    issue.mockRejectedValue(new ApiError('PROVIDER_NETWORK_ERROR', 'timeout', 502));
    await expect(create(exhibition)).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    const id = store.list()[0].id; const failed = exhibition.get();
    expect(failed).toMatchObject({ phase: 'paused', live: { sessionId: id, status: 'error', error: 'XMAX 凭证签发状态未确认，请联系工作人员。' } });
    for (let index = 0; index < 5; index++) { advance(20_000); await exhibition.sweepLive(); }
    expect(exhibition.get()).toEqual(failed);
    expect(() => exhibition.command({ action: 'resume' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_LIVE_STOP_PENDING' }));
    exhibition.command({ action: 'end' });
    expect(() => exhibition.command({ action: 'begin' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_LIVE_STOP_PENDING' }));
    await exhibition.reconcileLive(); const stoppedAttempt = exhibition.get();
    for (let index = 0; index < 5; index++) { advance(20_000); await exhibition.sweepLive(); }
    expect(exhibition.get()).toEqual(stoppedAttempt);
    expect(store.get(id)).toMatchObject({ status: 'issuance_unknown', errorCode: 'PROVIDER_NETWORK_ERROR' });
    expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(issue).toHaveBeenCalledOnce(); expect(deactivate).not.toHaveBeenCalled();
  });

  it('keeps repeated known-key stop errors stable while allowing revocation to be retried', async () => {
    const { exhibition, issue, deactivate, store, advance } = fixture(); start(exhibition); const session = await create(exhibition);
    deactivate.mockRejectedValue(new ApiError('PROVIDER_NETWORK_ERROR', 'timeout', 502));
    exhibition.command({ action: 'end' }); await exhibition.reconcileLive(); const failed = exhibition.get();
    for (let index = 0; index < 5; index++) { advance(20_000); await exhibition.sweepLive(); }
    expect(exhibition.get()).toEqual(failed); expect(deactivate).toHaveBeenCalledTimes(6);
    expect(store.get(session.id).status).toBe('stopping'); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(issue).toHaveBeenCalledOnce();
    deactivate.mockResolvedValueOnce({ status: 'inactive', consumedCredit: 1, expireTimestamp: session.expiresAt! });
    await exhibition.sweepLive();
    expect(exhibition.get()).toMatchObject({ phase: 'select', live: null });
    expect(store.get(session.id).status).toBe('stopped'); expect(deactivate).toHaveBeenCalledTimes(7);
  });

  it.each([false, true])('revokes a known token with unknown issuance status instead of leaving its lease paused (first stop fails: %s)', async failFirst => {
    const { exhibition, issue, deactivate, store } = fixture(); start(exhibition); const session = await create(exhibition);
    store.update(session.id, { status: 'issuance_unknown' });
    if (failFirst) deactivate.mockRejectedValueOnce(new ApiError('PROVIDER_NETWORK_ERROR', 'isolated timeout', 502));
    await exhibition.reconcileLive();
    expect(deactivate).toHaveBeenCalledWith(session.token); expect(deactivate).toHaveBeenCalledOnce();
    if (failFirst) {
      const failed = exhibition.get();
      expect(failed.live).toMatchObject({ sessionId: session.id, status: 'error' });
      expect(failed.live).not.toHaveProperty('localEnded'); expect(store.get(session.id).status).toBe('stopping');
      await exhibition.reconcileLive(); expect(deactivate).toHaveBeenCalledTimes(2);
    }
    expect(exhibition.get()).toMatchObject({ phase: 'paused', live: null });
    expect(store.get(session.id).status).toBe('stopped'); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(issue).toHaveBeenCalledOnce();
  });

  it.each(['true', 1, null, {}])('rejects an invalid stored local-ended marker %j without changing the cloud guard', async localEnded => {
    const { exhibition, issue, deactivate, store, directory, now, service } = fixture(); start(exhibition);
    issue.mockRejectedValue(new ApiError('PROVIDER_NETWORK_ERROR', 'timeout', 502));
    await expect(create(exhibition)).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    exhibition.command({ action: 'end' }); await exhibition.reconcileLive();
    const record = store.list()[0];
    const invalid = JSON.parse(JSON.stringify(store.mirrorState('default'))); invalid.state.live.localEnded = localEnded;
    store.saveMirrorState('default', invalid, { type: 'fixture-corruption' });
    expect(() => new ExhibitionService(directory, { now, strictStorage: true }).attachLiveService(service)).toThrow('Invalid durable mirror state');
    expect(store.mirrorState('default')).toEqual(invalid);
    expect(store.get(record.id)).toEqual(record); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
    expect(issue).toHaveBeenCalledOnce(); expect(deactivate).not.toHaveBeenCalled();
  });

  it('stops provider credentials on restart and keeps library/mode while clearing a recovered camera owner', async () => {
    const { exhibition, service, directory, now, store } = fixture(); start(exhibition); const session = await create(exhibition);
    const recovered = new ExhibitionService(directory, { now }); recovered.attachLiveService(service); await service.recover(); await recovered.sweepLive();
    expect(recovered.get()).toMatchObject({ providerMode: 'xmax', phase: 'select', live: null, enabledLookIds: ['commute', 'city', 'evening'] });
    expect(recovered.get().looks).toHaveLength(3); expect(store.get(session.id).status).toBe('stopped'); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('distinguishes rapid pause/resume generations so an old frame or error cannot complete the new attempt', async () => {
    const { exhibition, service, store } = fixture(); start(exhibition); const oldGeneration = exhibition.get().generationNumber;
    const session = await create(exhibition);
    await service.link(session.id, 'ums-old');
    exhibition.command({ action: 'pause' });
    expect(() => exhibition.command({ action: 'resume' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_LIVE_STOP_PENDING' }));
    await exhibition.reconcileLive(); exhibition.command({ action: 'resume' });
    const nextGeneration = exhibition.get().generationNumber; expect(nextGeneration).toBe(oldGeneration + 1);
    exhibition.liveFirstFrame(session.id, 123);
    expect(exhibition.get().phase).toBe('generating'); expect(exhibition.get().displayedLookId).toBeNull();
    await expect(exhibition.reportLiveError({ deviceId, sessionId: session.id, lookId: 'commute', sessionNumber: 1, generationNumber: oldGeneration, message: '迟到错误' })).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    await exhibition.reconcileLive(); expect(store.get(session.id).status).toBe('stopped');
    await expect(service.firstFrame(session.id, 150)).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
    await expect(service.link(session.id, 'ums-old')).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
    await expect(exhibition.createLiveSession({ deviceId, lookId: 'commute', generationNumber: oldGeneration })).rejects.toMatchObject({ code: 'EXHIBITION_STALE_GENERATION' });
    const next = await create(exhibition); expect(next.exhibition?.generationNumber).toBe(nextGeneration);
  });

  it('requires a slow timeout stop to finish before the next visitor can begin', async () => {
    const { exhibition, provider, advance, keys } = fixture(); start(exhibition); const session = await create(exhibition);
    let finishStop!: () => void;
    provider.deactivate = token => new Promise(resolve => { finishStop = () => resolve({ ...keys.get(token)!, status: 'inactive' }); });
    advance(20000); const stopping = exhibition.sweepLive(); await vi.waitFor(() => expect(finishStop).toBeTypeOf('function'));
    exhibition.command({ action: 'end' });
    expect(() => exhibition.command({ action: 'begin' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_LIVE_STOP_PENDING' }));
    expect(exhibition.get().sessionNumber).toBe(1);
    finishStop(); await stopping;
    expect(exhibition.get()).toMatchObject({ phase: 'select', sessionNumber: 1, live: null });
    const fresh = exhibition.command({ action: 'begin' }); expect(fresh.sessionNumber).toBe(2);
    expect(exhibition.get()).toMatchObject({ phase: 'generating', sessionNumber: 2, generationNumber: fresh.generationNumber, live: null });
    expect((await create(exhibition)).id).not.toBe(session.id);
  });

  it('coalesces concurrent stop requests and rechecks provider linking after an in-flight stop', async () => {
    const { exhibition, service, provider, keys, store } = fixture(); start(exhibition); const session = await create(exhibition);
    let finishLink!: () => void; let finishStop!: () => void;
    provider.sessionStatus = (_token, sessionUid) => new Promise(resolve => { finishLink = () => resolve({ sessionUid, status: 'ACTIVE', consumedCredit: 1 }); });
    const linking = service.link(session.id, 'ums-late-link');
    const revoke = vi.fn((token: string): Promise<KeyStatus> => new Promise(resolve => { finishStop = () => resolve({ ...keys.get(token)!, status: 'inactive' }); }));
    provider.deactivate = revoke;
    const stopA = service.stop(session.id); const stopB = service.stop(session.id);
    expect(revoke).toHaveBeenCalledTimes(1); finishLink();
    await expect(linking).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
    finishStop(); await Promise.all([stopA, stopB]);
    expect(store.get(session.id).providerSessionId).toBeUndefined(); expect(store.get(session.id).status).toBe('stopped'); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('revokes late issuance after client request cancellation without charging an automatic retry', async () => {
    const { exhibition, provider, keys, deactivate, store } = fixture(); start(exhibition);
    let cancelled = false; let finish!: (issued: IssuedKey) => void;
    provider.issueKey = () => new Promise(resolve => { finish = resolve; });
    const pending = exhibition.createLiveSession({ deviceId, lookId: 'commute', generationNumber: exhibition.get().generationNumber }, { cancelled: () => cancelled });
    await vi.waitFor(() => expect(exhibition.get().live?.sessionId).toBeTruthy()); cancelled = true;
    const issued = { token: 'tk-cancelled', expiresAt: new Date(Date.now() + 120000).toISOString() };
    keys.set(issued.token, { status: 'active', consumedCredit: 0, expireTimestamp: issued.expiresAt }); finish(issued);
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
    expect(deactivate).toHaveBeenCalledWith(issued.token); expect(exhibition.get()).toMatchObject({ phase: 'paused', live: null }); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('handles device errors without automatic retry and rejects stale error reports', async () => {
    const { exhibition, store } = fixture(); start(exhibition); const session = await create(exhibition);
    await expect(exhibition.reportLiveError({ deviceId, sessionId: session.id, lookId: 'city', sessionNumber: 1, generationNumber: exhibition.get().generationNumber, message: '摄像头断开' })).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    const state = await exhibition.reportLiveError({ deviceId, sessionId: session.id, lookId: 'commute', sessionNumber: 1, generationNumber: exhibition.get().generationNumber, message: '连接失败 tk-secret https://example.test/token' });
    expect(state).toMatchObject({ phase: 'paused', live: null }); expect(store.get(session.id).status).toBe('stopped');
    expect(state.logs[0].message).not.toContain('tk-secret'); expect(state.logs[0].message).not.toContain('https://');
  });
});

describe('live HTTP integration uses mock provider only', () => {
  it('links and reports the first frame through mirror-scoped APIs and stops from the staff command', async () => {
    const { service, store, directory } = fixture();
    const mirrors = new ExhibitionMirrors(directory);
    const exhibition = mirrors.getMirror('default');
    const server = createApiServer(service, ['http://xuminghong.local:10200'], undefined, mirrors);
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { 'X-Miror-Protocol': '2', 'X-Miror-Material': 'binding-v1', 'Content-Type': 'application/json', Origin: 'http://xuminghong.local:10200' };
    const mirrorPath = '/api/exhibition/mirrors/default';
    const post = async (path: string, input: unknown) => {
      const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(input) });
      expect(response.ok).toBe(true); return response.json();
    };
    try {
      const before = await fetch(base + mirrorPath + '/live/status'); const status = await before.json();
      expect(status).toMatchObject({ mode: 'demo', perSessionLimit: CONTINUOUS_SEGMENT_CREDITS });
      for (const field of ['totalLimit', 'allocatedCredits', 'remainingCredits']) expect(status).not.toHaveProperty(field);
      await post(mirrorPath + '/command', { action: 'configure', providerMode: 'xmax' });
      expect(await post(mirrorPath + '/command', { action: 'begin' })).toMatchObject({ phase: 'generating', sessionNumber: 1, generationNumber: 1, generationReadyAt: null });
      const session = await post(mirrorPath + '/live/session', { deviceId, lookId: 'commute', generationNumber: exhibition.get().generationNumber });
      await post(`${mirrorPath}/sessions/${session.id}/link`, { providerSessionId: 'ums-http-session' });
      await post(`${mirrorPath}/sessions/${session.id}/first-frame`, { firstFrameMs: 111 });
      expect(exhibition.get().phase).toBe('showcase');
      await post(mirrorPath + '/live/heartbeat', { deviceId, sessionId: session.id });
      const switched = await post(mirrorPath + '/command', { action: 'switch', lookId: 'evening', expectedRevision: exhibition.get().revision });
      expect(switched).toMatchObject({ phase: 'generating', selectedLookId: 'evening', displayedLookId: 'commute', sessionNumber: 1, generationNumber: 2,
        live: { sessionId: session.id, status: 'running', lookId: 'commute' } });
      await exhibition.reconcileLive();
      expect(store.get(session.id).status).toBe('active');
      const intent = { deviceId, lookId: 'evening', sessionNumber: switched.sessionNumber, generationNumber: switched.generationNumber };
      const updated = await post(`${mirrorPath}/live/session/${session.id}/condition`, { ...intent, bindingId: exhibition.readyReference('evening', true)!.bindingId });
      expect(await post(`${mirrorPath}/live/session/${session.id}/condition/applied`, { ...intent, referenceVersion: updated.referenceVersion }))
        .toMatchObject({ phase: 'showcase', displayedLookId: 'evening', live: { sessionId: session.id, status: 'running' } });
      const stopped = await post(mirrorPath + '/command', { action: 'end' }); expect(stopped).toMatchObject({ phase: 'select', live: null });
      expect(store.get(session.id).status).toBe('stopped'); expect(store.list()).toHaveLength(1);
    } finally { server.close(); await once(server, 'close'); }
  });
});
