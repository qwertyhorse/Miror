import { withLifecycleReferenceDelivery } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionService } from '../server/exhibition.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { createApiServer } from '../server/http.ts';
import type { TryOnService } from '../server/service.ts';
import type { ExhibitionState, ExhibitionUiSkin } from '../shared/exhibition.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'openbuy-exhibition-skin-')); directories.push(path); return path; }
function fixture() {
  const path = directory(); let time = 1_800_000_000_000; const now = () => time;
  return { directory: path, now, service: new ExhibitionService(path, { now }), advance: (ms: number) => { time += ms; } };
}
function image(width = 360, height = 640, format: 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'tiff' = 'png') {
  return sharp({ create: { width, height, channels: 4, background: '#aa88ff80' } })[format]().toBuffer();
}
function input(bytes: Buffer, expectedRevision?: number) { return { imageBase64: bytes.toString('base64'), ...(expectedRevision === undefined ? {} : { expectedRevision }) }; }
function skinId(skin: ExhibitionUiSkin) { return skin.image.split('/').at(-1)!; }
const code = (value: string) => expect.objectContaining({ code: value });

describe('built-in exhibition UI skins', () => {
  it('defaults to crystal, upgrades existing custom skin data, and rejects invalid stored presets', async () => {
    const { service, directory, now } = fixture();
    expect(service.get().settings).toMatchObject({ uiSkinPreset: 'crystal', uiSkin: null });
    const uploaded = await service.uploadUiSkin(input(await image()));
    const filename = join(directory, 'exhibition.json'); const legacy = JSON.parse(readFileSync(filename, 'utf8'));
    delete legacy.state.settings.uiSkinPreset;
    writeFileSync(filename, JSON.stringify(legacy));
    const restarted = new ExhibitionService(directory, { now, strictStorage: true });
    expect(restarted.get()).toMatchObject({ phase: uploaded.phase, looks: uploaded.looks, selectedLookId: uploaded.selectedLookId,
      settings: { uiSkinPreset: 'crystal', uiSkin: uploaded.settings.uiSkin } });
    expect(restarted.uiSkinAsset(skinId(uploaded.settings.uiSkin!)).data.length).toBe(uploaded.settings.uiSkin!.bytes);
    const invalid = JSON.parse(readFileSync(filename, 'utf8')); invalid.state.settings.uiSkinPreset = 'unknown';
    writeFileSync(filename, JSON.stringify(invalid)); const bytes = readFileSync(filename);
    expect(() => new ExhibitionService(directory, { now, strictStorage: true })).toThrow('Invalid exhibition mirror data');
    expect(readFileSync(filename)).toEqual(bytes);
  });

  it('persists a built-in choice without changing selected materials or the experience', () => {
    const { service, directory, now } = fixture(); const before = service.get();
    const brand = service.command({ action: 'configure', uiSkinPreset: 'brand', expectedRevision: before.revision });
    expect(brand).toMatchObject({ revision: before.revision + 1, phase: before.phase, looks: before.looks,
      selectedLookId: before.selectedLookId, enabledLookIds: before.enabledLookIds,
      sessionNumber: before.sessionNumber, generationNumber: before.generationNumber,
      settings: { ...before.settings, uiSkinPreset: 'brand', uiSkin: null } });
    const restarted = new ExhibitionService(directory, { now });
    expect(restarted.get()).toEqual(brand);
    expect(restarted.command({ action: 'configure', uiSkinPreset: 'crystal', expectedRevision: brand.revision }).settings.uiSkinPreset).toBe('crystal');
  });

  it('rejects invalid, stale and partially invalid changes without replacing a custom skin', async () => {
    const { service } = fixture(); const before = await service.uploadUiSkin(input(await image()));
    for (const uiSkinPreset of [null, '', 'unknown', 1, [], {}]) {
      expect(() => service.command({ action: 'configure', uiSkinPreset, autoReturnSeconds: 180 })).toThrow(code('EXHIBITION_INVALID_SETTINGS'));
      expect(service.get()).toEqual(before);
    }
    expect(() => service.command({ action: 'configure', uiSkinPreset: 'brand', expectedRevision: before.revision - 1 })).toThrow(code('EXHIBITION_STALE_REVISION'));
    expect(() => service.command({ action: 'configure', uiSkinPreset: 'brand', autoReturnSeconds: 14 })).toThrow(code('EXHIBITION_INVALID_SETTINGS'));
    expect(service.get()).toEqual(before);
    expect(service.uiSkinAsset(skinId(before.settings.uiSkin!)).data.length).toBe(before.settings.uiSkin!.bytes);
  });

  it('allows changes only in select or idle and waits for a retained live lease to stop', async () => {
    const { service, advance, now } = fixture(); service.command({ action: 'begin' });
    const checkPhase = () => {
      const before = service.get();
      expect(() => service.command({ action: 'configure', uiSkinPreset: 'brand', expectedRevision: before.revision })).toThrow(code('EXHIBITION_INVALID_PHASE'));
      expect(service.get()).toEqual(before);
    };
    checkPhase(); advance(2_200); checkPhase(); service.command({ action: 'pause' }); checkPhase();
    service.command({ action: 'end' });
    const session = { id: 'skin-test-session', status: 'active', expiresAt: new Date(now() + 120_000).toISOString(), pointsLimit: 30, consumedCredits: 0 };
    service.attachLiveService(withLifecycleReferenceDelivery({ status: () => ({ configured: true }),
      createExhibition: async (_input: unknown, hooks: { onReserved: (id: string) => void }) => { hooks.onReserved(session.id); return session; },
      cancelExhibitionSession: () => { session.status = 'stopping'; },
    } as unknown as TryOnService));
    service.command({ action: 'configure', providerMode: 'xmax' }); const generating = service.command({ action: 'begin' });
    await service.createLiveSession({ deviceId: 'skin-screen-001', lookId: generating.selectedLookId, generationNumber: generating.generationNumber });
    for (const action of ['end', 'idle']) {
      const before = service.command({ action });
      expect(before.live).toMatchObject({ sessionId: session.id, status: 'stopping' });
      expect(() => service.command({ action: 'configure', uiSkinPreset: 'brand', expectedRevision: before.revision })).toThrow(code('EXHIBITION_MIRROR_BUSY'));
      expect(service.get()).toEqual(before);
    }
  });

  it('lets uploads override a preset, replaces custom skin atomically, and removes to crystal', async () => {
    const { service, directory, now } = fixture(); service.command({ action: 'configure', uiSkinPreset: 'brand' });
    const custom = await service.uploadUiSkin(input(await image(), service.get().revision)); const skin = custom.settings.uiSkin!;
    expect(custom.settings.uiSkinPreset).toBe('brand');
    const restarted = new ExhibitionService(directory, { now }); expect(restarted.get()).toEqual(custom);
    const brand = restarted.command({ action: 'configure', uiSkinPreset: 'brand', expectedRevision: custom.revision });
    expect(brand.settings).toMatchObject({ uiSkinPreset: 'brand', uiSkin: null });
    expect(() => restarted.uiSkinAsset(skinId(skin))).toThrow(code('EXHIBITION_SKIN_NOT_FOUND'));
    const uploaded = await restarted.uploadUiSkin(input(await image(), brand.revision));
    const removed = restarted.removeUiSkin({ expectedRevision: uploaded.revision });
    expect(removed.settings).toMatchObject({ uiSkinPreset: 'crystal', uiSkin: null });
    expect(new ExhibitionService(directory, { now }).get()).toEqual(removed);
  });

  it('isolates mirrors and copies a preset only when settings are selected', async () => {
    const directoryPath = directory(); const mirrors = new ExhibitionMirrors(directoryPath);
    const source = mirrors.getMirror(); source.command({ action: 'configure', uiSkinPreset: 'brand' });
    const targetId = mirrors.create({ name: '皮肤目标镜' }).id; const target = mirrors.getMirror(targetId);
    const uploaded = await target.uploadUiSkin(input(await image())); const skin = uploaded.settings.uiSkin!;
    const sourceBefore = source.get();
    const looksOnly = mirrors.copy(targetId, { sourceMirrorId: 'default', copyLooks: true, copySettings: false, expectedRevision: uploaded.revision });
    expect(looksOnly.settings).toMatchObject({ uiSkinPreset: 'crystal', uiSkin: skin });
    const copied = mirrors.copy(targetId, { sourceMirrorId: 'default', copyLooks: false, copySettings: true, expectedRevision: looksOnly.revision });
    expect(copied.settings).toMatchObject({ uiSkinPreset: 'brand', uiSkin: null });
    expect(() => target.uiSkinAsset(skinId(skin))).toThrow(code('EXHIBITION_SKIN_NOT_FOUND'));
    target.command({ action: 'configure', uiSkinPreset: 'crystal' });
    expect(source.get()).toEqual(sourceBefore);
    const restarted = new ExhibitionMirrors(directoryPath);
    expect(restarted.getMirror().get()).toEqual(sourceBefore);
    expect(restarted.getMirror(targetId).get()).toEqual(target.get());
  });
});

