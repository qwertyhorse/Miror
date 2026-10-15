import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApiServer } from '../server/http.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { IssuedKey, KeyStatus, Provider, SessionRecord } from '../server/types.ts';

const resources: { server: Server; store: SessionStore; directory: string }[] = [];
const origin = 'http://127.0.0.1:5173';
const currentKey = 'uk-isolated-orphan-current';
const historicalKey = 'uk-isolated-orphan-original-signer';
const historicalToken = 'tk-isolated-orphan-old';
const deviceId = 'android-033-orphan-http-fixture';

afterEach(async () => {
  for (const { server, store, directory } of resources.splice(0)) {
    const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
    store.close(); await rm(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function fixture() {
  let now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const directory = await mkdtemp(join(tmpdir(), 'openbuy-orphan-recovery-http-'));
  const store = new SessionStore(':memory:'); store.activateApiKeyBudget(currentKey);
  const secrets = new SecretBox(randomBytes(32));
  const keys = new Map<string, KeyStatus>();
  const keyInfo = (status: KeyStatus['status']): KeyStatus => ({ status, consumedCredit: 7, expireTimestamp: new Date(now + 120_000).toISOString() });
  keys.set(historicalToken, keyInfo('active'));
  let issued = 0;
  const issue = vi.fn(async (): Promise<IssuedKey> => {
    const token = `tk-isolated-orphan-new-${++issued}`;
    const value = keyInfo('active'); keys.set(token, value);
    return { token, expiresAt: value.expireTimestamp };
  });
  const keyStatus = vi.fn(async (_credential: string, token: string): Promise<KeyStatus> => ({ ...keys.get(token)! }));
  const deactivate = vi.fn(async (_credential: string, token: string): Promise<KeyStatus> => {
    const value = { ...keys.get(token)!, status: 'inactive' as const }; keys.set(token, value); return value;
  });
  const provider = (credential: string): Provider => ({
    configured: true, credentialSnapshot: () => credential, issueKey: issue,
    keyStatus: token => keyStatus(credential, token), deactivate: token => deactivate(credential, token),
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'active', consumedCredit: 1 }),
  });
  const service = new LifecycleTryOnService({ provider: provider(currentKey), providerForApiKey: provider, store, secrets });
  const mirrors = new ExhibitionMirrors(directory, { now: () => now }); mirrors.attachLiveService(service);
  const mirror = mirrors.getMirror('default');
  mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
  // Reproduce the installed Android client's paused state, with no current live lease.
  mirror.command({ action: 'begin' }); mirror.command({ action: 'pause' });
  const server = createApiServer(service, undefined, undefined, mirrors);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  resources.push({ server, store, directory });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors/default`;
  const post = (path: string, input: unknown) => fetch(base + path, {
    method: 'POST', headers: { origin, 'X-Miror-Protocol': '2', 'X-Miror-Material': 'binding-v1', 'Content-Type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(2_000),
  });
  const resume = () => post('/command', { action: 'resume', commandId: randomUUID(), expectedRevision: mirror.get().revision });
  const start = () => {
    const state = mirror.get();
    return post('/live/session', { deviceId, lookId: state.selectedLookId,
      generationNumber: state.generationNumber, expectedRevision: state.revision });
  };
  const seedOrphan = (knownToken: boolean) => {
    const state = mirror.get(); const timestamp = new Date(now - 60_000).toISOString();
    const record: SessionRecord = {
      id: randomUUID(), status: knownToken ? 'stopping' : 'issuance_unknown',
      targetItemId: state.selectedLookId!, sourceId: 'exhibition:previous-terminal', sourceKind: 'camera', sourceName: 'Isolated historical session',
      pointsLimit: 30, refImageUrl: '', referenceVersion: 0, consumedCredits: 0, resultAvailable: false, verification: 'none',
      providerKeyCipher: secrets.encrypt(historicalKey), providerRegion: 'global', errorCode: 'PROVIDER_NETWORK_ERROR',
      ...(knownToken ? { tokenCipher: secrets.encrypt(historicalToken), expiresAt: new Date(now + 120_000).toISOString() } : {}),
      exhibition: { mirrorId: 'default', deviceId: 'previous-terminal', lookId: state.selectedLookId!, sessionNumber: 1, generationNumber: 1, mode: 'clothx' },
      createdAt: timestamp, updatedAt: timestamp,
    };
    store.reserve(record);
    return record;
  };
  return { store, secrets, mirror, mirrors, issue, keyStatus, deactivate, keys, keyInfo, base, post, resume, start, seedOrphan,
    advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('updated material-capable client recovery from detached historical sessions over HTTP', () => {
  it('resumes a paused mirror past tokenless unknown history without claiming revocation or replacing its signing key', async () => {
    const f = await fixture(); const old = f.seedOrphan(false); const paused = f.mirror.get();
    expect(paused).toMatchObject({ phase: 'paused', live: null });
    await f.mirrors.sweepLive();
    expect(f.issue).not.toHaveBeenCalled(); expect(f.keyStatus).not.toHaveBeenCalled(); expect(f.deactivate).not.toHaveBeenCalled();
    expect(f.store.get(old.id)).toEqual(old);

    const resumed = await f.resume(); expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ phase: 'generating', live: null,
      sessionNumber: paused.sessionNumber, generationNumber: paused.generationNumber + 1 });
    expect(f.issue).not.toHaveBeenCalled();
    const response = await f.start(); expect(response.status).toBe(201); const created = await response.json();
    expect(created.id).not.toBe(old.id);
    expect(created).toMatchObject({ status: 'active', exhibition: { deviceId,
      sessionNumber: paused.sessionNumber, generationNumber: paused.generationNumber + 1 } });
    expect(created).not.toHaveProperty('providerKeyCipher'); expect(created).not.toHaveProperty('tokenCipher');
    expect(f.store.get(old.id)).toEqual(old);
    expect(f.secrets.decrypt(f.store.get(old.id).providerKeyCipher!)).toBe(historicalKey);
    expect(f.store.get(old.id).status).toBe('issuance_unknown'); expect(f.store.list()).toHaveLength(2);
    expect(f.issue).toHaveBeenCalledOnce(); expect(f.deactivate).not.toHaveBeenCalled();
  });

  it('keeps a known-token orphan blocking after revoke failure, then permits the same client flow after provider confirmation', async () => {
    const f = await fixture(); const old = f.seedOrphan(true);
    f.deactivate.mockRejectedValue(new Error('isolated lost revoke response'));
    const resumed = await f.resume(); expect(resumed.status).toBe(200); await resumed.json();
    const blocked = await f.start(); expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: 'EXHIBITION_LIVE_STOP_PENDING' } });
    expect(f.store.get(old.id)).toMatchObject({ status: 'stopping', tokenCipher: old.tokenCipher, providerKeyCipher: old.providerKeyCipher });
    expect(f.keyStatus).toHaveBeenCalledWith(historicalKey, historicalToken);
    expect(f.deactivate).toHaveBeenCalledWith(historicalKey, historicalToken);
    expect(f.issue).not.toHaveBeenCalled();

    // The installed APK reports the failed allocation without a session ID and returns to paused.
    const attempted = f.mirror.get();
    const report = await f.post('/live/error', { deviceId, lookId: attempted.selectedLookId,
      sessionNumber: attempted.sessionNumber, generationNumber: attempted.generationNumber,
      reason: 'provider_rejected', message: '旧连接尚未确认释放。' });
    expect(report.status).toBe(200); const paused = await report.json();
    expect(paused).toMatchObject({ phase: 'paused', live: null });

    const revokeAttempts = f.deactivate.mock.calls.length;
    f.keys.set(historicalToken, f.keyInfo('inactive')); f.advance(6_000);
    await f.mirrors.sweepLive();
    expect(f.store.get(old.id)).toMatchObject({ status: 'stopped', consumedCredits: 7,
      tokenCipher: old.tokenCipher, providerKeyCipher: old.providerKeyCipher });
    expect(f.deactivate).toHaveBeenCalledTimes(revokeAttempts);
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.mirror.get()).toMatchObject({ phase: 'paused', live: null, generationNumber: paused.generationNumber });

    const retry = await f.resume(); expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ phase: 'generating', generationNumber: paused.generationNumber + 1 });
    expect(f.issue).not.toHaveBeenCalled();
    const created = await f.start(); expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ status: 'active', exhibition: { deviceId, generationNumber: paused.generationNumber + 1 } });
    expect(f.issue).toHaveBeenCalledOnce();
  });

  it('proactively revokes a detached active token with its original signer without starting a new experience', async () => {
    const f = await fixture(); const old = f.seedOrphan(true);
    f.store.update(old.id, { status: 'active' }); const paused = f.mirror.get();
    await f.mirrors.sweepLive(); await f.mirrors.sweepLive();
    expect(f.keyStatus).toHaveBeenCalledWith(historicalKey, historicalToken);
    expect(f.deactivate).toHaveBeenCalledExactlyOnceWith(historicalKey, historicalToken);
    expect(f.store.get(old.id)).toMatchObject({ status: 'stopped', providerKeyCipher: old.providerKeyCipher });
    expect(f.store.list()).toHaveLength(1); expect(f.issue).not.toHaveBeenCalled();
    const response = await fetch(f.base, { signal: AbortSignal.timeout(2_000) }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: 'paused', live: null,
      generationNumber: paused.generationNumber, sessionNumber: paused.sessionNumber });
    expect(f.issue).not.toHaveBeenCalled();
  });
});
