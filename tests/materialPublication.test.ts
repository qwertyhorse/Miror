import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
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
  provider.forCredential = () => provider;
  const dns = vi.fn(async () => ['93.184.216.34']); let fail = false; let clock = Date.now();
  const service = new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), referenceAssets: new ReferenceAssets(directory, { now: () => clock }), resolveHost: dns,
    referenceStorage: () => ({ upload: async () => { if (fail) throw new Error('fixture unavailable'); return 'https://fixture-123.cos.ap-test.myqcloud.com/reference.png'; }, check: async () => true }) });
  const mirror = new ExhibitionService(directory, { now: () => clock }); mirror.attachLiveService(service);
  const image = async (color: string) => (await sharp({ create: { width: 512, height: 512, channels: 3, background: color } }).png().toBuffer()).toString('base64');
  const add = async (sku: string, color: string) => (await mirror.upload({ sku, name: sku, imageBase64: await image('white'), referenceImageBase64: await image(color) })).looks[0]!;
  return { directory, mirror, service, provider, issue, dns, image, add, fail: (value = true) => { fail = value; }, advance: (ms: number) => { clock += ms; } };
}
it('enables uploads immediately and makes them selectable only after current provider preparation', async () => {
  const f = await fixture(); f.mirror.command({ action: 'configure', providerMode: 'xmax' });
  const look = await f.add('AUTO', 'red');
  expect(f.mirror.read().enabledLookIds).toContain(look.id);
  expect(f.mirror.read().catalog!.availableLookIds).not.toContain(look.id);
  const revision = f.mirror.read().revision; const notify = vi.fn(); const unsubscribe = f.mirror.subscribe(notify);
  await f.mirror.prepareReference(look.id);
  expect(f.mirror.read().catalog!.availableLookIds).toContain(look.id);
  expect(f.mirror.read().revision).toBeGreaterThan(revision); expect(notify).toHaveBeenCalled(); unsubscribe();
  expect(f.issue).not.toHaveBeenCalled();
});
it('keeps the previous display/reference pair on replacement failure, then replaces automatically on success', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [a.id] });
  const old = f.mirror.read().catalog!.looks[0]!;
  await f.mirror.updateLook(a.id, { name: 'Replacement', imageBase64: await f.image('blue'), referenceImageBase64: await f.image('green') });
  f.fail(); await expect(f.mirror.prepareReference(a.id)).rejects.toThrow();
  expect(f.mirror.read().catalog!.looks[0]).toEqual(old);
  const parts = old.referenceImage!.split('/assets/')[1]!.split('/'); expect(f.mirror.assetResource(parts[0]!, parts[1], parts[2]).data.length).toBeGreaterThan(0);
  expect(f.mirror.read().enabledLookIds).toContain(a.id);
  f.mirror.command({ action: 'configure', enabledLookIds: [] });
  expect(f.mirror.referencePreparationStatuses()[a.id]).toMatchObject({ state: 'ready', refreshState: 'failed' });
  f.mirror.command({ action: 'configure', enabledLookIds: [a.id] });
  f.fail(false); f.advance(60_001); await f.mirror.prepareReference(a.id);
  const replacement = f.mirror.read().catalog!.looks[0]!; expect(replacement.name).toBe('Replacement'); expect(replacement.image).not.toBe(old.image); expect(replacement.referenceImage).not.toBe(old.referenceImage);
});
it('keeps an active input pinned while an update becomes selectable and while staff takes it off sale', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [a.id] }); f.mirror.command({ action: 'begin' });
  const original = f.mirror.read().activeLook!;
  const session = await f.mirror.createLiveSession({ deviceId: 'fixture-device', lookId: a.id, contentVersion: original.contentVersion, generationNumber: f.mirror.get().generationNumber });
  await f.mirror.updateLook(a.id, { name: 'Replacement', imageBase64: await f.image('blue'), referenceImageBase64: await f.image('green') }); await f.mirror.prepareReference(a.id);
  expect(f.mirror.read().catalog!.looks[0]!.contentVersion).not.toBe(original.contentVersion);
  expect(f.mirror.read().activeLook).toEqual(original);
  f.mirror.command({ action: 'configure', enabledLookIds: [] });
  expect(f.mirror.read().catalog!.looks).toEqual([]); expect(f.mirror.read().activeLook).toEqual(original);
  expect(f.mirror.read().live!.sessionId).toBe(session.id); expect(f.mirror.read().live!.status).not.toBe('stopping');
  const parts = original.referenceImage!.split('/assets/')[1]!.split('/'); expect(f.mirror.assetResource(parts[0]!, parts[1], parts[2]).data.length).toBeGreaterThan(0);
  expect(f.issue).toHaveBeenCalledOnce();
});
it('finishes in-flight issuance after taking the pinned material off sale and then moves to a remaining available item', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); const b = await f.add('B', 'blue'); await f.mirror.prepareReference(a.id); await f.mirror.prepareReference(b.id);
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [a.id, b.id] }); f.mirror.command({ action: 'select', lookId: a.id }); f.mirror.command({ action: 'begin' });
  let finish!: (value: { token: string; expiresAt: string }) => void;
  f.issue.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const creating = f.mirror.createLiveSession({ deviceId: 'fixture-device', lookId: a.id, generationNumber: f.mirror.get().generationNumber });
  await vi.waitFor(() => expect(f.issue).toHaveBeenCalledOnce());
  f.mirror.command({ action: 'configure', enabledLookIds: [b.id] });
  finish({ token: 'tk-fixture', expiresAt: new Date(Date.now() + 120000).toISOString() });
  const session = await creating; expect(session.exhibition!.lookId).toBe(a.id); expect(f.mirror.read().live!.status).toBe('connecting');
  const next = f.mirror.command({ action: 'next' }); expect(next.selectedLookId).toBe(b.id); expect(next.activeLook!.id).toBe(b.id);
});
it('accepts the current pinned condition acknowledgement after staff takes the material off sale', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); const b = await f.add('B', 'blue'); await f.mirror.prepareReference(a.id); await f.mirror.prepareReference(b.id);
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [a.id, b.id] }); f.mirror.command({ action: 'select', lookId: a.id }); f.mirror.command({ action: 'begin' });
  const session = await f.mirror.createLiveSession({ deviceId: 'fixture-device', lookId: a.id, generationNumber: f.mirror.get().generationNumber });
  await f.service.link(session.id, 'ums-fixture'); await f.service.firstFrame(session.id, 100); f.mirror.liveFirstFrame(session.id, 100);
  const switching = f.mirror.command({ action: 'switch', lookId: b.id });
  const intent = { deviceId: 'fixture-device', lookId: b.id, sessionNumber: switching.sessionNumber, generationNumber: switching.generationNumber, contentVersion: switching.activeLook!.contentVersion };
  const updated = await f.mirror.updateLiveCondition(session.id, intent);
  f.mirror.command({ action: 'configure', enabledLookIds: [a.id] });
  const applied = await f.mirror.liveConditionApplied(session.id, { ...intent, referenceVersion: updated.referenceVersion });
  expect(applied.phase).toBe('showcase'); expect(applied.activeLook!.id).toBe(b.id); expect(applied.catalog!.availableLookIds).toEqual([a.id]);
  expect(applied.live!.status).toBe('running'); expect(f.issue).toHaveBeenCalledOnce();
});
it('rejects an outdated material version before issuing credentials and never probes DNS during use', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [a.id] }); f.mirror.command({ action: 'begin' });
  await expect(f.mirror.createLiveSession({ deviceId: 'fixture-device', lookId: a.id, contentVersion: 'old', generationNumber: f.mirror.get().generationNumber })).rejects.toMatchObject({ code: 'MATERIAL_VERSION_CHANGED' });
  expect(f.issue).not.toHaveBeenCalled(); const dnsCalls = f.dns.mock.calls.length;
  const session = await f.mirror.createLiveSession({ deviceId: 'fixture-device', lookId: a.id, contentVersion: f.mirror.read().activeLook!.contentVersion, generationNumber: f.mirror.get().generationNumber });
  expect(session.referenceVersion).toBe(1); expect(session.referenceScope).toBeTruthy(); expect(f.dns).toHaveBeenCalledTimes(dnsCalls);
});
it('projects exactly the enabled current mode and skips unsupported Decart modes', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); const b = await f.add('B', 'blue');
  f.mirror.updateLook(b.id, { name: 'B', mode: 'charx' }); await f.mirror.prepareReference(a.id); await f.mirror.prepareReference(b.id);
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [a.id, b.id] });
  expect(f.mirror.read().catalog!.availableLookIds).toEqual([a.id]);
  f.mirror.command({ action: 'configure', experienceMode: 'charx' }); expect(f.mirror.read().catalog!.availableLookIds).toEqual([b.id]);
});
it('requires a configured current provider even for prompt-only materials', async () => {
  const f = await fixture(); const a = await f.add('PROMPT', 'red');
  f.mirror.updateLook(a.id, { name: 'Prompt', mode: 'free', prompt: '晴朗的背景', referenceKind: 'none' });
  f.mirror.command({ action: 'configure', providerMode: 'xmax', experienceMode: 'free', enabledLookIds: [a.id] });
  expect(f.mirror.read().catalog!.availableLookIds).toEqual([a.id]); expect(f.mirror.referencePreparationStatus(a.id).state).toBe('not_required');
  f.provider.configured = false; f.mirror.refreshMaterials();
  expect(f.mirror.read().catalog!.looks).toEqual([]); expect(f.mirror.referencePreparationStatus(a.id).state).toBe('unconfigured');
  expect(f.issue).not.toHaveBeenCalled();
});
it('migrates previously published material on and historical unpublished material off, with a recoverable backup', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); const b = await f.add('B', 'blue');
  const filename = join(f.directory, 'exhibition.json'); const saved = JSON.parse(readFileSync(filename, 'utf8')); saved.state = f.mirror.read();
  saved.schemaVersion = 5; saved.state.publication = { revision: 3, publishedAt: Date.now(), legacy: false, looks: [a] }; delete saved.state.materialVersions; delete saved.state.catalog;
  writeFileSync(filename, JSON.stringify(saved)); const upgraded = new ExhibitionService(f.directory, { strictStorage: true });
  expect(upgraded.read().enabledLookIds).toEqual([a.id]); expect(upgraded.read().looks.map(look => look.id)).toContain(b.id);
  expect(upgraded.read().publication).toBeUndefined(); expect(existsSync(filename + '.before-material-workflow.json')).toBe(true);
  expect(new ExhibitionService(f.directory, { strictStorage: true }).read()).toEqual(upgraded.read());
});
it('preserves failed replacement fallback and files through schema 5 migration before service attachment', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [a.id] });
  const old = f.mirror.read().catalog!.looks[0]!;
  await f.mirror.updateLook(a.id, { name: 'Pending', imageBase64: await f.image('blue'), referenceImageBase64: await f.image('green') });
  const filename = join(f.directory, 'exhibition.json'); const stored = JSON.parse(readFileSync(filename, 'utf8'));
  stored.schemaVersion = 5; stored.state = f.mirror.read(); stored.state.publication = { revision: 1, publishedAt: Date.now(), legacy: false, looks: [old] }; delete stored.state.materialVersions; delete stored.state.catalog;
  writeFileSync(filename, JSON.stringify(stored));
  const reopened = new ExhibitionService(f.directory, { strictStorage: true });
  const parts = old.referenceImage!.split('/assets/')[1]!.split('/'); expect(reopened.assetResource(parts[0]!, parts[1], parts[2]).data.length).toBeGreaterThan(0);
  expect(reopened.read().materialVersions!.some(look => look.contentVersion === old.contentVersion)).toBe(true);
  reopened.attachLiveService(f.service);
  expect(reopened.read().catalog!.looks[0]!.contentVersion).toBe(old.contentVersion);
});
it('rejects corrupted new-schema material versions without resetting the library', async () => {
  const f = await fixture(); await f.add('A', 'red'); const filename = join(f.directory, 'exhibition.json');
  const saved = JSON.parse(readFileSync(filename, 'utf8')); delete saved.state.materialVersions; writeFileSync(filename, JSON.stringify(saved));
  expect(() => new ExhibitionService(f.directory)).toThrow('Invalid exhibition mirror data');
});
it('validates exact SKU and file roles before a bounded sequential import', () => {
  const item = { sku: 'SKU-1', name: 'One', mode: 'clothx', displayFile: 'display/SKU-1.png', referenceFile: 'reference/SKU-1.png' };
  expect(validateMaterialImport({ items: [item], files: [item.displayFile, item.referenceFile] }).valid).toBe(true);
  const bad = validateMaterialImport({ items: [item, item], files: [item.displayFile] });
  expect(bad.valid).toBe(false); expect(bad.items[1].errors).toContain('SKU 重复'); expect(bad.items[0].errors).toContain('缺少参考图');
});

