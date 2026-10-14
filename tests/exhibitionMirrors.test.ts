import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionService } from '../server/exhibition.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import type { TryOnService } from '../server/service.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-mirrors-')); directories.push(directory);
  let time = 1_800_000_000_000;
  const now = () => time;
  return { directory, now, advance: (ms: number) => { time += ms; } };
}
async function upload(service: ExhibitionService, name = '独立服装') {
  const image = await sharp({ create: { width: 512, height: 768, channels: 4, background: '#b0a0f088' } }).png().toBuffer();
  return service.upload({ name, category: '通勤', tags: ['简约'], imageBase64: image.toString('base64'), referenceImageBase64: image.toString('base64') });
}
function copy(manager: ExhibitionMirrors, targetId: string, sourceMirrorId = 'default', copyLooks = true, copySettings = true) {
  return manager.copy(targetId, { sourceMirrorId, copyLooks, copySettings, expectedRevision: manager.getMirror(targetId).get().revision });
}
const code = (value: string) => expect.objectContaining({ code: value });

describe('durable exhibition mirror registry', () => {
  it('creates named independent mirrors, keeps IDs stable on rename and reload, and rejects unknown or duplicate names', () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now });
    const second = manager.create({ name: '入口智能镜' });
    expect(second).toMatchObject({ name: '入口智能镜', phase: 'idle', providerMode: 'demo' });
    expect(manager.getMirror().mirrorId).toBe('default');
    expect(manager.list().mirrors).toHaveLength(2);
    const baseline = manager.getMirror(second.id).get();
    manager.getMirror().command({ action: 'select', lookId: 'city' });
    manager.getMirror().command({ action: 'configure', autoReturnSeconds: 180 });
    expect(manager.getMirror(second.id).get()).toEqual(baseline);
    const renamed = manager.rename(second.id, { name: '入口 2 号' });
    expect(renamed).toMatchObject({ id: second.id, name: '入口 2 号', revision: baseline.revision });
    expect(new ExhibitionMirrors(directory, { now }).list()).toEqual(manager.list());
    expect(() => manager.create({ name: '入口 2 号' })).toThrow(code('EXHIBITION_DUPLICATE_MIRROR_NAME'));
    expect(() => manager.rename(second.id, { name: '  ' })).toThrow(code('EXHIBITION_INVALID_MIRROR_NAME'));
    expect(() => manager.getMirror('../default')).toThrow(code('EXHIBITION_MIRROR_NOT_FOUND'));
    expect(() => manager.getMirror('')).toThrow(code('EXHIBITION_MIRROR_NOT_FOUND'));
    expect(manager.list().mirrors.every(mirror => !('looks' in mirror) && !('live' in mirror))).toBe(true);
  });

  it('migrates existing data and files to the default mirror, preserves originals and backup, and rewrites asset URLs once', async () => {
    const { directory, now } = fixture(); const old = new ExhibitionService(directory, { now });
    const uploaded = await upload(old); const garment = uploaded.looks.at(-1)!;
    old.command({ action: 'configure', enabledLookIds: [garment.id, 'evening'], autoReturnSeconds: 180 });
    old.command({ action: 'begin' }); old.command({ action: 'end' });
    const original = readFileSync(join(directory, 'exhibition.json'), 'utf8');
    const image = old.asset(garment.id).data;
    const manager = new ExhibitionMirrors(directory, { now }); const migrated = manager.getMirror().get();
    expect(migrated).toMatchObject({ mirrorId: 'default', selectedLookId: garment.id, enabledLookIds: [garment.id, 'evening'], sessionNumber: 1, settings: { autoReturnSeconds: 180 } });
    expect(migrated.looks.at(-1)!.image).toBe(garment.image.replace('/api/exhibition/assets', '/api/exhibition/mirrors/default/assets'));
    expect(migrated.looks.at(-1)!.referenceImage).toBe(garment.referenceImage!.replace('/api/exhibition/assets', '/api/exhibition/mirrors/default/assets'));
    expect(manager.getMirror().asset(garment.id).data).toEqual(image);
    expect(readFileSync(join(directory, 'exhibition.json'), 'utf8')).toBe(original);
    const backups = readdirSync(directory).filter(name => name.startsWith('exhibition-before-mirrors-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(directory, backups[0], 'exhibition.json'), 'utf8')).toBe(original);
    expect(readFileSync(join(directory, backups[0], 'exhibition-assets', `${garment.id}.display.${garment.image.split('/').at(-1)}.webp`))).toEqual(image);
    expect(new ExhibitionMirrors(directory, { now }).getMirror().get()).toEqual(migrated);
    expect(readdirSync(directory).filter(name => name.startsWith('exhibition-before-mirrors-'))).toHaveLength(1);
  });

  it('retains legacy runtime lease for recovery while moving an active mirror back to selection', () => {
    const { directory, now } = fixture(); const old = new ExhibitionService(directory, { now });
    old.command({ action: 'begin' });
    const file = join(directory, 'exhibition.json'); const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.state.providerMode = 'xmax';
    stored.state.live = { deviceId: 'screen-owner', sessionId: 'old-session', generationNumber: 1, lookId: 'commute', status: 'running', updatedAt: now(), heartbeatAt: now() };
    writeFileSync(file, JSON.stringify(stored));
    const migrated = new ExhibitionMirrors(directory, { now }).getMirror().get();
    expect(migrated).toMatchObject({ phase: 'select', providerMode: 'xmax', live: { sessionId: 'old-session', deviceId: 'screen-owner' } });
  });

  it('preserves registry and directories if registration fails, and refuses to reset damaged registered data', () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now });
    const file = join(directory, 'exhibition-mirrors.json'); const before = manager.list();
    renameSync(file, `${file}.saved`); mkdirSync(file);
    expect(() => manager.create({ name: '不可写入' })).toThrow();
    expect(manager.list()).toEqual(before);
    expect(readdirSync(join(directory, 'exhibition-mirrors'))).toEqual(['default']);
    rmSync(file, { recursive: true }); renameSync(`${file}.saved`, file);
    const dataFile = join(directory, 'exhibition-mirrors', 'default', 'exhibition.json');
    writeFileSync(dataFile, '{damaged');
    expect(() => new ExhibitionMirrors(directory, { now })).toThrow();
    expect(readFileSync(dataFile, 'utf8')).toBe('{damaged');
  });

  it('recovers an interrupted initial install without altering the preserved legacy source', () => {
    const { directory, now } = fixture(); new ExhibitionService(directory, { now });
    const initial = readFileSync(join(directory, 'exhibition.json'), 'utf8');
    const pending = join(directory, 'exhibition-mirrors', 'default'); mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, '.installing'), 'default'); writeFileSync(join(pending, 'exhibition.json'), 'partial');
    expect(new ExhibitionMirrors(directory, { now }).list().mirrors).toHaveLength(1);
    expect(readFileSync(join(directory, 'exhibition.json'), 'utf8')).toBe(initial);
  });
});

