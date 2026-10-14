import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApiServer } from '../server/http';
import { ExhibitionMirrors } from '../server/exhibitionMirrors';
import { TryOnService } from '../server/service';
import { SecretBox, SessionStore } from '../server/store';
import { ReferenceAssets } from '../server/referenceAssets';
import { ReferencePreparationError } from '../server/referencePreparation';
import { referenceStorage } from '../server/referenceStorage';
import type { Provider } from '../server/types';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const cloudUrl = 'https://fixture-123.cos.ap-test.myqcloud.com/ready.png';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'reference-status-'));
  const store = new SessionStore(':memory:');
  let now = Date.now(), key = 'uk-private-fixture-account';
  const expiresAt = new Date(now + 120_000).toISOString();
  const issue = vi.fn(async () => ({ token: 'tk-private-fixture-only', expiresAt }));
  const provider: Provider = { configured: true, region: 'cn', credentialSnapshot: () => key, issueKey: issue,
    deactivate: async () => ({ status: 'inactive', consumedCredit: 0, expireTimestamp: expiresAt }),
    keyStatus: async () => ({ status: 'active', consumedCredit: 0, expireTimestamp: expiresAt }),
    sessionStatus: async (_, sessionUid) => ({ sessionUid, status: 'active', consumedCredit: 0 }) };
  const upload = vi.fn(async () => cloudUrl);
  const check = vi.fn(async () => true);
  const assets = new ReferenceAssets(directory, { now: () => now });
  const service = new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), referenceAssets: assets,
    referenceStorage: () => ({ upload, check }) });
  const mirrors = new ExhibitionMirrors(directory, { now: () => now });
  const server = createApiServer(service, undefined, undefined, mirrors);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; store.close(); rmSync(directory, { force: true, recursive: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors/default`;
  const get = (path: string) => fetch(base + path);
  const post = (path: string) => fetch(base + path, { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' }, body: '{}' });
  return { get, post, upload, check, issue, assets, provider, mirror: mirrors.getMirror(),
    advance: (amount: number) => { now += amount; }, now: () => now,
    rotate: () => { key = 'uk-private-fixture-rotated'; }, disable: () => { provider.configured = false; } };
}

it('reports queued → preparing → ready, deduplicates retries, and exposes no storage URL or credential', async () => {
  const f = await fixture();
  expect((await (await f.get('/references')).json()).references.commute).toEqual({ state: 'queued' });
  expect(f.upload).not.toHaveBeenCalled();
  const pending = deferred<string>(); f.upload.mockImplementationOnce(() => pending.promise);
  const started = await f.post('/references/commute/retry');
  expect(started.status).toBe(202);
  expect(await started.json()).toMatchObject({ status: { state: 'preparing', stage: 'credentials' } });
  await f.post('/references/commute/retry'); expect(f.upload).toHaveBeenCalledOnce();
  pending.resolve(cloudUrl);
  await vi.waitFor(() => expect(f.mirror.referencePreparationStatus('commute').state).toBe('ready'));
  const batch = await (await f.get('/references')).json();
  expect(batch.references.commute).toMatchObject({ state: 'ready', freshUntil: f.now() + 3_600_000 });
  expect(JSON.stringify(batch)).not.toMatch(/https:|myqcloud|uk-|tk-|sha256|scope/);
  expect((await (await f.post('/references/commute/retry')).json()).status.state).toBe('ready');
  expect(f.upload).toHaveBeenCalledOnce(); expect(f.issue).not.toHaveBeenCalled();
  // The pre-existing screen API is unchanged.
  expect(await (await f.get('/references/commute')).json()).toMatchObject({ reference: { url: cloudUrl } });
  expect((await f.post('/references/commute')).status).toBe(200);
  expect((await f.post('/references/missing/retry')).status).toBe(404);
});

it('sanitizes failures and enforces cooldown before retrying without allocating a generation key', async () => {
  const f = await fixture();
  f.upload.mockRejectedValueOnce(new Error('upstream response uk-secret-leak https://private.example/token?secret=leak'));
  await f.post('/references/commute/retry');
  await vi.waitFor(() => expect(f.mirror.referencePreparationStatus('commute')).toMatchObject({ state: 'failed' }));
  const failed = await (await f.get('/references')).json();
  expect(failed.references.commute).toEqual({ state: 'failed', message: '准备失败，请稍后重试。', retryAt: f.now() + 60_000, updatedAt: f.now() });
  expect(JSON.stringify(failed)).not.toMatch(/uk-|private|token|leak/);
  expect((await f.post('/references/commute/retry')).status).toBe(202);
  expect(f.upload).toHaveBeenCalledOnce();
  f.advance(60_001); await f.post('/references/commute/retry');
  await vi.waitFor(() => expect(f.mirror.referencePreparationStatus('commute').state).toBe('ready'));
  expect(f.upload).toHaveBeenCalledTimes(2); expect(f.issue).not.toHaveBeenCalled();
});

it('isolates failures and in-flight completions when an account or region changes', async () => {
  const f = await fixture();
  const pending = deferred<string>(); f.upload.mockImplementationOnce(() => pending.promise);
  await f.post('/references/commute/retry');
  f.rotate(); expect(f.mirror.referencePreparationStatus('commute')).toEqual({ state: 'queued' });
  pending.resolve(cloudUrl);
  await vi.waitFor(() => expect(f.upload).toHaveBeenCalledOnce());
  expect(await (await f.get('/references/commute')).json()).toEqual({ reference: null });
  await f.post('/references/commute');
  expect(f.mirror.referencePreparationStatus('commute').state).toBe('ready');
  f.provider.region = 'global';
  expect(f.mirror.referencePreparationStatus('commute')).toEqual({ state: 'queued' });
  f.upload.mockRejectedValueOnce(new ReferencePreparationError('credentials', 'denied'));
  await f.post('/references/commute/retry');
  await vi.waitFor(() => expect(f.mirror.referencePreparationStatus('commute')).toMatchObject({ state: 'failed', stage: 'credentials', message: '密钥无效或无上传权限，请检查配置。' }));
  f.provider.region = 'cn'; expect(f.mirror.referencePreparationStatus('commute').state).toBe('ready');
});

it('makes unconfigured and prompt-only materials explicit without uploads', async () => {
  const f = await fixture();
  f.mirror.updateLook('commute', { mode: 'free', prompt: '水彩画', referenceKind: 'none' });
  expect(f.mirror.referencePreparationStatus('commute')).toEqual({ state: 'not_required' });
  expect(await (await f.post('/references/commute/retry')).json()).toEqual({ status: { state: 'not_required' } });
  f.disable();
  expect(f.mirror.referencePreparationStatus('city')).toEqual({ state: 'unconfigured' });
  expect(await (await f.post('/references/city/retry')).json()).toEqual({ status: { state: 'unconfigured' } });
  expect(f.upload).not.toHaveBeenCalled(); expect(f.issue).not.toHaveBeenCalled();
});

it('caches immutable source digests for repeated batch reads and bounds missing-source retries', async () => {
  const f = await fixture();
  const image = await sharp({ create: { width: 512, height: 512, channels: 4, background: '#eeeeee' } }).png().toBuffer();
  const state = await f.mirror.upload({ name: '素材', mode: 'clothx', imageBase64: image.toString('base64') });
  const look = state.looks.at(-1)!;
  const asset = vi.spyOn(f.mirror, 'asset');
  f.mirror.referencePreparationStatuses(); f.mirror.referencePreparationStatuses();
  expect(asset).toHaveBeenCalledOnce();
  asset.mockImplementation(() => { throw new Error('local path /secret/unavailable'); });
  await expect(f.mirror.prepareReference(look.id)).rejects.toThrow();
  const failed = f.mirror.referencePreparationStatus(look.id);
  expect(failed).toEqual({ state: 'failed', message: '本地图片不可用，请重新上传。', retryAt: f.now() + 60_000, updatedAt: f.now() });
  f.mirror.referencePreparationStatuses(); f.mirror.referencePreparationStatuses();
  expect(asset).toHaveBeenCalledTimes(2);
  f.advance(60_001); asset.mockRestore();
  expect(f.mirror.referencePreparationStatus(look.id)).toEqual({ state: 'queued' });
});

it('restores ready status after restart and reports revalidation failures without reuploading', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-status-reopen-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_000;
  const source = { scope: 'cn-fixture', bytes: Buffer.from('image'), mime: 'image/png' };
  const identity = { scope: source.scope, sha256: createHash('sha256').update(source.bytes).digest('hex'), mime: source.mime };
  const storage = { upload: vi.fn(async () => cloudUrl), check: vi.fn(async () => true) };
  await new ReferenceAssets(directory, { now: () => now }).prepare(source, storage);
  const reopened = new ReferenceAssets(directory, { now: () => now });
  expect(reopened.status(identity)).toEqual({ state: 'ready', freshUntil: now + 3_600_000 });
  now += 3_600_001;
  storage.check.mockRejectedValueOnce(new ReferencePreparationError('availability', 'network'));
  await expect(reopened.prepare(source, storage)).rejects.toThrow();
  expect(reopened.status(identity)).toMatchObject({ state: 'failed', stage: 'availability', retryAt: now + 60_000 });
  expect(storage.upload).toHaveBeenCalledOnce();
  now += 60_001; await reopened.prepare(source, storage);
  expect(reopened.status(identity).state).toBe('ready');
  expect(storage.upload).toHaveBeenCalledOnce();
});

it.each([
  ['credentials', 0, new Response(null, { status: 403 }), 'denied'],
  ['upload', 1, new Response(null, { status: 503 }), 'status'],
  ['check', 2, Response.json({ success: true, data: { safe: false, url: cloudUrl } }), 'unsafe'],
] as const)('labels %s failures while discarding raw upstream content', async (stage, index, failure, reason) => {
  const bytes = Buffer.from('image'); const sha = createHash('sha256').update(bytes).digest('hex');
  const responses = [Response.json({ success: true, data: { bucket: 'fixture-123', region: 'ap-test', prefix: 'references', credentials: { accessKeyId: 'sensitive-id', secretAccessKey: 'sensitive-secret', sessionToken: 'sensitive-token' } } }), new Response(), Response.json({ success: true, data: { safe: true, url: cloudUrl } })];
  responses[index] = failure;
  const call = vi.fn<typeof fetch>(async () => responses.shift()!);
  const onStage = vi.fn();
  await expect(referenceStorage('uk-private', 'cn', call).upload(bytes, sha, 'image/png', onStage)).rejects.toMatchObject({ stage, failure: reason, message: 'Reference preparation failed' });
  expect(onStage).toHaveBeenLastCalledWith(stage);
  expect(call).toHaveBeenCalledTimes(index + 1);
});
