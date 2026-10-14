import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionService } from '../server/exhibition.ts';
import { TryOnService } from '../server/service.ts';
import { CONTINUOUS_SEGMENT_CREDITS } from '../shared/sessionLimits.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import { ApiError, type IssuedKey, type KeyStatus, type Provider, type ProviderSessionStatus } from '../server/types.ts';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-manual-stop-races-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore(':memory:'); cleanups.push(() => store.close());
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const state = (status: KeyStatus['status'], consumedCredit = 1): KeyStatus => ({ status, consumedCredit, expireTimestamp: expiresAt });
  const revoke = vi.fn(async () => state('inactive', 5));
  const issue = vi.fn(async (): Promise<IssuedKey> => ({ token: 'tk-isolated-manual-stop', expiresAt }));
  const provider: Provider = { configured: true, issueKey: issue, keyStatus: async () => state('active'), deactivate: revoke,
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'ACTIVE', consumedCredit: 1 }) };
  const service = new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), catalog: async () => [], resolveHost: async () => ['93.184.216.34'] });
  const exhibition = new ExhibitionService(directory); exhibition.attachLiveService(service);
  exhibition.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0, switchMode: 'auto', autoSwitchSeconds: 5 });
  exhibition.command({ action: 'begin' });
  const create = () => exhibition.createLiveSession({ deviceId: 'isolated-stop-screen', lookId: 'commute', generationNumber: exhibition.get().generationNumber });
  return { directory, service, exhibition, store, provider, revoke, issue, state, expiresAt, create };
}

