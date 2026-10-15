import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionService } from '../server/exhibition.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import { ApiError, type IssuedKey, type KeyStatus, type Provider, type SessionRecord } from '../server/types.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-release-recovery-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore(':memory:'); cleanups.push(() => store.close());
  const secrets = new SecretBox(randomBytes(32)); const keys = new Map<string, KeyStatus>();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const status = (value: KeyStatus['status'], consumedCredit = 1): KeyStatus => ({ status: value, consumedCredit, expireTimestamp: expiresAt });
  const issue = vi.fn(async (): Promise<IssuedKey> => {
    const token = `tk-isolated-${randomUUID()}`; keys.set(token, status('active')); return { token, expiresAt };
  });
  const query = vi.fn(async (token: string) => keys.get(token)!);
  const revoke = vi.fn(async (token: string) => { const result = status('inactive', 3); keys.set(token, result); return result; });
  const provider: Provider = { configured: true, region: 'cn', credentialSnapshot: () => 'uk-isolated-original',
    issueKey: issue, keyStatus: query, deactivate: revoke,
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'ACTIVE', consumedCredit: 1 }) };
  const providerForApiKey = vi.fn(() => provider);
  const service = new LifecycleTryOnService({ store, secrets, provider, providerForApiKey });
  const mirror = new ExhibitionService(directory); mirror.attachLiveService(service);
  mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
  const create = () => mirror.createLiveSession({ deviceId: 'isolated-recovery-screen', lookId: 'commute', generationNumber: mirror.get().generationNumber });
  const orphan = (mirrorId = 'default') => service.createExhibition({ mirrorId, lookId: 'commute', deviceId: 'isolated-recovery-screen',
    name: 'isolated', referenceAsset: '/assets/exhibition/commute-cutout.png', sessionNumber: 1, generationNumber: 1 });
  const unknown = (patch: Partial<SessionRecord> = {}) => {
    const record: SessionRecord = { id: randomUUID(), status: 'issuance_unknown', pointsLimit: 30,
      sourceId: 'exhibition:isolated-recovery-screen', sourceKind: 'camera', sourceName: 'isolated', targetItemId: 'commute',
      providerKeyCipher: secrets.encrypt('uk-isolated-original'), providerRegion: 'cn',
      refImageUrl: '', referenceVersion: 0, consumedCredits: 0, resultAvailable: false, verification: 'none',
      errorCode: 'PROVIDER_NETWORK_ERROR', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
      exhibition: { mirrorId: 'default', lookId: 'commute', deviceId: 'isolated-recovery-screen', sessionNumber: 1, generationNumber: 1 }, ...patch };
    store.reserve(record); return record;
  };
  return { store, service, mirror, issue, query, revoke, status, keys, expiresAt, create, orphan, unknown, provider, providerForApiKey };
}

