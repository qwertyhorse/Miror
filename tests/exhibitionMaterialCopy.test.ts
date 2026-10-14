import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import type { ExhibitionService } from '../server/exhibition.ts';
import type { ExhibitionLook, ExhibitionLookCopyInput } from '../shared/exhibition.ts';

const sampleFiles = vi.hoisted(() => ({ distOnly: false, fallbackReads: 0 }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    const file = String(args[0]);
    if (sampleFiles.distOnly && file.includes('/public/assets/exhibition/')) throw Object.assign(new Error('not packaged'), { code: 'ENOENT' });
    if (sampleFiles.distOnly && file.includes('/dist/assets/exhibition/')) {
      sampleFiles.fallbackReads++;
      args[0] = file.replace('/dist/assets/exhibition/', '/public/assets/exhibition/');
    }
    return actual.readFileSync(...args);
  } };
});

const directories: string[] = [];
afterEach(() => {
  sampleFiles.distOnly = false; sampleFiles.fallbackReads = 0;
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-material-copy-')); directories.push(directory);
  const now = () => 1_800_000_000_000;
  const manager = new ExhibitionMirrors(directory, { now });
  const targetId = manager.create({ name: '目标智能镜' }).id;
  const source = manager.getMirror(); const target = manager.getMirror(targetId);
  const targetDirectory = join(directory, 'exhibition-mirrors', targetId);
  const copy = (sourceLookId = 'commute', extras: Partial<ExhibitionLookCopyInput> = {}) => manager.copyLook(targetId, {
    sourceMirrorId: 'default', sourceLookId, mode: 'clothx', expectedRevision: target.read().revision, ...extras,
  });
  return { directory, now, manager, source, target, targetId, targetDirectory, copy };
}
async function add(service: ExhibitionService, extras: Record<string, unknown> = {}) {
  const display = await sharp({ create: { width: 512, height: 768, channels: 4, background: '#ac8de088' } }).png().toBuffer();
  const reference = await sharp({ create: { width: 320, height: 512, channels: 4, background: '#cfa0a0ff' } }).png().toBuffer();
  const state = await service.upload({ name: '原始素材', description: '保留说明', category: '通勤', tags: ['简约'],
    imageBase64: display.toString('base64'), referenceImageBase64: reference.toString('base64'), ...extras });
  return state.looks.at(-1)!;
}
const code = (value: string) => expect.objectContaining({ code: value });
const assetFile = (image: string) => image.split('/').slice(-3).join('.') + '.webp';
const assets = (directory: string) => existsSync(join(directory, 'exhibition-assets')) ? readdirSync(join(directory, 'exhibition-assets')).sort() : [];
const referenceData = (service: ExhibitionService, look: ExhibitionLook) => {
  const parts = look.referenceImage!.split('/');
  return service.assetResource(look.id, parts.at(-2), parts.at(-1)).data;
};

describe('independent material copy', () => {
  it('appends enabled dual-image material in the target mode while preserving target state and source', async () => {
    const f = fixture();
    const original = await add(f.source);
    f.source.command({ action: 'configure', enabledLookIds: [...f.source.read().enabledLookIds, original.id] });
    f.target.command({ action: 'select', lookId: 'city' });
    f.target.command({ action: 'configure', autoReturnSeconds: 180 });
    f.source.command({ action: 'begin' });
    const before = f.target.read(); const sourceBefore = f.source.read();
    const result = await f.copy(original.id, { mode: 'charx' }); const copied = result.looks.at(-1)!;
    expect(copied).toMatchObject({ name: original.name, description: original.description, mode: 'charx', source: 'upload', category: original.category, tags: original.tags });
    expect(copied.id).not.toBe(original.id); expect(copied.id).toMatch(/^upload-[a-f0-9-]{36}$/);
    expect(result.looks.slice(0, -1)).toEqual(before.looks);
    expect(result.enabledLookIds).toEqual([...before.enabledLookIds, copied.id]);
    expect(result).toMatchObject({ selectedLookId: before.selectedLookId, phase: before.phase, experienceMode: before.experienceMode,
      settings: before.settings, live: before.live, sessionNumber: before.sessionNumber, generationNumber: before.generationNumber });
    expect(result.logs.slice(1)).toEqual(before.logs); expect(f.source.read()).toEqual(sourceBefore);
    expect(f.target.asset(copied.id).data).toEqual(f.source.asset(original.id).data);
    expect(referenceData(f.target, copied)).toEqual(referenceData(f.source, original));
    f.source.command({ action: 'end' }); f.source.removeLook(original.id, {});
    expect(f.target.asset(copied.id).data.length).toBeGreaterThan(0);
    const restarted = new ExhibitionMirrors(f.directory, { now: f.now }).getMirror(f.targetId);
    expect(restarted.read()).toEqual(result); expect(referenceData(restarted, copied)).toEqual(referenceData(f.target, copied));
  });

  it('materializes sample assets as unique WebP files, including same-mirror and repeated copies', async () => {
    const f = fixture(); const originalCount = f.source.read().looks.length;
    const first = await f.manager.copyLook('default', { sourceMirrorId: 'default', sourceLookId: 'commute', mode: 'vibex', expectedRevision: f.source.read().revision });
    const sampleCopy = first.looks.at(-1)!;
    expect(sampleCopy).toMatchObject({ source: 'upload', mime: 'image/webp', referenceImageInfo: { mime: 'image/webp' }, mode: 'vibex' });
    expect(sampleCopy.image).toContain(`/default/assets/${sampleCopy.id}/display/`);
    expect((await sharp(f.source.asset(sampleCopy.id).data).metadata()).format).toBe('webp');
    const next = await f.manager.copyLook('default', { sourceMirrorId: 'default', sourceLookId: 'commute', mode: 'clothx', expectedRevision: first.revision });
    expect(next.looks).toHaveLength(originalCount + 2); expect(next.looks.at(-1)!.id).not.toBe(sampleCopy.id);
    expect(new ExhibitionMirrors(f.directory, { now: f.now }).getMirror().read()).toEqual(next);
  });

  it('reads built-in assets from dist when the deployed package has no public directory', async () => {
    const f = fixture(); sampleFiles.distOnly = true;
    const state = await f.copy();
    expect(sampleFiles.fallbackReads).toBe(1);
    expect((await sharp(f.target.asset(state.looks.at(-1)!.id).data).metadata()).format).toBe('webp');
  });

  it('preserves disabled state and merges source taxonomy without replacing target names', async () => {
    const f = fixture();
    f.source.taxonomy({ categories: [...f.source.read().categories, 'Winter'], tags: [...f.source.read().tags, 'Wool'] });
    f.target.taxonomy({ categories: [...f.target.read().categories, 'winter'], tags: [...f.target.read().tags, '目标标签'] });
    const original = await add(f.source, { category: 'Winter', tags: ['Wool'] });
    const before = f.target.read(); const result = await f.copy(original.id); const copied = result.looks.at(-1)!;
    expect(copied).toMatchObject({ category: 'winter', tags: ['Wool'] });
    expect(result.categories).toEqual(before.categories); expect(result.tags).toEqual([...before.tags, 'Wool']);
    expect(result.enabledLookIds).toEqual(before.enabledLookIds);
  });

  it('validates Free prompts, preserves Free prompts by default and rejects prompt-only cross-mode copies', async () => {
    const f = fixture();
    await expect(f.copy('commute', { mode: 'free' })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PROMPT' });
    await expect(f.copy('commute', { mode: 'free', prompt: ' '.repeat(2) })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PROMPT' });
    const free = (await f.copy('commute', { mode: 'free', prompt: '  人物身后出现彩虹  ' })).looks.at(-1)!;
    expect(free.prompt).toBe('人物身后出现彩虹');
    const duplicate = await f.manager.copyLook(f.targetId, { sourceMirrorId: f.targetId, sourceLookId: free.id, mode: 'free', expectedRevision: f.target.read().revision });
    expect(duplicate.looks.at(-1)!.prompt).toBe(free.prompt);
    f.source.updateLook('commute', { mode: 'free', referenceKind: 'none', prompt: '纯文本场景' });
    await expect(f.copy('commute', { mode: 'dimx' })).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_REQUIRED' });
    const textOnly = (await f.copy('commute', { mode: 'free' })).looks.at(-1)!;
    expect(textOnly).toMatchObject({ referenceKind: 'none', prompt: '纯文本场景' }); expect(textOnly.referenceImage).toBeUndefined();
    const imageMode = await f.manager.copyLook(f.targetId, { sourceMirrorId: f.targetId, sourceLookId: free.id, mode: 'mox', expectedRevision: f.target.read().revision });
    expect(imageMode.looks.at(-1)!.prompt).toBeUndefined();
  });

  it('establishes only the initial selection when copying an enabled material into an empty active group', async () => {
    const f = fixture(); f.target.command({ action: 'configure', experienceMode: 'charx' });
    expect(f.target.read().selectedLookId).toBeNull();
    const result = await f.copy('commute', { mode: 'charx' });
    expect(result.selectedLookId).toBe(result.looks.at(-1)!.id); expect(result.phase).toBe('idle'); expect(result.sessionNumber).toBe(0);
    expect(new ExhibitionMirrors(f.directory, { now: f.now }).getMirror(f.targetId).read()).toEqual(result);
  });

  it('captures both source images before awaiting and survives later source deletion', async () => {
    const f = fixture(); const original = await add(f.source); const display = f.source.asset(original.id).data; const reference = referenceData(f.source, original);
    const copying = f.copy(original.id);
    f.source.removeLook(original.id, {});
    const copied = (await copying).looks.at(-1)!;
    expect(f.target.asset(copied.id).data).toEqual(display); expect(referenceData(f.target, copied)).toEqual(reference);
  });

  it('rejects missing, malformed, stale and active target requests without writing assets', async () => {
    const f = fixture(); const before = f.target.read();
    await expect(f.manager.copyLook(f.targetId, {})).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_COPY' });
    await expect(f.copy('commute', { sourceMirrorId: 'missing' })).rejects.toMatchObject({ code: 'EXHIBITION_MIRROR_NOT_FOUND' });
    await expect(f.copy('missing')).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_LOOK' });
    await expect(f.copy('commute', { mode: 'invalid' as 'clothx' })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_MODE' });
    await expect(f.copy('commute', { expectedRevision: before.revision - 1 })).rejects.toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
    expect(f.target.read()).toEqual(before); expect(assets(f.targetDirectory)).toEqual([]);
    f.target.command({ action: 'begin' }); const active = f.target.read();
    await expect(f.copy()).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' }); expect(f.target.read()).toEqual(active);
  });

  it('rejects target changes during preparation and blocks deletion or whole-copy until preparation finishes', async () => {
    const f = fixture(); const original = await add(f.source); const copying = f.copy(original.id);
    expect(() => f.manager.remove(f.targetId, { expectedRevision: f.target.read().revision })).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    expect(() => f.manager.copy(f.targetId, { sourceMirrorId: 'default', copyLooks: true, copySettings: true, expectedRevision: f.target.read().revision })).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    await expect(f.copy(original.id)).rejects.toMatchObject({ code: 'EXHIBITION_MIRROR_BUSY' });
    f.target.command({ action: 'configure', autoReturnSeconds: 180 }); const changed = f.target.read();
    await expect(copying).rejects.toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
    expect(f.target.read()).toEqual(changed); expect(assets(f.targetDirectory)).toEqual([]);
    expect((await f.copy(original.id)).looks).toHaveLength(changed.looks.length + 1);
  });

  it('honors target image limits and cleans all copied files when the state commit fails', async () => {
    const f = fixture(); const original = await add(f.source);
    f.target.command({ action: 'configure', uploadLimits: { ...f.target.read().settings.uploadLimits, minWidth: 400 } });
    const limited = f.target.read();
    await expect(f.copy(original.id)).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_DIMENSIONS' });
    expect(f.target.read()).toEqual(limited); expect(assets(f.targetDirectory)).toEqual([]);
    f.target.command({ action: 'configure', uploadLimits: { ...limited.settings.uploadLimits, minWidth: 256 } });
    const before = f.target.read(); const file = join(f.targetDirectory, 'exhibition.json');
    renameSync(file, `${file}.saved`); mkdirSync(file);
    await expect(f.copy(original.id)).rejects.toBeDefined();
    expect(f.target.read()).toEqual(before); expect(assets(f.targetDirectory)).toEqual([]);
    rmSync(file, { recursive: true }); renameSync(`${file}.saved`, file);
    expect((await f.copy(original.id)).looks).toHaveLength(before.looks.length + 1);
  });

  it('rejects a missing source image without appending or reserving target processing', async () => {
    const f = fixture(); const original = await add(f.source); const before = f.target.read();
    rmSync(join(f.directory, 'exhibition-mirrors', 'default', 'exhibition-assets', assetFile(original.referenceImage!)));
    await expect(f.copy(original.id)).rejects.toMatchObject({ code: 'EXHIBITION_ASSET_NOT_FOUND' });
    expect(f.target.read()).toEqual(before); expect(assets(f.targetDirectory)).toEqual([]);
    await expect(f.copy()).resolves.toBeDefined();
  });

  it('enforces catalog and taxonomy capacity before creating any files', async () => {
    const f = fixture(); const original = await add(f.target); const file = join(f.targetDirectory, 'exhibition.json');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    while (stored.state.looks.length < 100) {
      const id = `upload-${randomUUID()}`;
      stored.state.looks.push({ ...original, id, image: original.image.replace(original.id, id), referenceImage: original.referenceImage!.replace(original.id, id) });
    }
    writeFileSync(file, JSON.stringify(stored));
    const reloaded = new ExhibitionMirrors(f.directory, { now: f.now }); const beforeFiles = assets(f.targetDirectory);
    await expect(reloaded.copyLook(f.targetId, { sourceMirrorId: 'default', sourceLookId: 'commute', mode: 'clothx', expectedRevision: reloaded.getMirror(f.targetId).read().revision })).rejects.toMatchObject({ code: 'EXHIBITION_CATALOG_FULL' });
    expect(assets(f.targetDirectory)).toEqual(beforeFiles);
    f.source.taxonomy({ categories: [...f.source.read().categories, '额外分类'], tags: f.source.read().tags });
    f.source.updateLook('commute', { category: '额外分类' });
    f.target.taxonomy({ categories: [...f.target.read().categories, ...Array.from({ length: 37 }, (_, index) => `分类${index}`)], tags: f.target.read().tags });
    const before = f.target.read();
    await expect(f.copy()).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_TAXONOMY' });
    expect(f.target.read()).toEqual(before); expect(assets(f.targetDirectory)).toEqual(beforeFiles);
  });
});
