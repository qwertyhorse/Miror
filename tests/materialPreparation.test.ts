import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createMaterialPreparationQueue } from '../server/materialPreparation';
import { ExhibitionMirrors } from '../server/exhibitionMirrors';
import { TryOnService } from '../server/service';
import { ReferenceAssets } from '../server/referenceAssets';
import { MirrorCredentialStore } from '../server/mirrorCredentials';
import { DecartProvider } from '../server/decart';
import { SecretBox, SessionStore } from '../server/store';
import type { Provider } from '../server/types';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(close => close()));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(configureDecart = true) {
  const directory = mkdtempSync(join(tmpdir(), 'material-preupload-'));
  const secrets = SecretBox.forDirectory(directory); const store = new SessionStore(':memory:');
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let now = Date.now(); let failDecart = false;
  const credentials = new MirrorCredentialStore(directory, secrets);
  const issue = vi.fn(async () => { throw Error('No generation allowed'); });
  const provider: Provider = { configured: true, credentialSnapshot: () => 'uk-fixture', region: 'cn', issueKey: issue,
    deactivate: issue, keyStatus: issue, sessionStatus: issue };
  const xmax = vi.fn(async (_bytes: Buffer, sha: string) => `https://fixture-123.cos.ap-test.myqcloud.com/${sha}.png`);
  const decart = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (failDecart) return new Response(null, { status: 503 });
    const form = init!.body as FormData; expect(form.get('ttl_seconds')).toBe('persistent');
    const bytes = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
    return Response.json({ id: `file_${hash(bytes)}`, expires_at: null });
  });
  const service = new TryOnService({ provider, store, secrets, mirrorCredentials: credentials,
    referenceAssets: new ReferenceAssets(directory, { now: () => now }), referenceStorage: () => ({ upload: xmax, check: async () => { throw Error('No HEAD checks'); } }),
    decartProvider: key => new DecartProvider(key, decart) });
  const configure = () => {
    service.saveProviderSettings('default', { provider: 'decart', apiKey: 'dct_fixture', expectedRevision: service.providerSettings('default')!.revision }, true);
    service.saveProviderSettings('default', { provider: 'xmax', expectedRevision: service.providerSettings('default')!.revision }, true, true);
    expect(service.providerSettings('default')).toMatchObject({ active: 'xmax', desired: 'xmax', pending: false });
  };
  if (configureDecart) configure();
  const mirrors = new ExhibitionMirrors(directory, { now: () => now }); mirrors.attachLiveService(service);
  const mirror = mirrors.getMirror(); const queue = createMaterialPreparationQueue(mirrors, service, () => now);
  const drain = async () => { for (let i = 0; i < mirror.get().looks.length * 4 + 4; i++) await queue.runOnce(); };
  const image = async (color: string) => (await sharp({ create: { width: 512, height: 512, channels: 3, background: color } }).png().toBuffer()).toString('base64');
  return { service, mirror, drain, xmax, decart, issue, image, configure,
    advance: (ms: number) => { now += ms; }, fail: (value: boolean) => { failDecart = value; } };
}
it('automatically uploads new reference bytes to both configured services once without requesting a provider switch', async () => {
  const f = fixture(); await f.drain();
  const before = [f.xmax.mock.calls.length, f.decart.mock.calls.length];
  const state = await f.mirror.upload({ name: 'New material', imageBase64: await f.image('white'), referenceImageBase64: await f.image('red') });
  const look = state.looks[0]!;
  expect(look.name).toBe('New material');
  await f.drain();
  expect(f.xmax.mock.calls.length).toBe(before[0] + 1); expect(f.decart.mock.calls.length).toBe(before[1] + 1);
  for (const target of ['xmax', 'decart'] as const) expect(f.mirror.referencePreparationStatus(look.id, false, target).state).toBe('ready');
  // Replacing the display image keeps the model reference and performs no uploads.
  await f.mirror.updateLook(look.id, { imageBase64: await f.image('green') }); await f.drain();
  expect(f.xmax.mock.calls.length).toBe(before[0] + 1); expect(f.decart.mock.calls.length).toBe(before[1] + 1);
  f.mirror.command({ action: 'configure', enabledLookIds: [look.id] });
  f.advance(90 * 86400_000); await f.drain();
  expect(f.xmax.mock.calls.length).toBe(before[0] + 1); expect(f.decart.mock.calls.length).toBe(before[1] + 1);
  expect(f.service.providerSettings('default')).toMatchObject({ active: 'xmax', pending: false }); expect(f.issue).not.toHaveBeenCalled();
});
it('prepares newly configured standby provider and isolates its outage from the active provider', async () => {
  const f = fixture(false); await f.drain(); expect(f.decart).not.toHaveBeenCalled();
  const count = f.xmax.mock.calls.length; f.configure(); f.fail(true); await f.drain();
  expect(f.mirror.referencePreparationStatus('commute', true, 'xmax').state).toBe('ready');
  expect(f.mirror.referencePreparationStatus('commute', true, 'decart').state).toBe('failed');
  f.fail(false); f.advance(60_001); await f.drain();
  expect(f.mirror.referencePreparationStatus('commute', true, 'decart').state).toBe('ready');
  expect(f.xmax).toHaveBeenCalledTimes(count); expect(f.issue).not.toHaveBeenCalled();
});

