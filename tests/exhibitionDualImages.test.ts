import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionService } from '../server/exhibition';
import { ExhibitionMirrors } from '../server/exhibitionMirrors';
import { exhibitionReferenceImage, type ExhibitionLook } from '../shared/exhibition';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'exhibition-dual-')); directories.push(directory);
  const now = () => 1_800_000_000_000;
  return { directory, now, service: new ExhibitionService(directory, { now }) };
}
async function picture(color: string, width = 512, height = 768) {
  return (await sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer()).toString('base64');
}
const file = (url: string) => url.includes('/display/') || url.includes('/reference/') ? url.split('/').slice(-3).join('.') + '.webp' : url.split('/').at(-1)! + '.webp';
const resources = (look: ExhibitionLook) => [...new Set([look.image, look.referenceImage].filter((value): value is string => !!value))];
const bytes = (service: ExhibitionService, url: string) => {
  const pieces = url.split('/assets/')[1].split('/');
  return service.assetResource(pieces[0], pieces[1], pieces[2]).data;
};
async function add(service: ExhibitionService) {
  const state = await service.upload({ name: '双图素材', imageBase64: await picture('#cc0000', 512, 768), referenceImageBase64: await picture('#0000cc', 768, 512) });
  return state.looks.at(-1)!;
}
async function legacy(promptOnly = false) {
  const f = fixture(); const look = await add(f.service); const display = f.service.asset(look.id).data;
  const stored = JSON.parse(readFileSync(join(f.directory, 'exhibition.json'), 'utf8'));
  const old = stored.state.looks.at(-1);
  old.image = `/api/exhibition/assets/${look.id}`; delete old.referenceImage; delete old.referenceImageInfo;
  if (promptOnly) { old.mode = 'free'; old.referenceKind = 'none'; old.prompt = '保留人物，背景变为花海'; }
  writeFileSync(join(f.directory, 'exhibition.json'), JSON.stringify(stored));
  for (const url of resources(look)) rmSync(join(f.directory, 'exhibition-assets', file(url)));
  writeFileSync(join(f.directory, 'exhibition-assets', `${look.id}.webp`), display);
  return { ...f, service: new ExhibitionService(f.directory, { now: f.now, strictStorage: true }), look: old as ExhibitionLook, display };
}