describe('independent configuration snapshots', () => {
  it('keeps each mirror idle deadline and log history independent, including a mirror with automatic return disabled', async () => {
    const { directory, now, advance } = fixture(); const manager = new ExhibitionMirrors(directory, { now });
    const a = manager.getMirror(); const b = manager.getMirror(manager.create({ name: '60 秒设备' }).id); const c = manager.getMirror(manager.create({ name: '不自动待机' }).id);
    a.command({ action: 'configure', autoReturnSeconds: 30 });
    b.command({ action: 'configure', autoReturnSeconds: 60 });
    c.command({ action: 'configure', autoReturnSeconds: 0 });
    for (const mirror of [a, b, c]) mirror.command({ action: 'begin' });
    advance(2200); await manager.sweepLive();
    expect([a, b, c].map(mirror => mirror.get().phase)).toEqual(['showcase', 'showcase', 'showcase']);
    const bBefore = b.get(); const cBefore = c.get();
    advance(27800); await manager.sweepLive();
    expect(a.get()).toMatchObject({ phase: 'idle', sessionNumber: 1, generationNumber: 1 });
    expect(a.get().logs[0].message).toContain('自动返回待机');
    expect(b.get()).toEqual(bBefore); expect(c.get()).toEqual(cBefore);
    // Activity on A must not postpone B's deadline or add log rows to another mirror.
    a.command({ action: 'select', lookId: 'city' });
    advance(29999); await manager.sweepLive(); expect(b.get()).toEqual(bBefore);
    advance(1); await manager.sweepLive();
    expect(b.get()).toMatchObject({ phase: 'idle', sessionNumber: 1, generationNumber: 1, revision: bBefore.revision + 1 });
    expect(b.get().logs.slice(1)).toEqual(bBefore.logs);
    expect(c.get()).toEqual(cBefore);
  });

  it('isolates taxonomy, garment metadata and enablement before and after a library copy', () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now });
    const a = manager.getMirror(); const bId = manager.create({ name: '独立衣库' }).id; const b = manager.getMirror(bId);
    const bBefore = b.get();
    a.taxonomy({ categories: [...a.get().categories, '冬装'], tags: [...a.get().tags, '羊毛'] });
    a.updateLook('commute', { name: '冬季通勤', category: '冬装', tags: ['羊毛'] });
    a.command({ action: 'configure', enabledLookIds: ['commute'] });
    a.removeLook('city', {});
    const aBefore = a.get();
    expect(b.get()).toEqual(bBefore);
    expect(() => b.updateLook('commute', { category: '冬装', tags: ['羊毛'] })).toThrow(code('EXHIBITION_UNKNOWN_TAXONOMY'));
    expect(b.get()).toEqual(bBefore);
    copy(manager, bId, 'default', true, false);
    expect(b.get()).toMatchObject({ categories: aBefore.categories, tags: aBefore.tags, enabledLookIds: ['commute'] });
    expect(b.get().looks).toEqual(aBefore.looks);
    b.taxonomy({ categories: [...b.get().categories, '运动'], tags: [...b.get().tags, '速干'] });
    b.updateLook('commute', { name: '目标运动装', category: '运动', tags: ['速干'] });
    b.command({ action: 'configure', enabledLookIds: ['evening', 'commute'] });
    expect(a.get()).toEqual(aBefore);
    const restarted = new ExhibitionMirrors(directory, { now });
    expect(restarted.getMirror().get()).toEqual(aBefore);
    expect(restarted.getMirror(bId).get()).toEqual(b.get());
  });

  it('copies from a source with a running live lease without transferring or stopping that lease', async () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now });
    const a = manager.getMirror(); const bId = manager.create({ name: '目标设备' }).id;
    const stop = vi.fn();
    const liveService = {
      status: () => ({ configured: true }),
      createExhibition: vi.fn(async (_input, hooks) => { hooks.onReserved('source-session'); return { id: 'source-session' }; }),
      get: vi.fn(async () => ({ status: 'active', expiresAt: new Date(now() + 120000).toISOString() })),
      stop,
    } as unknown as TryOnService;
    manager.attachLiveService(liveService);
    a.command({ action: 'configure', providerMode: 'xmax' });
    const active = a.command({ action: 'begin' });
    await a.createLiveSession({ deviceId: 'source-screen', lookId: 'commute', generationNumber: active.generationNumber, expectedRevision: active.revision });
    a.liveFirstFrame('source-session', 800);
    const before = a.get();
    expect(before).toMatchObject({ phase: 'showcase', live: { sessionId: 'source-session', status: 'running' } });
    const result = copy(manager, bId);
    expect(result).toMatchObject({ phase: 'idle', live: null, providerMode: 'xmax', sessionNumber: 0, generationNumber: 0 });
    expect(a.get()).toEqual(before);
    expect(stop).not.toHaveBeenCalled();
    expect(liveService.createExhibition).toHaveBeenCalledOnce();
  });

  it('copies garments into independently deletable files, remaps enabled order and leaves runtime/history with the target', async () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now });
    const source = manager.getMirror(); const second = manager.create({ name: '智能镜 2' }); const target = manager.getMirror(second.id);
    const uploaded = await upload(source, '来源服装'); const original = uploaded.looks.at(-1)!;
    source.command({ action: 'configure', enabledLookIds: [original.id, 'city'], autoReturnSeconds: 240 });
    source.command({ action: 'begin' });
    const oldTarget = target.get(); const sourceState = source.get();
    const result = copy(manager, second.id);
    const cloned = result.looks.find(look => look.source === 'upload')!;
    expect(cloned.id).not.toBe(original.id);
    expect(cloned.image).toMatch(new RegExp(`^/api/exhibition/mirrors/${second.id}/assets/${cloned.id}/display/[a-f0-9-]+$`));
    expect(cloned.referenceImage).toMatch(new RegExp(`^/api/exhibition/mirrors/${second.id}/assets/${cloned.id}/reference/[a-f0-9-]+$`));
    expect(result.enabledLookIds).toEqual([cloned.id, 'city']);
    expect(result).toMatchObject({ mirrorId: second.id, phase: 'idle', sessionNumber: oldTarget.sessionNumber, generationNumber: oldTarget.generationNumber, live: null, settings: { autoReturnSeconds: 240 } });
    expect(result.logs.slice(1)).toEqual(oldTarget.logs);
    expect(source.get()).toEqual(sourceState);
    expect(target.asset(cloned.id).data).toEqual(source.asset(original.id).data);
    expect(() => target.asset(original.id)).toThrow(code('EXHIBITION_ASSET_NOT_FOUND'));
    source.command({ action: 'end' }); source.removeLook(original.id, {});
    expect(target.asset(cloned.id).data.length).toBeGreaterThan(0);
    target.updateLook(cloned.id, { name: '目标独立名称' });
    expect(target.get().looks.find(look => look.id === cloned.id)!.name).toBe('目标独立名称');
    expect(new ExhibitionMirrors(directory, { now }).getMirror(second.id).asset(cloned.id).data).toEqual(target.asset(cloned.id).data);
  });

  it('supports copying only garments or only settings and rejects empty, stale, self and busy copies', async () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now });
    const targetId = manager.create({ name: '复制目标' }).id; const source = manager.getMirror(); const target = manager.getMirror(targetId);
    await upload(source); source.command({ action: 'configure', autoReturnSeconds: 240 });
    const originalLooks = target.get().looks;
    expect(copy(manager, targetId, 'default', false, true).looks).toEqual(originalLooks);
    target.command({ action: 'configure', autoReturnSeconds: 60 });
    expect(copy(manager, targetId, 'default', true, false)).toMatchObject({ settings: { autoReturnSeconds: 60 } });
    expect(() => manager.copy(targetId, { sourceMirrorId: 'default', copyLooks: true, copySettings: true })).toThrow(code('EXHIBITION_INVALID_COPY'));
    expect(() => copy(manager, targetId, 'default', false, false)).toThrow(code('EXHIBITION_INVALID_COPY'));
    expect(() => copy(manager, targetId, targetId)).toThrow(code('EXHIBITION_INVALID_COPY'));
    expect(() => manager.copy(targetId, { sourceMirrorId: 'default', copyLooks: true, copySettings: true, expectedRevision: 0 })).toThrow(code('EXHIBITION_STALE_REVISION'));
    target.command({ action: 'begin' });
    expect(() => copy(manager, targetId)).toThrow(code('EXHIBITION_INVALID_PHASE'));
  });

  it('rolls back copied files when the final state commit fails and preserves the previous target asset', async () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now });
    await upload(manager.getMirror()); const targetId = manager.create({ name: '目标' }).id; const target = manager.getMirror(targetId);
    const old = await upload(target, '原目标素材'); const oldAsset = old.looks.at(-1)!; const bytes = target.asset(oldAsset.id).data;
    const targetDir = join(directory, 'exhibition-mirrors', targetId); const file = join(targetDir, 'exhibition.json');
    const originalFiles = readdirSync(join(targetDir, 'exhibition-assets'));
    renameSync(file, `${file}.saved`); mkdirSync(file);
    expect(() => copy(manager, targetId)).toThrow();
    expect(target.get()).toEqual(old); expect(target.asset(oldAsset.id).data).toEqual(bytes);
    expect(readdirSync(join(targetDir, 'exhibition-assets'))).toEqual(originalFiles);
    rmSync(file, { recursive: true }); renameSync(`${file}.saved`, file);
    expect(new ExhibitionMirrors(directory, { now }).getMirror(targetId).get()).toEqual(old);
  });

  it('removes already copied files when a later source asset is missing', async () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now }); const source = manager.getMirror();
    await upload(source, '有效图片'); const state = await upload(source, '缺失图片'); const missing = state.looks.at(-1)!;
    rmSync(join(directory, 'exhibition-mirrors', 'default', 'exhibition-assets', `${missing.id}.reference.${missing.referenceImage!.split('/').at(-1)}.webp`));
    const targetId = manager.create({ name: '目标' }).id; const before = manager.getMirror(targetId).get();
    expect(() => copy(manager, targetId)).toThrow(code('EXHIBITION_ASSET_NOT_FOUND'));
    expect(manager.getMirror(targetId).get()).toEqual(before);
    expect(readdirSync(join(directory, 'exhibition-mirrors', targetId, 'exhibition-assets'))).toEqual([]);
  });

  it('applies the two-upload resource limit across mirrors and prevents replacing a library during an upload', async () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now });
    const b = manager.create({ name: 'B' }).id; const c = manager.create({ name: 'C' }).id;
    const image = await sharp({ create: { width: 512, height: 768, channels: 4, background: '#fff' } }).png().toBuffer();
    const input = { name: '素材', category: '通勤', tags: [], imageBase64: image.toString('base64'), referenceImageBase64: image.toString('base64') };
    const first = manager.getMirror().upload(input); const second = manager.getMirror(b).upload(input); const third = manager.getMirror(c).upload(input);
    expect(() => copy(manager, b)).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    const results = await Promise.allSettled([first, second, third]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(results[2]).toMatchObject({ reason: { code: 'EXHIBITION_UPLOAD_BUSY' } });
    await expect(manager.getMirror(c).upload(input)).resolves.toMatchObject({ mirrorId: c });
  });

  it('sweeps every mirror even when one mirror cleanup rejects', async () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now }); const b = manager.create({ name: 'B' }).id;
    const failed = vi.spyOn(manager.getMirror(), 'sweepLive').mockRejectedValue(new Error('stop failure'));
    const good = vi.spyOn(manager.getMirror(b), 'sweepLive').mockResolvedValue(undefined);
    await expect(manager.sweepLive()).resolves.toBeUndefined();
    expect(failed).toHaveBeenCalledOnce(); expect(good).toHaveBeenCalledOnce();
    const service = { status: () => ({ configured: true }) } as TryOnService;
    manager.attachLiveService(service);
    expect(manager.getMirror(b).liveStatus().configured).toBe(true);
    const newId = manager.create({ name: 'C' }).id;
    expect(manager.getMirror(newId).liveStatus().configured).toBe(true);
  });
});
