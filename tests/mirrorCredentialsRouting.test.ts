import { createHash } from 'node:crypto';
import { ReferenceAssets } from '../server/referenceAssets.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MirrorCredentialStore } from '../server/mirrorCredentials.ts';
import { XmaxProvider } from '../server/provider.ts';
import { TryOnService } from '../server/service.ts';
import { ExhibitionService } from '../server/exhibition.ts';
import { CONTINUOUS_SEGMENT_CREDITS } from '../shared/sessionLimits.ts';
import { apiKeyBudgetScope, SecretBox, SessionStore } from '../server/store.ts';
import { ApiError, type SessionRecord } from '../server/types.ts';
import type { XmaxRegion } from '../shared/xmax.ts';

const keyDefault = 'uk-isolated-default-routing-fixture';
const keyA = 'uk-isolated-east-routing-fixture';
const keyB = 'uk-isolated-west-routing-fixture';
const keyC = 'uk-isolated-new-routing-fixture';
const expiry = '2099-10-10T00:00:00.000Z';
const directories: string[] = [];
const stores: SessionStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function openStore(filename: string) { const store = new SessionStore(filename); stores.push(store); return store; }
function closeStore(store: SessionStore) { stores.splice(stores.indexOf(store), 1); store.close(); }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'openbuy-mirror-credential-routing-'));
  directories.push(directory);
  const database = join(directory, 'sessions.sqlite');
  const secrets = SecretBox.forDirectory(directory);
  const store = openStore(database);
  store.activateApiKeyBudget(keyDefault);
  const credentials = new MirrorCredentialStore(directory, secrets);
  const requests: { method: string; path: string; hostname: string; credential: string }[] = [];
  const issued = new Map<string, { key: string; active: boolean; hostname?: string }>();
  let nextToken = 0;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const credential = new Headers(init?.headers).get('X-Api-Key') ?? '';
    const method = init?.method ?? 'GET';
    requests.push({ method, path: url.pathname, hostname: url.hostname, credential });
    const ok = (data: unknown) => Response.json({ success: true, data });
    if (url.pathname.endsWith('/temporary-api-key') && method === 'POST') {
      const token = `tk-routing-fixture-${++nextToken}`;
      issued.set(token, { key: credential, active: true, hostname: url.hostname });
      return ok({ temporaryApiKey: token, expireTimestamp: expiry });
    }
    const keyRequest = /\/temporary-api-key\/([^/]+)\/(status|inactive)$/.exec(url.pathname);
    if (keyRequest) {
      const entry = issued.get(keyRequest[1]);
      if (!entry || credential !== entry.key || (entry.hostname && entry.hostname !== url.hostname)) return Response.json({ success: false }, { status: 403 });
      if (keyRequest[2] === 'inactive') entry.active = false;
      return ok({ status: entry.active ? 'active' : 'inactive', consumedCredit: 3, expireTimestamp: expiry });
    }
    const sessionRequest = /\/session\/([^/]+)\/status$/.exec(url.pathname);
    if (sessionRequest && issued.has(credential)) return ok({ sessionUid: sessionRequest[1], status: 'active', consumedCredit: 2 });
    throw new Error('Unexpected isolated provider request');
  }) as typeof fetch;
  const provider = new XmaxProvider(keyDefault, fetcher);
  const providerFactory = vi.fn((key: string, region: XmaxRegion = 'global') => new XmaxProvider(key, fetcher, region));
  const createService = (currentStore = store, currentSecrets = secrets, currentCredentials = credentials) => new TryOnService({
    provider, store: currentStore, secrets: currentSecrets, mirrorCredentials: currentCredentials, providerForApiKey: providerFactory,
    referenceAssets: new ReferenceAssets(directory), referenceStorage: () => ({ upload: async () => 'https://fixture-123.cos.ap-test.myqcloud.com/reference.png', check: async () => true }),
    resolveHost: async () => ['93.184.216.34'],
  });
  const service = createService();
  const save = (mirrorId: string, apiKey: string, region: XmaxRegion = 'global') => service.saveMirrorCredentials(mirrorId, { apiKey, region, expectedRevision: service.mirrorCredentialsStatus(mirrorId).revision });
  return { directory, database, secrets, store, credentials, requests, issued, provider, providerFactory, service, createService, save };
}