describe('independent exhibition display and XMAX images', () => {
  it('requires both images for every new material, including Free, and rejects either invalid image without files', async () => {
    const f = fixture(); const valid = await picture('#cc0000'); const before = f.service.get();
    await expect(f.service.upload({ name: '单图', imageBase64: valid })).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_REQUIRED' });
    await expect(f.service.upload({ name: '提示词', mode: 'free', prompt: '彩虹', referenceKind: 'none', imageBase64: valid, referenceImageBase64: valid })).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_REQUIRED' });
    await expect(f.service.upload({ name: '坏参考图', imageBase64: valid, referenceImageBase64: '%%%%' })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_IMAGE', message: expect.stringContaining('XMAX 参考图') });
    expect(f.service.get()).toEqual(before); expect(readdirSync(f.directory)).toEqual(['exhibition.json']);
  });

  it('stores separate dimensions and bytes, serves only owned resources, and preserves both on restart', async () => {
    const f = fixture(); const look = await add(f.service);
    expect(look).toMatchObject({ width: 512, height: 768, referenceImageInfo: { width: 768, height: 512, mime: 'image/webp' } });
    expect(bytes(f.service, look.image)).not.toEqual(bytes(f.service, look.referenceImage!));
    expect(exhibitionReferenceImage(look)).toBe(look.referenceImage);
    const restored = new ExhibitionService(f.directory, { now: f.now, strictStorage: true });
    expect(restored.get()).toEqual(f.service.get());
    for (const url of resources(look)) expect(bytes(restored, url)).toEqual(bytes(f.service, url));
    expect(() => restored.assetResource(look.id)).toThrow();
    const referenceId = look.referenceImage!.split('/').at(-1)!;
    expect(() => restored.assetResource(look.id, 'display', referenceId)).toThrow();
    expect(() => restored.assetResource('commute', 'reference', referenceId)).toThrow();
    expect(() => restored.assetResource(look.id, 'reference', '../exhibition.json')).toThrow();
  });

  it('replaces either image independently with fresh URLs while keeping the material id and the other bytes', async () => {
    const f = fixture(); const original = await add(f.service); const reference = bytes(f.service, original.referenceImage!);
    let state = await f.service.updateLook(original.id, { imageBase64: await picture('#00cc00'), expectedRevision: f.service.get().revision });
    const displayChanged = state.looks.at(-1)!;
    expect(displayChanged.id).toBe(original.id); expect(displayChanged.image).not.toBe(original.image);
    expect(displayChanged.referenceImage).toBe(original.referenceImage); expect(bytes(f.service, displayChanged.referenceImage!)).toEqual(reference);
    expect(() => bytes(f.service, original.image)).toThrow();
    state = await f.service.updateLook(original.id, { referenceImageBase64: await picture('#cccc00', 640, 640), expectedRevision: state.revision });
    const referenceChanged = state.looks.at(-1)!;
    expect(referenceChanged.image).toBe(displayChanged.image); expect(referenceChanged.referenceImage).not.toBe(original.referenceImage);
    expect(referenceChanged.referenceImageInfo).toMatchObject({ width: 640, height: 640 });
    expect(() => bytes(f.service, original.referenceImage!)).toThrow();
    expect(readdirSync(join(f.directory, 'exhibition-assets')).sort()).toEqual(resources(referenceChanged).map(file).sort());
  });

  it('pins a legacy single image as the reference when only its display is changed', async () => {
    const f = await legacy();
    const updated = (await f.service.updateLook(f.look.id, { imageBase64: await picture('#00cc00') })).looks.at(-1)!;
    expect(updated.referenceImage).toBe(f.look.image); expect(updated.referenceImageInfo).toMatchObject({ width: 512, height: 768 });
    expect(bytes(f.service, updated.referenceImage!)).toEqual(f.display);
    expect(new ExhibitionService(f.directory, { now: f.now, strictStorage: true }).get().looks.at(-1)).toEqual(updated);
    f.service.removeLook(updated.id, {}); expect(readdirSync(join(f.directory, 'exhibition-assets'))).toEqual([]);
  });

  it('supports customized samples without modifying public assets and keeps their original reference', async () => {
    const f = fixture(); const sample = f.service.get().looks[0];
    const original = readFileSync(join(process.cwd(), 'public', sample.image));
    const updated = (await f.service.updateLook(sample.id, { imageBase64: await picture('#00cc00') })).looks[0];
    expect(updated.referenceImage).toBe(sample.image); expect(updated.source).toBe('sample');
    expect(readFileSync(join(process.cwd(), 'public', sample.image))).toEqual(original);
    expect(new ExhibitionService(f.directory, { now: f.now, strictStorage: true }).get().looks[0]).toEqual(updated);
    f.service.removeLook(sample.id, {}); expect(readdirSync(join(f.directory, 'exhibition-assets'))).toEqual([]);
    expect(readFileSync(join(process.cwd(), 'public', sample.image))).toEqual(original);
  });

  it('preserves legacy prompt-only display edits and requires a new reference before switching modes', async () => {
    const f = await legacy(true);
    const displayed = (await f.service.updateLook(f.look.id, { imageBase64: await picture('#00cc00') })).looks.at(-1)!;
    expect(displayed.referenceKind).toBe('none'); expect(exhibitionReferenceImage(displayed)).toBeNull();
    expect(() => f.service.updateLook(f.look.id, { mode: 'clothx' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_REFERENCE_REQUIRED' }));
    expect(() => f.service.updateLook(f.look.id, { referenceKind: 'image' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_REFERENCE_REQUIRED' }));
    const converted = (await f.service.updateLook(f.look.id, { mode: 'clothx', referenceImageBase64: await picture('#0000cc') })).looks.at(-1)!;
    expect(converted).toMatchObject({ mode: 'clothx', referenceKind: 'image', image: displayed.image });
    expect(exhibitionReferenceImage(converted)).toBe(converted.referenceImage);
    const promptOnly = await f.service.updateLook(f.look.id, { mode: 'free', prompt: '彩虹', referenceKind: 'none' });
    expect(exhibitionReferenceImage(promptOnly.looks.at(-1)!)).toBeNull();
  });

  it('rejects an edit when revision or active phase changes while decoding, retaining all current resources', async () => {
    const f = fixture(); const look = await add(f.service); const replacement = await picture('#00cc00');
    const pending = f.service.updateLook(look.id, { imageBase64: replacement });
    f.service.updateLook(look.id, { name: '并发改名' });
    await expect(pending).rejects.toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
    expect(f.service.get().looks.at(-1)).toEqual({ ...look, name: '并发改名' });
    const entering = f.service.updateLook(look.id, { referenceImageBase64: replacement });
    f.service.command({ action: 'begin' });
    await expect(entering).rejects.toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
    expect(readdirSync(join(f.directory, 'exhibition-assets')).sort()).toEqual(resources(look).map(file).sort());
  });

  it('rolls back the first new resource if writing the second image fails', async () => {
    const f = fixture(); const value = await picture('#00cc00');
    const service = f.service as unknown as { newImage: (...args: unknown[]) => string };
    const write = service.newImage.bind(service); let calls = 0;
    vi.spyOn(service, 'newImage').mockImplementation((...args) => { if (++calls === 2) throw new Error('disk full'); return write(...args); });
    const before = f.service.get();
    await expect(f.service.upload({ name: '双图', imageBase64: value, referenceImageBase64: value })).rejects.toThrow('disk full');
    expect(f.service.get()).toEqual(before); expect(readdirSync(join(f.directory, 'exhibition-assets'))).toEqual([]);
  });

  it('retains the old pair and removes replacements when atomic state commit fails', async () => {
    const f = fixture(); const look = await add(f.service); const before = f.service.get(); const replacement = await picture('#00cc00');
    const stateFile = join(f.directory, 'exhibition.json'); renameSync(stateFile, stateFile + '.saved'); mkdirSync(stateFile);
    await expect(f.service.updateLook(look.id, { imageBase64: replacement, referenceImageBase64: replacement })).rejects.toThrow();
    expect(f.service.get()).toEqual(before);
    expect(readdirSync(join(f.directory, 'exhibition-assets')).sort()).toEqual(resources(look).map(file).sort());
    for (const url of resources(look)) expect(bytes(f.service, url).length).toBeGreaterThan(0);
  });

  it('invalidates reference digests after a replacement and keeps display changes out of XMAX preparation', async () => {
    const f = fixture(); const look = await add(f.service); const hashes: string[] = [];
    f.service.attachLiveService({ status: () => ({ configured: true }), referencePreparationStatus: (_mirror: string, hash: string) => { hashes.push(hash); return { state: 'pending' }; } } as never);
    f.service.referencePreparationStatus(look.id); const originalHash = hashes.at(-1);
    await f.service.updateLook(look.id, { imageBase64: await picture('#00cc00') });
    f.service.referencePreparationStatus(look.id); expect(hashes.at(-1)).toBe(originalHash);
    await f.service.updateLook(look.id, { referenceImageBase64: await picture('#cccc00') });
    f.service.referencePreparationStatus(look.id); expect(hashes.at(-1)).not.toBe(originalHash);
  });

  it('copies both independently, remaps owned URLs, backs up both, and restores a complete snapshot', async () => {
    const f = fixture(); const manager = new ExhibitionMirrors(f.directory, { now: f.now });
    const source = manager.getMirror(); const sourceLook = await add(source);
    const targetId = manager.create({ name: '目标设备' }).id; const target = manager.getMirror(targetId); const previous = await add(target);
    const oldPair = resources(previous).map(url => bytes(target, url));
    const state = manager.copy(targetId, { sourceMirrorId: 'default', copyLooks: true, copySettings: false, expectedRevision: target.get().revision });
    const copied = state.looks.at(-1)!;
    expect(copied.id).not.toBe(sourceLook.id);
    resources(copied).forEach((url, index) => {
      expect(url).toContain(`/mirrors/${targetId}/assets/${copied.id}/`);
      expect(bytes(target, url)).toEqual(bytes(source, resources(sourceLook)[index]));
    });
    const mirrorDirectory = join(f.directory, 'exhibition-mirrors', targetId);
    const backupDirectory = join(mirrorDirectory, 'exhibition-copy-backups');
    const backup = join(backupDirectory, readdirSync(backupDirectory)[0]);
    resources(previous).forEach((url, index) => expect(readFileSync(join(backup, 'exhibition-assets', file(url)))).toEqual(oldPair[index]));
    const restored = new ExhibitionService(backup, { now: f.now, mirrorId: targetId, assetBasePath: `/api/exhibition/mirrors/${targetId}/assets`, strictStorage: true });
    expect(restored.get().looks.at(-1)).toEqual(previous);
    resources(previous).forEach((url, index) => expect(bytes(restored, url)).toEqual(oldPair[index]));
  });
});
