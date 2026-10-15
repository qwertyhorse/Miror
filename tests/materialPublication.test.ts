import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { ExhibitionService } from '../server/exhibition';
import { TryOnService } from '../server/service';
import { ReferenceAssets } from '../server/referenceAssets';
import { SessionStore, SecretBox } from '../server/store';
import { validateMaterialImport } from '../server/materialImport';
import type { Provider } from '../server/types';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'material-publication-')); const store = new SessionStore(':memory:');
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const issue = vi.fn(async () => ({ token: 'tk-fixture', expiresAt: new Date(Date.now() + 120000).toISOString() }));
  const provider = { configured: true, region: 'cn', credentialSnapshot: () => 'uk-fixture', issueKey: issue,
    deactivate: async () => ({ status: 'inactive', consumedCredit: 0 }), keyStatus: async () => ({ status: 'active', consumedCredit: 0 }),
    sessionStatus: async (_, sessionUid: string) => ({ sessionUid, status: 'active', consumedCredit: 0 }) } as Provider;
  const dns = vi.fn(async () => ['93.184.216.34']); let fail = false;
  const service = new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), referenceAssets: new ReferenceAssets(directory), resolveHost: dns,
    referenceStorage: () => ({ upload: async () => { if (fail) throw new Error('fixture unavailable'); return 'https://fixture-123.cos.ap-test.myqcloud.com/reference.png'; }, check: async () => true }) });
  const mirror = new ExhibitionService(directory); mirror.attachLiveService(service);
  const image = async (color: string) => (await sharp({ create: { width: 512, height: 512, channels: 3, background: color } }).png().toBuffer()).toString('base64');
  const add = async (sku: string, color: string) => (await mirror.upload({ sku, name: sku, imageBase64: await image('white'), referenceImageBase64: await image(color) })).looks.at(-1)!;
  return { directory, mirror, service, issue, dns, image, add, fail: () => { fail = true; } };
}
it('keeps prior published versions on failed full publication and only publishes explicit ready subset', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', enabledLookIds: [a.id] }); f.mirror.publishPublication({});
  const before = f.mirror.read().publication!; const b = await f.add('B', 'blue');
  f.mirror.command({ action: 'configure', enabledLookIds: [a.id, b.id] }); f.fail(); await f.mirror.preparePublication({});
  await vi.waitFor(() => expect(f.mirror.publicationStatus().preparing).toBe(false));
  expect(() => f.mirror.publishPublication({})).toThrowError(expect.objectContaining({ code: 'EXHIBITION_PUBLICATION_NOT_READY' }));
  expect(f.mirror.read().publication).toEqual(before);
  const partial = f.mirror.publishPublication({ allowPartial: true });
  expect(f.mirror.read().enabledLookIds).toEqual([a.id, b.id]);
  expect(partial.publication.lookIds).toEqual([a.id]); expect(partial.publication.revision).toBe(before.revision + 1);
});
it('pins published reference bytes across draft replacement and starts with trusted reference without new DNS', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', enabledLookIds: [a.id] }); f.mirror.publishPublication({});
  const old = f.mirror.read().publication!.looks[0]; const parts = old.referenceImage!.split('/assets/')[1].split('/');
  const oldBytes = f.mirror.assetResource(parts[0], parts[1], parts[2]).data;
  await f.mirror.updateLook(a.id, { name: 'A', referenceImageBase64: await f.image('blue') });
  expect(f.mirror.read().publication!.looks[0]).toEqual(old); expect(f.mirror.assetResource(parts[0], parts[1], parts[2]).data).toEqual(oldBytes);
  f.mirror.command({ action: 'configure', providerMode: 'xmax' }); f.mirror.command({ action: 'begin' }); const calls = f.dns.mock.calls.length;
  const session = await f.mirror.createLiveSession({ deviceId: 'fixture-device', lookId: a.id, generationNumber: f.mirror.get().generationNumber });
  expect(session.token).toBe('tk-fixture'); expect(session.referenceAsset).toBe(old.referenceImage); expect(session.refImageUrl).toContain('fixture-123');
  expect(f.dns).toHaveBeenCalledTimes(calls); expect(f.issue).toHaveBeenCalledOnce();
});
it('refuses unavailable start before generation-key issuance and leaves existing effect selected', async () => {
  const f = await fixture(); f.mirror.command({ action: 'configure', providerMode: 'xmax' });
  expect(() => f.mirror.command({ action: 'begin' })).toThrowError(expect.objectContaining({ code: 'REFERENCE_NOT_READY' }));
  expect(f.issue).not.toHaveBeenCalled(); expect(f.mirror.get().phase).toBe('select');
});
it('validates exact SKU and file roles before a bounded sequential import', () => {
  const item = { sku: 'SKU-1', name: 'One', mode: 'clothx', displayFile: 'display/SKU-1.png', referenceFile: 'reference/SKU-1.png' };
  expect(validateMaterialImport({ items: [item], files: [item.displayFile, item.referenceFile] }).valid).toBe(true);
  const bad = validateMaterialImport({ items: [item, item], files: [item.displayFile] });
  expect(bad.valid).toBe(false); expect(bad.items[1].errors).toContain('SKU 重复'); expect(bad.items[0].errors).toContain('缺少参考图');
});

