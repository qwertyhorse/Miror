import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { BrowserTests, BROWSER_TEST_IDLE_MS, BROWSER_TEST_LIMIT, BROWSER_TEST_TTL_MS } from '../server/browserTests';
import { ExhibitionMirrors } from '../server/exhibitionMirrors';
import { MirrorCredentialStore } from '../server/mirrorCredentials';
import { ReferenceAssets } from '../server/referenceAssets';
import { XmaxProvider } from '../server/provider';
import { TryOnService } from '../server/service';
import { SecretBox, SessionStore } from '../server/store';
import type { XmaxRegion } from '../shared/xmax';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });
const keyDefault = 'uk-browser-default-fixture';
const keySource = 'uk-browser-source-fixture';
const keyChanged = 'uk-browser-changed-fixture';
const code = (value: string) => expect.objectContaining({ code: value });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-browser-test-'));
  let time = Date.now(); let stopFails = false;
  const now = () => time;
  const store = new SessionStore(':memory:'); const secrets = SecretBox.forDirectory(directory);
  const credentials = new MirrorCredentialStore(directory, secrets);
  const issued = new Map<string, { key: string; host: string; active: boolean; expiry: string }>();
  const requests: { path: string; host: string; key: string; body: unknown }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const key = new Headers(init?.headers).get('X-Api-Key') ?? '';
    requests.push({ path: url.pathname, host: url.hostname, key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (data: unknown) => Response.json({ success: true, data });
    if (url.pathname.endsWith('/temporary-api-key')) {
      const token = `tk-browser-${randomUUID()}`; const seconds = JSON.parse(String(init?.body)).expireSeconds;
      const expiry = new Date(time + seconds * 1_000).toISOString();
      issued.set(token, { key, host: url.hostname, active: true, expiry });
      return ok({ temporaryApiKey: token, expireTimestamp: expiry });
    }
    const request = /\/temporary-api-key\/([^/]+)\/(status|inactive)$/.exec(url.pathname);
    if (request) {
      const entry = issued.get(request[1]);
      if (!entry || key !== entry.key || url.hostname !== entry.host) return Response.json({ success: false }, { status: 403 });
      if (request[2] === 'inactive') {
        if (stopFails) throw new Error('offline');
        entry.active = false;
      }
      return ok({ status: entry.active ? 'active' : 'inactive', consumedCredit: 0, expireTimestamp: entry.expiry });
    }
    const session = /\/session\/([^/]+)\/status$/.exec(url.pathname);
    if (session && issued.has(key)) return ok({ sessionUid: session[1], status: 'ACTIVE', consumedCredit: 0 });
    throw new Error('Unexpected mock provider request');
  }) as typeof fetch;
  const provider = new XmaxProvider(keyDefault, fetcher);
  const uploads: { key: string; region: XmaxRegion; bytes: Buffer }[] = [];
  const service = new TryOnService({ store, secrets, provider, mirrorCredentials: credentials,
    referenceAssets: new ReferenceAssets(directory, { now }), resolveHost: async () => ['8.8.8.8'],
    referenceStorage: (key, region) => ({ upload: async (bytes, hash) => {
      uploads.push({ key, region, bytes }); return `https://browser-fixture-123.cos.ap-guangzhou.myqcloud.com/${hash}.webp`;
    }, check: async () => true }),
  });
  const mirrors = new ExhibitionMirrors(directory, { now }); mirrors.attachLiveService(service);
  const source = mirrors.getMirror();
  service.saveMirrorCredentials(source.mirrorId, { apiKey: keySource, region: 'cn', expectedRevision: 0 });
  const manager = new BrowserTests(directory, { now }); manager.attachLiveService(service);
  cleanups.push(async () => { stopFails = false; await manager.destroy(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, now, store, secrets, credentials, issued, requests, uploads, provider, fetcher, service, mirrors, source, manager,
    advance: (ms: number) => { time += ms; }, failStop: (value: boolean) => { stopFails = value; } };
}
async function image(color: string) { return (await sharp({ create: { width: 512, height: 512, channels: 4, background: color } }).png().toBuffer()).toString('base64'); }
async function upload(source: ReturnType<typeof fixture>['source']) {
  const state = await source.upload({ name: '双图素材', category: '通勤', tags: [], imageBase64: await image('#dd1111'), referenceImageBase64: await image('#1133ee'), mode: 'clothx' });
  const look = state.looks.at(-1)!;
  source.command({ action: 'configure', enabledLookIds: [...state.enabledLookIds, look.id] });
  await source.preparePublication({ lookIds: [...state.enabledLookIds, look.id] });
  await vi.waitFor(() => expect([...state.enabledLookIds, look.id].every(id => !!source.readyReference(id))).toBe(true));
  source.publishPublication({ lookIds: [...state.enabledLookIds, look.id] });
  source.command({ action: 'select', lookId: look.id });
  return look;
}
function testPath(f: ReturnType<typeof fixture>, id: string) {
  const root = join(f.directory, 'browser-tests');
  return readdirSync(root).map(run => join(root, run, id)).find(path => existsSync(path));
}
async function start(context: ReturnType<BrowserTests['resolve']>) {
  await context.exhibition.prepareReference(context.exhibition.read().selectedLookId!, undefined, true);
  context.exhibition.command({ action: 'configure', autoReturnSeconds: 0 });
  const state = context.exhibition.command({ action: 'begin' });
  return context.exhibition.createLiveSession({ deviceId: 'browser-test-camera', lookId: state.selectedLookId, generationNumber: state.generationNumber });
}

describe('independent complete browser tests', () => {
  it('snapshots the selected mode and look without ticking or changing a bound physical mirror', async () => {
    const f = fixture(); const terminal = { terminalId: `terminal-${randomUUID()}`, token: 'a'.repeat(64), label: '真实镜', platform: 'android' };
    f.mirrors.bindDevice('default', { code: f.mirrors.connectDevice(terminal).code });
    f.source.updateLook('city', { mode: 'charx' }); f.source.updateLook('evening', { mode: 'charx' });
    await f.source.preparePublication({ lookIds: ['city', 'evening'] }); await vi.waitFor(() => expect(['city', 'evening'].every(id => !!f.source.readyReference(id))).toBe(true)); f.source.publishPublication({ lookIds: ['city', 'evening'] });
    f.source.command({ action: 'configure', experienceMode: 'charx', materialDrawerColumns: 1 });
    f.source.command({ action: 'select', lookId: 'evening' }); f.source.command({ action: 'begin' });
    f.advance(3_000); // Calling source.get() would finish this demo and mutate its revision.
    const before = f.source.read(); const events = f.store.mirrorEvents('default'); const binding = f.mirrors.devices.binding('default');
    const created = f.manager.create(f.source, '展会智能镜 1'); const context = f.manager.resolve(created.mirror.id, created.token);
    expect(created).toMatchObject({ mirror: { name: '展会智能镜 1 · 浏览器测试', providerMode: 'xmax', binding: null }, expiresAt: f.now() + BROWSER_TEST_TTL_MS });
    expect(created.token).toMatch(/^[a-f0-9]{64}$/u); expect(created.mirror.id).toMatch(/^test-/u);
    expect(context.exhibition.read()).toMatchObject({ phase: 'select', experienceMode: 'charx', selectedLookId: 'evening', live: null, sessionNumber: 0, settings: { materialDrawerColumns: 1 } });
    expect(f.source.read()).toEqual(before); expect(f.store.mirrorEvents('default')).toEqual(events);
    expect(f.mirrors.devices.binding('default')).toEqual(binding);
    expect(f.mirrors.list().mirrors.map(mirror => mirror.id)).toEqual(['default']);
    expect(f.requests).toEqual([]); expect(f.store.list()).toEqual([]);
    expect(JSON.stringify(created)).not.toContain(keySource);
  });

  it('copies both uploaded images with new owned URLs and isolates later source edits', async () => {
    const f = fixture(); const sourceLook = await upload(f.source);
    const created = f.manager.create(f.source); const { exhibition } = f.manager.resolve(created.mirror.id, created.token);
    const copied = exhibition.read().looks.at(-1)!;
    expect(copied.id).not.toBe(sourceLook.id); expect(exhibition.read().selectedLookId).toBe(copied.id);
    expect(copied.image).toContain(`/mirrors/${created.mirror.id}/assets/${copied.id}/display/`);
    expect(copied.referenceImage).toContain(`/mirrors/${created.mirror.id}/assets/${copied.id}/reference/`);
    const display = exhibition.assetResource(copied.id, 'display', copied.image.split('/').at(-1)!).data;
    const reference = exhibition.assetResource(copied.id, 'reference', copied.referenceImage!.split('/').at(-1)!).data;
    expect(display).not.toEqual(reference); expect(display).toEqual(f.source.asset(sourceLook.id).data);
    await f.source.updateLook(sourceLook.id, { imageBase64: await image('#111111'), referenceImageBase64: await image('#ffffff') });
    expect(exhibition.asset(copied.id).data).toEqual(display);
    expect(exhibition.assetResource(copied.id, 'reference', copied.referenceImage!.split('/').at(-1)!).data).toEqual(reference);
    expect(() => exhibition.asset(sourceLook.id)).toThrow(code('EXHIBITION_ASSET_NOT_FOUND'));
  });

  it('preserves legacy prompt-only Free semantics and supports full generation without a reference', async () => {
    const f = fixture(); f.source.updateLook('commute', { mode: 'free', prompt: '水彩人物', referenceKind: 'none' });
    f.source.publishPublication({ lookIds: ['commute'] });
    f.source.command({ action: 'configure', experienceMode: 'free' });
    const created = f.manager.create(f.source); const context = f.manager.resolve(created.mirror.id, created.token);
    const session = await start(context);
    expect(session).toMatchObject({ referenceAsset: '', exhibition: { mirrorId: created.mirror.id, mode: 'free', prompt: '水彩人物' } });
    await context.service.link(session.id, 'ums-browser-free'); await context.service.firstFrame(session.id, 150); context.exhibition.liveFirstFrame(session.id, 150);
    expect(context.exhibition.read().phase).toBe('showcase'); expect(f.uploads).toEqual([]);
    await f.manager.close(created.mirror.id, created.token); expect(f.store.get(session.id).status).toBe('stopped');
  });

  it('freezes source key and region for reference upload, generation, renewal and revocation', async () => {
    const f = fixture(); await upload(f.source);
    const created = f.manager.create(f.source); const context = f.manager.resolve(created.mirror.id, created.token);
    f.service.saveMirrorCredentials('default', { apiKey: keyChanged, region: 'global', expectedRevision: 1 }); f.provider.setApiKey('');
    const selected = context.exhibition.read().selectedLookId!;
    const prepared = await context.exhibition.prepareReference(selected);
    expect(f.uploads.length).toBeGreaterThan(0); expect(f.uploads.every(row => row.key === keySource && row.region === 'cn')).toBe(true); expect(prepared).not.toBeNull();
    const session = await start(context);
    expect(f.secrets.decrypt(f.store.get(session.id).providerKeyCipher!)).toBe(keySource);
    expect(session).toMatchObject({ pointsLimit: 3000, providerRegion: 'cn', exhibition: { mirrorId: created.mirror.id, continuous: true } });
    expect(session.refImageUrl).toBe(prepared!.url);
    await expect(context.exhibition.bindLiveReference(session.id, { deviceId: 'browser-test-camera', lookId: selected, bindingId: prepared!.bindingId })).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_LOCKED' });
    await context.service.link(session.id, 'ums-browser-continuous'); await context.service.firstFrame(session.id, 100); context.exhibition.liveFirstFrame(session.id, 100);
    for (let n = 0; n < 7; n++) { f.advance(15_000); context.exhibition.heartbeat({ deviceId: 'browser-test-camera', sessionId: session.id }); }
    const state = context.exhibition.read();
    const { renewalId } = await context.exhibition.prepareLiveRenewal(session.id, { deviceId: 'browser-test-camera', sessionNumber: state.sessionNumber, generationNumber: state.generationNumber });
    await context.service.stop(session.id); await context.exhibition.sweepLive();
    const renewed = await context.exhibition.commitLiveRenewal(session.id, { deviceId: 'browser-test-camera', renewalId });
    await context.exhibition.createLiveSession({ deviceId: 'browser-test-camera', lookId: renewed.selectedLookId, generationNumber: renewed.generationNumber });
    await f.manager.close(created.mirror.id, created.token);
    const keyCalls = f.requests.filter(request => request.path.includes('/temporary-api-key'));
    expect(keyCalls.filter(request => request.path.endsWith('/temporary-api-key'))).toHaveLength(2);
    expect(keyCalls.every(request => request.key === keySource && request.host === 'api.xmaxai.com')).toBe(true);
    expect(f.store.list().every(record => record.exhibition?.mirrorId === created.mirror.id && record.status === 'stopped')).toBe(true);
  });

  it('rejects a missing source key before installing any context or allocating credentials', () => {
    const f = fixture(); const other = f.mirrors.getMirror(f.mirrors.create({ name: '无密钥' }).id); f.provider.setApiKey('');
    const before = readdirSync(join(f.directory, 'browser-tests'), { recursive: true });
    expect(() => f.manager.create(other)).toThrow(code('MISSING_API_KEY'));
    expect(readdirSync(join(f.directory, 'browser-tests'), { recursive: true })).toEqual(before);
    expect(f.requests).toEqual([]); expect(f.store.list()).toEqual([]);
  });

  it('also freezes a default provider before its mutable key is replaced', async () => {
    const f = fixture(); const source = f.mirrors.getMirror(f.mirrors.create({ name: '默认密钥镜' }).id);
    const created = f.manager.create(source); f.provider.setApiKey(keyChanged);
    const session = await start(f.manager.resolve(created.mirror.id, created.token));
    expect(f.secrets.decrypt(f.store.get(session.id).providerKeyCipher!)).toBe(keyDefault);
    expect(f.requests[0]).toMatchObject({ key: keyDefault, host: 'api.xmax.ai' });
    await f.manager.close(created.mirror.id, created.token);
    expect(f.requests.every(request => request.key === keyDefault)).toBe(true);
  });

  it('rejects other or invalid test tokens without touching either experience', async () => {
    const f = fixture(); const first = f.manager.create(f.source); const other = f.manager.create(f.source);
    const context = f.manager.resolve(first.mirror.id, first.token); const before = context.exhibition.read();
    for (const token of [undefined, '', 'wrong', 'b'.repeat(64), other.token]) {
      expect(() => f.manager.resolve(first.mirror.id, token)).toThrow(code('BROWSER_TEST_UNAUTHORIZED'));
      await expect(f.manager.close(first.mirror.id, token)).rejects.toMatchObject({ code: 'BROWSER_TEST_UNAUTHORIZED' });
    }
    expect(context.exhibition.read()).toEqual(before); expect(f.requests).toEqual([]);
    expect(f.manager.owns(`test-${randomUUID()}`)).toBe(true); expect(f.manager.owns('default')).toBe(false);
  });

  it('keeps a failed stop guarded, retries it, and closes idempotently while retaining audit history', async () => {
    const f = fixture(); const created = f.manager.create(f.source); const context = f.manager.resolve(created.mirror.id, created.token); const path = testPath(f, created.mirror.id)!;
    const session = await start(context); f.failStop(true);
    await expect(f.manager.close(created.mirror.id, created.token)).rejects.toMatchObject({ code: 'BROWSER_TEST_STOP_PENDING' });
    expect(() => f.manager.resolve(created.mirror.id, created.token)).toThrow(code('BROWSER_TEST_EXPIRED'));
    expect(existsSync(path)).toBe(true); expect(f.store.get(session.id).status).toBe('stopping');
    f.failStop(false); await f.manager.close(created.mirror.id, created.token); await f.manager.close(created.mirror.id, created.token);
    expect(existsSync(path)).toBe(false); expect(f.store.get(session.id).status).toBe('stopped');
    expect(() => context.exhibition.command({ action: 'begin' })).toThrow(code('EXHIBITION_MIRROR_NOT_FOUND'));
    expect(f.store.mirrorEvents(created.mirror.id).length).toBeGreaterThan(0);
  });

  it('expires after one fixed hour despite reads and stops only its own active session', async () => {
    const f = fixture(); const created = f.manager.create(f.source); const context = f.manager.resolve(created.mirror.id, created.token); const session = await start(context);
    await f.source.prepareReference(f.source.read().selectedLookId!, undefined, true); f.source.command({ action: 'configure', providerMode: 'xmax' }); const state = f.source.command({ action: 'begin' });
    const physical = await f.source.createLiveSession({ deviceId: 'physical', lookId: state.selectedLookId, generationNumber: state.generationNumber });
    const before = f.source.read();
    f.advance(BROWSER_TEST_TTL_MS - 1); expect(f.manager.resolve(created.mirror.id, created.token).expiresAt).toBe(created.expiresAt);
    f.advance(1); expect(() => f.manager.resolve(created.mirror.id, created.token)).toThrow(code('BROWSER_TEST_EXPIRED'));
    await f.manager.sweep();
    expect(f.store.get(session.id).status).toBe('stopped'); expect(f.store.get(physical.id).status).toBe('active'); expect(f.source.read()).toEqual(before);
  });

  it('retains resources across in-flight issuance and revokes a late key before removing the test', async () => {
    const f = fixture(); const created = f.manager.create(f.source); const context = f.manager.resolve(created.mirror.id, created.token);
    const original = vi.mocked(f.fetcher).getMockImplementation()!; let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.fetcher).mockImplementationOnce(async (...args) => { await waiting; return original(...args); });
    const pending = start(context); const rejected = expect(pending).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
    await vi.waitFor(() => expect(f.store.unreleasedMirror(created.mirror.id)).toHaveLength(1));
    const path = testPath(f, created.mirror.id)!;
    await expect(f.manager.close(created.mirror.id, created.token)).rejects.toMatchObject({ code: 'BROWSER_TEST_STOP_PENDING' });
    expect(existsSync(path)).toBe(true); release(); await rejected; await f.manager.sweep();
    expect(existsSync(path)).toBe(false); expect(f.store.list()).toHaveLength(1);
    expect(f.store.list()[0].status).toBe('stopped'); expect([...f.issued.values()].every(key => !key.active)).toBe(true);
  });

  it('waits for an in-flight reference preparation before deleting local image resources', async () => {
    const f = fixture(); await upload(f.source); const created = f.manager.create(f.source); const context = f.manager.resolve(created.mirror.id, created.token);
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    f.advance(55 * 60_000);
    context.service.options.referenceStorage = () => ({ upload: async (_bytes, hash) => `https://browser-fixture-123.cos.ap-guangzhou.myqcloud.com/${hash}.webp`, check: async () => { await waiting; return false; } });
    const preparing = context.exhibition.prepareReference(context.exhibition.read().selectedLookId!); const path = testPath(f, created.mirror.id)!;
    await expect(f.manager.close(created.mirror.id, created.token)).rejects.toMatchObject({ code: 'BROWSER_TEST_STOP_PENDING' });
    expect(existsSync(path)).toBe(true); release(); await preparing; await f.manager.sweep();
    expect(existsSync(path)).toBe(false); expect(f.requests).toEqual([]);
  });

  it('sweeps a lost browser heartbeat without stopping the physical mirror', async () => {
    const f = fixture(); const created = f.manager.create(f.source); const context = f.manager.resolve(created.mirror.id, created.token); const session = await start(context);
    const before = f.source.read(); f.advance(20_001); await f.manager.sweep();
    expect(f.store.get(session.id).status).toBe('stopped'); expect(context.exhibition.read()).toMatchObject({ phase: 'paused', live: null });
    expect(f.source.read()).toEqual(before); expect(f.manager.resolve(created.mirror.id, created.token).mirror.id).toBe(created.mirror.id);
  });

  it('releases abandoned previews and their capacity without ever generating', async () => {
    const f = fixture(); const entries = Array.from({ length: BROWSER_TEST_LIMIT }, () => f.manager.create(f.source));
    const paths = entries.map(entry => testPath(f, entry.mirror.id)!);
    f.advance(BROWSER_TEST_IDLE_MS - 1); await f.manager.sweep();
    expect(() => f.manager.create(f.source)).toThrow(code('BROWSER_TEST_LIMIT'));
    f.advance(1); await f.manager.sweep();
    expect(paths.every(path => !existsSync(path))).toBe(true);
    expect(f.manager.create(f.source).mirror.id).not.toBe(entries[0].mirror.id);
    expect(f.requests).toEqual([]); expect(f.store.list()).toEqual([]);
  });

  it('keeps valid API polling alive without extending the fixed one-hour expiry', async () => {
    const f = fixture(); const created = f.manager.create(f.source); const path = testPath(f, created.mirror.id)!;
    while (f.now() + BROWSER_TEST_IDLE_MS - 1 < created.expiresAt) {
      f.advance(BROWSER_TEST_IDLE_MS - 1);
      expect(f.manager.resolve(created.mirror.id, created.token).expiresAt).toBe(created.expiresAt);
      await f.manager.sweep(); expect(existsSync(path)).toBe(true);
    }
    f.advance(created.expiresAt - f.now() - 1);
    expect(f.manager.resolve(created.mirror.id, created.token).expiresAt).toBe(created.expiresAt);
    await f.manager.sweep(); expect(existsSync(path)).toBe(true);
    f.advance(1); await f.manager.sweep(); expect(existsSync(path)).toBe(false);
    expect(() => f.manager.resolve(created.mirror.id, created.token)).toThrow(code('BROWSER_TEST_EXPIRED'));
  });

  it('does not let unauthorized API requests keep an abandoned preview alive', async () => {
    const f = fixture(); const created = f.manager.create(f.source); const path = testPath(f, created.mirror.id)!;
    f.advance(BROWSER_TEST_IDLE_MS - 1);
    expect(() => f.manager.resolve(created.mirror.id, '0'.repeat(64))).toThrow(code('BROWSER_TEST_UNAUTHORIZED'));
    await expect(f.manager.close(created.mirror.id, undefined)).rejects.toMatchObject({ code: 'BROWSER_TEST_UNAUTHORIZED' });
    f.advance(1); await f.manager.sweep(); expect(existsSync(path)).toBe(false);
    expect(f.requests).toEqual([]);
  });

  it('retains unknown issuance and its assets when the browser disappears', async () => {
    const f = fixture(); const created = f.manager.create(f.source); const context = f.manager.resolve(created.mirror.id, created.token);
    vi.mocked(f.fetcher).mockRejectedValueOnce(new Error('connection lost during issuance'));
    await expect(start(context)).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_ERROR' });
    const record = f.store.list()[0]; const path = testPath(f, created.mirror.id)!;
    expect(record.status).toBe('issuance_unknown'); expect(record.tokenCipher).toBeUndefined();
    f.advance(BROWSER_TEST_IDLE_MS); await f.manager.sweep();
    expect(existsSync(path)).toBe(true); expect(f.store.get(record.id)).toEqual(record);
    expect(() => f.manager.resolve(created.mirror.id, created.token)).toThrow(code('BROWSER_TEST_EXPIRED'));
  });

  it('limits unsettled contexts and frees capacity only after a confirmed close', async () => {
    const f = fixture(); const entries = Array.from({ length: BROWSER_TEST_LIMIT }, () => f.manager.create(f.source));
    expect(() => f.manager.create(f.source)).toThrow(code('BROWSER_TEST_LIMIT'));
    const context = f.manager.resolve(entries[0].mirror.id, entries[0].token); await start(context); f.failStop(true);
    await expect(f.manager.close(entries[0].mirror.id, entries[0].token)).rejects.toMatchObject({ code: 'BROWSER_TEST_STOP_PENDING' });
    expect(() => f.manager.create(f.source)).toThrow(code('BROWSER_TEST_LIMIT'));
    f.failStop(false); await f.manager.sweep(); expect(f.manager.create(f.source).mirror.id).not.toBe(entries[0].mirror.id);
  });

  it('cleans partially copied files when creation fails and keeps the original catalog unchanged', async () => {
    const f = fixture(); const look = await upload(f.source);
    const path = join(f.directory, 'exhibition-mirrors/default/exhibition-assets', `${look.id}.reference.${look.referenceImage!.split('/').at(-1)}.webp`);
    const bytes = readFileSync(path); rmSync(path); const before = f.source.read();
    const tree = readdirSync(join(f.directory, 'browser-tests'), { recursive: true });
    expect(() => f.manager.create(f.source)).toThrow();
    expect(readdirSync(join(f.directory, 'browser-tests'), { recursive: true })).toEqual(tree);
    expect(f.source.read()).toEqual(before); expect(f.requests).toEqual([]);
    writeFileSync(path, bytes); expect(f.manager.create(f.source).mirror.providerMode).toBe('xmax');
  });

  it('never restores old browser tokens after restart while the shared store can revoke old sessions', async () => {
    const f = fixture(); const created = f.manager.create(f.source); const context = f.manager.resolve(created.mirror.id, created.token); const session = await start(context);
    const restarted = new BrowserTests(f.directory, { now: f.now }); restarted.attachLiveService(f.service);
    expect(() => restarted.resolve(created.mirror.id, created.token)).toThrow(code('BROWSER_TEST_NOT_FOUND'));
    await f.service.recover(); expect(f.store.get(session.id).status).toBe('stopped');
    expect(restarted.create(f.source).mirror.id).not.toBe(created.mirror.id); await restarted.destroy();
  });
});
