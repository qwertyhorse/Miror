import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { ExhibitionService } from '../server/exhibition.ts';
import { EXHIBITION_EXPERIENCE_MODES, type ExhibitionExperienceMode } from '../shared/exhibition.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-copy-backup-')); directories.push(directory);
  const now = () => 1_800_000_000_000;
  const manager = new ExhibitionMirrors(directory, { now });
  const targetId = manager.create({ name: '备份目标' }).id;
  const targetDirectory = join(directory, 'exhibition-mirrors', targetId);
  const source = manager.getMirror(); const target = manager.getMirror(targetId);
  const backupsDirectory = join(targetDirectory, 'exhibition-copy-backups');
  const copy = (copyLooks = true, copySettings = true) => manager.copy(targetId, {
    sourceMirrorId: 'default', copyLooks, copySettings, expectedRevision: target.get().revision,
  });
  const backups = () => existsSync(backupsDirectory) ? readdirSync(backupsDirectory).filter(name => name.startsWith('before-copy-')).map(name => join(backupsDirectory, name)) : [];
  return { directory, now, manager, targetId, targetDirectory, source, target, backupsDirectory, copy, backups };
}
async function add(service: ExhibitionService, mode: ExhibitionExperienceMode = 'clothx') {
  const image = await sharp({ create: { width: 512, height: 768, channels: 4, background: '#ac8de088' } }).png().toBuffer();
  const result = await service.upload({ name: `${mode} 原始素材`, description: `${mode} 描述`, mode, category: '通勤', tags: ['简约'],
    ...(mode === 'free' ? { prompt: '雨后的城市，人物身后出现彩虹，保持人物面部和动作。', referenceKind: 'image' } : {}), imageBase64: image.toString('base64'), referenceImageBase64: image.toString('base64') });
  return result.looks.at(-1)!;
}
const assetFile = (image: string) => image.split('/').slice(-3).join('.') + '.webp';
const assetFiles = (look: { image: string; referenceImage?: string }) => [assetFile(look.image), ...(look.referenceImage ? [assetFile(look.referenceImage)] : [])];
const code = (value: string) => expect.objectContaining({ code: value });