it('recovers response-lost SKU uploads idempotently and rejects conflicting bytes', async () => {
  const f = await fixture(); const input = { sku: 'SAME', name: 'Same', imageBase64: await f.image('white'), referenceImageBase64: await f.image('red') };
  const first = await f.mirror.upload(input); const second = await f.mirror.upload(input);
  expect(second).toEqual(first); expect(second.looks.filter(look => look.sku === 'SAME')).toHaveLength(1);
  await expect(f.mirror.upload({ ...input, referenceImageBase64: await f.image('blue') })).rejects.toMatchObject({ code: 'EXHIBITION_DUPLICATE_SKU' });
  const look = first.looks.at(-1)!; expect(f.mirror.updateLook(look.id, { name: 'Renamed' })).toMatchObject({ looks: expect.arrayContaining([expect.objectContaining({ sku: 'SAME', name: 'Renamed' })]) });
});
it('retains published selection order across draft enable edits and rejects corrupted new-schema publication', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); const b = await f.add('B', 'blue');
  await f.mirror.prepareReference(a.id); await f.mirror.prepareReference(b.id);
  f.mirror.command({ action: 'configure', enabledLookIds: [b.id, a.id] }); f.mirror.publishPublication({});
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [a.id] });
  expect(f.mirror.get().selectedLookId).toBe(b.id); f.mirror.command({ action: 'begin' });
  expect(f.mirror.command({ action: 'next' }).selectedLookId).toBe(a.id);
  f.mirror.command({ action: 'end' });
  const raw = JSON.parse(readFileSync(join(f.directory, 'exhibition.json'), 'utf8')); delete raw.state.publication;
  writeFileSync(join(f.directory, 'exhibition.json'), JSON.stringify(raw));
  expect(() => new ExhibitionService(f.directory)).toThrow('Invalid exhibition mirror data');
});
it('allows live and paused draft reference edits while preserving the current published effect', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', enabledLookIds: [a.id] }); f.mirror.publishPublication({}); f.mirror.command({ action: 'configure', providerMode: 'xmax' }); f.mirror.command({ action: 'begin' });
  const session = await f.mirror.createLiveSession({ deviceId: 'live-draft-device', lookId: a.id, generationNumber: f.mirror.get().generationNumber });
  const published = f.mirror.get().publication; await f.mirror.updateLook(a.id, { name: 'Draft B', referenceImageBase64: await f.image('blue') });
  expect(f.mirror.get().live!.sessionId).toBe(session.id); expect(f.mirror.get().publication).toEqual(published);
  f.mirror.command({ action: 'pause' }); await f.mirror.updateLook(a.id, { name: 'Draft C', referenceImageBase64: await f.image('green') });
  expect(f.mirror.get().publication).toEqual(published); expect(f.issue).toHaveBeenCalledOnce();
});

it('reclaims superseded publication files only after replacement publication commits', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', enabledLookIds: [a.id] }); f.mirror.publishPublication({});
  const parts = a.referenceImage!.split('/assets/')[1].split('/'); const oldFile = join(f.directory, 'exhibition-assets', parts.join('.') + '.webp');
  await f.mirror.updateLook(a.id, { name: 'A', referenceImageBase64: await f.image('blue') }); expect(existsSync(oldFile)).toBe(true);
  await f.mirror.prepareReference(a.id); f.mirror.publishPublication({});
  expect(existsSync(oldFile)).toBe(false); expect(() => f.mirror.assetResource(parts[0], parts[1], parts[2])).toThrowError(expect.objectContaining({ code: 'EXHIBITION_ASSET_NOT_FOUND' }));
});

it('withdraws a deleted material as a new publication revision and reclaims both draft and published versions', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', enabledLookIds: [a.id] }); f.mirror.publishPublication({});
  const revision = f.mirror.get().publication!.revision;
  const oldParts = a.referenceImage!.split('/assets/')[1].split('/'); const oldFile = join(f.directory, 'exhibition-assets', oldParts.join('.') + '.webp');
  await f.mirror.updateLook(a.id, { name: 'Draft A', referenceImageBase64: await f.image('blue') });
  const draftParts = f.mirror.get().looks.find(look => look.id === a.id)!.referenceImage!.split('/assets/')[1].split('/'); const draftFile = join(f.directory, 'exhibition-assets', draftParts.join('.') + '.webp');
  f.mirror.removeLook(a.id, {});
  expect(f.mirror.get().publication).toMatchObject({ revision: revision + 1, looks: [] });
  expect(existsSync(oldFile)).toBe(false); expect(existsSync(draftFile)).toBe(false);
});

it('gates supplier switching against the current mode while retaining other published mode catalogs', async () => {
  const f = await fixture(); const cloth = await f.add('Cloth', 'red'); const free = await f.add('Free', 'blue');
  await f.mirror.updateLook(free.id, { name: 'Free', mode: 'free', prompt: 'A blue sky', referenceKind: 'none' });
  await f.mirror.prepareReference(cloth.id); f.mirror.command({ action: 'configure', enabledLookIds: [cloth.id, free.id] }); f.mirror.publishPublication({});
  vi.spyOn(f.service, 'isReferenceReadyForProvider').mockReturnValue(true);
  vi.spyOn(f.service, 'providerSettings').mockReturnValue({ revision: 1, active: 'xmax', desired: 'decart', pending: true, applyAfterStop: false, accounts: { decart: { configured: true }, xmax: { configured: true } } });
  const activate = vi.spyOn(f.service, 'activatePendingProvider').mockImplementation(() => undefined);
  expect(() => f.mirror.assertProviderPublicationReady('decart')).not.toThrow();
  expect(f.mirror.publicationStatus().targetLookIds).toEqual([cloth.id]);
  f.mirror.command({ action: 'configure', providerMode: 'xmax', experienceMode: 'free' });
  expect(() => f.mirror.command({ action: 'begin' })).toThrowError(expect.objectContaining({ code: 'PROVIDER_MODE_UNSUPPORTED' }));
  expect(activate).not.toHaveBeenCalled(); expect(f.mirror.get().publication!.looks).toHaveLength(2);
});