describe('exhibition UI skin validation and persistence', () => {
  it.each(['png', 'jpeg', 'webp', 'gif', 'avif', 'tiff'] as const)('decodes real %s content to WebP and preserves the exhibition selection', async format => {
    const { service } = fixture(); const before = service.get();
    const uploaded = await service.uploadUiSkin(input(await image(360, 640, format), before.revision));
    const skin = uploaded.settings.uiSkin!; const asset = service.uiSkinAsset(skinId(skin));
    expect(skin).toMatchObject({ width: 360, height: 640, bytes: asset.data.length });
    expect(skin.image).toMatch(/^\/api\/exhibition\/skin\/[a-f0-9-]{36}$/u);
    expect(uploaded).toMatchObject({ revision: before.revision + 1, looks: before.looks, enabledLookIds: before.enabledLookIds,
      selectedLookId: before.selectedLookId, phase: before.phase, generationNumber: before.generationNumber, sessionNumber: before.sessionNumber });
    expect(asset.mime).toBe('image/webp');
    expect(await sharp(asset.data).metadata()).toMatchObject({ format: 'webp', width: 360, height: 640 });
    if (format === 'png' || format === 'webp') expect((await sharp(asset.data).metadata()).hasAlpha).toBe(true);
  });

  it('retains transparency while stripping embedded metadata', async () => {
    const { service } = fixture();
    const source = await sharp({ create: { width: 360, height: 640, channels: 4, background: '#7755aa80' } }).png().withMetadata().toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const skin = (await service.uploadUiSkin(input(source))).settings.uiSkin!;
    const stored = service.uiSkinAsset(skinId(skin)).data;
    const metadata = await sharp(stored).metadata();
    expect(metadata).toMatchObject({ format: 'webp', hasAlpha: true, width: 360, height: 640 });
    expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined(); expect(metadata.orientation).toBeUndefined();
    const { data, info } = await sharp(stored).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4); expect(data[3]).toBeGreaterThan(0); expect(data[3]).toBeLessThan(255);
  });

  it('stores dimensions from the decoded and correctly rotated image', async () => {
    const { service } = fixture();
    const source = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#ccc' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const skin = (await service.uploadUiSkin(input(source))).settings.uiSkin!;
    expect(skin).toMatchObject({ width: 360, height: 640 });
    const metadata = await sharp(service.uiSkinAsset(skinId(skin)).data).metadata();
    expect(metadata).toMatchObject({ width: 360, height: 640 }); expect(metadata.exif).toBeUndefined();
  });

  it('rejects fake, truncated, unsupported and malformed image content without changing state', async () => {
    const { service, directory } = fixture(); const before = service.get(); const png = await image();
    for (const bytes of [Buffer.alloc(0), Buffer.from('<html>not an image</html>'), Buffer.from('<svg broken'), png.subarray(0, 70)]) {
      await expect(service.uploadUiSkin({ imageBase64: `data:image/png;base64,${bytes.toString('base64')}`, filename: 'skin.png', width: 360, height: 640 })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_SKIN' });
    }
    for (const imageBase64 of ['', '%%%%', 'a===', 'data:text/html;base64,AAAA', 'AAAA\nAAAA', 123, null]) {
      await expect(service.uploadUiSkin({ imageBase64 })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_SKIN' });
    }
    expect(service.get()).toEqual(before); expect(existsSync(join(directory, 'exhibition-skins'))).toBe(false);
  });

  it('normalizes the first frame of an animated image to a static skin', async () => {
    const { service } = fixture();
    const pixels = Buffer.concat([Buffer.alloc(360 * 640 * 4, 80), Buffer.alloc(360 * 640 * 4, 160)]);
    const webp = await sharp(pixels, { raw: { width: 360, height: 1280, channels: 4, pageHeight: 640 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(webp).metadata()).pages).toBe(2);
    const skin = (await service.uploadUiSkin(input(webp))).settings.uiSkin!;
    const stored = service.uiSkinAsset(skinId(skin));
    const metadata = await sharp(stored.data).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 360, height: 640 });
    expect(metadata.pages ?? 1).toBe(1);
    const pixel = await sharp(stored.data).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(pixel[0]).toBeLessThan(100);
  });

  it.each([[1, 1], [359, 640], [360, 639], [2161, 3000], [400, 3841], [360, 1000], [1000, 1000], [4000, 2500]])('accepts %s × %s without dimension or aspect ratio restrictions', async (width, height) => {
    const { service } = fixture();
    const skin = (await service.uploadUiSkin({ ...input(await image(width, height)), width: 1080, height: 1920 })).settings.uiSkin!;
    expect(skin).toMatchObject({ width, height });
    expect(await sharp(service.uiSkinAsset(skinId(skin)).data).metadata()).toMatchObject({ width, height });
  });

  it('accepts SVG image data and image data URLs for other decodable formats', async () => {
    const { service } = fixture();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="red"/></svg>');
    for (const [mime, bytes] of [['image/svg+xml', svg], ['image/tiff', await image(200, 100, 'tiff')]] as const) {
      const skin = (await service.uploadUiSkin({ imageBase64: `data:${mime};base64,${bytes.toString('base64')}` })).settings.uiSkin!;
      expect((await sharp(service.uiSkinAsset(skinId(skin)).data).metadata()).format).toBe('webp');
    }
  });

  it.each([[16_384, 100, 16_383, 100], [100, 16_384, 100, 16_383]])('scales %s × %s to the WebP encoder range without rejecting the upload', async (width, height, storedWidth, storedHeight) => {
    const { service } = fixture();
    const skin = (await service.uploadUiSkin(input(await image(width, height)))).settings.uiSkin!;
    expect(skin).toMatchObject({ width: storedWidth, height: storedHeight });
    expect(await sharp(service.uiSkinAsset(skinId(skin)).data).metadata()).toMatchObject({ width: storedWidth, height: storedHeight });
  });

  it('accepts a real image over the former 8 MB upload limit', async () => {
    const { service } = fixture();
    const bytes = await sharp({ create: { width: 1500, height: 1500, channels: 4, background: '#aa88ff80' } }).tiff({ compression: 'none' }).toBuffer();
    expect(bytes.length).toBeGreaterThan(8 * 1024 * 1024);
    const skin = (await service.uploadUiSkin(input(bytes))).settings.uiSkin!;
    expect(skin).toMatchObject({ width: 1500, height: 1500 });
    expect((await sharp(service.uiSkinAsset(skinId(skin)).data).metadata()).format).toBe('webp');
  });

  it('rechecks revisions after decoding and does not install stale or in-experience updates', async () => {
    const { service, directory } = fixture(); const bytes = await image(); const before = service.get();
    await expect(service.uploadUiSkin(input(bytes, before.revision - 1))).rejects.toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
    const pending = service.uploadUiSkin(input(bytes, before.revision));
    service.command({ action: 'select', lookId: 'city' });
    const changed = service.get();
    await expect(pending).rejects.toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
    expect(service.get()).toEqual(changed); expect(existsSync(join(directory, 'exhibition-skins'))).toBe(false);
    const decoding = service.uploadUiSkin(input(bytes)); service.command({ action: 'begin' }); const generating = service.get();
    expect(generating.phase).toBe('generating');
    await expect(decoding).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' });
    await expect(service.uploadUiSkin(input(bytes, generating.revision))).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' });
    expect(() => service.removeUiSkin({ expectedRevision: generating.revision })).toThrow(code('EXHIBITION_INVALID_PHASE'));
    expect(service.get()).toEqual(generating); expect(existsSync(join(directory, 'exhibition-skins'))).toBe(false);
  });

  it('persists across restart and prevents replaced or removed URLs from being read', async () => {
    const { service, directory, now } = fixture(); const bytes = await image();
    const first = (await service.uploadUiSkin(input(bytes))).settings.uiSkin!;
    const replacement = await service.uploadUiSkin(input(await image(450, 800, 'webp'), service.get().revision));
    const current = replacement.settings.uiSkin!; const stored = service.uiSkinAsset(skinId(current));
    expect(current.image).not.toBe(first.image);
    expect(() => service.uiSkinAsset(skinId(first))).toThrow(code('EXHIBITION_SKIN_NOT_FOUND'));
    const restarted = new ExhibitionService(directory, { now });
    expect(restarted.get()).toEqual(replacement); expect(restarted.uiSkinAsset(skinId(current)).data).toEqual(stored.data);
    expect(() => restarted.removeUiSkin({ expectedRevision: replacement.revision - 1 })).toThrow(code('EXHIBITION_STALE_REVISION'));
    const removed = restarted.removeUiSkin({ expectedRevision: replacement.revision });
    expect(removed.settings.uiSkin).toBeNull(); expect(removed.revision).toBe(replacement.revision + 1);
    expect(() => restarted.uiSkinAsset(skinId(current))).toThrow(code('EXHIBITION_SKIN_NOT_FOUND'));
    const afterDelete = new ExhibitionService(directory, { now });
    expect(afterDelete.get()).toEqual(removed); expect(() => afterDelete.uiSkinAsset(skinId(current))).toThrow(code('EXHIBITION_SKIN_NOT_FOUND'));
    expect(readdirSync(join(directory, 'exhibition-skins')).every(name => name.endsWith('.webp'))).toBe(true);
  });

  it('isolates mirrors and creates an independent skin asset when copying settings', async () => {
    const directoryPath = directory(); const mirrors = new ExhibitionMirrors(directoryPath);
    const source = mirrors.getMirror(); const targetId = mirrors.create({ name: '目标智能镜' }).id; const target = mirrors.getMirror(targetId);
    source.command({ action: 'configure', uiSkinPreset: 'brand' });
    const sourceState = await source.uploadUiSkin(input(await image())); const original = sourceState.settings.uiSkin!;
    const targetBefore = target.get(); expect(targetBefore.settings.uiSkin).toBeNull();
    expect(() => target.uiSkinAsset(skinId(original))).toThrow(code('EXHIBITION_SKIN_NOT_FOUND'));
    const looksOnly = mirrors.copy(targetId, { sourceMirrorId: 'default', copyLooks: true, copySettings: false, expectedRevision: targetBefore.revision });
    expect(looksOnly.settings.uiSkin).toBeNull();
    const copied = mirrors.copy(targetId, { sourceMirrorId: 'default', copyLooks: false, copySettings: true, expectedRevision: looksOnly.revision });
    const independent = copied.settings.uiSkin!;
    expect(copied.settings.uiSkinPreset).toBe('brand');
    expect(independent.image).toMatch(new RegExp(`^/api/exhibition/mirrors/${targetId}/skin/`));
    expect(independent.image).not.toBe(original.image); expect(skinId(independent)).not.toBe(skinId(original));
    expect(target.uiSkinAsset(skinId(independent)).data).toEqual(source.uiSkinAsset(skinId(original)).data);
    source.removeUiSkin({ expectedRevision: sourceState.revision });
    expect(target.get()).toEqual(copied); expect(target.uiSkinAsset(skinId(independent)).data.length).toBe(independent.bytes);
    const restarted = new ExhibitionMirrors(directoryPath);
    expect(restarted.getMirror(targetId).get()).toEqual(copied); expect(restarted.getMirror().get().settings.uiSkin).toBeNull();
    expect(restarted.getMirror(targetId).uiSkinAsset(skinId(independent)).data.length).toBe(independent.bytes);
  });
});

