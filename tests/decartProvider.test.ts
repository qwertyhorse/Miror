import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MirrorCredentialStore } from '../server/mirrorCredentials';
import { SecretBox, SessionStore } from '../server/store';
import { TryOnService } from '../server/service';
import { XmaxProvider } from '../server/provider';
import { DecartProvider } from '../server/decart';
import { ReferenceAssets } from '../server/referenceAssets';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'miror-decart-')); const secrets = SecretBox.forDirectory(dir); const store = new SessionStore(join(dir, 'state.sqlite'));
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const credentials = new MirrorCredentialStore(dir, secrets);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/client/tokens')) return Response.json({ apiKey: 'ek_fixture', expiresAt: new Date(Date.now() + 30_000).toISOString(), constraints: JSON.parse(init!.body as string).constraints });
    if (String(url).endsWith('/files')) return Response.json({ id: 'file_fixture' });
    return Response.json({ limit: null, active: null, remaining: null });
  });
  const xmaxFetch = vi.fn<typeof fetch>(async () => { throw Error('Unexpected XMAX request'); });
  const service = new TryOnService({ provider: new XmaxProvider('uk-fixture', xmaxFetch), store, secrets, mirrorCredentials: credentials,
    referenceAssets: new ReferenceAssets(dir), decartProvider: key => new DecartProvider(key, fetcher) });
  const save = (provider: 'xmax' | 'decart', editable = true, apiKey?: string) => service.saveProviderSettings('default', { provider, apiKey, expectedRevision: service.providerSettings('default')!.revision }, editable);
  const create = () => service.createExhibition({ lookId: 'commute', deviceId: 'screen-fixture', name: '衣服', referenceAsset: '/assets/exhibition/commute-cutout.png', mode: 'clothx', sessionNumber: 1, generationNumber: 1, sessionLimits: { credits: null, expireSeconds: 120 } });
  return { dir, secrets, store, credentials, fetcher, xmaxFetch, service, save, create };
}
describe('per-mirror provider configuration', () => {
  it('keeps encrypted accounts independent through switching and reopening', () => {
    const f = fixture(); f.credentials.save('default', 'uk-mirror-fixture', 0, 'cn');
    f.save('decart', true, 'dct_fixture'); expect(f.service.status('default')).toMatchObject({ providerId: 'decart', model: 'lucy-vton-3.6' });
    f.save('xmax'); expect(f.service.status('default')).toMatchObject({ providerId: 'xmax', providerRegion: 'cn' });
    expect(JSON.parse(readFileSync(join(f.dir, 'exhibition-credentials.json'), 'utf8')).schemaVersion).toBe(2);
    const reopened = new MirrorCredentialStore(f.dir, f.secrets);
    expect(reopened.decartKey('default')).toBe('dct_fixture'); expect(reopened.apiKey('default')).toBe('uk-mirror-fixture');
    expect(readFileSync(join(f.dir, 'exhibition-credentials.json'), 'utf8')).not.toMatch(/uk-mirror-fixture|dct_fixture/);
    expect(JSON.stringify(f.service.providerSettings('default'))).not.toMatch(/dct_|Cipher/);
    expect(f.service.providerSettings('east')!.accounts.decart.configured).toBe(false);
  });
  it('queues changes while busy and activates only at a new released experience', async () => {
    const f = fixture(); f.save('decart', true, 'dct_fixture'); const row = await f.create();
    expect(f.save('xmax', false)).toMatchObject({ active: 'decart', desired: 'xmax', pending: true });
    expect(() => f.service.activatePendingProvider('default')).toThrow();
    await f.service.stop(row.id); f.service.activatePendingProvider('default');
    expect(f.service.status('default').providerId).toBe('xmax');
    expect(f.store.get(row.id).providerId).toBe('decart');
  });
  it('rejects stale revisions, invalid keys and unconfigured targets', () => {
    const f = fixture(); expect(() => f.save('decart')).toThrow();
    expect(() => f.save('decart', true, 'uk-wrong-provider')).toThrow();
    f.save('decart', true, 'dct_fixture');
    expect(() => f.service.saveProviderSettings('default', { provider: 'xmax', expectedRevision: 0 }, true)).toThrow();
  });
  it('freezes browser-test provider and signing credential', async () => {
    const f = fixture(); f.save('decart', true, 'dct_first'); const browser = f.service.forBrowserTest('default');
    f.save('xmax'); expect(browser.status().providerId).toBe('decart');
    expect(f.service.status('default').providerId).toBe('xmax');
  });
});
describe('Decart segment contract', () => {
  it('prepares isolated file refs, mints just before one dial, switches conditions and closes with explicit evidence', async () => {
    const f = fixture(); f.save('decart', true, 'dct_fixture');
    const prepared = await f.service.prepareReference('default', Buffer.from('fixture'), 'image/png'); expect(prepared?.url).toBe('file_fixture');
    const row = await f.create(); expect(row).toMatchObject({ providerId: 'decart', model: 'lucy-vton-3.6', token: '', usageStatus: 'unavailable' });
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/client/tokens'))).toHaveLength(0);
    expect(f.service.public(f.store.get(row.id))).not.toHaveProperty('clientReleaseHash');
    await f.service.bindExhibitionReference(row.id, { deviceId: 'screen-fixture', lookId: 'commute', refImageUrl: 'file_fixture' });
    const grant = await f.service.decartDial(row.id, row.releaseKey); expect(grant.token).toBe('ek_fixture');
    await expect(f.service.decartDial(row.id, row.releaseKey)).rejects.toThrow();
    await f.service.link(row.id, 'decart-session-fixture');
    await f.service.firstFrame(row.id, 100);
    await f.service.updateExhibitionCondition(row.id, { deviceId: 'screen-fixture', lookId: 'city', sessionNumber: 1, generationNumber: 2, referenceAsset: '/assets/exhibition/city-cutout.png', mode: 'clothx', refImageUrl: 'file_second' }, () => true);
    expect((await f.service.stop(row.id)).status).toBe('stopping');
    expect(() => f.service.clientReleased(row.id, 'wrong')).toThrow();
    expect(f.service.clientReleased(row.id, row.releaseKey)).toMatchObject({ status: 'stopped', releaseEvidence: 'client_transport_closed', usageStatus: 'unavailable' });
    expect(f.xmaxFetch).not.toHaveBeenCalled();
  });
  it('does not confuse token expiry with active session termination; retains a conservative release deadline', async () => {
    vi.useFakeTimers(); const f = fixture(); f.save('decart', true, 'dct_fixture'); const row = await f.create();
    await f.service.bindExhibitionReference(row.id, { deviceId: 'screen-fixture', lookId: 'commute', refImageUrl: 'file_fixture' });
    await f.service.decartDial(row.id, row.releaseKey);
    vi.setSystemTime(Date.now() + 31_000); expect((await f.service.get(row.id)).status).toBe('active');
    expect((await f.service.stop(row.id)).status).toBe('stopping');
    vi.setSystemTime(Date.now() + 125_000); expect(await f.service.get(row.id)).toMatchObject({ status: 'stopped', releaseEvidence: 'bounded_expiry' });
  });
  it('does not deliver a late token after an end while minting', async () => {
    const f = fixture(); f.save('decart', true, 'dct_fixture'); const row = await f.create();
    await f.service.bindExhibitionReference(row.id, { deviceId: 'screen-fixture', lookId: 'commute', refImageUrl: 'file_fixture' });
    let finish!: (response: Response) => void; f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.decartDial(row.id, row.releaseKey); await f.service.stop(row.id);
    finish(Response.json({ apiKey: 'ek_late', expiresAt: new Date(Date.now() + 30_000).toISOString(), constraints: { realtime: { maxSessionDuration: 120 } } }));
    await expect(pending).rejects.toThrow(); expect(f.store.get(row.id).status).toBe('stopped');
  });
  it('rejects missing server duration enforcement and never fabricates revoke support', async () => {
    const provider = new DecartProvider('dct_fixture', vi.fn(async () => Response.json({ apiKey: 'ek_fixture', expiresAt: new Date().toISOString() })));
    await expect(provider.issue(120)).rejects.toThrow(); await expect(provider.deactivate('ek_fixture')).rejects.toThrow();
  });
  it('denies unsupported modes before allocating or contacting a provider', async () => {
    const f = fixture(); f.save('decart', true, 'dct_fixture');
    await expect(f.service.createExhibition({ lookId: 'commute', deviceId: 'screen-fixture', name: '衣服', referenceAsset: '/assets/exhibition/commute-cutout.png', mode: 'charx', sessionNumber: 1, generationNumber: 1 })).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.store.list()).toHaveLength(0);
  });
});

