import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretBox, SessionStore } from '../server/store.ts';
import { MirrorCredentialStore } from '../server/mirrorCredentials.ts';
import { XmaxProvider } from '../server/provider.ts';
import { TryOnService } from '../server/service.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { createApiServer } from '../server/http.ts';
import type { SessionRecord } from '../server/types.ts';

const directories: string[] = []; const stores: SessionStore[] = []; const servers: ReturnType<typeof createApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const origin = 'https://xuminghong.local:10202'; const globalKey = 'uk-fixture-global'; const mirrorKey = 'uk-fixture-mirror';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-mirror-credentials-')); directories.push(directory);
  const secrets = SecretBox.forDirectory(directory); const store = new SessionStore(join(directory, 'sessions.sqlite')); stores.push(store); store.activateApiKeyBudget(globalKey);
  const credentials = new MirrorCredentialStore(directory, secrets); const fetcher = vi.fn(async () => { throw new Error('This configuration test must not contact XMAX.'); });
  const provider = new XmaxProvider(globalKey, fetcher as typeof fetch);
  const service = new TryOnService({ provider, store, secrets, mirrorCredentials: credentials });
  const mirrors = new ExhibitionMirrors(directory); const second = mirrors.create({ name: '智能镜 2' }); mirrors.attachLiveService(service);
  return { directory, secrets, store, credentials, provider, service, mirrors, second, fetcher };
}
async function api(f: ReturnType<typeof fixture>) {
  const server = createApiServer(f.service, [origin], undefined, f.mirrors); servers.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors`;
  const get = (id = 'default') => fetch(`${base}/${id}/credentials`);
  const put = (id = 'default', apiKey: unknown = mirrorKey, expectedRevision: unknown = 0, headers = { Origin: origin }, region: unknown = 'global') => fetch(`${base}/${id}/credentials`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ apiKey, expectedRevision, region }),
  });
  return { base, get, put };
}
function record(id: string, mirrorId: string, status: SessionRecord['status'] = 'reserved'): SessionRecord {
  return { id, targetItemId: 'commute', sourceId: 'test-screen', sourceKind: 'camera', sourceName: '测试素材', status, pointsLimit: 30,
    refImageUrl: '', referenceVersion: 0, consumedCredits: 0, resultAvailable: false, verification: 'none', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    exhibition: { mirrorId, lookId: 'commute', deviceId: 'screen-test', sessionNumber: 1, generationNumber: 1 } };
}
const code = (value: string) => expect.objectContaining({ code: value });

describe('private encrypted mirror credential storage', () => {
  it('encrypts permanent keys with SecretBox and persists independent revisions without exposing a key or cipher in status', () => {
    const f = fixture(); const before = f.mirrors.getMirror().get();
    const saved = f.service.saveMirrorCredentials('default', { apiKey: mirrorKey, expectedRevision: 0 });
    expect(saved).toMatchObject({ configured: true, source: 'mirror', revision: 1, editable: true, perSessionLimit: 30 });
    for (const field of ['totalLimit', 'allocatedCredits', 'remainingCredits']) expect(saved).not.toHaveProperty(field);
    const file = join(f.directory, 'exhibition-credentials.json'); const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(mirrorKey); expect(raw).not.toContain(globalKey);
    const stored = JSON.parse(raw); expect(f.secrets.decrypt(stored.mirrors.default.keyCipher)).toBe(mirrorKey);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(f.mirrors.getMirror().get()).toEqual(before);
    expect(JSON.stringify(saved)).not.toMatch(/uk-|keyCipher|providerKeyCipher/u);
    const reopened = new MirrorCredentialStore(f.directory, SecretBox.forDirectory(f.directory));
    expect(reopened.apiKey('default')).toBe(mirrorKey); expect(reopened.configuration('default')).toEqual({ revision: 1, hasOverride: true, region: 'global' });
    expect(reopened.configuration(f.second.id)).toEqual({ revision: 0, hasOverride: false, region: 'global' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('persists a chosen region independently while keeping legacy encrypted entries on global', () => {
    const f = fixture();
    const file = join(f.directory, 'exhibition-credentials.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, mirrors: { default: { revision: 2, keyCipher: f.secrets.encrypt(globalKey) } } }));
    const legacy = new MirrorCredentialStore(f.directory, f.secrets);
    expect(legacy.configuration('default')).toEqual({ revision: 2, hasOverride: true, region: 'global' });
    expect(legacy.apiKey('default')).toBe(globalKey);
    legacy.save(f.second.id, mirrorKey, 0, 'cn');
    const reopened = new MirrorCredentialStore(f.directory, f.secrets);
    expect(reopened.configuration(f.second.id)).toEqual({ revision: 1, hasOverride: true, region: 'cn' });
    expect(reopened.configuration('default').region).toBe('global');
    expect(reopened.apiKey(f.second.id)).toBe(mirrorKey);
    const stored = readFileSync(file, 'utf8');
    expect(JSON.parse(stored).schemaVersion).toBe(1);
    expect(stored).not.toContain(mirrorKey); expect(stored).not.toContain(globalKey);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(['', 'CN', 'domestic', 'https://foreign.example', null, 1, {}])('rejects an invalid credential region without changing encrypted storage: %s', region => {
    const f = fixture(); f.credentials.save('default', globalKey, 0);
    const file = join(f.directory, 'exhibition-credentials.json'); const before = readFileSync(file);
    expect(() => f.credentials.save('default', mirrorKey, 1, region)).toThrow(code('INVALID_PROVIDER_REGION'));
    expect(readFileSync(file)).toEqual(before);
    expect(f.credentials.configuration('default')).toEqual({ revision: 1, hasOverride: true, region: 'global' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid stored region without silently routing to global', () => {
    const f = fixture(); f.credentials.save('default', mirrorKey, 0, 'cn');
    const file = join(f.directory, 'exhibition-credentials.json'); const value = JSON.parse(readFileSync(file, 'utf8'));
    value.mirrors.default.region = 'foreign'; writeFileSync(file, JSON.stringify(value));
    expect(() => new MirrorCredentialStore(f.directory, f.secrets)).toThrow(code('EXHIBITION_CREDENTIALS_UNAVAILABLE'));
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('rejects stale or invalid saves and retains the prior encrypted configuration after disk failure', () => {
    const f = fixture(); f.credentials.save('default', mirrorKey, 0);
    for (const key of ['', 'sk-invalid', null, 1, 'uk-valid\ninvalid', `uk-${'a'.repeat(600)}`]) expect(() => f.credentials.save('default', key, 1)).toThrow(code('INVALID_API_KEY'));
    expect(() => f.credentials.save('default', globalKey, 0)).toThrow(code('EXHIBITION_STALE_CREDENTIALS'));
    const file = join(f.directory, 'exhibition-credentials.json'); renameSync(file, `${file}.saved`); mkdirSync(file);
    expect(() => f.credentials.save('default', globalKey, 1)).toThrow(code('SETTINGS_SAVE_FAILED'));
    expect(f.credentials.apiKey('default')).toBe(mirrorKey); expect(f.credentials.configuration('default').revision).toBe(1);
    expect(readdirSync(f.directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('fails closed on damaged encrypted storage instead of silently using another key', () => {
    const f = fixture(); f.credentials.save('default', mirrorKey, 0);
    const file = join(f.directory, 'exhibition-credentials.json'); const value = JSON.parse(readFileSync(file, 'utf8'));
    value.mirrors.default.keyCipher = 'broken'; writeFileSync(file, JSON.stringify(value));
    expect(() => new MirrorCredentialStore(f.directory, f.secrets)).toThrow(code('EXHIBITION_CREDENTIALS_UNAVAILABLE'));
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('does not copy credentials into another mirror or material backup', () => {
    const f = fixture(); f.credentials.save('default', mirrorKey, 0); f.credentials.save(f.second.id, 'uk-target-independent', 0);
    const credentialBytes = readFileSync(join(f.directory, 'exhibition-credentials.json'));
    const sourceBefore = f.mirrors.getMirror().get();
    f.mirrors.copy(f.second.id, { sourceMirrorId: 'default', copyLooks: true, copySettings: true, expectedRevision: f.mirrors.getMirror(f.second.id).get().revision });
    expect(f.credentials.apiKey('default')).toBe(mirrorKey); expect(f.credentials.apiKey(f.second.id)).toBe('uk-target-independent');
    expect(readFileSync(join(f.directory, 'exhibition-credentials.json'))).toEqual(credentialBytes);
    expect(f.mirrors.getMirror().get()).toEqual(sourceBefore);
    const backupRoot = join(f.directory, 'exhibition-mirrors', f.second.id, 'exhibition-copy-backups'); const [name] = readdirSync(backupRoot);
    const backup = join(backupRoot, name); expect(readdirSync(backup)).toEqual(['backup.json', 'exhibition.json']);
    const exported = join(f.directory, 'backup-export'); cpSync(backup, exported, { recursive: true });
    const text = readFileSync(join(exported, 'exhibition.json'), 'utf8') + readFileSync(join(exported, 'backup.json'), 'utf8');
    expect(text).not.toMatch(/uk-|keyCipher|providerKeyCipher|exhibition-credentials/u);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('mirror credentials HTTP boundary', () => {
  it('returns safe default/configured status, saves only the chosen mirror and uses the independent credential revision', async () => {
    const f = fixture(); const a = await api(f); const before = f.mirrors.getMirror().get();
    const initial = await (await a.get()).json();
    expect(initial).toMatchObject({ configured: true, source: 'default', revision: 0, perSessionLimit: 30 });
    for (const field of ['totalLimit', 'allocatedCredits', 'remainingCredits']) expect(initial).not.toHaveProperty(field);
    const response = await a.put(); expect(response.status).toBe(200);
    const saved = await response.json(); expect(saved).toMatchObject({ source: 'mirror', revision: 1, editable: true });
    expect(JSON.stringify(saved)).not.toMatch(/uk-|Cipher/u); expect(f.mirrors.getMirror().get()).toEqual(before);
    expect(await (await a.get(f.second.id)).json()).toMatchObject({ source: 'default', revision: 0 });
    expect((await a.put('default', mirrorKey, 0)).status).toBe(409);
    expect((await a.put('default', mirrorKey, 1)).status).toBe(200);
    expect(await (await a.get()).json()).toMatchObject({ revision: 2 });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('omits local counters from mirror APIs while preserving exhausted default history and budget scope', async () => {
    const f = fixture(); for (let index = 0; index < 12; index++) f.store.reserve(record(`history-${index}`, 'default', 'stopped'), 360);
    const a = await api(f); const before = await (await a.get()).json();
    for (const field of ['totalLimit', 'allocatedCredits', 'remainingCredits']) expect(before).not.toHaveProperty(field);
    expect((await a.put('default', globalKey, 0)).status).toBe(200);
    expect(await (await a.get()).json()).toMatchObject({ source: 'mirror' });
    expect(f.store.allocated()).toBe(360); expect(f.service.status()).not.toHaveProperty('allocatedCredits');
    expect((await a.put(f.second.id, mirrorKey, 0)).status).toBe(200);
    const other = await (await a.get(f.second.id)).json(); expect(other).toMatchObject({ source: 'mirror' });
    for (const field of ['totalLimit', 'allocatedCredits', 'remainingCredits']) expect(other).not.toHaveProperty(field);
    expect(f.store.list()).toHaveLength(12); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('rejects phase and lease ownership conflicts while allowing another mirror to save independently', async () => {
    const f = fixture(); const a = await api(f);
    f.mirrors.getMirror().command({ action: 'begin' });
    expect(await (await a.get()).json()).toMatchObject({ editable: false }); expect((await a.put()).status).toBe(409);
    f.mirrors.getMirror().command({ action: 'idle' });
    f.store.reserve(record('other-mirror-pending', f.second.id, 'issuance_unknown'), 360);
    expect((await a.put()).status).toBe(200); expect((await a.put(f.second.id)).status).toBe(409);
    expect(await (await a.get(f.second.id)).json()).toMatchObject({ editable: false });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(['reserved', 'active', 'stopping', 'issuance_unknown'] as const)('blocks changing a mirror key for its unresolved %s session even without a state lease', async status => {
    const f = fixture(); f.store.reserve(record(`pending-${status}`, 'default', status), 360); const a = await api(f);
    expect(await (await a.get()).json()).toMatchObject({ editable: false }); expect((await a.put()).status).toBe(409);
    expect(existsSync(join(f.directory, 'exhibition-credentials.json'))).toBe(false); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('allows future regional configuration for a tokenless unknown issuance only when its original credential is frozen', async () => {
    const f = fixture(); const pending = record('frozen-unknown', 'default', 'issuance_unknown');
    pending.providerKeyCipher = f.secrets.encrypt(globalKey); pending.providerRegion = 'global'; pending.errorCode = 'PROVIDER_NETWORK_ERROR';
    f.store.reserve(pending, 360); const before = f.store.get(pending.id); const a = await api(f);
    expect(await (await a.get()).json()).toMatchObject({ editable: true, region: 'global', hasUnconfirmedSession: true });
    expect((await a.put('default', mirrorKey, 0, { Origin: origin }, 'cn')).status).toBe(200);
    expect(await (await a.get()).json()).toMatchObject({ source: 'mirror', revision: 1, region: 'cn', hasUnconfirmedSession: true });
    expect(f.store.get(pending.id)).toEqual(before);
    expect(f.secrets.decrypt(f.store.get(pending.id).providerKeyCipher!)).toBe(globalKey);
    expect(f.credentials.apiKey('default')).toBe(mirrorKey);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid regions at the HTTP boundary without writing credential storage', async () => {
    const f = fixture(); const a = await api(f);
    for (const region of ['CN', 'https://foreign.example', null, 1]) {
      const response = await a.put('default', mirrorKey, 0, { Origin: origin }, region);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_PROVIDER_REGION' } });
    }
    expect(existsSync(join(f.directory, 'exhibition-credentials.json'))).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('rejects unknown mirrors, invalid bodies and foreign origins before credential writes', async () => {
    const f = fixture(); const a = await api(f);
    expect((await a.get('missing')).status).toBe(404); expect((await a.put('missing')).status).toBe(404);
    expect((await a.put('default', '', 0)).status).toBe(400);
    expect((await a.put('default', mirrorKey, null)).status).toBe(409);
    expect((await a.put('default', mirrorKey, 0, { Origin: 'https://foreign.example' })).status).toBe(403);
    expect(existsSync(join(f.directory, 'exhibition-credentials.json'))).toBe(false); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
