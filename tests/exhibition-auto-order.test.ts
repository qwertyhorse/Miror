import { withLifecycleReferenceDelivery } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionService } from '../server/exhibition.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import type { TryOnService } from '../server/service.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-auto-order-')); directories.push(directory);
  let time = 1_800_000_000_000;
  const now = () => time;
  const service = new ExhibitionService(directory, { now });
  return { service, directory, now, advance: (ms: number) => { time += ms; } };
}
const errorCode = (code: string) => expect.objectContaining({ code });
function automatic(service: ExhibitionService, seconds = 5) {
  return service.command({ action: 'configure', switchMode: 'auto', autoSwitchSeconds: seconds });
}
function showcase(service: ExhibitionService, advance: (ms: number) => void) {
  service.command({ action: 'begin' }); advance(2_200); return service.get();
}
function liveFixture() {
  const f = fixture();
  const sessions = new Map<string, { id: string; status: 'active' | 'stopping' | 'stopped'; expiresAt: string; pointsLimit: number; consumedCredits: number; exhibition: { sessionNumber: number } }>();
  const create = vi.fn(async (input, hooks) => {
    const id = `session-${sessions.size + 1}`;
    const session = { id, status: 'active' as const, expiresAt: new Date(f.now() + 120_000).toISOString(), pointsLimit: 30, consumedCredits: 0, exhibition: { sessionNumber: input.sessionNumber } };
    sessions.set(id, session); hooks.onReserved(id); return session;
  });
  const get = vi.fn(async (id: string) => structuredClone(sessions.get(id)!));
  const stop = vi.fn(async (id: string) => { const session = sessions.get(id)!; session.status = 'stopped'; return structuredClone(session); });
  const cancelExhibitionSession = (id: string) => { const session = sessions.get(id)!; if (session.status !== 'stopped') session.status = 'stopping'; };
  const liveService = withLifecycleReferenceDelivery({ status: () => ({ configured: true }), createExhibition: create, get, stop, cancelExhibitionSession } as unknown as TryOnService);
  f.service.attachLiveService(liveService);
  f.service.command({ action: 'configure', providerMode: 'xmax', switchMode: 'auto', autoSwitchSeconds: 5 });
  const createSession = () => f.service.createLiveSession({ deviceId: 'auto-screen-001', lookId: f.service.get().selectedLookId, generationNumber: f.service.get().generationNumber });
  return { ...f, sessions, create, get, stop, createSession };
}