it('persists stop-and-switch intent, waits for release, then applies once', async () => {
  const f = fixture(); f.save('decart', true, 'dct_fixture'); const row = await f.create();
  await f.service.bindExhibitionReference(row.id, { deviceId: 'screen-fixture', lookId: 'commute', refImageUrl: 'file_fixture' });
  await f.service.decartDial(row.id, row.releaseKey); f.save('xmax', false);
  f.service.requestProviderSwitch('default', f.service.providerSettings('default')!.revision);
  const reopened = new MirrorCredentialStore(f.dir, f.secrets); expect(reopened.providerSettings('default').applyAfterStop).toBe(true);
  f.service.finishProviderSwitch('default'); expect(f.service.status('default').providerId).toBe('decart');
  f.service.clientReleased(row.id, row.releaseKey); f.service.finishProviderSwitch('default');
  const applied = f.service.providerSettings('default'); expect(applied).toMatchObject({ active: 'xmax', pending: false, applyAfterStop: false });
  f.service.finishProviderSwitch('default'); expect(f.service.providerSettings('default')).toEqual(applied);
});
it('browser-test issuance and preparation use the frozen Decart account after source changes', async () => {
  const f = fixture(); f.save('decart', true, 'dct_first'); const browser = f.service.forBrowserTest('default'); f.save('xmax');
  const row = await browser.createExhibition({ lookId: 'commute', deviceId: 'screen-browser', name: '衣服', referenceAsset: '/assets/exhibition/commute-cutout.png', mode: 'clothx', sessionNumber: 1, generationNumber: 1 });
  await browser.bindExhibitionReference(row.id, { deviceId: 'screen-browser', lookId: 'commute', refImageUrl: 'file_fixture' });
  await browser.decartDial(row.id, row.releaseKey);
  expect(new Headers(f.fetcher.mock.calls.at(-1)![1]!.headers).get('x-api-key')).toBe('dct_first');
});