describe('recoverable snapshots before mirror copy', () => {
  it('backs up the complete target state, all mode assets and skin, and can reload the snapshot after replacement', async () => {
    const f = fixture();
    const originals = [];
    for (const mode of EXHIBITION_EXPERIENCE_MODES) originals.push(await add(f.target, mode));
    const ids = originals.map(look => look.id);
    const clothIds = f.target.get().looks.filter(look => look.mode === 'clothx').map(look => look.id).reverse();
    f.target.command({ action: 'reorder', experienceMode: 'clothx', lookIds: clothIds, expectedRevision: f.target.get().revision });
    f.target.command({ action: 'configure', experienceMode: 'free', enabledLookIds: [...ids].reverse(), switchMode: 'auto', autoSwitchSeconds: 45, autoReturnSeconds: 180 });
    const skinImage = await sharp({ create: { width: 360, height: 640, channels: 4, background: '#e8dcffaa' } }).png().toBuffer();
    const before = await f.target.uploadUiSkin({ imageBase64: skinImage.toString('base64'), expectedRevision: f.target.get().revision });
    const snapshot = JSON.parse(readFileSync(join(f.targetDirectory, 'exhibition.json'), 'utf8'));
    const originalBytes = new Map(originals.map(look => [look.id, f.target.asset(look.id).data]));
    const skin = before.settings.uiSkin!; const skinId = skin.image.split('/').at(-1)!; const skinBytes = f.target.uiSkinAsset(skinId).data;
    const sourceBefore = f.source.get();
    const result = f.copy();
    expect(result.looks).toEqual(sourceBefore.looks); expect(result.settings.uiSkin).toBeNull();
    expect(f.source.get()).toEqual(sourceBefore);
    const [backup] = f.backups(); expect(f.backups()).toHaveLength(1);
    expect(readdirSync(f.backupsDirectory)).toHaveLength(1); // No published partial staging snapshot.
    expect(JSON.parse(readFileSync(join(backup, 'exhibition.json'), 'utf8'))).toEqual(snapshot);
    expect(JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, reason: 'before-copy', createdAt: f.now(),
      sourceMirrorId: 'default', targetMirrorId: f.targetId, revision: before.revision, copyLooks: true, copySettings: true });
    expect(result.logs[0].message).toBe('设备数据已复制，复制前数据已备份。');
    for (const look of originals) {
      expect(readFileSync(join(backup, 'exhibition-assets', assetFile(look.image)))).toEqual(originalBytes.get(look.id));
      expect(existsSync(join(f.targetDirectory, 'exhibition-assets', assetFile(look.image)))).toBe(false);
      expect(readFileSync(join(backup, 'exhibition-assets', assetFile(look.referenceImage!)))).toEqual(originalBytes.get(look.id));
      expect(existsSync(join(f.targetDirectory, 'exhibition-assets', assetFile(look.referenceImage!)))).toBe(false);
    }
    expect(readFileSync(join(backup, 'exhibition-skins', `${skinId}.webp`))).toEqual(skinBytes);
    const restoreDirectory = join(f.directory, 'restore-check'); cpSync(backup, restoreDirectory, { recursive: true });
    const restored = new ExhibitionService(restoreDirectory, { now: f.now, mirrorId: f.targetId, assetBasePath: `/api/exhibition/mirrors/${f.targetId}/assets`, strictStorage: true });
    expect(restored.get()).toEqual(before);
    expect(restored.get().looks.find(look => look.mode === 'free')).toMatchObject({ referenceKind: 'image', prompt: originals.find(look => look.mode === 'free')!.prompt });
    for (const look of originals) expect(restored.asset(look.id).data).toEqual(originalBytes.get(look.id));
    expect(restored.uiSkinAsset(skinId).data).toEqual(skinBytes);
  });

  it('retains independent snapshots even for repeated settings-only copies at the same time', async () => {
    const f = fixture(); const look = await add(f.target, 'free');
    const before = f.target.get(); const bytes = f.target.asset(look.id).data;
    f.copy(false, true); f.copy(false, true);
    expect(f.backups()).toHaveLength(2); expect(new Set(f.backups()).size).toBe(2);
    const snapshots = f.backups().map(path => JSON.parse(readFileSync(join(path, 'exhibition.json'), 'utf8')));
    expect(snapshots.some(snapshot => snapshot.state.revision === before.revision)).toBe(true);
    for (const path of f.backups()) expect(readFileSync(join(path, 'exhibition-assets', assetFile(look.image)))).toEqual(bytes);
    expect(f.target.get().looks).toEqual(before.looks);
  });

  it('blocks copying when the backup destination is unwritable and preserves state and all original files', async () => {
    const f = fixture(); const old = await add(f.target); await add(f.source);
    const before = f.target.get(); const persisted = readFileSync(join(f.targetDirectory, 'exhibition.json'));
    const bytes = f.target.asset(old.id).data;
    writeFileSync(f.backupsDirectory, 'blocked backup directory');
    expect(() => f.copy()).toThrow(code('EXHIBITION_COPY_BACKUP_FAILED'));
    expect(f.target.get()).toEqual(before); expect(readFileSync(join(f.targetDirectory, 'exhibition.json'))).toEqual(persisted);
    expect(f.target.asset(old.id).data).toEqual(bytes);
    expect(readdirSync(join(f.targetDirectory, 'exhibition-assets')).sort()).toEqual(assetFiles(old).sort());
    expect(readFileSync(f.backupsDirectory, 'utf8')).toBe('blocked backup directory');
  });

  it('removes partial staging snapshots and refuses to replace a library if one original asset cannot be backed up', async () => {
    const f = fixture(); const first = await add(f.target); const missing = await add(f.target, 'free');
    const before = f.target.get(); const bytes = f.target.asset(first.id).data;
    rmSync(join(f.targetDirectory, 'exhibition-assets', assetFile(missing.image)));
    expect(() => f.copy()).toThrow(code('EXHIBITION_COPY_BACKUP_FAILED'));
    expect(f.target.get()).toEqual(before); expect(f.target.asset(first.id).data).toEqual(bytes);
    expect(readdirSync(f.backupsDirectory)).toEqual([]);
    expect(readdirSync(join(f.targetDirectory, 'exhibition-assets')).sort()).toEqual([...assetFiles(first), assetFile(missing.referenceImage!)].sort());
  });

  it('keeps a complete recovery snapshot when the later state commit fails', async () => {
    const f = fixture(); const old = await add(f.target, 'free'); await add(f.source);
    const before = f.target.get(); const bytes = f.target.asset(old.id).data; const file = join(f.targetDirectory, 'exhibition.json');
    const originalState = JSON.parse(readFileSync(file, 'utf8')).state;
    renameSync(file, `${file}.saved`); mkdirSync(file);
    expect(() => f.copy()).toThrow();
    expect(f.target.get()).toEqual(before); expect(f.target.asset(old.id).data).toEqual(bytes);
    expect(readdirSync(join(f.targetDirectory, 'exhibition-assets')).sort()).toEqual(assetFiles(old).sort());
    const [backup] = f.backups(); expect(f.backups()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(backup, 'exhibition.json'), 'utf8')).state).toEqual(originalState);
    expect(readFileSync(join(backup, 'exhibition-assets', assetFile(old.image)))).toEqual(bytes);
  });

  it('does not create backups for rejected stale or active-experience copies', () => {
    const f = fixture();
    expect(() => f.manager.copy(f.targetId, { sourceMirrorId: 'default', copyLooks: true, copySettings: false, expectedRevision: 0 })).toThrow(code('EXHIBITION_STALE_REVISION'));
    f.target.command({ action: 'begin' });
    expect(() => f.copy()).toThrow(code('EXHIBITION_INVALID_PHASE'));
    expect(existsSync(f.backupsDirectory)).toBe(false);
  });
});