it('preserves each provider effective version independently when the standby replacement fails', async () => {
  const f = fixture(); await f.drain();
  const look = (await f.mirror.upload({ name: 'Original', imageBase64: await f.image('white'), referenceImageBase64: await f.image('red') })).looks[0]!; await f.drain();
  f.mirror.command({ action: 'configure', providerMode: 'xmax', enabledLookIds: [look.id] });
  const old = f.mirror.read().catalog!.looks[0]!;
  await f.mirror.updateLook(look.id, { name: 'Updated', imageBase64: await f.image('green'), referenceImageBase64: await f.image('blue') }); f.fail(true); await f.drain();
  expect(f.mirror.read().catalog!.looks[0]!.name).toBe('Updated');
  f.service.saveProviderSettings('default', { provider: 'decart', expectedRevision: f.service.providerSettings('default')!.revision }, true, true);
  f.mirror.refreshMaterials(); expect(f.mirror.read().catalog!.looks[0]!.contentVersion).toBe(old.contentVersion);
  expect(f.mirror.materialReadinessStatus().targetReadyLookIds).toEqual([look.id]);
  expect(f.mirror.read().catalog!.looks[0]!.image).toBe(old.image); expect(f.issue).not.toHaveBeenCalled();
});
it('never reuses another account upload and automatically prepares the new scope', async () => {
  const f = fixture(); await f.drain(); f.mirror.command({ action: 'configure', providerMode: 'xmax' });
  const before = f.xmax.mock.calls.length; const oldScope = f.service.materialScope('default');
  f.service.saveMirrorCredentials('default', { apiKey: 'uk-otherfixture', expectedRevision: f.service.mirrorCredentialsStatus('default').revision, region: 'cn' });
  f.mirror.refreshMaterials(); expect(f.service.materialScope('default')).not.toBe(oldScope); expect(f.mirror.read().catalog!.looks).toEqual([]);
  await f.drain(); expect(f.mirror.read().catalog!.availableLookIds).toEqual(['commute', 'city', 'evening']); expect(f.xmax.mock.calls.length).toBe(before + 3); expect(f.issue).not.toHaveBeenCalled();
});

it.each(['begin', 'after-stop'] as const)('reconciles selection to a ready target item when switching provider %s', async trigger => {
  const f = fixture();
  for (const id of ['commute', 'city', 'evening']) await f.mirror.prepareReference(id, 'xmax');
  await f.mirror.prepareReference('city', 'decart');
  f.mirror.command({ action: 'configure', providerMode: 'xmax' }); f.mirror.command({ action: 'select', lookId: 'commute' });
  f.service.saveProviderSettings('default', { provider: 'decart', expectedRevision: f.service.providerSettings('default')!.revision }, true, false);
  const previous = f.mirror.read().revision; const notify = vi.fn(); const unsubscribe = f.mirror.subscribe(notify);
  if (trigger === 'after-stop') { f.service.requestProviderSwitch('default', f.service.providerSettings('default')!.revision); await f.mirror.reconcileLive(); }
  else f.mirror.command({ action: 'begin' });
  const state = f.mirror.read(); expect(state.selectedLookId).toBe('city'); expect(state.catalog!.availableLookIds).toEqual(['city']);
  expect(state.catalog!.providerId).toBe('decart'); expect(state.revision).toBeGreaterThan(previous); expect(notify).toHaveBeenCalled(); unsubscribe();
  if (trigger === 'begin') expect(state.activeLook!.id).toBe('city'); expect(f.issue).not.toHaveBeenCalled();
});
