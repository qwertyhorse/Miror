import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ReferencePreparationError } from '../server/referencePreparation';
import { ReferenceAssets } from '../server/referenceAssets';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-reference-')); directories.push(directory);
  let now = 1_000;
  const assets = new ReferenceAssets(directory, { now: () => now });
  const input = { scope: 'account-cn', bytes: Buffer.from('original-image'), mime: 'image/png' };
  const provider = { upload: vi.fn(async () => 'https://fixture-123.cos.ap-test.myqcloud.com/image.png'), check: vi.fn(async () => { throw Error('DNS offline'); }) };
  return { directory, assets, input, provider, now: () => now, advance: (ms: number) => { now += ms; } };
}
it('uploads once across concurrent calls, 90 days, and process restart with zero availability probes', async () => {
  const f = fixture();
  const [ready] = await Promise.all([f.assets.prepare(f.input, f.provider), f.assets.prepare(f.input, f.provider)]);
  f.advance(90 * 86400_000);
  const reopened = new ReferenceAssets(f.directory, { now: f.now });
  expect(await reopened.prepare(f.input, f.provider)).toEqual(ready);
  expect(reopened.acquire(ready.bindingId, { ...f.input, sha256: ready.sha256 })).toEqual(ready);
  expect(reopened.ready({ ...f.input, scope: 'another-account' })).toBeNull();
  expect(reopened.ready({ ...f.input, bytes: Buffer.from('changed') })).toBeNull();
  expect(reopened.ready({ ...f.input, mime: 'image/webp' })).toBeNull();
  expect(f.provider.upload).toHaveBeenCalledOnce(); expect(f.provider.check).not.toHaveBeenCalled();
  const record = JSON.parse(readFileSync(join(f.directory, 'prepared-references', readdirSync(join(f.directory, 'prepared-references'))[0]), 'utf8'));
  expect(record.schemaVersion).toBe(3); expect(record).not.toHaveProperty('freshUntil');
});
it('preserves an existing binding when explicit replacement fails and coalesces repair retries', async () => {
  const f = fixture(); const old = await f.assets.prepare(f.input, f.provider);
  f.provider.upload.mockRejectedValueOnce(Error('upload outage'));
  await expect(f.assets.prepare(f.input, f.provider, { replace: true })).rejects.toThrow('upload outage');
  expect(f.assets.acquire(old.bindingId, { ...f.input, sha256: old.sha256 })).toEqual(old);
  expect(f.assets.status({ ...f.input, sha256: old.sha256 })).toMatchObject({ state: 'ready', refreshState: 'failed' });
  await expect(f.assets.prepare(f.input, f.provider, { replace: true })).rejects.toThrow('cooling down');
  f.advance(60_001);
  const [next, same] = await Promise.all([f.assets.prepare(f.input, f.provider, { replace: true }), f.assets.prepare(f.input, f.provider, { replace: true })]);
  expect(next).toEqual(same); expect(next.bindingId).not.toBe(old.bindingId);
  expect(f.provider.upload).toHaveBeenCalledTimes(3);
  expect(f.assets.acquire(old.bindingId, { ...f.input, sha256: old.sha256 })).toBeNull();
});
it('honors real supplier expiry and preserves a still-usable old file during failed migration', async () => {
  const f = fixture();
  const provider = { upload: vi.fn(async () => ({ url: 'file_legacy', providerExpiresAt: f.now() + 600_000 })), check: f.provider.check };
  const old = await f.assets.prepare(f.input, provider);
  f.advance(400_000); provider.upload.mockRejectedValueOnce(Error('offline'));
  await expect(f.assets.prepare(f.input, provider, { replace: true })).rejects.toThrow('offline');
  expect(f.assets.acquire(old.bindingId, { ...f.input, sha256: old.sha256 })).toEqual(old);
  f.advance(171_000);
  expect(f.assets.ready(f.input)).not.toBeNull(); expect(f.assets.acquire(old.bindingId, { ...f.input, sha256: old.sha256 })).toBeNull();
  f.advance(30_000); expect(f.assets.ready(f.input)).toBeNull();
  const next = await f.assets.prepare(f.input, provider); expect(next.bindingId).not.toBe(old.bindingId);
  expect(provider.check).not.toHaveBeenCalled();
});
it.each(['xmax', 'decart-with-expiry', 'decart-missing-expiry'])('migrates v2 %s records without inventing permanence for timed files', async kind => {
  const f = fixture(); const old = await f.assets.prepare(f.input, f.provider);
  const path = join(f.directory, 'prepared-references', readdirSync(join(f.directory, 'prepared-references'))[0]);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.schemaVersion = 2; record.freshUntil = 3_601_000;
  if (kind.startsWith('decart')) record.url = 'file_legacy';
  if (kind === 'decart-with-expiry') record.providerExpiresAt = 86_401_000;
  writeFileSync(path, JSON.stringify(record)); f.advance(3_600_001);
  const reopened = new ReferenceAssets(f.directory, { now: f.now });
  if (kind === 'xmax') expect(reopened.ready(f.input)).toMatchObject({ bindingId: old.bindingId, freshUntil: Number.MAX_SAFE_INTEGER });
  if (kind === 'decart-with-expiry') { expect(reopened.ready(f.input)?.freshUntil).toBe(86_401_000); f.advance(86_400_000); expect(reopened.ready(f.input)).toBeNull(); }
  if (kind === 'decart-missing-expiry') expect(reopened.ready(f.input)).toBeNull();
});
it('a delayed worker cannot overwrite a newer persisted replica from another worker', async () => {
  const f = fixture(); const second = new ReferenceAssets(f.directory);
  let finish!: (url: string) => void;
  const pending = f.assets.prepare(f.input, { upload: () => new Promise(resolve => { finish = resolve; }), check: f.provider.check });
  const winner = await second.prepare(f.input, f.provider);
  finish('https://fixture-123.cos.ap-test.myqcloud.com/old.png');
  expect(await pending).toEqual(winner); expect(f.assets.ready(f.input)).toEqual(winner);
});

