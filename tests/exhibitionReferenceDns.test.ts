import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publicAddress, TryOnService } from '../server/service.ts';
import { ReferenceAssets } from '../server/referenceAssets.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { Provider } from '../server/types.ts';
const cleanup: (() => void)[] = [];
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No network in trusted binding tests')); });
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });
const initial = { lookId: 'commute', deviceId: 'screen-trusted', name: '通勤', referenceAsset: '/assets/exhibition/commute-cutout.png', sessionNumber: 1, generationNumber: 1 };
async function fixture() {
  let now = Date.now();
  const directory = mkdtempSync(join(tmpdir(), 'trusted-bind-')); const store = new SessionStore(':memory:');
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const expiresAt = new Date(now + 120_000).toISOString();
  let currentKey = 'uk-trusted-fixture';
  const provider: Provider = { configured: true, credentialSnapshot: () => currentKey, issueKey: vi.fn(async () => ({ token: 'tk-trusted', expiresAt })),
    keyStatus: async () => ({ status: 'active', consumedCredit: 0, expireTimestamp: expiresAt }), deactivate: async () => ({ status: 'inactive', consumedCredit: 0, expireTimestamp: expiresAt }), sessionStatus: async (_, sessionUid) => ({ sessionUid, status: 'active', consumedCredit: 0 }) };
  const resolveHost = vi.fn(async () => { throw Error('DNS must not run during trusted acquisition'); });
  const service = new TryOnService({ provider, providerForApiKey: () => provider, store, secrets: new SecretBox(randomBytes(32)), resolveHost,
    referenceAssets: new ReferenceAssets(directory, { now: () => now }), referenceStorage: () => ({ upload: async () => 'https://fixture-123.cos.ap-test.myqcloud.com/reference.webp', check: async () => true }) });
  const bytes = Buffer.from('exact-reference-content'); const expected = { sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'image/webp' };
  const prepared = (await service.prepareReference('default', bytes, expected.mime))!; const session = await service.createExhibition(initial);
  return { service, store, session, prepared, expected, resolveHost, rotate: () => { currentKey = 'uk-rotated-fixture'; }, expire: () => { now += 3_600_001; } };
}
it('acquires ready references and updates same lease without DNS even while resolver is down', async () => {
  const f = await fixture();
  await f.service.bindExhibitionReference(f.session.id, { deviceId: initial.deviceId, lookId: initial.lookId, bindingId: f.prepared.bindingId }, f.expected);
  await f.service.link(f.session.id, 'ums-trusted');
  await expect(f.service.updateExhibitionCondition(f.session.id, { deviceId: initial.deviceId, lookId: 'city', referenceAsset: '/assets/exhibition/city-cutout.png', sessionNumber: 1, generationNumber: 2, bindingId: f.prepared.bindingId }, () => true, f.expected)).resolves.toMatchObject({ referenceVersion: 2, refImageUrl: f.prepared.url });
  expect(f.resolveHost).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it.each(['missing', 'wrong-id', 'wrong-content', 'wrong-account', 'expired'])('rejects %s trusted reference without changing session', async scenario => {
  const f = await fixture(); const before = f.store.get(f.session.id);
  if (scenario === 'expired') f.expire();
  if (scenario === 'wrong-account') f.store.update(f.session.id, { referenceScope: 'another-account' });
  await expect(f.service.bindExhibitionReference(f.session.id, { deviceId: initial.deviceId, lookId: initial.lookId,
    bindingId: scenario === 'missing' ? undefined : scenario === 'wrong-id' ? 'other' : f.prepared.bindingId,
    refImageUrl: 'https://arbitrary.example/reference.webp' }, scenario === 'wrong-content' ? { ...f.expected, sha256: '0'.repeat(64) } : f.expected)).rejects.toMatchObject({ code: scenario === 'missing' || scenario === 'wrong-account' ? 'REFERENCE_BINDING_INVALID' : 'REFERENCE_NOT_READY' });
  expect(f.store.get(f.session.id).refImageUrl).toBe(before.refImageUrl); expect(f.resolveHost).not.toHaveBeenCalled();
});
it.each(['2001:2::28', '198.18.0.40', '198.19.255.255'])('keeps benchmark address %s blocked for network validation', address => expect(publicAddress(address)).toBe(false));

it('rejects a formerly ready binding after the configured provider account rotates', async () => {
  const f = await fixture(); f.rotate();
  await expect(f.service.bindExhibitionReference(f.session.id, { deviceId: initial.deviceId, lookId: initial.lookId, bindingId: f.prepared.bindingId }, f.expected)).rejects.toMatchObject({ code: 'REFERENCE_BINDING_INVALID' });
  expect(f.service.readyReference('default', Buffer.from('exact-reference-content'), f.expected.mime)).toBeNull();
  expect(f.resolveHost).not.toHaveBeenCalled();
});