describe('automatic material switching', () => {
  it('waits for an explicit start and a full result interval, preserves the round, and loops in saved order', () => {
    const { service, advance, now } = fixture();
    service.command({ action: 'reorder', experienceMode: 'clothx', lookIds: ['evening', 'commute', 'city'] });
    automatic(service);
    advance(10_000); expect(service.get()).toMatchObject({ phase: 'select', autoSwitchAt: null, generationNumber: 0 });
    const result = showcase(service, advance);
    expect(result).toMatchObject({ selectedLookId: 'commute', displayedLookId: 'commute', autoSwitchAt: now() + 5_000 });
    advance(4_999); expect(service.get()).toEqual(result);
    advance(1); const next = service.get();
    expect(next).toMatchObject({ phase: 'generating', selectedLookId: 'city', displayedLookId: 'commute', sessionNumber: result.sessionNumber,
      generationNumber: result.generationNumber + 1, autoSwitchAt: null, generationReadyAt: now() + 2_200 });
    advance(2_199); expect(service.get().phase).toBe('generating');
    advance(1); expect(service.get().autoSwitchAt).toBe(now() + 5_000);
    advance(5_000); expect(service.get().selectedLookId).toBe('evening');
    advance(2_200); service.get(); advance(5_000); expect(service.get().selectedLookId).toBe('commute');
  });

  it('starts the dwell from observed result completion after a delayed tick and does not skip materials', () => {
    const { service, advance, now } = fixture(); automatic(service); service.command({ action: 'begin' });
    advance(100_000); expect(service.get()).toMatchObject({ phase: 'showcase', selectedLookId: 'commute', autoSwitchAt: now() + 5_000 });
    expect(service.get().generationNumber).toBe(1);
    advance(5_000); expect(service.get()).toMatchObject({ phase: 'generating', selectedLookId: 'city', generationNumber: 2 });
  });

  it('does not let the inactivity deadline truncate a long automatic display interval', () => {
    const { service, advance } = fixture(); service.command({ action: 'configure', autoReturnSeconds: 15 }); automatic(service, 120);
    showcase(service, advance); advance(119_999); expect(service.get().phase).toBe('showcase');
    advance(1); expect(service.get()).toMatchObject({ phase: 'generating', selectedLookId: 'city' });
  });

  it('pauses its deadline, resumes with a fresh interval, and never restarts after end or idle', () => {
    const { service, advance, now } = fixture(); automatic(service); showcase(service, advance); advance(4_000);
    expect(service.command({ action: 'pause' }).autoSwitchAt).toBeNull(); advance(100_000); expect(service.get().phase).toBe('paused');
    expect(service.command({ action: 'resume' })).toMatchObject({ phase: 'showcase', autoSwitchAt: now() + 5_000 });
    advance(4_999); expect(service.get().selectedLookId).toBe('commute');
    service.command({ action: 'end' }); advance(120_000); expect(service.get()).toMatchObject({ autoSwitchAt: null, generationNumber: 1 });
    expect(service.get().phase).toBe('idle');
    service.command({ action: 'begin' }); service.command({ action: 'idle' }); advance(100_000);
    expect(service.get()).toMatchObject({ phase: 'idle', autoSwitchAt: null, generationNumber: 2 });
  });

  it('can update automation and availability while active and disabling automation clears the timer immediately', () => {
    const { service, advance, now } = fixture(); showcase(service, advance);
    expect(automatic(service)).toMatchObject({ phase: 'showcase', autoSwitchAt: now() + 5_000 });
    advance(1_000); expect(service.command({ action: 'configure', autoSwitchSeconds: 10 }).autoSwitchAt).toBe(now() + 10_000);
    const state = service.get();
    for (const command of [{ action: 'configure', autoReturnSeconds: 0, switchMode: 'manual' }, { action: 'configure', experienceMode: 'free' }]) {
      expect(() => service.command(command)).toThrow(errorCode('EXHIBITION_INVALID_PHASE')); expect(service.get()).toEqual(state);
    }
    expect(service.command({ action: 'configure', enabledLookIds: ['city'] })).toMatchObject({ selectedLookId: 'commute', activeLook: { id: 'commute' } });
    expect(service.command({ action: 'configure', switchMode: 'manual' }).autoSwitchAt).toBeNull();
    advance(10_000); expect(service.get().selectedLookId).toBe('commute');
    service.command({ action: 'configure', enabledLookIds: ['commute', 'city', 'evening'] });
    service.command({ action: 'pause' }); automatic(service); expect(service.get().autoSwitchAt).toBeNull();
    service.command({ action: 'resume' }); service.command({ action: 'next' });
    expect(service.command({ action: 'configure', switchMode: 'manual' })).toMatchObject({ phase: 'generating', autoSwitchAt: null });
  });

  it('rejects invalid intervals and stale changes atomically', () => {
    const { service } = fixture(); const before = service.get();
    for (const autoSwitchSeconds of [0, 4, 601, 5.5, '30', NaN, null]) {
      expect(() => service.command({ action: 'configure', switchMode: 'auto', autoSwitchSeconds })).toThrow(errorCode('EXHIBITION_INVALID_SETTINGS'));
      expect(service.get()).toEqual(before);
    }
    expect(() => service.command({ action: 'configure', switchMode: 'unknown' })).toThrow(errorCode('EXHIBITION_INVALID_SETTINGS'));
    service.command({ action: 'configure', autoSwitchSeconds: 600 });
    const latest = service.get();
    expect(() => service.command({ action: 'configure', switchMode: 'auto', expectedRevision: before.revision })).toThrow(errorCode('EXHIBITION_STALE_REVISION'));
    expect(service.get()).toEqual(latest);
  });

  it('keeps one enabled material static and does not start an empty current mode', () => {
    const { service, advance } = fixture(); service.command({ action: 'configure', enabledLookIds: ['commute'] }); automatic(service); showcase(service, advance);
    advance(50_000); expect(service.get()).toMatchObject({ phase: 'showcase', generationNumber: 1, autoSwitchAt: null });
    service.command({ action: 'idle' }); service.command({ action: 'configure', experienceMode: 'mox' });
    expect(() => service.command({ action: 'begin' })).toThrow(errorCode('EXHIBITION_NO_ENABLED_LOOKS'));
    expect(service.get()).toMatchObject({ phase: 'idle', selectedLookId: null, autoSwitchAt: null });
  });

  it('preserves old catalogs when adding defaults, persists configuration, and clears active deadlines on restart', () => {
    const { service, directory, now, advance } = fixture();
    const file = join(directory, 'exhibition.json'); const stored = JSON.parse(readFileSync(file, 'utf8'));
    for (let i = 0; i < 96; i += 1) {
      const id = `upload-${randomUUID()}`;
      stored.state.looks.push({ ...stored.state.looks[0], id, source: 'upload', image: `/api/exhibition/assets/${id}`, referenceImage: `/api/exhibition/assets/${id}`, width: 512, height: 768, bytes: 100, mime: 'image/webp' });
      stored.state.enabledLookIds.push(id);
    }
    delete stored.state.settings.switchMode; delete stored.state.settings.autoSwitchSeconds; delete stored.state.settings.uiSkin; delete stored.state.autoSwitchAt;
    writeFileSync(file, JSON.stringify(stored));
    const migrated = new ExhibitionService(directory, { now, strictStorage: true });
    expect(migrated.get()).toMatchObject({ autoSwitchAt: null, settings: { switchMode: 'manual', autoSwitchSeconds: 30 } });
    expect(migrated.get().looks).toHaveLength(99); expect(migrated.get().enabledLookIds).toHaveLength(99);
    automatic(migrated, 45); const saved = migrated.get(); expect(new ExhibitionService(directory, { now }).get()).toEqual(saved);
    showcase(migrated, advance); const current = migrated.get();
    expect(new ExhibitionService(directory, { now }).get()).toMatchObject({ phase: 'select', autoSwitchAt: null, settings: { switchMode: 'auto', autoSwitchSeconds: 45 }, revision: current.revision + 1 });
  });
});

