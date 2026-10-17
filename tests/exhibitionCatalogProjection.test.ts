import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ExhibitionMirrors } from '../server/exhibitionMirrors';
import { TryOnService } from '../server/service';
import { ReferenceAssets } from '../server/referenceAssets';
import { MirrorCredentialStore } from '../server/mirrorCredentials';
import { DecartProvider } from '../server/decart';
import { SecretBox, SessionStore } from '../server/store';
import type { Provider } from '../server/types';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).forEach(cleanup => cleanup()); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-projection-'));
  const secrets = SecretBox.forDirectory(directory); const store = new SessionStore(':memory:');
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let now = Date.now();
  const credentials = new MirrorCredentialStore(directory, secrets);
  const forbidden = vi.fn(async () => { throw Error('Generation forbidden'); });
  const provider: Provider = { configured: true, credentialSnapshot: () => 'uk-fixture', region: 'cn', issueKey: forbidden, deactivate: forbidden, keyStatus: forbidden, sessionStatus: forbidden };
  const references = new ReferenceAssets(directory, { now: () => now });
  const service = new TryOnService({ provider, store, secrets, mirrorCredentials: credentials, referenceAssets: references,
    referenceStorage: () => ({ upload: async (_bytes, sha) => ({ url: `https://fixture-123.cos.ap-test.myqcloud.com/${sha}.png`, providerExpiresAt: now + 60_000 }) }),
    decartProvider: key => new DecartProvider(key, async (_url, init) => {
      const bytes = Buffer.from(await ((init!.body as FormData).get('file') as Blob).arrayBuffer());
      return Response.json({ id: `file_${createHash('sha256').update(bytes).digest('hex')}`, expires_at: null });
    }),
  });
  service.saveMirrorCredentials('default', { apiKey: 'uk-mirrorfixture', expectedRevision: 0, region: 'cn' });
  service.saveProviderSettings('default', { provider: 'decart', apiKey: 'dct_fixture', expectedRevision: 0 }, true);
  service.saveProviderSettings('default', { provider: 'xmax', expectedRevision: 1 }, true, true);
  const mirrors = new ExhibitionMirrors(directory, { now: () => now }); mirrors.attachLiveService(service);
  const mirror = mirrors.getMirror();
  for (const look of mirror.read().looks) for (const target of ['xmax', 'decart'] as const) await mirror.prepareReference(look.id, target);
  mirror.command({ action: 'configure', providerMode: 'xmax' });
  return { directory, service, mirror, references, forbidden, advance: (ms: number) => { now += ms; } };
}

it('checks each provider and reference once per synchronous catalogue projection', async () => {
  const f = await fixture();
  const configured = vi.spyOn(f.service, 'materialProviderConfigured');
  const ready = vi.spyOn(f.service, 'readyReferenceIdentity');
  const disk = vi.spyOn(f.references, 'ready');
  expect(f.mirror.read().catalog!.availableLookIds).toEqual(['commute', 'city', 'evening']);
  expect(configured).toHaveBeenCalledTimes(2);
  expect(ready).toHaveBeenCalledTimes(6);
  expect(disk).toHaveBeenCalledTimes(6);
  f.mirror.read();
  expect(configured).toHaveBeenCalledTimes(4);
  expect(ready).toHaveBeenCalledTimes(12);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('observes new credentials and their different asset scope on the very next read', async () => {
  const f = await fixture(); const before = f.mirror.read().catalog!;
  f.service.saveMirrorCredentials('default', { apiKey: 'uk-otherfixture', expectedRevision: 1, region: 'cn' });
  const after = f.mirror.read().catalog!;
  expect(after.availableLookIds).toEqual([]); expect(after.revision).not.toBe(before.revision);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('checks actual supplier expiry again on the next read', async () => {
  const f = await fixture(); expect(f.mirror.read().catalog!.looks).toHaveLength(3);
  f.advance(60_001); expect(f.mirror.read().catalog!.looks).toEqual([]);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('rejects a replaced reference identity immediately without reusing the previous projection', async () => {
  const f = await fixture(); expect(f.mirror.read().catalog!.looks).toHaveLength(3);
  const directory = join(f.directory, 'prepared-references');
  for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
    const path = join(directory, file); const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.url?.startsWith('https://')) { record.sha256 = '0'.repeat(64); writeFileSync(path, JSON.stringify(record)); }
  }
  expect(f.mirror.read().catalog!.looks).toEqual([]);
  expect(f.forbidden).not.toHaveBeenCalled();
});