describe('manual stop races', () => {
  it('cannot resurrect a confirmed stopped session or reduce usage with a delayed active status reply', async () => {
    const f = fixture(); const session = await f.create();
    const read = deferred<KeyStatus>(); f.provider.keyStatus = () => read.promise;
    const polling = f.service.get(session.id);
    f.exhibition.command({ action: 'end' }); await f.exhibition.reconcileLive();
    expect(f.store.get(session.id)).toMatchObject({ status: 'stopped', consumedCredits: 5 });
    expect(f.exhibition.get()).toMatchObject({ phase: 'select', live: null, autoSwitchAt: null });
    read.resolve(f.state('active', 2));
    expect(await polling).toMatchObject({ status: 'stopped', consumedCredits: 5 });
    expect(f.store.get(session.id)).toMatchObject({ status: 'stopped', consumedCredits: 5 });
    expect(f.issue).toHaveBeenCalledTimes(1); expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('keeps an unconfirmed stop and its error through a delayed active reply, then accepts a manual retry', async () => {
    const f = fixture(); const session = await f.create(); f.exhibition.liveFirstFrame(session.id, 100);
    const read = deferred<KeyStatus>(); let reads = 0;
    f.provider.keyStatus = () => ++reads === 1 ? read.promise : Promise.resolve(f.state('active', 2));
    const polling = f.service.get(session.id);
    f.revoke.mockRejectedValueOnce(new ApiError('ISOLATED_REVOKE_FAILURE', 'isolated failure', 502));
    f.exhibition.command({ action: 'end' }); await f.exhibition.reconcileLive();
    read.resolve(f.state('active', 2));
    expect(await polling).toMatchObject({ status: 'stopping', errorCode: 'ISOLATED_REVOKE_FAILURE', consumedCredits: 2 });
    expect(f.exhibition.get()).toMatchObject({ phase: 'select', autoSwitchAt: null, live: { sessionId: session.id, status: 'error' } });
    expect(() => f.exhibition.command({ action: 'begin' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_LIVE_STOP_PENDING' }));
    f.exhibition.command({ action: 'end' }); await f.exhibition.reconcileLive();
    expect(f.store.get(session.id)).toMatchObject({ status: 'stopped', consumedCredits: 5 });
    expect(f.exhibition.get().live).toBeNull(); expect(f.revoke).toHaveBeenCalledTimes(2);
    expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(f.issue).toHaveBeenCalledTimes(1);
  });

  it('returns the latest stopped state when an earlier status request fails', async () => {
    const f = fixture(); const session = await f.create();
    const read = deferred<KeyStatus>(); f.provider.keyStatus = () => read.promise;
    const polling = f.service.get(session.id);
    await f.service.stop(session.id); read.reject(new Error('isolated status failure'));
    expect(await polling).toMatchObject({ status: 'stopped', consumedCredits: 5 });
  });

  it('does not reduce newer usage when an older stop response arrives, and coalesces concurrent requests', async () => {
    const f = fixture(); const session = await f.create();
    const revoke = deferred<KeyStatus>(); f.revoke.mockImplementation(() => revoke.promise);
    const first = f.service.stop(session.id); const second = f.service.stop(session.id);
    f.provider.keyStatus = async () => f.state('active', 9);
    expect(await f.service.get(session.id)).toMatchObject({ status: 'stopping', consumedCredits: 9 });
    revoke.resolve(f.state('inactive', 3));
    expect(await first).toMatchObject({ status: 'stopped', consumedCredits: 9 });
    expect(await second).toMatchObject({ status: 'stopped', consumedCredits: 9 });
    expect(f.revoke).toHaveBeenCalledTimes(1);
  });

  it.each(['end', 'idle'] as const)('invalidates pending reference binding immediately on %s, before revocation starts', async action => {
    const f = fixture(); const session = await f.create();
    const address = deferred<string[]>(); f.service.options.resolveHost = () => address.promise;
    const binding = f.exhibition.bindLiveReference(session.id, { deviceId: 'isolated-stop-screen', lookId: 'commute', refImageUrl: 'https://uploads.example/isolated.webp' });
    const ended = f.exhibition.command({ action });
    expect(ended).toMatchObject({ autoSwitchAt: null, live: { status: 'stopping' } });
    expect(f.store.get(session.id).status).toBe('stopping'); expect(f.revoke).not.toHaveBeenCalled();
    address.resolve(['93.184.216.34']);
    await expect(binding).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_LOCKED' });
    expect(f.store.get(session.id).refImageUrl).toBe('');
    await f.exhibition.reconcileLive(); expect(f.exhibition.get().live).toBeNull();
  });

  it('rejects delayed linking and first-frame completion immediately after ending', async () => {
    const f = fixture(); const session = await f.create();
    await f.exhibition.bindLiveReference(session.id, { deviceId: 'isolated-stop-screen', lookId: 'commute', refImageUrl: 'https://uploads.example/isolated.webp' });
    const info = deferred<ProviderSessionStatus>(); f.provider.sessionStatus = () => info.promise;
    const linking = f.service.link(session.id, 'ums-isolated-late-link');
    f.exhibition.command({ action: 'end' });
    info.resolve({ sessionUid: 'ums-isolated-late-link', status: 'ACTIVE', consumedCredit: 2 });
    await expect(linking).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
    await expect(f.service.firstFrame(session.id, 123)).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
    f.exhibition.liveFirstFrame(session.id, 123);
    expect(f.exhibition.get()).toMatchObject({ phase: 'select', displayedLookId: null, autoSwitchAt: null });
    expect(f.store.get(session.id).providerSessionId).toBeUndefined();
    await f.exhibition.reconcileLive(); expect(f.exhibition.get().live).toBeNull();
  });

  it('retries revocation with a late token when a tokenless stop is still settling', async () => {
    const f = fixture(); const issued = deferred<IssuedKey>(); f.issue.mockImplementation(() => issued.promise);
    const creating = f.create();
    await vi.waitFor(() => expect(f.store.list()).toHaveLength(1));
    const id = f.store.list()[0].id;
    // Schedule issuance first, so its continuation observes the in-flight tokenless stop.
    issued.resolve({ token: 'tk-isolated-late-stop-race', expiresAt: f.expiresAt });
    const stopping = f.service.stop(id);
    await stopping;
    await expect(creating).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
    expect(f.revoke).toHaveBeenCalledWith('tk-isolated-late-stop-race');
    expect(f.store.get(id).status).toBe('stopped'); expect(f.exhibition.get().live).toBeNull();
    expect(f.issue).toHaveBeenCalledTimes(1); expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('does not turn failed unknown issuance into an apparently revocable session on manual end', async () => {
    const f = fixture(); f.issue.mockRejectedValue(new ApiError('PROVIDER_NETWORK_ERROR', 'isolated timeout', 502));
    await expect(f.create()).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    const id = f.store.list()[0].id;
    for (let index = 0; index < 2; index++) {
      f.service.cancelExhibitionSession(id, 'default');
      expect(f.store.get(id).status).toBe('issuance_unknown');
      f.exhibition.command({ action: 'end' }); await f.exhibition.reconcileLive();
      expect(await f.service.stop(id)).toMatchObject({ status: 'issuance_unknown', errorCode: 'PROVIDER_NETWORK_ERROR' });
      expect(f.exhibition.get()).toMatchObject({ phase: 'select', live: { sessionId: id, status: 'error', localEnded: true, error: '本地体验已结束，云端凭证状态待确认。' } });
    }
    expect(f.revoke).not.toHaveBeenCalled(); expect(f.issue).toHaveBeenCalledOnce(); expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('fences an old reconciliation, heartbeat and first frame after explicit local recovery', async () => {
    const f = fixture(); f.issue.mockRejectedValueOnce(new ApiError('PROVIDER_NETWORK_ERROR', 'isolated timeout', 502));
    await expect(f.create()).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    f.exhibition.command({ action: 'end' }); await f.exhibition.reconcileLive();
    const ended = f.exhibition.get(); const lease = ended.live!; const record = f.store.get(lease.sessionId!);
    const read = deferred<ReturnType<TryOnService['public']>>();
    const reading = vi.spyOn(f.service, 'get').mockImplementationOnce(() => read.promise);
    const reconciling = f.exhibition.reconcileLive();
    await vi.waitFor(() => expect(reading).toHaveBeenCalled());
    const recovered = f.exhibition.command({ action: 'recover' });
    expect(recovered).toMatchObject({ phase: 'select', live: null, generationNumber: ended.generationNumber + 1 });
    const next = f.exhibition.command({ action: 'begin' });
    read.resolve(f.service.public(record)); await reconciling;
    f.exhibition.liveFirstFrame(record.id, 100);
    expect(() => f.exhibition.heartbeat({ deviceId: lease.deviceId, sessionId: record.id })).toThrow(expect.objectContaining({ code: 'EXHIBITION_OWNER_MISMATCH' }));
    await expect(f.exhibition.reportLiveError({ deviceId: lease.deviceId, sessionId: record.id, lookId: lease.lookId,
      sessionNumber: ended.sessionNumber, generationNumber: ended.generationNumber, message: 'isolated late error' })).rejects.toMatchObject({ code: 'EXHIBITION_OWNER_MISMATCH' });
    expect(f.exhibition.get()).toEqual(next); expect(f.store.get(record.id)).toEqual(record);
    await expect(f.create()).resolves.toMatchObject({ status: 'active' });
    expect(f.store.get(record.id)).toEqual(record);
    expect(f.issue).toHaveBeenCalledTimes(2); expect(f.store.allocated()).toBe(2 * CONTINUOUS_SEGMENT_CREDITS); expect(f.revoke).not.toHaveBeenCalled();
  });

  it('checks the cloud record before recovering a stored local-ended marker for a known token', async () => {
    const f = fixture(); const session = await f.create();
    f.revoke.mockRejectedValue(new ApiError('PROVIDER_NETWORK_ERROR', 'isolated timeout', 502));
    f.exhibition.command({ action: 'end' }); await f.exhibition.reconcileLive();
    const stored = JSON.parse(JSON.stringify(f.store.mirrorState('default')));
    stored.state.live.localEnded = true; f.store.saveMirrorState('default', stored, { type: 'fixture-corruption' });
    f.store.update(session.id, { status: 'issuance_unknown' });
    const loaded = new ExhibitionService(f.directory); loaded.attachLiveService(f.service);
    const before = loaded.get(); const record = f.store.get(session.id);
    expect(() => loaded.command({ action: 'recover' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_RECOVERY_UNAVAILABLE' }));
    expect(loaded.get()).toEqual(before); expect(f.store.get(session.id)).toEqual(record);
    expect(f.revoke).toHaveBeenCalledOnce(); expect(f.issue).toHaveBeenCalledOnce(); expect(f.store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });
});