async function bindPrepared(service: TryOnService, id: string, mirrorId: string) {
  const bytes = Buffer.from('fixture'); const mime = 'image/png'; const prepared = (await service.prepareReference(mirrorId, bytes, mime))!;
  return service.bindExhibitionReference(id, { mirrorId, deviceId: `screen-${mirrorId}`, lookId: 'commute', bindingId: prepared.bindingId }, { sha256: createHash('sha256').update(bytes).digest('hex'), mime });
}
function create(service: TryOnService, mirrorId: string, hooks?: Parameters<TryOnService['createExhibition']>[1]) {
  return service.createExhibition({ mirrorId, lookId: 'commute', deviceId: `screen-${mirrorId}`, name: '隔离测试服装', referenceAsset: '/assets/exhibition/commute-cutout.png', mode: 'clothx', sessionNumber: 1, generationNumber: 1 }, hooks);
}

function legacyRecord(id: string, tokenCipher?: string): SessionRecord {
  return { id, targetItemId: 'commute', sourceId: 'legacy-fixture', sourceName: '隔离历史会话', sourceKind: 'camera', status: tokenCipher ? 'active' : 'stopped', pointsLimit: 30,
    tokenCipher, refImageUrl: '', referenceVersion: 0, consumedCredits: 0, resultAvailable: false, verification: 'none', createdAt: expiry, updatedAt: expiry };
}

