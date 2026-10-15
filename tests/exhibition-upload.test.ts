import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionService } from '../server/exhibition.ts';
import { createApiServer } from '../server/http.ts';
import type { TryOnService } from '../server/service.ts';
import { EXHIBITION_DEFAULT_UPLOAD_LIMITS, type ExhibitionState } from '../shared/exhibition.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-exhibition-upload-')); directories.push(directory);
  let time = 1_800_000_000_000;
  const now = () => time;
  return { directory, now, service: new ExhibitionService(directory, { now }), advance: (milliseconds: number) => { time += milliseconds; } };
}
async function image(width = 512, height = 768) {
  return sharp({ create: { width, height, channels: 4, background: '#bfbcff88' } }).png().toBuffer();
}
function uploadInput(bytes: Buffer, extras: Record<string, unknown> = {}) {
  return { name: '展会衬衫', description: '可上传的服装素材', category: '通勤', tags: ['简约'], imageBase64: bytes.toString('base64'), referenceImageBase64: bytes.toString('base64'), ...extras };
}
const assetFile = (image: string) => image.split('/').slice(-3).join('.') + '.webp';
const errorCode = (code: string) => expect.objectContaining({ code });

describe('exhibition upload validation and persistence', () => {
  it.each([[432, 768], [256, 256], [8192, 256], [256, 8192]])('accepts %i × %i display and reference images with the wider defaults', async (width, height) => {
    const { service } = fixture();
    const state = await service.upload(uploadInput(await image(width, height)));
    expect(state.settings.uploadLimits).toEqual(EXHIBITION_DEFAULT_UPLOAD_LIMITS);
    expect(state.looks.at(-1)).toMatchObject({ width, height, referenceImageInfo: { width, height } });
  });

  it('upgrades saved default limits once while preserving the catalog and later explicit limits', async () => {
    const { service, directory, now } = fixture();
    await service.upload(uploadInput(await image()));
    const filename = join(directory, 'exhibition.json');
    const old = JSON.parse(readFileSync(filename, 'utf8'));
    const legacyLimits = { maxFileSizeMB: 10, minWidth: 512, maxWidth: 4096, minHeight: 512, maxHeight: 4096 };
    delete old.uploadLimitsVersion;
    old.state.settings.uploadLimits = legacyLimits;
    writeFileSync(filename, JSON.stringify(old));
    const migrated = new ExhibitionService(directory, { now });
    expect(migrated.get().settings.uploadLimits).toEqual(EXHIBITION_DEFAULT_UPLOAD_LIMITS);
    expect(migrated.get().looks).toEqual(old.state.looks);
    expect(new ExhibitionService(directory, { now }).get()).toEqual(migrated.get());
    await expect(migrated.upload(uploadInput(await image(432, 768)))).resolves.toBeDefined();
    migrated.command({ action: 'configure', uploadLimits: legacyLimits });
    expect(new ExhibitionService(directory, { now }).get().settings.uploadLimits).toEqual(legacyLimits);
  });

  it('preserves custom limits when upgrading older saved settings', () => {
    const { directory, now } = fixture();
    const filename = join(directory, 'exhibition.json');
    const old = JSON.parse(readFileSync(filename, 'utf8'));
    const customLimits = { maxFileSizeMB: 5, minWidth: 640, maxWidth: 2048, minHeight: 480, maxHeight: 4096 };
    delete old.uploadLimitsVersion;
    old.state.settings.uploadLimits = customLimits;
    writeFileSync(filename, JSON.stringify(old));
    expect(new ExhibitionService(directory, { now }).get().settings.uploadLimits).toEqual(customLimits);
  });

  it('decodes an image, stores a sanitized asset, leaves it disabled, then supports enabling its dynamic ID and restarting', async () => {
    const { service, directory, now } = fixture();
    const bytes = await image();
    const initial = service.get();
    const uploaded = await service.upload(uploadInput(bytes, { expectedRevision: initial.revision }));
    expect(uploaded.revision).toBe(initial.revision + 1);
    expect(uploaded.looks).toHaveLength(4);
    const look = uploaded.looks.at(-1)!;
    expect(look).toMatchObject({ name: '展会衬衫', category: '通勤', tags: ['简约'], width: 512, height: 768, source: 'upload', mime: 'image/webp' });
    expect(look.id).toMatch(/^upload-[a-f0-9-]{36}$/);
    expect(look.image).toMatch(new RegExp(`^/api/exhibition/assets/${look.id}/display/[a-f0-9-]{36}$`));
    expect(look.referenceImage).toMatch(new RegExp(`^/api/exhibition/assets/${look.id}/reference/[a-f0-9-]{36}$`));
    expect(uploaded.enabledLookIds).not.toContain(look.id);
    expect(() => service.command({ action: 'select', lookId: look.id })).toThrow(errorCode('EXHIBITION_INVALID_LOOK'));
    const asset = service.asset(look.id);
    expect(asset.mime).toBe('image/webp'); expect(asset.data.length).toBe(look.bytes);
    expect(await sharp(asset.data).metadata()).toMatchObject({ format: 'webp', width: 512, height: 768, hasAlpha: true });
    service.command({ action: 'configure', enabledLookIds: [look.id] });
    const selected = service.get(); expect(selected.selectedLookId).toBe(look.id);
    const restarted = new ExhibitionService(directory, { now });
    expect(restarted.get()).toEqual(selected); expect(restarted.asset(look.id).data).toEqual(asset.data);
    expect(readdirSync(join(directory, 'exhibition-assets')).sort()).toEqual([assetFile(look.image), assetFile(look.referenceImage!)].sort());
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('migrates schema 1 settings, selected outfit and enabled order without overwriting the old session counter', () => {
    const { service, directory, now } = fixture();
    service.command({ action: 'configure', enabledLookIds: ['evening', 'city'], autoReturnSeconds: 180 });
    service.command({ action: 'begin' }); service.command({ action: 'end' });
    const old = JSON.parse(readFileSync(join(directory, 'exhibition.json'), 'utf8'));
    old.schemaVersion = 1; delete old.state.looks; delete old.state.categories; delete old.state.tags; delete old.state.settings.uploadLimits;
    writeFileSync(join(directory, 'exhibition.json'), JSON.stringify(old));
    const migrated = new ExhibitionService(directory, { now }).get();
    expect(migrated).toMatchObject({ selectedLookId: 'evening', enabledLookIds: ['evening', 'city'], sessionNumber: 1,
      settings: { autoReturnSeconds: 180, uploadLimits: EXHIBITION_DEFAULT_UPLOAD_LIMITS } });
    expect(migrated.looks).toHaveLength(3); expect(migrated.revision).toBe(old.state.revision + 1);
    expect(JSON.parse(readFileSync(join(directory, 'exhibition.json'), 'utf8')).schemaVersion).toBe(5);
  });

  it('rejects fake, truncated, unsupported and malformed images independently of the client MIME or filename', async () => {
    const { service, directory } = fixture(); const bytes = await image(); const initial = service.get();
    const invalid = [Buffer.from('<html>Not an image</html>'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"></svg>'), bytes.subarray(0, 70)];
    for (const content of invalid) await expect(service.upload(uploadInput(content, { imageBase64: `data:image/png;base64,${content.toString('base64')}`, filename: 'garment.png' }))).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_IMAGE' });
    for (const imageBase64 of ['', '%%%%', 'a===', 'data:text/html;base64,AAAA', 'AAAA\nAAAA']) await expect(service.upload(uploadInput(bytes, { imageBase64 }))).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_IMAGE' });
    const animationChunk = Buffer.alloc(20); animationChunk.writeUInt32BE(8, 0); animationChunk.write('acTL', 4); animationChunk.writeUInt32BE(2, 8);
    await expect(service.upload(uploadInput(Buffer.concat([bytes.subarray(0, 8), animationChunk, bytes.subarray(8)])))).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_IMAGE' });
    expect(service.get()).toEqual(initial); expect(readdirSync(directory)).toEqual(['exhibition.json']);
  });

  it('uses server-side limits for actual size and dimensions, with hard upper bounds on configuration', async () => {
    const { service } = fixture();
    const limits = { maxFileSizeMB: 1, minWidth: 512, maxWidth: 1024, minHeight: 512, maxHeight: 1024 };
    service.command({ action: 'configure', uploadLimits: limits });
    for (const [width, height] of [[511, 768], [768, 511], [1025, 768], [768, 1025]]) {
      await expect(service.upload(uploadInput(await image(width, height), { width: 512, height: 512 }))).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_DIMENSIONS' });
    }
    await expect(service.upload(uploadInput(Buffer.alloc(1_048_577)))).rejects.toMatchObject({ code: 'EXHIBITION_IMAGE_TOO_LARGE' });
    const initial = service.get();
    for (const bad of [{ ...limits, maxFileSizeMB: 21 }, { ...limits, minWidth: 1025 }, { ...limits, maxHeight: 8193 }, { ...limits, minHeight: 63 }, { ...limits, maxWidth: 500.5 }, { ...limits, minWidth: 8192, maxWidth: 8192, minHeight: 8192, maxHeight: 8192 }]) {
      expect(() => service.command({ action: 'configure', uploadLimits: bad, enabledLookIds: ['city'] })).toThrow(errorCode('EXHIBITION_INVALID_SETTINGS'));
      expect(service.get()).toEqual(initial);
    }
    await expect(service.upload(uploadInput(await image(512, 1024)))).resolves.toMatchObject({ settings: { uploadLimits: limits } });
  });

  it('validates EXIF-oriented dimensions and strips embedded metadata from stored images', async () => {
    const { service } = fixture();
    service.command({ action: 'configure', uploadLimits: { maxFileSizeMB: 10, minWidth: 512, maxWidth: 600, minHeight: 700, maxHeight: 900 } });
    const bytes = await sharp({ create: { width: 800, height: 512, channels: 3, background: '#ccc' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const state = await service.upload(uploadInput(bytes)); const look = state.looks.at(-1)!;
    expect(look).toMatchObject({ width: 512, height: 800 });
    const metadata = await sharp(service.asset(look.id).data).metadata();
    expect(metadata.orientation).toBeUndefined(); expect(metadata.exif).toBeUndefined();
  });

  it('appends onto the newest state despite stale revisions, selection changes and demo advancement during decoding', async () => {
    const { service, advance } = fixture(); const bytes = await image();
    const pending = service.upload(uploadInput(bytes, { expectedRevision: service.get().revision - 1 }));
    service.command({ action: 'configure', enabledLookIds: ['evening'], autoReturnSeconds: 0 });
    service.command({ action: 'begin' });
    advance(2200); const latest = service.get(); expect(latest.phase).toBe('showcase');
    const appended = await pending;
    expect(appended.looks).toHaveLength(4);
    const { looks: _looks, revision: _revision, updatedAt: _updatedAt, logs: _logs, ...visitor } = appended;
    const { looks: _oldLooks, revision: _oldRevision, updatedAt: _oldUpdatedAt, logs: _oldLogs, ...expectedVisitor } = latest;
    expect(visitor).toEqual(expectedVisitor); expect(appended.enabledLookIds).toEqual(['evening']);
  });

  it('allows disabled garment uploads in every phase without resetting playback or extending the idle deadline', async () => {
    const bytes = await image();
    for (const phase of ['select', 'idle', 'generating', 'showcase', 'paused']) {
      const { service, directory, advance } = fixture();
      if (phase === 'idle') service.command({ action: 'idle' });
      else if (phase !== 'select') {
        service.command({ action: 'begin' });
        if (phase === 'showcase') { advance(2200); service.get(); }
        if (phase === 'paused') service.command({ action: 'pause' });
      }
      const before = service.get(); expect(before.phase).toBe(phase);
      const beforeStorage = JSON.parse(readFileSync(join(directory, 'exhibition.json'), 'utf8'));
      const appended = await service.upload(uploadInput(bytes, { expectedRevision: 0 }));
      const afterStorage = JSON.parse(readFileSync(join(directory, 'exhibition.json'), 'utf8'));
      expect(appended).toMatchObject({ phase, selectedLookId: before.selectedLookId, displayedLookId: before.displayedLookId,
        enabledLookIds: before.enabledLookIds, live: before.live, sessionNumber: before.sessionNumber, generationNumber: before.generationNumber, generationReadyAt: before.generationReadyAt });
      expect(appended.enabledLookIds).not.toContain(appended.looks.at(-1)!.id);
      expect(afterStorage.lastCommandAt).toBe(beforeStorage.lastCommandAt);
      expect(afterStorage.pausedPhase).toBe(beforeStorage.pausedPhase); expect(afterStorage.pausedRemainingMs).toBe(beforeStorage.pausedRemainingMs);
    }
    const { service, advance } = fixture(); service.command({ action: 'configure', autoReturnSeconds: 15 }); service.command({ action: 'begin' });
    advance(14000); await service.upload(uploadInput(bytes)); advance(1000);
    expect(service.get().lifecycle?.idleEndsAt).toBeDefined();
    advance(15000);
    expect(service.get().phase).toBe('idle');
  });

  it('revalidates latest upload limits and referenced taxonomy after decoding', async () => {
    const bytes = await image();
    const tightened = fixture(); const pending = tightened.service.upload(uploadInput(bytes));
    tightened.service.command({ action: 'configure', uploadLimits: { maxFileSizeMB: 10, minWidth: 600, maxWidth: 4096, minHeight: 512, maxHeight: 4096 } });
    await expect(pending).rejects.toMatchObject({ code: 'EXHIBITION_UPLOAD_RULES_CHANGED' });
    expect(readdirSync(tightened.directory)).toEqual(['exhibition.json']);
    const noisy = await sharp(randomBytes(512 * 768 * 4), { raw: { width: 512, height: 768, channels: 4 } }).png().toBuffer();
    expect(noisy.length).toBeGreaterThan(1_048_576);
    const sizeLimited = fixture(); const sizePending = sizeLimited.service.upload(uploadInput(noisy));
    sizeLimited.service.command({ action: 'configure', uploadLimits: { ...sizeLimited.service.get().settings.uploadLimits, maxFileSizeMB: 1 } });
    await expect(sizePending).rejects.toMatchObject({ code: 'EXHIBITION_UPLOAD_RULES_CHANGED' });
    expect(readdirSync(sizeLimited.directory)).toEqual(['exhibition.json']);
    const allowed = fixture(); const allowedPending = allowed.service.upload(uploadInput(bytes));
    const old = allowed.service.get();
    allowed.service.command({ action: 'configure', uploadLimits: { ...old.settings.uploadLimits, maxWidth: 2048 } });
    allowed.service.taxonomy({ categories: [...old.categories, '新分类'], tags: [...old.tags, '新标签'] });
    expect((await allowedPending).looks).toHaveLength(4);
    for (const removed of ['category', 'tag']) {
      const { service, directory } = fixture(); const initial = service.get();
      service.taxonomy({ categories: [...initial.categories, '临时分类'], tags: [...initial.tags, '临时标签'] });
      const upload = service.upload(uploadInput(bytes, { category: '临时分类', tags: ['临时标签'] }));
      service.taxonomy({ categories: removed === 'category' ? initial.categories : [...initial.categories, '临时分类'], tags: removed === 'tag' ? initial.tags : [...initial.tags, '临时标签'] });
      await expect(upload).rejects.toMatchObject({ code: 'EXHIBITION_UPLOAD_TAXONOMY_CHANGED' });
      expect(service.get().looks).toHaveLength(3); expect(readdirSync(directory)).toEqual(['exhibition.json']);
    }
  });

  it('merges parallel uploads and enforces the catalog cap again at the serialized commit', async () => {
    const { service, directory, now } = fixture(); const bytes = await image();
    const [first, second] = await Promise.all([service.upload(uploadInput(bytes, { name: '并发甲' })), service.upload(uploadInput(bytes, { name: '并发乙' }))]);
    expect(Math.max(first.looks.length, second.looks.length)).toBe(5);
    expect(service.get().looks.map(look => look.name)).toEqual(expect.arrayContaining(['并发甲', '并发乙']));
    const saved = JSON.parse(readFileSync(join(directory, 'exhibition.json'), 'utf8'));
    const template = saved.state.looks.at(-1);
    while (saved.state.looks.length < 99) {
      const id = `upload-${randomUUID()}`;
      saved.state.looks.push({ ...template, id, image: `/api/exhibition/assets/${id}`, referenceImage: undefined, referenceImageInfo: undefined });
    }
    writeFileSync(join(directory, 'exhibition.json'), JSON.stringify(saved));
    const capped = new ExhibitionService(directory, { now });
    const results = await Promise.allSettled([capped.upload(uploadInput(bytes, { name: '最后一套甲' })), capped.upload(uploadInput(bytes, { name: '最后一套乙' }))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'EXHIBITION_CATALOG_FULL' } });
    expect(capped.get().looks).toHaveLength(100);
    expect(readdirSync(join(directory, 'exhibition-assets'))).toHaveLength(6);
  });

  it('rejects asset IDs with traversal, sample IDs or unknown uploads', () => {
    const { service } = fixture();
    for (const id of ['../exhibition.json', '%2e%2e%2fexhibition.json', '/etc/passwd', 'commute', 'upload-00000000-0000-0000-0000-000000000000']) expect(() => service.asset(id)).toThrow(errorCode('EXHIBITION_ASSET_NOT_FOUND'));
  });
});

describe('exhibition flat classification and metadata', () => {
  it('supports flat category/tag updates and editing uploaded garments, but prevents deleting referenced terms', async () => {
    const { service, directory, now } = fixture();
    let state = service.get();
    state = service.taxonomy({ categories: [...state.categories, '国风'], tags: [...state.tags, '新品', '限定'], expectedRevision: state.revision });
    state = await service.upload(uploadInput(await image(), { category: '国风', tags: ['新品', '限定'] }));
    const id = state.looks.at(-1)!.id;
    state = await service.updateLook(id, { name: '改名服装', description: '已修改', tags: ['限定'], expectedRevision: state.revision });
    expect(state.looks.at(-1)).toMatchObject({ name: '改名服装', description: '已修改', category: '国风', tags: ['限定'] });
    expect(() => service.taxonomy({ categories: ['通勤', '休闲', '礼服'], tags: state.tags })).toThrow(errorCode('EXHIBITION_TAXONOMY_IN_USE'));
    expect(() => service.taxonomy({ categories: state.categories, tags: state.tags.filter(tag => tag !== '限定') })).toThrow(errorCode('EXHIBITION_TAXONOMY_IN_USE'));
    state = service.taxonomy({ categories: state.categories, tags: state.tags.filter(tag => tag !== '新品') });
    expect(new ExhibitionService(directory, { now }).get()).toEqual(state);
  });

  it('rejects nested, duplicated or unknown taxonomy and stale/in-session metadata edits without mutation', async () => {
    const { service } = fixture(); const initial = service.get();
    for (const payload of [{ categories: [], tags: [] }, { categories: ['休闲', ' 休闲 '], tags: [] }, { categories: [['通勤']], tags: [] }, { categories: initial.categories, tags: ['New', 'new'] }, { categories: initial.categories, tags: ['a'.repeat(21)] }]) expect(() => service.taxonomy(payload)).toThrow();
    for (const changes of [{ name: '' }, { name: 'x'.repeat(41) }, { description: 'x'.repeat(121) }, { category: '未添加分类' }, { tags: ['未知标签'] }, { tags: ['简约', '简约'] }]) expect(() => service.updateLook('commute', changes)).toThrow();
    expect(() => service.updateLook('missing', { name: '名' })).toThrow(errorCode('EXHIBITION_INVALID_LOOK'));
    expect(() => service.updateLook('commute', { name: '名字', expectedRevision: initial.revision - 1 })).toThrow(errorCode('EXHIBITION_STALE_REVISION'));
    expect(service.get()).toEqual(initial);
    service.command({ action: 'begin' });
    expect(() => service.taxonomy({ categories: initial.categories, tags: initial.tags })).toThrow(errorCode('EXHIBITION_INVALID_PHASE'));
    expect(service.updateLook('commute', { name: '名字' })).toMatchObject({ phase: 'generating' });
    expect(service.get().publication!.looks[0].name).toBe(initial.looks[0].name);
    expect((await service.upload(uploadInput(await image()))).phase).toBe('generating');
  });
});

describe('exhibition garment deletion', () => {
  it('removes an enabled uploaded garment, falls back in enabled order, and persists without its asset', async () => {
    const { service, directory, now } = fixture();
    const uploaded = await service.upload(uploadInput(await image())); const look = uploaded.looks.at(-1)!;
    service.command({ action: 'configure', enabledLookIds: ['evening', look.id, 'city'] });
    const selected = service.command({ action: 'select', lookId: look.id });
    const removed = service.removeLook(look.id, { expectedRevision: selected.revision });
    expect(removed).toMatchObject({ revision: selected.revision + 1, enabledLookIds: ['evening', 'city'], selectedLookId: 'evening', displayedLookId: null });
    expect(removed.looks).toEqual(selected.looks.filter(item => item.id !== look.id));
    expect(removed.logs[0].message).toBe(`服装「${look.name}」已删除。`);
    expect(() => service.asset(look.id)).toThrow(errorCode('EXHIBITION_ASSET_NOT_FOUND'));
    expect(readdirSync(join(directory, 'exhibition-assets'))).toEqual([]);
    expect(new ExhibitionService(directory, { now }).get()).toEqual(removed);
  });

  it('removes a sample record and its stale displayed selection while retaining the public image', () => {
    const { service, directory, now } = fixture();
    const storedPath = join(directory, 'exhibition.json');
    const stored = JSON.parse(readFileSync(storedPath, 'utf8')); stored.state.displayedLookId = 'commute';
    writeFileSync(storedPath, JSON.stringify(stored));
    const restored = new ExhibitionService(directory, { now });
    const publicImage = join(process.cwd(), 'public', service.get().looks[0].image);
    const originalImage = readFileSync(publicImage);
    const removed = restored.removeLook('commute', { expectedRevision: restored.get().revision });
    expect(removed).toMatchObject({ enabledLookIds: ['city', 'evening'], selectedLookId: 'city', displayedLookId: null });
    expect(removed.looks.map(look => look.id)).toEqual(['city', 'evening']);
    expect(readFileSync(publicImage)).toEqual(originalImage);
    expect(new ExhibitionService(directory, { now }).get()).toEqual(removed);
  });

  it('rejects stale revisions, missing IDs and active-session deletion without mutation', async () => {
    const { service } = fixture();
    const uploaded = await service.upload(uploadInput(await image())); const look = uploaded.looks.at(-1)!;
    const initial = service.command({ action: 'configure', enabledLookIds: ['city'] });
    expect(() => service.removeLook(look.id, { expectedRevision: initial.revision - 1 })).toThrow(errorCode('EXHIBITION_STALE_REVISION'));
    expect(() => service.removeLook(look.id, { expectedRevision: -1 })).toThrow(errorCode('EXHIBITION_INVALID_REVISION'));
    expect(() => service.removeLook('../exhibition.json', {})).toThrow(errorCode('EXHIBITION_INVALID_LOOK'));
    expect(service.get()).toEqual(initial);
    const generating = service.command({ action: 'begin' });
    expect(() => service.removeLook(look.id, {})).toThrow(errorCode('EXHIBITION_INVALID_PHASE'));
    expect(service.get()).toEqual(generating);
    service.command({ action: 'idle' });
    expect(service.removeLook(look.id, {})).toMatchObject({ phase: 'idle', enabledLookIds: ['city'], selectedLookId: 'city' });
  });

  it('retains the catalog and image when the atomic state write fails', async () => {
    const { service, directory } = fixture();
    const before = await service.upload(uploadInput(await image())); const look = before.looks.at(-1)!;
    const originalImage = service.asset(look.id).data;
    const storedPath = join(directory, 'exhibition.json'); const backupPath = `${storedPath}.saved`;
    const originalState = readFileSync(storedPath, 'utf8');
    renameSync(storedPath, backupPath); mkdirSync(storedPath);
    expect(() => service.removeLook(look.id, { expectedRevision: before.revision })).toThrow();
    expect(service.get()).toEqual(before); expect(service.asset(look.id).data).toEqual(originalImage);
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
    rmSync(storedPath, { recursive: true }); renameSync(backupPath, storedPath);
    expect(readFileSync(storedPath, 'utf8')).toBe(originalState);
  });

  it('does not misreport a committed deletion when asset cleanup fails, and never serves the orphan', async () => {
    const { service, directory, now } = fixture();
    const uploaded = await service.upload(uploadInput(await image())); const look = uploaded.looks.at(-1)!;
    const assetPath = join(directory, 'exhibition-assets', assetFile(look.image));
    const original = readFileSync(assetPath); rmSync(assetPath); mkdirSync(assetPath); writeFileSync(join(assetPath, 'orphan'), original);
    const removed = service.removeLook(look.id, { expectedRevision: uploaded.revision });
    expect(removed.looks.some(item => item.id === look.id)).toBe(false);
    expect(readFileSync(join(assetPath, 'orphan'))).toEqual(original);
    expect(() => service.asset(look.id)).toThrow(errorCode('EXHIBITION_ASSET_NOT_FOUND'));
    expect(new ExhibitionService(directory, { now }).get()).toEqual(removed);
  });
});

describe('exhibition upload HTTP boundary', () => {
  const headers = { 'Content-Type': 'application/json', Origin: 'http://xuminghong.local:10200' };
  async function withServer(run: (base: string, service: ExhibitionService) => Promise<void>) {
    const { service } = fixture();
    const unrelatedService = new Proxy({} as TryOnService, { get: () => { throw new Error('Uploads must not call XMAX.'); } });
    const server = createApiServer(unrelatedService, ['http://xuminghong.local:10200'], undefined, service);
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address() as { port: number };
    try { await run(`http://127.0.0.1:${address.port}`, service); }
    finally { server.close(); await once(server, 'close'); }
  }

  it('accepts multipart-sized JSON only on uploads, returns safe image content, and exposes metadata/taxonomy APIs', async () => {
    await withServer(async (base, service) => {
      const uploaded = await fetch(`${base}/api/exhibition/looks`, { method: 'POST', headers, body: JSON.stringify(uploadInput(await image())) });
      expect(uploaded.status).toBe(201); const state = await uploaded.json() as ExhibitionState; const look = state.looks.at(-1)!;
      const asset = await fetch(`${base}${look.image}`); expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toBe('image/webp');
      expect(asset.headers.get('x-content-type-options')).toBe('nosniff'); expect(Buffer.from(await asset.arrayBuffer())).toEqual(service.asset(look.id).data);
      const head = await fetch(`${base}${look.image}`, { method: 'HEAD' }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
      const edit = await fetch(`${base}/api/exhibition/looks/${look.id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: '新名字', expectedRevision: state.revision }) });
      expect(edit.status).toBe(200); expect((await edit.json() as ExhibitionState).looks.at(-1)?.name).toBe('新名字');
      const terms = await fetch(`${base}/api/exhibition/taxonomy`, { method: 'POST', headers, body: JSON.stringify({ categories: [...state.categories, '运动'], tags: state.tags }) });
      expect(terms.status).toBe(200); expect((await terms.json() as ExhibitionState).categories).toContain('运动');
      for (const path of ['/api/exhibition/assets/%2e%2e%2fexhibition.json', '/api/exhibition/assets/commute', '/api/exhibition/assets/upload-00000000-0000-0000-0000-000000000000']) expect((await fetch(`${base}${path}`)).status).toBe(404);
    });
  });


  it('accepts two full-size images in upload and PATCH and exposes only current immutable resources', async () => {
    await withServer(async (base, service) => {
      const noisy = await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
      expect(noisy.length).toBeGreaterThan(16_384);
      const uploaded = await fetch(`${base}/api/exhibition/looks`, { method: 'POST', headers, body: JSON.stringify(uploadInput(noisy)) });
      expect(uploaded.status).toBe(201); const state = await uploaded.json() as ExhibitionState; const look = state.looks.at(-1)!;
      const reference = await fetch(`${base}${look.referenceImage}`); expect(reference.status).toBe(200);
      const originalReference = Buffer.from(await reference.arrayBuffer());
      expect((await fetch(`${base}${look.referenceImage}`, { method: 'HEAD' })).status).toBe(200);
      const edited = await fetch(`${base}/api/exhibition/looks/${look.id}`, { method: 'PATCH', headers,
        body: JSON.stringify({ imageBase64: noisy.toString('base64'), expectedRevision: state.revision }) });
      expect(edited.status).toBe(200); const changed = (await edited.json() as ExhibitionState).looks.at(-1)!;
      expect(changed.image).not.toBe(look.image); expect(changed.referenceImage).toBe(look.referenceImage);
      expect(Buffer.from(await (await fetch(`${base}${changed.referenceImage}`)).arrayBuffer())).toEqual(originalReference);
      expect((await fetch(`${base}${look.image}`)).status).toBe(404);
      expect((await fetch(`${base}/api/exhibition/assets/${look.id}`)).status).toBe(404);
      expect((await fetch(`${base}${look.referenceImage!.replace('/reference/', '/display/')}`)).status).toBe(404);
      const tooLarge = await fetch(`${base}/api/exhibition/looks/${look.id}`, { method: 'PATCH', headers,
        body: JSON.stringify({ referenceImageBase64: 'A'.repeat(service.uploadRequestLimit()) }) });
      expect(tooLarge.status).toBe(413); expect((await tooLarge.json()).code).toBe('REQUEST_TOO_LARGE');
    });
  });

  it('enforces origin and route-specific request body limits before decoding a garment', async () => {
    await withServer(async (base, service) => {
      const state = service.get(); service.command({ action: 'configure', uploadLimits: { ...state.settings.uploadLimits, maxFileSizeMB: 1 } });
      const content = uploadInput(await image()); const initial = service.get();
      const forbidden = await fetch(`${base}/api/exhibition/looks`, { method: 'POST', headers: { ...headers, Origin: 'http://outside.example' }, body: JSON.stringify(content) });
      expect(forbidden.status).toBe(403);
      const tooLarge = await fetch(`${base}/api/exhibition/looks`, { method: 'POST', headers, body: JSON.stringify({ ...content, imageBase64: 'A'.repeat(service.uploadRequestLimit()) }) });
      expect(tooLarge.status).toBe(413); expect(await tooLarge.json()).toMatchObject({ code: 'REQUEST_TOO_LARGE' });
      const command = await fetch(`${base}/api/exhibition/command`, { method: 'POST', headers, body: JSON.stringify({ action: 'begin', padding: 'A'.repeat(20_000) }) });
      expect(command.status).toBe(413);
      const invalidType = await fetch(`${base}/api/exhibition/looks`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: JSON.stringify(content) }); expect(invalidType.status).toBe(415);
      expect(service.get()).toEqual(initial);
    });
  });

  it('deletes through the protected revision-aware route and makes the deleted image unavailable', async () => {
    await withServer(async (base, service) => {
      const uploaded = await service.upload(uploadInput(await image())); const look = uploaded.looks.at(-1)!;
      const path = `${base}/api/exhibition/looks/${look.id}`;
      const requestDelete = (requestHeaders: Record<string, string>, expectedRevision: number) => fetch(path, {
        method: 'DELETE', headers: requestHeaders, body: JSON.stringify({ expectedRevision }),
      });
      expect((await requestDelete({ ...headers, Origin: 'http://outside.example' }, uploaded.revision)).status).toBe(403);
      const stale = await requestDelete(headers, uploaded.revision - 1);
      expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
      expect(service.get()).toEqual(uploaded);
      const deleted = await requestDelete(headers, uploaded.revision);
      expect(deleted.status).toBe(200); const state = await deleted.json() as ExhibitionState;
      expect(state.revision).toBe(uploaded.revision + 1); expect(state.looks.some(item => item.id === look.id)).toBe(false);
      expect((await fetch(`${base}${look.image}`)).status).toBe(404);
      expect((await requestDelete(headers, state.revision)).status).toBe(404);
      expect(service.get()).toEqual(state);
    });
  });
});
