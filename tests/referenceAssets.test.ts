import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReferenceAssets } from '../server/referenceAssets';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
it('reuses an exact prepared reference across experiences and process reopen, isolated by account and region', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-reference-')); directories.push(directory);
  const upload = vi.fn(async () => 'https://fixture-123.cos.ap-test.myqcloud.com/image.webp');
  const provider = { upload, check: vi.fn(async () => true) };
  const input = { scope: 'account-cn', bytes: Buffer.from('original-image'), mime: 'image/webp' };
  const assets = new ReferenceAssets(directory, { now: () => 1_000 });
  await Promise.all([assets.prepare(input, provider), assets.prepare(input, provider)]);
  expect(upload).toHaveBeenCalledTimes(1);
  const reopened = new ReferenceAssets(directory, { now: () => 2_000 });
  expect(reopened.ready(input)).toMatchObject({ url: 'https://fixture-123.cos.ap-test.myqcloud.com/image.webp' });
  expect(reopened.ready({ ...input, scope: 'another-account' })).toBeNull();
  expect(reopened.ready({ ...input, bytes: Buffer.from('changed-image') })).toBeNull();
  expect(new ReferenceAssets(directory, { now: () => 100_000_000 }).ready(input)).toBeNull();
});
it('revalidates stale copies, backs off uncertain failures, and only reuploads a confirmed missing copy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-reference-')); directories.push(directory);
  let now = 1_000;
  const assets = new ReferenceAssets(directory, { now: () => now });
  const input = { scope: 'cn-account', bytes: Buffer.from('original'), mime: 'image/png' };
  const provider = { upload: vi.fn(async () => 'https://fixture-123.cos.ap-test.myqcloud.com/a.png'), check: vi.fn(async () => true) };
  await assets.prepare(input, provider); now += 3_600_001;
  provider.check.mockRejectedValueOnce(new Error('network uncertain'));
  await expect(assets.prepare(input, provider)).rejects.toThrow('network uncertain');
  await expect(assets.prepare(input, provider)).rejects.toThrow('cooling down');
  expect(provider.upload).toHaveBeenCalledOnce(); expect(assets.ready(input)).toBeNull();
  now += 60_001; await assets.prepare(input, provider);
  expect(provider.upload).toHaveBeenCalledOnce(); expect(assets.ready(input)).not.toBeNull();
  now += 3_600_001; provider.check.mockResolvedValueOnce(false); await assets.prepare(input, provider);
  expect(provider.upload).toHaveBeenCalledTimes(2);
});
it('keeps valid readiness during refresh outage and honors cooldown without invalidating binding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-reference-')); directories.push(directory); let now = 1_000;
  const assets = new ReferenceAssets(directory, { now: () => now }); const input = { scope: 'account', bytes: Buffer.from('stable'), mime: 'image/png' };
  const provider = { upload: vi.fn(async () => 'https://fixture-123.cos.ap-test.myqcloud.com/a.png'), check: vi.fn(async () => true) };
  const ready = await assets.prepare(input, provider); now = ready.freshUntil - 120_000;
  provider.check.mockRejectedValueOnce(Error('DNS unavailable'));
  await expect(assets.prepare(input, provider)).rejects.toThrow('DNS unavailable');
  expect(assets.status({ ...input, sha256: ready.sha256 })).toMatchObject({ state: 'ready', refreshState: 'failed', freshUntil: ready.freshUntil });
  expect(assets.acquire(ready.bindingId, { ...input, sha256: ready.sha256 })).toEqual(ready);
  expect(provider.upload).toHaveBeenCalledOnce();
});
it('does not resurrect expired binding after successful availability refresh', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-reference-')); directories.push(directory); let now = 1_000;
  const assets = new ReferenceAssets(directory, { now: () => now }); const input = { scope: 'account', bytes: Buffer.from('stable'), mime: 'image/png' };
  const provider = { upload: vi.fn(async () => 'https://fixture-123.cos.ap-test.myqcloud.com/a.png'), check: vi.fn(async () => true) };
  const old = await assets.prepare(input, provider); now = old.freshUntil + 1; const renewed = await assets.prepare(input, provider);
  expect(renewed.bindingId).not.toBe(old.bindingId); expect(provider.upload).toHaveBeenCalledOnce();
  expect(assets.acquire(old.bindingId, { ...input, sha256: old.sha256 })).toBeNull();
});
it('bounds freshness by provider hard expiry and reuploads instead of extending expired provider object', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-reference-')); directories.push(directory); let now = 1_000;
  const assets = new ReferenceAssets(directory, { now: () => now }); const input = { scope: 'decart-account', bytes: Buffer.from('stable'), mime: 'image/png' };
  const provider = { upload: vi.fn(async () => ({ url: 'file_fixture', providerExpiresAt: now + 120_000 })), check: vi.fn(async () => true) };
  const old = await assets.prepare(input, provider); expect(old.freshUntil).toBe(121_000); now = 121_001;
  const renewed = await assets.prepare(input, provider); expect(renewed.bindingId).not.toBe(old.bindingId); expect(provider.upload).toHaveBeenCalledTimes(2); expect(provider.check).not.toHaveBeenCalled();
});
it('invalidates a definitively missing replica even if its replacement upload fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-reference-')); directories.push(directory); let now = 1_000;
  const assets = new ReferenceAssets(directory, { now: () => now }); const input = { scope: 'account', bytes: Buffer.from('stable'), mime: 'image/png' };
  const provider = { upload: vi.fn(async () => 'https://fixture-123.cos.ap-test.myqcloud.com/a.png'), check: vi.fn(async () => true) };
  const old = await assets.prepare(input, provider); now = old.freshUntil - 60_000;
  provider.check.mockResolvedValue(false); provider.upload.mockRejectedValueOnce(Error('upload outage'));
  await expect(assets.prepare(input, provider)).rejects.toThrow('upload outage'); expect(assets.ready(input)).toBeNull();
});
it('a delayed worker cannot overwrite a newer persisted replica from another worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-reference-')); directories.push(directory);
  const first = new ReferenceAssets(directory); const second = new ReferenceAssets(directory);
  const input = { scope: 'account', bytes: Buffer.from('stable'), mime: 'image/png' };
  let finish!: (url: string) => void;
  const pending = first.prepare(input, { upload: () => new Promise(resolve => { finish = resolve; }), check: async () => true });
  const winner = await second.prepare(input, { upload: async () => 'https://fixture-123.cos.ap-test.myqcloud.com/new.png', check: async () => true });
  finish('https://fixture-123.cos.ap-test.myqcloud.com/old.png');
  expect(await pending).toEqual(winner); expect(first.ready(input)).toEqual(winner);
});
it('rejects acquisition below the minimum use window even while locally fresh', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-reference-')); directories.push(directory); let now = 1_000;
  const assets = new ReferenceAssets(directory, { now: () => now }); const input = { scope: 'account', bytes: Buffer.from('stable'), mime: 'image/png' };
  const ready = await assets.prepare(input, { upload: async () => 'https://fixture-123.cos.ap-test.myqcloud.com/a.png', check: async () => true });
  now = ready.freshUntil - 29_999;
  expect(assets.ready(input)).not.toBeNull(); expect(assets.acquire(ready.bindingId, { ...input, sha256: ready.sha256 })).toBeNull();
});
