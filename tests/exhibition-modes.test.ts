import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTINUOUS_SEGMENT_CREDITS } from '../shared/sessionLimits';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionService } from '../server/exhibition.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { KeyStatus, Provider } from '../server/types.ts';
import { EXHIBITION_EXPERIENCE_MODES, exhibitionPromptForLook, type ExhibitionExperienceMode } from '../shared/exhibition.ts';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-six-modes-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1_800_000_000_000;
  const now = () => time;
  const service = new ExhibitionService(directory, { now });
  return { directory, service, now, advance: (ms: number) => { time += ms; } };
}
function liveFixture() {
  const base = fixture(); const store = new SessionStore(':memory:'); cleanup.push(() => store.close());
  const keys = new Map<string, KeyStatus>();
  const issue = vi.fn(async () => {
    const token = `tk-test-mode-${keys.size}`; const expiresAt = new Date(base.now() + 120000).toISOString();
    keys.set(token, { status: 'active', consumedCredit: 0, expireTimestamp: expiresAt });
    return { token, expiresAt };
  });
  const provider: Provider = { configured: true, issueKey: issue, keyStatus: async token => keys.get(token)!,
    deactivate: async token => { const status = { ...keys.get(token)!, status: 'inactive' as const }; keys.set(token, status); return status; },
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'ACTIVE', consumedCredit: 1 }) };
  const live = new LifecycleTryOnService({ store, provider, secrets: new SecretBox(randomBytes(32)), catalog: async () => [], resolveHost: async () => ['8.8.8.8'] });
  base.service.attachLiveService(live);
  return { ...base, live, store, issue, provider };
}
const code = (value: string) => expect.objectContaining({ code: value });
function setMode(service: ExhibitionService, mode: ExhibitionExperienceMode) { return service.command({ action: 'configure', experienceMode: mode }); }
function setLookMode(service: ExhibitionService, id: string, mode: ExhibitionExperienceMode, prompt?: string) { return service.updateLook(id, { mode, prompt }); }
function create(service: ExhibitionService, extra = {}) {
  const state = service.get();
  return service.createLiveSession({ deviceId: 'screen-mode-test', lookId: state.selectedLookId, generationNumber: state.generationNumber, ...extra });
}