describe('automatic live lifecycle', () => {
  it('waits for a real first frame, advances via the watchdog, and releases the old lease before another allocation', async () => {
    const { service, advance, now, create, stop, createSession } = liveFixture(); service.command({ action: 'begin' });
    advance(12_000); expect(service.get()).toMatchObject({ phase: 'generating', autoSwitchAt: null }); expect(create).not.toHaveBeenCalled();
    const previous = await createSession(); advance(4_000); service.liveFirstFrame(previous.id, 4_000);
    expect(service.get().autoSwitchAt).toBe(now() + 5_000);
    advance(5_000); expect(service.get().phase).toBe('showcase');
    await service.sweepLive();
    expect(service.get()).toMatchObject({ phase: 'generating', selectedLookId: 'city', displayedLookId: 'commute', live: null, generationNumber: 2, sessionNumber: 1, autoSwitchAt: null });
    expect(stop).toHaveBeenCalledWith(previous.id); expect(create).toHaveBeenCalledTimes(1);
    advance(10_000); await service.sweepLive(); expect(service.get().generationNumber).toBe(2); expect(create).toHaveBeenCalledTimes(1);
    const next = await createSession(); service.liveFirstFrame(previous.id, 100); expect(service.get().phase).toBe('generating');
    service.liveFirstFrame(next.id, 100); expect(service.get()).toMatchObject({ phase: 'showcase', autoSwitchAt: now() + 5_000, selectedLookId: 'city' });
  });

  it('does not rotate an owner whose heartbeat expired at the deadline', async () => {
    const { service, advance, createSession, create, stop } = liveFixture(); service.command({ action: 'configure', autoSwitchSeconds: 15 }); service.command({ action: 'begin' });
    const session = await createSession(); service.liveFirstFrame(session.id, 100); advance(20_000); await service.sweepLive();
    expect(service.get()).toMatchObject({ phase: 'paused', selectedLookId: 'commute', generationNumber: 1, live: null, autoSwitchAt: null });
    expect(stop).toHaveBeenCalledWith(session.id); expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not rotate an expired, exhausted or provider-stopping credential at the deadline', async () => {
    for (const condition of ['expired', 'exhausted', 'stopping'] as const) {
      const { service, advance, now, createSession, sessions, create } = liveFixture(); service.command({ action: 'begin' });
      const session = await createSession(); service.liveFirstFrame(session.id, 100);
      if (condition === 'expired') sessions.get(session.id)!.expiresAt = new Date(now() - 1).toISOString();
      else if (condition === 'exhausted') sessions.get(session.id)!.consumedCredits = 30;
      else sessions.get(session.id)!.status = 'stopping';
      advance(5_000); await service.sweepLive();
      expect(service.get()).toMatchObject({ phase: 'paused', selectedLookId: 'commute', generationNumber: 1, autoSwitchAt: null, live: null });
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it('clears automation on reported errors and allows staff to disable it while paused', async () => {
    const { service, createSession, advance, create } = liveFixture(); service.command({ action: 'begin' }); const session = await createSession(); service.liveFirstFrame(session.id, 100);
    await service.reportLiveError({ deviceId: 'auto-screen-001', sessionId: session.id, lookId: 'commute', sessionNumber: 1, generationNumber: 1, message: 'camera interrupted' });
    service.command({ action: 'configure', switchMode: 'manual' }); advance(100_000); await service.sweepLive();
    expect(service.get()).toMatchObject({ phase: 'paused', generationNumber: 1, autoSwitchAt: null, settings: { switchMode: 'manual' } }); expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed previous stop owned and prevents a second allocation or another timer advance', async () => {
    const { service, createSession, advance, create, stop } = liveFixture(); service.command({ action: 'begin' });
    const previous = await createSession(); service.liveFirstFrame(previous.id, 100);
    stop.mockRejectedValue(new Error('stop unavailable'));
    advance(5_000); await service.sweepLive();
    expect(service.get()).toMatchObject({ phase: 'generating', selectedLookId: 'city', generationNumber: 2, autoSwitchAt: null, live: { sessionId: previous.id, status: 'error' } });
    await expect(createSession()).rejects.toMatchObject({ code: 'EXHIBITION_DEVICE_BUSY' });
    advance(30_000); await service.sweepLive();
    expect(service.get()).toMatchObject({ phase: 'generating', generationNumber: 2, autoSwitchAt: null }); expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('persistent mode-scoped material order', () => {
  it('reorders disabled and enabled materials without changing other-mode slots or the selected material', () => {
    const { service, directory, now } = fixture(); service.updateLook('city', { mode: 'charx' });
    service.command({ action: 'configure', enabledLookIds: ['evening', 'city'] }); const before = service.get();
    const result = service.command({ action: 'reorder', experienceMode: 'clothx', lookIds: ['evening', 'commute'], expectedRevision: before.revision });
    expect(result.looks.map(look => look.id)).toEqual(['evening', 'city', 'commute']);
    expect(result).toMatchObject({ selectedLookId: 'evening', enabledLookIds: ['evening', 'city'], sessionNumber: before.sessionNumber, generationNumber: before.generationNumber });
    const enabled = result.looks.filter(look => ['city', 'commute', 'evening'].includes(look.id)).map(look => look.id);
    service.command({ action: 'configure', enabledLookIds: enabled });
    expect(service.get().enabledLookIds).toEqual(['evening', 'city', 'commute']);
    expect(new ExhibitionService(directory, { now }).get()).toEqual(service.get());
  });

  it('reorders only enabled slots for the requested mode and cycles the resulting playback sequence', () => {
    const { service, advance } = fixture(); service.updateLook('city', { mode: 'charx' });
    service.command({ action: 'configure', enabledLookIds: ['commute', 'city', 'evening'] });
    const result = service.command({ action: 'reorder', experienceMode: 'clothx', lookIds: ['evening', 'commute'] });
    expect(result.enabledLookIds).toEqual(['evening', 'city', 'commute']); expect(result.selectedLookId).toBe('commute');
    showcase(service, advance); expect(service.command({ action: 'next' }).selectedLookId).toBe('evening');
  });

  it('rejects missing, duplicate, cross-mode, stale and active-round reorder operations atomically', () => {
    const { service } = fixture(); service.updateLook('city', { mode: 'charx' }); const before = service.get();
    for (const input of [undefined, [], ['commute'], ['commute', 'commute'], ['commute', 'city'], ['commute', 'evening', 'city'], [1, 'evening']]) {
      expect(() => service.command({ action: 'reorder', experienceMode: 'clothx', lookIds: input })).toThrow(errorCode('EXHIBITION_INVALID_LOOK_ORDER')); expect(service.get()).toEqual(before);
    }
    expect(() => service.command({ action: 'reorder', lookIds: ['commute', 'evening'] })).toThrow(errorCode('EXHIBITION_INVALID_MODE'));
    const reordered = service.command({ action: 'reorder', experienceMode: 'clothx', lookIds: ['evening', 'commute'] });
    expect(() => service.command({ action: 'reorder', experienceMode: 'clothx', lookIds: ['commute', 'evening'], expectedRevision: before.revision })).toThrow(errorCode('EXHIBITION_STALE_REVISION')); expect(service.get()).toEqual(reordered);
    service.command({ action: 'begin' }); const generating = service.get();
    expect(() => service.command({ action: 'reorder', experienceMode: 'clothx', lookIds: ['commute', 'evening'] })).toThrow(errorCode('EXHIBITION_INVALID_PHASE')); expect(service.get()).toEqual(generating);
  });

  it('refuses to reorder a catalog while its stopped experience still retains a live lease', async () => {
    const { service, createSession } = liveFixture(); service.command({ action: 'begin' }); await createSession();
    const ended = service.command({ action: 'end' });
    expect(() => service.command({ action: 'reorder', experienceMode: 'clothx', lookIds: ['evening', 'city', 'commute'] })).toThrow(errorCode('EXHIBITION_MIRROR_BUSY'));
    expect(service.get()).toEqual(ended);
  });

  it('isolates timers and ordering between mirrors, copies configured order, and clears the copied runtime deadline', () => {
    const { directory, now, advance } = fixture(); const manager = new ExhibitionMirrors(directory, { now }); const a = manager.getMirror();
    const targetId = manager.create({ name: '独立镜' }).id; const b = manager.getMirror(targetId); const before = b.get();
    a.command({ action: 'reorder', experienceMode: 'clothx', lookIds: ['evening', 'city', 'commute'] }); automatic(a); showcase(a, advance);
    expect(b.get()).toEqual(before);
    const copied = manager.copy(targetId, { sourceMirrorId: 'default', expectedRevision: b.get().revision, copyLooks: true, copySettings: true });
    expect(copied.looks.map(look => look.id)).toEqual(['evening', 'city', 'commute']);
    expect(copied).toMatchObject({ phase: 'idle', autoSwitchAt: null, enabledLookIds: ['evening', 'city', 'commute'], settings: { switchMode: 'auto', autoSwitchSeconds: 5 } });
    advance(5_000); expect(a.get()).toMatchObject({ phase: 'generating', selectedLookId: 'evening' }); expect(b.get()).toEqual(copied);
    const restarted = new ExhibitionMirrors(directory, { now }); expect(restarted.getMirror(targetId).get()).toEqual(copied); expect(restarted.getMirror().get().autoSwitchAt).toBeNull();
  });
});

describe('mirror skin service bridge', () => {
  async function image() {
    return (await sharp({ create: { width: 360, height: 640, channels: 4, background: '#aabbcc88' } }).png().toBuffer()).toString('base64');
  }
  it('persists a skin, gates assets by current configuration, and restores the default independently', async () => {
    const { service, directory, now } = fixture(); const bytes = await image();
    const first = await service.uploadUiSkin({ imageBase64: bytes, expectedRevision: service.get().revision }); const original = first.settings.uiSkin!;
    const originalId = original.image.split('/').at(-1)!;
    expect(service.uiSkinAsset(originalId).mime).toBe('image/webp');
    expect(new ExhibitionService(directory, { now }).get()).toEqual(first);
    const replacement = await service.uploadUiSkin({ imageBase64: bytes, expectedRevision: first.revision }); const nextId = replacement.settings.uiSkin!.image.split('/').at(-1)!;
    expect(nextId).not.toBe(originalId); expect(() => service.uiSkinAsset(originalId)).toThrow(errorCode('EXHIBITION_SKIN_NOT_FOUND'));
    expect(service.uiSkinAsset(nextId).data.length).toBe(replacement.settings.uiSkin!.bytes);
    const reset = service.removeUiSkin({ expectedRevision: replacement.revision });
    expect(reset.settings.uiSkin).toBeNull(); expect(() => service.uiSkinAsset(nextId)).toThrow(errorCode('EXHIBITION_SKIN_NOT_FOUND'));
    expect(reset.looks).toEqual(first.looks); expect(reset.settings.switchMode).toBe('manual');
  });

  it('rejects stale uploads and rechecks the phase after asynchronous image processing', async () => {
    const { service } = fixture(); const bytes = await image(); const old = service.get(); service.command({ action: 'select', lookId: 'city' });
    await expect(service.uploadUiSkin({ imageBase64: bytes, expectedRevision: old.revision })).rejects.toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
    const pending = service.uploadUiSkin({ imageBase64: bytes }); service.command({ action: 'begin' });
    await expect(pending).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' });
    expect(service.get()).toMatchObject({ phase: 'generating', settings: { uiSkin: null } });
    await expect(service.uploadUiSkin({ imageBase64: bytes })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PHASE' });
  });

  it('copies skin bytes and URLs into the target mirror without sharing the source configuration', async () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now }); const source = manager.getMirror();
    const targetId = manager.create({ name: '独立皮肤镜' }).id; const target = manager.getMirror(targetId);
    const original = await source.uploadUiSkin({ imageBase64: await image() }); const sourceSkin = original.settings.uiSkin!;
    const copied = manager.copy(targetId, { sourceMirrorId: 'default', expectedRevision: target.get().revision, copyLooks: false, copySettings: true }); const targetSkin = copied.settings.uiSkin!;
    expect(targetSkin.image).toContain(`/mirrors/${targetId}/skin/`); expect(targetSkin.image).not.toBe(sourceSkin.image);
    expect(target.uiSkinAsset(targetSkin.image.split('/').at(-1)!).data).toEqual(source.uiSkinAsset(sourceSkin.image.split('/').at(-1)!).data);
    source.removeUiSkin({}); expect(target.get()).toEqual(copied);
    expect(new ExhibitionMirrors(directory, { now }).getMirror(targetId).get()).toEqual(copied);
  });
});