describe('per-mirror credential routing and persistent session history', () => {
  it('issues concurrent mirrors through their own keys and keeps all later provider paths on the frozen credential', async () => {
    const f = await fixture(); f.save('east', keyA); f.save('west', keyB);
    const [east, west] = await Promise.all([create(f.service, 'east'), create(f.service, 'west')]);
    expect(f.requests.filter(row => row.method === 'POST').map(row => row.credential)).toEqual([keyA, keyB]);
    expect(f.store.currentBudgetScope()).toBe(apiKeyBudgetScope(keyDefault));
    expect(f.secrets.decrypt(f.store.get(east.id).providerKeyCipher!)).toBe(keyA);
    expect(f.secrets.decrypt(f.store.get(west.id).providerKeyCipher!)).toBe(keyB);
    // Clearing the mutable default must not disable existing mirror sessions.
    f.provider.setApiKey('');
    for (const [session, mirrorId, originalKey] of [[east, 'east', keyA], [west, 'west', keyB]] as const) {
      expect(await f.service.get(session.id)).toMatchObject({ consumedCredits: 3, status: 'active' });
      await bindPrepared(f.service, session.id, mirrorId);
      const providerSessionId = `ums-routing-${mirrorId}`;
      await f.service.link(session.id, providerSessionId);
      // Linking is idempotent and still verifies the session with its frozen credential.
      await f.service.link(session.id, providerSessionId);
      expect(await f.service.stop(session.id)).toMatchObject({ status: 'stopped' });
      const keyCalls = f.requests.filter(row => row.path.includes(`/temporary-api-key/${session.token}/`));
      expect(keyCalls.map(row => row.credential)).toEqual([originalKey, originalKey]);
      expect(f.requests.filter(row => row.path.includes(`/session/${providerSessionId}/`)).map(row => row.credential)).toEqual([session.token, session.token]);
    }
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(30);
    expect(f.store.allocated(apiKeyBudgetScope(keyB))).toBe(30);
    for (const id of ['east', 'west']) for (const field of ['totalLimit', 'allocatedCredits', 'remainingCredits']) expect(f.service.status(id)).not.toHaveProperty(field);
  });

  it('recovers active sessions with their persisted signing keys after restart and a different default', async () => {
    const f = await fixture(); f.save('east', keyA); f.save('west', keyB);
    const east = await create(f.service, 'east'); const west = await create(f.service, 'west');
    closeStore(f.store);
    f.provider.setApiKey(keyC);
    const restartedSecrets = SecretBox.forDirectory(f.directory);
    const restartedStore = openStore(f.database);
    restartedStore.activateApiKeyBudget(keyC);
    const restartedCredentials = new MirrorCredentialStore(f.directory, restartedSecrets);
    const restarted = f.createService(restartedStore, restartedSecrets, restartedCredentials);
    await restarted.recover();
    expect(restartedStore.get(east.id).status).toBe('stopped');
    expect(restartedStore.get(west.id).status).toBe('stopped');
    expect(f.requests.filter(row => row.path.endsWith('/inactive')).map(row => row.credential)).toEqual([keyA, keyB]);
    expect(restarted.mirrorCredentialsStatus('east')).toMatchObject({ source: 'mirror', revision: 1 });
    expect(restartedStore.allocated(apiKeyBudgetScope(keyA))).toBe(30);
    expect(restartedStore.allocated(apiKeyBudgetScope(keyB))).toBe(30);
    expect(restarted.status()).not.toHaveProperty('allocatedCredits');
  });

  it('queries historical usage with the original key after its mirror rotates to another key', async () => {
    const f = await fixture(); f.save('east', keyA);
    const old = await create(f.service, 'east');
    await bindPrepared(f.service, old.id, 'east');
    await f.service.link(old.id, 'ums-routing-historical');
    await f.service.stop(old.id);
    f.save('east', keyB);
    f.provider.setApiKey(keyC);
    f.requests.splice(0); f.providerFactory.mockClear();
    expect(await f.service.get(old.id)).toMatchObject({ status: 'stopped', consumedCredits: 3 });
    expect(f.providerFactory.mock.calls.map(([key]) => key)).toEqual([keyA]);
    expect(f.requests[0].credential).toBe(keyA);
    expect(f.service.mirrorCredentialsStatus('east')).toMatchObject({ revision: 2 });
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(30);
  });

  it('allows mirrors sharing a key to continue beyond the ordinary local test limit while retaining key scopes', async () => {
    const f = await fixture(); f.save('east', keyA); f.save('west', keyA); f.save('north', keyB);
    const a = await create(f.service, 'east'); const b = await create(f.service, 'west');
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(60);
    await f.service.stop(a.id); await f.service.stop(b.id);
    const third = await create(f.service, 'east'); await f.service.stop(third.id);
    expect(f.requests.filter(row => row.method === 'POST')).toHaveLength(3);
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(90);
    await create(f.service, 'north'); await create(f.service, 'south');
    expect(f.store.allocated(apiKeyBudgetScope(keyB))).toBe(30);
    expect(f.store.allocated(apiKeyBudgetScope(keyDefault))).toBe(30);
    expect(f.service.status()).not.toHaveProperty('allocatedCredits');
    expect(f.store.list()).toHaveLength(5);
  });

  it('does not reset allocations when saving the same key, rotating away and back, or reopening storage', async () => {
    const f = await fixture(); f.save('east', keyA);
    const a = await create(f.service, 'east'); await f.service.stop(a.id);
    expect(f.save('east', keyA)).toMatchObject({ revision: 2 });
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(30);
    expect(f.save('east', keyB)).toMatchObject({ revision: 3 });
    const b = await create(f.service, 'east'); await f.service.stop(b.id);
    expect(f.save('east', keyA)).toMatchObject({ revision: 4 });
    closeStore(f.store);
    const restartedStore = openStore(f.database);
    const restarted = f.createService(restartedStore, f.secrets, new MirrorCredentialStore(f.directory, f.secrets));
    expect(restarted.mirrorCredentialsStatus('east')).toMatchObject({ revision: 4 });
    expect(restartedStore.allocated(apiKeyBudgetScope(keyA))).toBe(30);
    expect(restartedStore.allocated(apiKeyBudgetScope(keyB))).toBe(30);
    const second = await create(restarted, 'east'); await restarted.stop(second.id);
    const third = await create(restarted, 'east'); await restarted.stop(third.id);
    expect(restartedStore.allocated(apiKeyBudgetScope(keyA))).toBe(90);
    expect(restartedStore.list()).toHaveLength(4);
  });

  it('locks only the mirror with a pending reservation and leaves another mirror editable', async () => {
    const f = await fixture(); f.save('east', keyA);
    let reservedId = '';
    let pendingStatus: ReturnType<TryOnService['mirrorCredentialsStatus']> | undefined;
    const pending = create(f.service, 'east', { onReserved: id => {
      reservedId = id; pendingStatus = f.service.mirrorCredentialsStatus('east');
      expect(() => f.save('east', keyC)).toThrowError(expect.objectContaining({ code: 'EXHIBITION_MIRROR_BUSY' }));
      expect(f.save('west', keyB)).toMatchObject({ editable: true, source: 'mirror' });
    } });
    const session = await pending;
    expect(reservedId).toBe(session.id); expect(pendingStatus?.editable).toBe(false);
    expect(f.service.mirrorCredentialsStatus('west').editable).toBe(true);
    expect(() => f.service.saveMirrorCredentials('west', { apiKey: keyC, expectedRevision: 1 }, false)).toThrowError(expect.objectContaining({ code: 'EXHIBITION_MIRROR_BUSY' }));
    await f.service.stop(session.id);
    expect(f.service.mirrorCredentialsStatus('east').editable).toBe(true);
  });

  it('allows future credential configuration for frozen unknown issuance without releasing its ownership or deleting history', async () => {
    const f = await fixture(); f.save('east', keyA);
    const provider = f.service.options.providerForApiKey!;
    const issue = vi.fn(async () => { throw new ApiError('PROVIDER_NETWORK_ERROR', '隔离超时', 502); });
    f.service.options.providerForApiKey = (key, region) => {
      const current = provider(key, region);
      if (key === keyA) current.issueKey = issue;
      return current;
    };
    const exhibition = new ExhibitionService(join(f.directory, 'east'), { mirrorId: 'east' }); exhibition.attachLiveService(f.service);
    exhibition.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 }); await exhibition.prepareReference('commute'); exhibition.command({ action: 'begin' });
    const createLive = () => exhibition.createLiveSession({ deviceId: 'screen-east', lookId: 'commute', generationNumber: exhibition.get().generationNumber });
    await expect(createLive()).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    const record = f.store.list()[0]; const paused = exhibition.get();
    expect(record).toMatchObject({ status: 'issuance_unknown', providerRegion: 'global' });
    expect(f.secrets.decrypt(record.providerKeyCipher!)).toBe(keyA);
    expect(exhibition.credentialsEditable()).toBe(true);
    expect(f.service.mirrorCredentialsStatus('east', exhibition.credentialsEditable())).toMatchObject({ editable: true, hasUnconfirmedSession: true, region: 'global' });
    expect(f.service.saveMirrorCredentials('east', { apiKey: keyB, region: 'cn', expectedRevision: 1 }, exhibition.credentialsEditable())).toMatchObject({ revision: 2, editable: true, hasUnconfirmedSession: true, region: 'cn' });
    expect(exhibition.get()).toEqual(paused); expect(f.store.get(record.id)).toEqual(record);
    expect(() => exhibition.command({ action: 'resume' })).toThrowError(expect.objectContaining({ code: 'EXHIBITION_LIVE_STOP_PENDING' }));
    await expect(createLive()).rejects.toMatchObject({ code: 'EXHIBITION_RECOVERY_REQUIRED' });
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(CONTINUOUS_SEGMENT_CREDITS); expect(f.store.allocated(apiKeyBudgetScope(keyB))).toBe(0);
    expect(f.store.currentBudgetScope()).toBe(apiKeyBudgetScope(keyDefault)); expect(issue).toHaveBeenCalledOnce(); expect(f.requests).toHaveLength(0);
    await f.service.recover();
    expect(f.store.get(record.id)).toEqual(record);
    expect(f.store.allocated(apiKeyBudgetScope(keyB))).toBe(0);
  });

  it.each(['missing', 'damaged'] as const)('does not replace credentials for unknown issuance with a %s signing snapshot', async snapshot => {
    const f = await fixture(); f.save('east', keyA);
    f.service.options.providerForApiKey = (key, region) => {
      const provider = f.provider.forCredential(key, region);
      provider.issueKey = async () => { throw new ApiError('PROVIDER_NETWORK_ERROR', '隔离超时', 502); }; return provider;
    };
    await expect(create(f.service, 'east')).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    const id = f.store.list()[0].id; f.store.update(id, { providerKeyCipher: snapshot === 'missing' ? undefined : 'damaged-fixture' });
    expect(f.service.mirrorCredentialsStatus('east')).toMatchObject({ editable: false, hasUnconfirmedSession: true });
    expect(() => f.save('east', keyB, 'cn')).toThrowError(expect.objectContaining({ code: 'EXHIBITION_MIRROR_BUSY' }));
    expect(f.credentials.configuration('east')).toMatchObject({ revision: 1, region: 'global' });
    expect(f.store.get(id).status).toBe('issuance_unknown'); expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(30);
  });

  it.each(['reserved', 'active', 'stopping'] as const)('does not edit future credentials while an additional %s session remains unresolved', async status => {
    const f = await fixture(); f.save('east', keyA);
    f.service.options.providerForApiKey = (key, region) => {
      const provider = f.provider.forCredential(key, region);
      provider.issueKey = async () => { throw new ApiError('PROVIDER_NETWORK_ERROR', '隔离超时', 502); }; return provider;
    };
    await expect(create(f.service, 'east')).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    const unknown = f.store.list()[0];
    f.store.reserve({ ...unknown, id: `additional-${status}`, status, errorCode: undefined,
      tokenCipher: status === 'active' ? f.secrets.encrypt('tk-isolated-additional-active') : undefined }, 60, apiKeyBudgetScope(keyA));
    expect(f.service.mirrorCredentialsStatus('east')).toMatchObject({ editable: false, hasUnconfirmedSession: true });
    expect(() => f.save('east', keyB, 'cn')).toThrowError(expect.objectContaining({ code: 'EXHIBITION_MIRROR_BUSY' }));
    expect(f.credentials.configuration('east')).toMatchObject({ revision: 1, region: 'global' });
    expect(f.store.get(unknown.id)).toEqual(unknown); expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(60);
  });

  it('does not edit future credentials for an unknown issuance that already holds a token', async () => {
    const f = await fixture(); f.save('east', keyA); const session = await create(f.service, 'east');
    f.store.update(session.id, { status: 'issuance_unknown' });
    expect(f.service.mirrorCredentialsStatus('east')).toMatchObject({ editable: false, hasUnconfirmedSession: true });
    expect(() => f.save('east', keyB, 'cn')).toThrowError(expect.objectContaining({ code: 'EXHIBITION_MIRROR_BUSY' }));
    expect(f.store.get(session.id)).toMatchObject({ status: 'issuance_unknown', providerRegion: 'global' });
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(30);
  });

  it('keeps regional provider routing frozen when a mirror changes its key and region', async () => {
    const f = await fixture(); f.save('east', keyA, 'cn');
    const old = await create(f.service, 'east');
    expect(old.providerRegion).toBe('cn'); expect(f.requests[0].hostname).toBe('api.xmaxai.com');
    await f.service.stop(old.id); f.save('east', keyB, 'global');
    f.requests.splice(0); f.providerFactory.mockClear();
    await f.service.get(old.id);
    expect(f.providerFactory).toHaveBeenCalledWith(keyA, 'cn');
    expect(f.requests).toMatchObject([{ hostname: 'api.xmaxai.com', credential: keyA }]);
    expect(f.store.get(old.id).providerRegion).toBe('cn'); expect(f.service.status('east').providerRegion).toBe('global');
    expect(f.service.mirrorCredentialsStatus('east')).toMatchObject({ region: 'global' });
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(30);
  });

  it('defaults legacy sessions to the global provider even after current configuration changes region', async () => {
    const f = await fixture(); f.save('east', keyA);
    const old = await create(f.service, 'east'); await f.service.stop(old.id);
    f.store.update(old.id, { providerRegion: undefined }); f.save('east', keyB, 'cn');
    f.requests.splice(0); f.providerFactory.mockClear();
    await f.service.get(old.id);
    expect(f.providerFactory).toHaveBeenCalledWith(keyA, 'global');
    expect(f.requests).toMatchObject([{ hostname: 'api.xmax.ai', credential: keyA }]);
    expect(f.service.status('east').providerRegion).toBe('cn');
  });

  it('retains same-key history across region changes without using it to reject mirror sessions', async () => {
    const f = await fixture(); f.save('east', keyA, 'cn'); const first = await create(f.service, 'east'); await f.service.stop(first.id);
    expect(f.save('east', keyA, 'global')).toMatchObject({ region: 'global' });
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(30);
    const second = await create(f.service, 'east'); await f.service.stop(second.id);
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(60);
    const third = await create(f.service, 'east'); await f.service.stop(third.id);
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(90);
    expect(f.requests.filter(row => row.method === 'POST').map(row => row.hostname)).toEqual(['api.xmaxai.com', 'api.xmax.ai', 'api.xmax.ai']);
  });

  it('keeps legacy allocations and rejects revoking an old unbound session under a different default key', async () => {
    const f = await fixture();
    const legacyToken = 'tk-routing-legacy-fixture'; f.issued.set(legacyToken, { key: keyA, active: true });
    const legacy = legacyRecord('legacy-original-key', f.secrets.encrypt(legacyToken));
    f.store.reserve(legacy, 60, apiKeyBudgetScope(keyA));
    f.store.reserve(legacyRecord('legacy-unscoped-history'), 60, 'legacy');
    await f.service.recover();
    expect(f.store.get(legacy.id)).toMatchObject({ status: 'stopping', errorCode: 'SESSION_CREDENTIALS_UNAVAILABLE' });
    expect(f.requests).toHaveLength(0);
    expect(f.store.allocated('legacy')).toBe(30);
    expect(f.store.allocated(apiKeyBudgetScope(keyA))).toBe(30);
    expect(f.service.status()).not.toHaveProperty('allocatedCredits');
    f.provider.setApiKey(keyA);
    await expect(f.service.stop(legacy.id)).resolves.toMatchObject({ status: 'stopped' });
    expect(f.requests.at(-1)?.credential).toBe(keyA);
  });

  it('never returns permanent secrets or encrypted provider/token fields in public records and safe statuses', async () => {
    const f = await fixture(); f.save('east', keyA);
    const session = await create(f.service, 'east');
    const raw = f.store.get(session.id);
    const publicValues = [session, f.service.public(raw), await f.service.get(session.id), f.service.status(), f.service.status('east'), f.service.mirrorCredentialsStatus('east')];
    for (const value of publicValues) {
      const serialized = JSON.stringify(value);
      for (const forbidden of [keyDefault, keyA, keyB, keyC, raw.providerKeyCipher!, raw.tokenCipher!, 'providerKeyCipher', 'tokenCipher']) expect(serialized).not.toContain(forbidden);
    }
    const encryptedFile = await readFile(join(f.directory, 'exhibition-credentials.json'), 'utf8');
    expect(encryptedFile).not.toContain(keyA);
    expect(encryptedFile).not.toContain(keyDefault);
    expect(f.service.status('west').activeSessions).toHaveLength(0);
    expect(f.service.status('east').activeSessions).toHaveLength(1);
  });
});