describe('exhibition six-mode catalogue and migration', () => {
  it('backs up schema 2 once and preserves old category, tags, assets, order and settings as ClothX', () => {
    const { directory, service, now } = fixture();
    service.command({ action: 'configure', enabledLookIds: ['city', 'evening'], autoReturnSeconds: 45 });
    const path = join(directory, 'exhibition.json'); const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.schemaVersion = 2; delete raw.state.experienceMode;
    for (const look of raw.state.looks) delete look.mode;
    const original = JSON.stringify(raw); writeFileSync(path, original);
    const migrated = new ExhibitionService(directory, { now, strictStorage: true }).get();
    expect(migrated).toMatchObject({ experienceMode: 'clothx', selectedLookId: 'city', enabledLookIds: ['city', 'evening'], settings: { autoReturnSeconds: 45 } });
    expect(migrated.looks).toEqual(raw.state.looks.map((look: object) => ({ ...look, mode: 'clothx' })));
    expect(readFileSync(`${path}.before-six-modes.json`, 'utf8')).toBe(original);
    expect(new ExhibitionService(directory, { now, strictStorage: true }).get()).toEqual(migrated);
    expect(readFileSync(`${path}.before-six-modes.json`, 'utf8')).toBe(original);
  });

  it('fails closed on invalid persisted modes and missing Free prompts without overwriting data', () => {
    const { directory, now } = fixture(); const path = join(directory, 'exhibition.json');
    const original = JSON.parse(readFileSync(path, 'utf8'));
    for (const patch of [{ mode: 'unknown' }, { mode: 'free', prompt: '' }, { referenceKind: 'none' }, { mode: 'free', prompt: 'test', referenceKind: 'unknown' }]) {
      const invalid = structuredClone(original); Object.assign(invalid.state.looks[0], patch);
      const contents = JSON.stringify(invalid); writeFileSync(path, contents);
      expect(() => new ExhibitionService(directory, { now, strictStorage: true })).toThrow('Invalid exhibition mirror data');
      expect(readFileSync(path, 'utf8')).toBe(contents);
    }
  });

  it('supports an empty current mode, empty enabled list, and deletion of the final material across restarts', () => {
    const { directory, service, now } = fixture();
    expect(setMode(service, 'mox')).toMatchObject({ phase: 'idle', experienceMode: 'mox', selectedLookId: null });
    expect(() => service.command({ action: 'begin' })).toThrow(code('EXHIBITION_NO_ENABLED_LOOKS'));
    expect(() => service.command({ action: 'select', lookId: 'commute' })).toThrow(code('EXHIBITION_INVALID_LOOK'));
    expect(new ExhibitionService(directory, { now, strictStorage: true }).get()).toEqual(service.get());
    expect(setMode(service, 'clothx').selectedLookId).toBe('commute');
    expect(service.command({ action: 'configure', enabledLookIds: [] })).toMatchObject({ phase: 'idle', selectedLookId: null });
    for (const look of service.get().looks) service.removeLook(look.id, {});
    expect(service.get()).toMatchObject({ looks: [], enabledLookIds: [], selectedLookId: null, phase: 'idle' });
    expect(new ExhibitionService(directory, { now, strictStorage: true }).get()).toEqual(service.get());
    expect(() => service.command({ action: 'begin' })).toThrow(code('EXHIBITION_NO_ENABLED_LOOKS'));
  });

  it('limits select, switch, previous and next to the active mode intersected with enabled materials', () => {
    const { service, advance } = fixture();
    setLookMode(service, 'city', 'charx'); setMode(service, 'clothx');
    expect(() => service.command({ action: 'select', lookId: 'city' })).toThrow(code('EXHIBITION_INVALID_LOOK'));
    service.command({ action: 'begin' }); advance(2200);
    expect(() => service.command({ action: 'switch', lookId: 'city' })).toThrow(code('EXHIBITION_INVALID_LOOK'));
    expect(service.command({ action: 'next' }).selectedLookId).toBe('evening'); advance(2200);
    expect(service.command({ action: 'previous' }).selectedLookId).toBe('commute');
    expect(() => setMode(service, 'charx')).toThrow(code('EXHIBITION_INVALID_PHASE'));
    service.command({ action: 'end' });
    expect(setMode(service, 'charx')).toMatchObject({ phase: 'idle', selectedLookId: 'city' });
    service.command({ action: 'begin' }); advance(2200);
    const before = service.get(); expect(service.command({ action: 'next' })).toEqual(before);
    expect(service.command({ action: 'previous' })).toEqual(before);
  });

  it('reconciles selection when a material moves mode or is disabled/deleted', () => {
    const { service } = fixture();
    expect(setLookMode(service, 'commute', 'vibex').selectedLookId).toBe('city');
    expect(setMode(service, 'vibex').selectedLookId).toBe('commute');
    expect(service.command({ action: 'configure', enabledLookIds: ['city', 'evening'] })).toMatchObject({ selectedLookId: null, phase: 'idle' });
    expect(service.command({ action: 'configure', enabledLookIds: ['commute'] }).selectedLookId).toBe('commute');
    expect(service.removeLook('commute', {})).toMatchObject({ selectedLookId: null, enabledLookIds: [], phase: 'idle' });
  });

  it('requires a bounded Free prompt and ignores custom prompts for the five presets', () => {
    const { service } = fixture(); const baseline = service.get();
    for (const prompt of [undefined, '', '  ', 'a'.repeat(1001), 'unsafe\u0000prompt']) {
      expect(() => setLookMode(service, 'commute', 'free', prompt)).toThrow(code('EXHIBITION_INVALID_PROMPT'));
      expect(service.get()).toEqual(baseline);
    }
    const free = setLookMode(service, 'commute', 'free', '  头发变成银色\n保留人物表情  ').looks[0];
    expect(free).toMatchObject({ mode: 'free', prompt: '头发变成银色\n保留人物表情', category: '通勤', tags: ['简约'] });
    const charx = setLookMode(service, 'commute', 'charx', 'arbitrary override').looks[0];
    expect(charx.prompt).toBeUndefined(); expect(exhibitionPromptForLook(charx)).toBe('视频中角色替换成参考图中角色');
    expect(() => service.updateLook('commute', { mode: 'unknown' })).toThrow(code('EXHIBITION_INVALID_MODE'));
  });

  it('uploads new-mode materials without legacy taxonomy and puts them on shelf', async () => {
    const { service, directory, now } = fixture();
    const imageBase64 = (await sharp({ create: { width: 512, height: 512, channels: 4, background: '#9999ff' } }).png().toBuffer()).toString('base64');
    const state = await service.upload({ name: '拖拽场景', mode: 'mox', imageBase64, referenceImageBase64: imageBase64 });
    const look = state.looks[0]!;
    expect(look).toMatchObject({ name: '拖拽场景', mode: 'mox', tags: [] }); expect(state.enabledLookIds).toContain(look.id);
    expect(new ExhibitionService(directory, { now, strictStorage: true }).get()).toEqual(state);
    await expect(service.upload({ name: '自定义', mode: 'free', imageBase64 })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PROMPT' });
    expect(readdirSync(join(directory, 'exhibition-assets')).sort()).toEqual([`${look.id}.display.${look.image.split('/').at(-1)}.webp`, `${look.id}.reference.${look.referenceImage!.split('/').at(-1)}.webp`].sort());
  });

  it('preserves legacy prompt-only Free covers and requires a reference when moving to image modes', async () => {
    const original = fixture(); const { directory, now } = original;
    const imageBase64 = (await sharp({ create: { width: 512, height: 512, channels: 4, background: '#554477' } }).png().toBuffer()).toString('base64');
    const state = await original.service.upload({ name: '水彩画', mode: 'free', prompt: '视频变成水彩画', imageBase64, referenceImageBase64: imageBase64 });
    const uploaded = state.looks[0]!;
    // Reconstruct a persisted single-image catalog from before dual-image uploads.
    const path = join(directory, 'exhibition.json'); const stored = JSON.parse(readFileSync(path, 'utf8'));
    const legacy = stored.state.looks[0];
    renameSync(join(directory, 'exhibition-assets', `${uploaded.id}.display.${uploaded.image.split('/').at(-1)}.webp`), join(directory, 'exhibition-assets', `${uploaded.id}.webp`));
    rmSync(join(directory, 'exhibition-assets', `${uploaded.id}.reference.${uploaded.referenceImage!.split('/').at(-1)}.webp`));
    legacy.image = `/api/exhibition/assets/${uploaded.id}`; legacy.referenceKind = 'none';
    delete legacy.referenceImage; delete legacy.referenceImageInfo;
    writeFileSync(path, JSON.stringify(stored));
    const service = new ExhibitionService(directory, { now, strictStorage: true }); const cover = service.get().looks[0]!;
    expect(cover).toMatchObject({ mode: 'free', referenceKind: 'none', source: 'upload' });
    expect(service.asset(cover.id).data.length).toBeGreaterThan(0);
    expect((await service.updateLook(cover.id, { name: '水彩效果' })).looks[0]).toMatchObject({ name: '水彩效果', referenceKind: 'none' });
    expect(new ExhibitionService(directory, { now, strictStorage: true }).get()).toEqual(service.get());
    await expect(Promise.resolve().then(() => service.updateLook(cover.id, { mode: 'charx' }))).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_REQUIRED' });
    await expect(service.upload({ name: '角色', mode: 'charx', referenceKind: 'none', imageBase64, referenceImageBase64: imageBase64 })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_REFERENCE' });
    await expect(service.upload({ name: '水彩', mode: 'free', prompt: '水彩画', referenceKind: 'none', imageBase64 })).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_REQUIRED' });
    expect((await service.updateLook(cover.id, { mode: 'charx', referenceImageBase64: imageBase64 })).looks[0]).toMatchObject({ mode: 'charx', referenceKind: 'image' });
  });

  it('copies mode and prompts with materials, copies current mode with settings, and never selects another mode', () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(join(directory, 'registry'), { now });
    const source = manager.getMirror(); const targetId = manager.create({ name: '另一个镜子' }).id; const target = manager.getMirror(targetId);
    setLookMode(source, 'city', 'free', '变为水彩'); setMode(source, 'free');
    const copy = (copyLooks: boolean, copySettings: boolean) => manager.copy(targetId, { sourceMirrorId: 'default', copyLooks, copySettings, expectedRevision: target.get().revision });
    expect(copy(false, true)).toMatchObject({ experienceMode: 'free', selectedLookId: null, phase: 'idle' });
    const copied = copy(true, false); expect(copied).toMatchObject({ experienceMode: 'free', selectedLookId: 'city' });
    expect(copied.looks.find(look => look.id === 'city')).toMatchObject({ mode: 'free', prompt: '变为水彩' });
    setLookMode(target, 'city', 'free', '变为素描'); expect(source.get().looks[1].prompt).toBe('变为水彩');
    source.command({ action: 'begin' }); expect(copy(true, true)).toMatchObject({ phase: 'idle', experienceMode: 'free', selectedLookId: 'city', sessionNumber: 0, live: null });
    expect(source.get().phase).toBe('generating');
    source.command({ action: 'end' }); source.command({ action: 'configure', enabledLookIds: [] });
    for (const look of source.get().looks) source.removeLook(look.id, {});
    expect(copy(true, true)).toMatchObject({ looks: [], enabledLookIds: [], selectedLookId: null, experienceMode: 'free' });
    expect(new ExhibitionMirrors(join(directory, 'registry'), { now }).getMirror(targetId).get()).toEqual(target.get());
  });
});

describe('authoritative exhibition mode session snapshots', () => {
  it('creates and links prompt-only Free sessions without using or binding their cover', async () => {
    const { service, live, store, issue } = liveFixture();
    service.updateLook('commute', { mode: 'free', prompt: '视频变成水彩画', referenceKind: 'none' });
    service.command({ action: 'configure', providerMode: 'xmax', experienceMode: 'free', autoReturnSeconds: 0 });
    service.command({ action: 'begin' });
    const session = await create(service);
    expect(session).toMatchObject({ referenceAsset: '', refImageUrl: '', referenceVersion: 0, exhibition: { mode: 'free', prompt: '视频变成水彩画' } });
    await expect(service.bindLiveReference(session.id, { deviceId: 'screen-mode-test', lookId: 'commute', refImageUrl: 'https://uploads.example/cover.webp' })).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_NOT_REQUIRED' });
    const linked = await live.link(session.id, 'ums-free-prompt-only');
    expect(linked).toMatchObject({ referenceAsset: '', refImageUrl: '', referenceVersion: 0, providerSessionId: 'ums-free-prompt-only' });
    await live.firstFrame(session.id, 150); service.liveFirstFrame(session.id, 150);
    expect(service.get()).toMatchObject({ phase: 'showcase', displayedLookId: 'commute' });
    expect(issue).toHaveBeenCalledTimes(1); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('rejects missing references outside explicitly prompt-only Free sessions before reserving credits', async () => {
    const { live, issue, store } = liveFixture();
    const input = { lookId: 'commute', deviceId: 'screen-mode-test', name: '素材', referenceAsset: '', prompt: '视频变成水彩画', sessionNumber: 1, generationNumber: 1 };
    await expect(live.createExhibition({ ...input, mode: 'free' })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_REFERENCE' });
    await expect(live.createExhibition({ ...input, mode: 'clothx', referenceKind: 'none' })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_REFERENCE' });
    await expect(live.createExhibition({ ...input, mode: 'free', referenceKind: 'none', referenceAsset: '/assets/exhibition/commute-cutout.png' })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_REFERENCE' });
    expect(issue).not.toHaveBeenCalled(); expect(store.allocated()).toBe(0);
  });

  it.each(EXHIBITION_EXPERIENCE_MODES)('snapshots %s inputs before issuance and retains reference binding and first-frame evidence', async mode => {
    const { service, live, store, issue } = liveFixture();
    setLookMode(service, 'commute', mode, mode === 'free' ? '人物变成水彩画' : undefined);
    service.command({ action: 'configure', providerMode: 'xmax', experienceMode: mode, autoReturnSeconds: 0 });
    service.command({ action: 'begin' });
    const session = await create(service, { mode: 'free', prompt: 'untrusted client prompt' });
    expect(session).toMatchObject({ sourceKind: mode === 'mox' ? 'photo' : 'camera', exhibition: { mode, prompt: exhibitionPromptForLook(service.get().looks[0]), mirrorId: 'default' } });
    expect(session.exhibition?.prompt).not.toBe('untrusted client prompt');
    expect(store.get(session.id).exhibition).toEqual(session.exhibition); expect(issue).toHaveBeenCalledTimes(1); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
    await live.link(session.id, `ums-${mode}`); await live.firstFrame(session.id, 200); service.liveFirstFrame(session.id, 200);
    expect(service.get()).toMatchObject({ phase: 'showcase', displayedLookId: 'commute' });
    await live.link(session.id, `ums-${mode}`); expect(issue).toHaveBeenCalledTimes(1); expect(store.allocated()).toBe(CONTINUOUS_SEGMENT_CREDITS);
  });

  it('rejects a different-mode live material and empty modes without allocating credits', async () => {
    const { service, issue, store } = liveFixture(); setLookMode(service, 'city', 'charx');
    service.command({ action: 'configure', providerMode: 'xmax' }); service.command({ action: 'begin' });
    await expect(create(service, { lookId: 'city' })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_LOOK' });
    service.command({ action: 'end' }); setMode(service, 'mox');
    expect(() => service.command({ action: 'begin' })).toThrow(code('EXHIBITION_NO_ENABLED_LOOKS'));
    await expect(create(service)).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' });
    expect(issue).not.toHaveBeenCalled(); expect(store.allocated()).toBe(0);
  });

  it('does not change mode while any live lease is stopping, and resumes MoX with a new photo generation', async () => {
    const { service, provider, store, issue } = liveFixture(); setLookMode(service, 'commute', 'mox');
    service.command({ action: 'configure', providerMode: 'xmax', experienceMode: 'mox' }); service.command({ action: 'begin' });
    const session = await create(service); const generation = service.get().generationNumber;
    service.command({ action: 'pause' }); await service.reconcileLive();
    service.command({ action: 'resume' }); const resumed = await create(service);
    expect(resumed).toMatchObject({ sourceKind: 'photo', exhibition: { mode: 'mox', generationNumber: generation + 1 } });
    expect(resumed.id).not.toBe(session.id); expect(store.get(session.id).status).toBe('stopped'); expect(issue).toHaveBeenCalledTimes(2);
    provider.deactivate = async () => { throw new Error('stop pending'); };
    service.command({ action: 'end' }); await service.reconcileLive(); const before = service.get();
    expect(() => setMode(service, 'charx')).toThrow(code('EXHIBITION_MIRROR_BUSY')); expect(service.get()).toEqual(before);
    expect(store.allocated()).toBe(2 * CONTINUOUS_SEGMENT_CREDITS);
  });
});