it('bounds transient upload attempts across restarts and explicit retry resets the failed identity', async () => {
  const f = fixture(); const failing = { upload: vi.fn(async () => { throw new ReferencePreparationError('upload', 'timeout'); }) };
  const identity = { scope: f.input.scope, mime: f.input.mime, sha256: createHash('sha256').update(f.input.bytes).digest('hex') };
  let assets = f.assets;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect(assets.prepare(f.input, failing)).rejects.toThrow();
    expect(assets.status(identity).retryAt !== undefined).toBe(attempt < 3);
    f.advance(60_001); assets = new ReferenceAssets(f.directory, { now: f.now });
  }
  expect(assets.status(identity)).toMatchObject({ state: 'failed' });
  expect(assets.status(identity).retryAt).toBeUndefined();
  await expect(assets.prepare(f.input, failing)).rejects.toThrow('manual retry');
  expect(failing.upload).toHaveBeenCalledTimes(3);
  await expect(assets.prepare(f.input, failing, { manualRetry: true })).rejects.toThrow();
  expect(assets.status(identity).retryAt).toBeGreaterThan(f.now());
  expect(failing.upload).toHaveBeenCalledTimes(4);
  expect(readFileSync(join(f.directory, 'prepared-references', readdirSync(join(f.directory, 'prepared-references'))[0]), 'utf8')).not.toContain('tk-');
});
it.each(['denied', 'not_configured', 'unsafe', 'malformed', 'not_found', 'invalid_request'] as const)('requires manual retry after permanent %s failures and isolates new account/content identities', async failure => {
  const f = fixture(); const failing = { upload: vi.fn(async () => { throw new ReferencePreparationError('credentials', failure); }) };
  await expect(f.assets.prepare(f.input, failing)).rejects.toThrow(); f.advance(600_000);
  const reopened = new ReferenceAssets(f.directory, { now: f.now });
  await expect(reopened.prepare(f.input, failing)).rejects.toThrow('manual retry'); expect(failing.upload).toHaveBeenCalledOnce();
  await expect(reopened.prepare(f.input, f.provider, { manualRetry: true })).resolves.toHaveProperty('bindingId');
  await expect(reopened.prepare({ ...f.input, scope: 'new-account' }, f.provider)).resolves.toHaveProperty('bindingId');
  await expect(reopened.prepare({ ...f.input, bytes: Buffer.from('new-content') }, f.provider)).resolves.toHaveProperty('bindingId');
});
it('counts an interrupted upload attempt after reopening and recovers its unfinished work', async () => {
  const f = fixture(); let finish!: (value: string) => void;
  const task = f.assets.prepare(f.input, { upload: () => new Promise(resolve => { finish = resolve; }) });
  const reopened = new ReferenceAssets(f.directory, { now: f.now });
  const failed = { upload: vi.fn(async () => { throw new ReferencePreparationError('upload', 'network'); }) };
  await expect(reopened.prepare(f.input, failed)).rejects.toThrow(); f.advance(60_001);
  await expect(reopened.prepare(f.input, failed)).rejects.toThrow(); f.advance(60_001);
  await expect(reopened.prepare(f.input, failed)).rejects.toThrow('manual retry'); expect(failed.upload).toHaveBeenCalledTimes(2);
  finish('https://fixture-123.cos.ap-test.myqcloud.com/recovered.png'); await task;
});