it('wakes an active browser catalog when its deferred mode becomes ready while the source has another mode', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [a.id] });
  const child = new ExhibitionService(join(f.directory, 'child'), { mirrorId: 'test-child' }); child.attachLiveService(f.service.forBrowserTest('default')); child.syncSourceCatalog(f.mirror);
  child.command({ action: 'configure', providerMode: 'xmax' }); child.command({ action: 'begin' });
  const unsubscribe = f.mirror.subscribe(() => child.syncSourceCatalog(f.mirror));
  try {
    f.mirror.command({ action: 'configure', experienceMode: 'charx' });
    const pending = await f.add('B', 'blue'); const sourceRevision = f.mirror.read().catalog!.revision;
    const before = child.read().revision; const notify = vi.fn(); const stop = child.subscribe(notify);
    await f.mirror.prepareReference(pending.id);
    expect(f.mirror.read().catalog!.revision).toBe(sourceRevision);
    expect(child.read().experienceMode).toBe('clothx'); expect(child.read().catalog!.availableLookIds).toContain(pending.id);
    expect(child.read().revision).toBeGreaterThan(before); expect(notify).toHaveBeenCalled(); stop();
  } finally { unsubscribe(); child.markRemoved(); }
});

it('retains the provider-applied input across cold recovery until cloud stop is confirmed', async () => {
  const f = await fixture(); const a = await f.add('A', 'red'); await f.mirror.prepareReference(a.id);
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [a.id] }); f.mirror.command({ action: 'begin' });
  await f.mirror.createLiveSession({ deviceId: 'fixture-device', lookId: a.id, generationNumber: f.mirror.get().generationNumber });
  const bound = f.mirror.read().boundLook!; const parts = bound.referenceImage!.split('/assets/')[1]!.split('/');
  await f.mirror.updateLook(a.id, { name: 'Replacement', imageBase64: await f.image('blue'), referenceImageBase64: await f.image('green') }); await f.mirror.prepareReference(a.id);
  expect(f.mirror.read().catalog!.looks[0]!.contentVersion).not.toBe(bound.contentVersion);
  f.provider.deactivate = async () => { throw new Error('stop unavailable'); };
  const reopened = new ExhibitionService(f.directory, { strictStorage: true }); reopened.attachLiveService(f.service);
  await reopened.reconcileLive();
  expect(reopened.read().boundLook!.contentVersion).toBe(bound.contentVersion); expect(reopened.read().live).not.toBeNull();
  expect(reopened.assetResource(parts[0]!, parts[1], parts[2]).data.length).toBeGreaterThan(0);
  f.provider.deactivate = async () => ({ status: 'inactive', consumedCredit: 0 }); await reopened.reconcileLive();
  expect(reopened.read().live).toBeNull(); expect(reopened.read().boundLook).toBeUndefined();
  expect(() => reopened.assetResource(parts[0]!, parts[1], parts[2])).toThrowError(expect.objectContaining({ code: 'EXHIBITION_ASSET_NOT_FOUND' }));
});
