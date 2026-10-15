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
  const look = state.looks.at(-1)!; await f.drain();
  expect(f.xmax.mock.calls.length).toBe(before[0] + 1); expect(f.decart.mock.calls.length).toBe(before[1] + 1);
  for (const target of ['xmax', 'decart'] as const) expect(f.mirror.referencePreparationStatus(look.id, false, target).state).toBe('ready');
  // The display image is not uploaded; published and draft snapshots share the same content reference.
  f.mirror.command({ action: 'configure', enabledLookIds: [look.id] }); f.mirror.publishPublication({});
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