describe('mirror release recovery', () => {
  it('archives detached tokenless unknown history unchanged and starts only after an explicit request', async () => {
    const f = fixture(); const history = Array.from({ length: 14 }, () => f.unknown());
    const before = f.mirror.get(); await f.mirror.sweepLive();
    expect(f.mirror.get()).toEqual(before); expect(f.issue).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled(); expect(f.revoke).not.toHaveBeenCalled();
    f.mirror.command({ action: 'begin' }); const session = await f.create();
    expect(session.status).toBe('active'); expect(f.issue).toHaveBeenCalledOnce();
    for (const record of history) expect(f.store.get(record.id)).toEqual(record);
    expect(f.store.list()).toHaveLength(15);
  });

  it('keeps current unknown issuance blocked until explicit end and local recovery', async () => {
    const f = fixture(); f.mirror.command({ action: 'begin' });
    f.issue.mockRejectedValueOnce(new ApiError('PROVIDER_NETWORK_ERROR', 'isolated timeout', 502));
    await expect(f.create()).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    const record = f.store.list()[0]; await f.mirror.sweepLive();
    expect(() => f.mirror.command({ action: 'resume' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_LIVE_STOP_PENDING' }));
    f.mirror.command({ action: 'end' }); await f.mirror.reconcileLive(); f.mirror.command({ action: 'recover' });
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.store.get(record.id)).toEqual(record);
    f.mirror.command({ action: 'begin' }); await f.create();
    expect(f.issue).toHaveBeenCalledTimes(2); expect(f.store.get(record.id)).toEqual(record);
  });

  it.each([{ expiresAt: '2020-01-01T00:00:00.000Z' }, { providerSessionId: 'ums-isolated-unknown' }])(
    'does not discard unknown history with additional cloud identity: %j', async patch => {
      const f = fixture(); const record = f.unknown(patch); f.mirror.command({ action: 'begin' });
      await expect(f.create()).rejects.toMatchObject({ code: 'EXHIBITION_LIVE_STOP_PENDING' });
      expect(f.store.get(record.id)).toEqual(record); expect(f.issue).not.toHaveBeenCalled();
    });

  it.each(['active', 'stopping', 'reserved', 'issuance_unknown', 'error'] as const)(
    'revokes a detached known token in %s using its frozen key and region', async status => {
      const f = fixture(); const record = await f.orphan(); f.store.update(record.id, { status });
      f.provider.credentialSnapshot = () => 'uk-isolated-replaced';
      await f.mirror.sweepLive();
      expect(f.store.get(record.id)).toMatchObject({ status: 'stopped', consumedCredits: 3 });
      expect(f.query).toHaveBeenCalledWith(record.token); expect(f.revoke).toHaveBeenCalledWith(record.token);
      expect(f.providerForApiKey).toHaveBeenCalledWith('uk-isolated-original', 'cn');
      expect(f.issue).toHaveBeenCalledOnce(); expect(f.mirror.get().phase).toBe('select');
    });

  it('accepts an already inactive orphan without sending another revoke', async () => {
    const f = fixture(); const record = await f.orphan(); f.keys.set(record.token, f.status('inactive', 9));
    await f.mirror.sweepLive();
    expect(f.store.get(record.id)).toMatchObject({ status: 'stopped', consumedCredits: 9 });
    expect(f.revoke).not.toHaveBeenCalled();
  });

  it('settles a detached known token before servicing an explicit new-session request', async () => {
    const f = fixture(); const previous = await f.orphan(); f.mirror.command({ action: 'begin' });
    const next = await f.create();
    expect(next.id).not.toBe(previous.id); expect(next.status).toBe('active');
    expect(f.store.get(previous.id).status).toBe('stopped'); expect(f.issue).toHaveBeenCalledTimes(2);
    expect(f.revoke).toHaveBeenCalledExactlyOnceWith(previous.token);
    expect(f.revoke.mock.invocationCallOrder[0]).toBeLessThan(f.issue.mock.invocationCallOrder[1]);
  });

  it.each(['inactive', 'timeout'] as const)('confirms %s after the revocation response is lost', async status => {
    const f = fixture(); const record = await f.orphan();
    f.revoke.mockImplementationOnce(async token => { f.keys.set(token, f.status(status, 7)); throw new Error('isolated response loss'); });
    await expect(f.service.stop(record.id)).resolves.toMatchObject({ status: 'stopped', consumedCredits: 7 });
    expect(f.query).toHaveBeenCalledOnce(); expect(f.revoke).toHaveBeenCalledOnce(); expect(f.issue).toHaveBeenCalledOnce();
  });

  it('confirms status after a revoke returns active, without treating that response as confirmation', async () => {
    const f = fixture(); const record = await f.orphan();
    f.revoke.mockResolvedValueOnce(f.status('active')); f.query.mockResolvedValueOnce(f.status('inactive', 8));
    await expect(f.service.stop(record.id)).resolves.toMatchObject({ status: 'stopped', consumedCredits: 8 });
  });

  it.each([false, true])('retains an unconfirmed known token and throttles retries (status fails: %s)', async queryFails => {
    const f = fixture(); const record = await f.orphan(); let time = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => time);
    f.revoke.mockRejectedValue(new ApiError('PROVIDER_NETWORK_ERROR', 'isolated outage', 502));
    if (queryFails) f.query.mockRejectedValue(new Error('isolated query outage'));
    await f.mirror.sweepLive();
    expect(f.store.get(record.id)).toMatchObject({ status: 'stopping', errorCode: 'PROVIDER_NETWORK_ERROR' });
    expect(f.service.hasBlockingMirrorSessions('default')).toBe(true); expect(f.revoke).toHaveBeenCalledOnce();
    f.mirror.command({ action: 'begin' }); await expect(f.create()).rejects.toMatchObject({ code: 'EXHIBITION_LIVE_STOP_PENDING' });
    await f.mirror.sweepLive(); time += 4999; await f.mirror.sweepLive(); expect(f.revoke).toHaveBeenCalledOnce();
    time += 1; await f.mirror.sweepLive(); expect(f.revoke).toHaveBeenCalledTimes(2); expect(f.issue).toHaveBeenCalledOnce();
  });

  it('does not touch another mirror or the current live lease while cleaning an orphan', async () => {
    const f = fixture(); f.mirror.command({ action: 'begin' }); const current = await f.create();
    const other = await f.orphan('other-mirror'); const detached = await f.orphan();
    await f.mirror.sweepLive();
    expect(f.store.get(current.id).status).toBe('active'); expect(f.store.get(other.id).status).toBe('active');
    expect(f.store.get(detached.id).status).toBe('stopped');
    expect(f.query).toHaveBeenCalledTimes(1); expect(f.revoke).toHaveBeenCalledExactlyOnceWith(detached.token);
  });

  it('coalesces concurrent cleanup and stop calls for a detached token', async () => {
    const f = fixture(); const record = await f.orphan(); const read = deferred<KeyStatus>(); f.query.mockImplementationOnce(() => read.promise);
    const first = f.service.reconcileMirrorSessions('default'); const second = f.service.reconcileMirrorSessions('default');
    expect(first).toBe(second); expect(f.query).toHaveBeenCalledOnce();
    read.resolve(f.status('active')); await Promise.all([first, second]);
    expect(f.revoke).toHaveBeenCalledOnce(); expect(f.store.get(record.id).status).toBe('stopped');
  });

  it('keeps in-flight issuance fenced and never revokes or duplicates it', async () => {
    const f = fixture(); const issued = deferred<IssuedKey>(); f.issue.mockImplementationOnce(() => issued.promise);
    const creating = f.orphan(); const record = f.store.list()[0];
    f.mirror.command({ action: 'begin' }); await f.mirror.sweepLive();
    await expect(f.create()).rejects.toMatchObject({ code: 'EXHIBITION_LIVE_STOP_PENDING' });
    expect(f.store.get(record.id).status).toBe('reserved'); expect(f.query).not.toHaveBeenCalled(); expect(f.revoke).not.toHaveBeenCalled();
    f.keys.set('tk-isolated-late', f.status('active')); issued.resolve({ token: 'tk-isolated-late', expiresAt: f.expiresAt });
    await creating; expect(f.issue).toHaveBeenCalledOnce(); await f.mirror.sweepLive();
    expect(f.store.get(record.id).status).toBe('stopped'); expect(f.revoke).toHaveBeenCalledExactlyOnceWith('tk-isolated-late');
  });
});