describe('exhibition UI skin HTTP boundary', () => {
  const headers = { 'Content-Type': 'application/json', Origin: 'http://xuminghong.local:10200' };
  async function withServer(run: (base: string, mirrors: ExhibitionMirrors) => Promise<void>) {
    const mirrors = new ExhibitionMirrors(directory());
    const unrelated = new Proxy({} as TryOnService, { get: (_target, property) => { if (property === 'reconcileMirrorSessions') return async () => {}; throw new Error('UI skin routes must not contact XMAX.'); } });
    const server = createApiServer(unrelated, ['http://xuminghong.local:10200'], undefined, mirrors);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`, mirrors); }
    finally { server.close(); await once(server, 'close'); }
  }

  it('switches a mirror to a built-in skin through the revision-checked command endpoint', async () => {
    await withServer(async (base, mirrors) => {
      const source = mirrors.getMirror(); const before = await source.uploadUiSkin(input(await image()));
      const skin = before.settings.uiSkin!;
      const targetId = mirrors.create({ name: 'HTTP 皮肤隔离镜' }).id; const targetBefore = mirrors.getMirror(targetId).get();
      const command = (body: unknown) => fetch(`${base}/api/exhibition/mirrors/default/command`, { method: 'POST', headers, body: JSON.stringify(body) });
      const invalid = await command({ action: 'configure', uiSkinPreset: 'unknown', expectedRevision: before.revision });
      expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: 'EXHIBITION_INVALID_SETTINGS' });
      const stale = await command({ action: 'configure', uiSkinPreset: 'brand', expectedRevision: before.revision - 1 });
      expect(stale.status).toBe(409); expect(source.get()).toEqual(before);
      const response = await command({ action: 'configure', uiSkinPreset: 'brand', expectedRevision: before.revision });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ settings: { uiSkinPreset: 'brand', uiSkin: null }, revision: before.revision + 1 });
      expect((await fetch(base + skin.image)).status).toBe(404);
      expect(mirrors.getMirror(targetId).get()).toEqual(targetBefore);
    });
  });

  it('uploads and reads safe WebP content with no-store headers, scopes the asset, and removes old access', async () => {
    await withServer(async (base, mirrors) => {
      const root = '/api/exhibition/mirrors/default'; const service = mirrors.getMirror(); const before = service.get();
      const uploaded = await fetch(`${base}${root}/skin`, { method: 'POST', headers, body: JSON.stringify(input(await image(), before.revision)) });
      expect(uploaded.status).toBe(200); expect(uploaded.headers.get('cache-control')).toBe('no-store');
      const state = await uploaded.json() as ExhibitionState; const skin = state.settings.uiSkin!;
      const asset = await fetch(base + skin.image);
      expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toBe('image/webp');
      expect(asset.headers.get('cache-control')).toBe('no-store'); expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Number(asset.headers.get('content-length'))).toBe(skin.bytes);
      expect(Buffer.from(await asset.arrayBuffer())).toEqual(service.uiSkinAsset(skinId(skin)).data);
      const head = await fetch(base + skin.image, { method: 'HEAD' }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
      expect(head.headers.get('cache-control')).toBe('no-store'); expect(head.headers.get('content-type')).toBe('image/webp');
      const other = mirrors.create({ name: '另一台镜' });
      expect((await fetch(`${base}/api/exhibition/mirrors/${other.id}/skin/${skinId(skin)}`)).status).toBe(404);
      for (const id of ['%2e%2e%2fexhibition.json', '00000000-0000-0000-0000-000000000000']) expect((await fetch(`${base}${root}/skin/${id}`)).status).toBe(404);
      const removed = await fetch(`${base}${root}/skin`, { method: 'DELETE', headers, body: JSON.stringify({ expectedRevision: state.revision }) });
      expect(removed.status).toBe(200); expect((await removed.json() as ExhibitionState).settings.uiSkin).toBeNull();
      expect((await fetch(base + skin.image)).status).toBe(404); expect((await fetch(base + skin.image, { method: 'HEAD' })).status).toBe(404);
    });
  });

  it('enforces origin, revision, content type and invalid content checks before installing a skin', async () => {
    await withServer(async (base, mirrors) => {
      const path = `${base}/api/exhibition/mirrors/default/skin`; const service = mirrors.getMirror(); const before = service.get(); const payload = input(await image(), before.revision);
      const forbidden = await fetch(path, { method: 'POST', headers: { ...headers, Origin: 'http://outside.example' }, body: JSON.stringify(payload) });
      expect(forbidden.status).toBe(403);
      const stale = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ ...payload, expectedRevision: before.revision - 1 }) });
      expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
      const wrongType = await fetch(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) }); expect(wrongType.status).toBe(415);
      const malformed = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ imageBase64: 'AAAA' }) });
      expect(malformed.status).toBe(400); expect(await malformed.json()).toMatchObject({ code: 'EXHIBITION_INVALID_SKIN' });
      expect(service.get()).toEqual(before);
    });
  });

  it('accepts a skin body over the former 8 MB limit while retaining command body limits', async () => {
    await withServer(async (base, mirrors) => {
      const root = `${base}/api/exhibition/mirrors/default`; const service = mirrors.getMirror();
      const bytes = await sharp({ create: { width: 1500, height: 1500, channels: 4, background: '#aa88ff80' } }).tiff({ compression: 'none' }).toBuffer();
      expect(bytes.length).toBeGreaterThan(8 * 1024 * 1024);
      const uploaded = await fetch(`${root}/skin`, { method: 'POST', headers, body: JSON.stringify(input(bytes, service.get().revision)) });
      expect(uploaded.status).toBe(200);
      expect(await uploaded.json()).toMatchObject({ settings: { uiSkin: { width: 1500, height: 1500 } } });
      const before = service.get();
      const tooLarge = await fetch(`${root}/command`, { method: 'POST', headers, body: JSON.stringify({ action: 'configure', padding: 'A'.repeat(16_384) }) });
      expect(tooLarge.status).toBe(413); expect(await tooLarge.json()).toMatchObject({ code: 'REQUEST_TOO_LARGE' });
      expect(service.get()).toEqual(before);
    });
  });
});
