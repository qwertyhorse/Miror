import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionService } from '../server/exhibition.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { createApiServer } from '../server/http.ts';
import type { TryOnService } from '../server/service.ts';
import { DEFAULT_EXHIBITION_GESTURE_SETTINGS, isExhibitionGestureSettings, resolveExhibitionGestureSettings, type ExhibitionGestureSettings } from '../shared/exhibitionGestures.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'openbuy-gesture-settings-')); directories.push(path); return path; }
function fixture() {
  const path = directory(); let time = 1_800_000_000_000; const now = () => time;
  return { directory: path, now, service: new ExhibitionService(path, { now }), advance: (ms: number) => { time += ms; } };
}
function settings(overrides: Partial<ExhibitionGestureSettings> = {}): ExhibitionGestureSettings {
  return { ...resolveExhibitionGestureSettings(), ...overrides };
}
const code = (value: string) => expect.objectContaining({ code: value });
const configured: ExhibitionGestureSettings = settings({ gestures: ['open_palm', 'wave'], minHandDetectionConfidence: 0.4,
  minHandPresenceConfidence: 0.45, minTrackingConfidence: 0.6, palmConfirmMs: 450, palmReleaseMs: 700, maxFps: 20, inputLongEdge: 960 });

describe('per-mirror gesture settings', () => {
  it('defaults every new mirror to palm only with independent settings and gesture arrays', () => {
    const manager = new ExhibitionMirrors(directory()); const second = manager.create({ name: '第二台镜' });
    const firstState = manager.getMirror().get(); const secondState = manager.getMirror(second.id).get();
    expect(firstState.settings.gestureRecognition).toEqual({ gestures: ['open_palm'], minHandDetectionConfidence: 0.35,
      minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.5, palmConfirmMs: 300, palmReleaseMs: 500, maxFps: 15, inputLongEdge: 720 });
    expect(secondState.settings.gestureRecognition).toEqual(firstState.settings.gestureRecognition);
    firstState.settings.gestureRecognition!.gestures.push('wave'); firstState.settings.gestureRecognition!.maxFps = 30;
    expect(manager.getMirror().get().settings.gestureRecognition).toEqual(DEFAULT_EXHIBITION_GESTURE_SETTINGS);
    expect(manager.getMirror(second.id).get()).toEqual(secondState);
    const resolved = resolveExhibitionGestureSettings(); resolved.gestures.length = 0;
    expect(resolveExhibitionGestureSettings().gestures).toEqual(['open_palm']);
  });

  it('persists a complete update atomically, clones the input, and does not start a generation', () => {
    const { service, directory, now, advance } = fixture(); const before = service.get();
    const createExhibition = vi.fn();
    service.attachLiveService({ status: () => ({ configured: true }), createExhibition } as unknown as TryOnService);
    const submitted = structuredClone(configured);
    const saved = service.command({ action: 'configure', gestureRecognition: submitted, expectedRevision: before.revision });
    expect(saved).toMatchObject({ revision: before.revision + 1, phase: before.phase, settings: { ...before.settings, gestureRecognition: configured },
      looks: before.looks, enabledLookIds: before.enabledLookIds, selectedLookId: before.selectedLookId,
      sessionNumber: 0, generationNumber: 0, generationReadyAt: null, live: null });
    submitted.gestures.length = 0; submitted.palmConfirmMs = 999;
    expect(service.get()).toEqual(saved);
    expect(new ExhibitionService(directory, { now, strictStorage: true }).get()).toEqual(saved);
    advance(10_000); expect(service.get()).toEqual(saved); expect(createExhibition).not.toHaveBeenCalled();
  });

  it.each<{ gestures: ExhibitionGestureSettings['gestures'] }>([{ gestures: [] }, { gestures: ['wave'] }, { gestures: ['open_palm'] }, { gestures: ['wave', 'open_palm'] }])('saves gesture selection $gestures including an explicit disable', ({ gestures }) => {
    const { service } = fixture();
    expect(service.command({ action: 'configure', gestureRecognition: settings({ gestures }) }).settings.gestureRecognition?.gestures).toEqual(gestures);
  });

  it('accepts all advertised parameter boundaries', () => {
    const { service } = fixture();
    for (const value of [settings({ minHandDetectionConfidence: 0.1, minHandPresenceConfidence: 0.1, minTrackingConfidence: 0.1,
      palmConfirmMs: 150, palmReleaseMs: 300, maxFps: 5, inputLongEdge: 480 }),
    settings({ minHandDetectionConfidence: 0.9, minHandPresenceConfidence: 0.9, minTrackingConfidence: 0.9,
      palmConfirmMs: 1000, palmReleaseMs: 1500, maxFps: 30, inputLongEdge: 960 })]) {
      expect(service.command({ action: 'configure', gestureRecognition: value }).settings.gestureRecognition).toEqual(value);
    }
  });

  it.each([
    ['gestures', [['raise'], ['open_palm', 'open_palm'], ['wave', 'wave'], ['open_palm', 'wave', 'open_palm'], 'open_palm', null, Array(1)]],
    ['minHandDetectionConfidence', [-0.1, 0.09, 0.91, 1, NaN, Infinity, '0.35', null]],
    ['minHandPresenceConfidence', [0, 0.09, 0.91, NaN, -Infinity, '0.35', null]],
    ['minTrackingConfidence', [0, 0.09, 0.91, NaN, Infinity, '0.5', null]],
    ['palmConfirmMs', [0, 149, 1001, 300.5, NaN, Infinity, '300', null]],
    ['palmReleaseMs', [0, 299, 1501, 500.5, NaN, Infinity, '500', null]],
    ['maxFps', [0, 4, 31, 15.5, NaN, Infinity, '15', null]],
    ['inputLongEdge', [0, 479, 721, 1080, NaN, Infinity, '720', null]],
  ] as const)('rejects invalid %s without changing memory or disk', (field, values) => {
    const { service, directory } = fixture(); const before = service.get(); const file = join(directory, 'exhibition.json'); const persisted = readFileSync(file);
    for (const value of values) {
      const gestureRecognition = { ...configured, [field]: value };
      expect(isExhibitionGestureSettings(gestureRecognition)).toBe(false);
      expect(() => service.command({ action: 'configure', gestureRecognition, autoReturnSeconds: 180 })).toThrow(code('EXHIBITION_INVALID_SETTINGS'));
      expect(service.get()).toEqual(before); expect(readFileSync(file)).toEqual(persisted);
    }
  });

  it('requires the whole settings object and rolls back valid gesture settings when another field fails', () => {
    const { service, directory } = fixture(); const before = service.get(); const persisted = readFileSync(join(directory, 'exhibition.json'));
    const incomplete = Object.keys(configured).map(field => { const copy = { ...configured } as Record<string, unknown>; delete copy[field]; return copy; });
    for (const gestureRecognition of [null, [], 'palm', 1, {}, ...incomplete]) {
      expect(() => service.command({ action: 'configure', gestureRecognition, autoReturnSeconds: 180 })).toThrow(code('EXHIBITION_INVALID_SETTINGS'));
    }
    expect(() => service.command({ action: 'configure', gestureRecognition: configured, autoReturnSeconds: 14 })).toThrow(code('EXHIBITION_INVALID_SETTINGS'));
    expect(service.get()).toEqual(before); expect(readFileSync(join(directory, 'exhibition.json'))).toEqual(persisted);
  });

  it('rejects stale updates without overwriting a newer operator choice', () => {
    const { service } = fixture(); const before = service.get();
    const saved = service.command({ action: 'configure', gestureRecognition: configured, expectedRevision: before.revision });
    expect(() => service.command({ action: 'configure', gestureRecognition: settings({ gestures: [] }), expectedRevision: before.revision })).toThrow(code('EXHIBITION_STALE_REVISION'));
    expect(service.get()).toEqual(saved);
  });

  it('only saves in select or idle, and blocks a live lease retained after stopping', async () => {
    const { service, advance, now } = fixture(); service.command({ action: 'begin' });
    const assertBlocked = (expectedCode: string) => {
      const before = service.get();
      expect(() => service.command({ action: 'configure', gestureRecognition: configured, expectedRevision: before.revision })).toThrow(code(expectedCode));
      expect(service.get()).toEqual(before);
    };
    assertBlocked('EXHIBITION_INVALID_PHASE'); advance(2_200); assertBlocked('EXHIBITION_INVALID_PHASE');
    service.command({ action: 'pause' }); assertBlocked('EXHIBITION_INVALID_PHASE');
    service.command({ action: 'end' });
    expect(service.command({ action: 'configure', gestureRecognition: configured }).settings.gestureRecognition).toEqual(configured);
    const session = { id: 'gesture-test-session', status: 'active', expiresAt: new Date(now() + 120_000).toISOString(), pointsLimit: 30, consumedCredits: 0 };
    service.attachLiveService({ status: () => ({ configured: true }),
      createExhibition: async (_input: unknown, hooks: { onReserved: (id: string) => void }) => { hooks.onReserved(session.id); return session; },
      cancelExhibitionSession: () => { session.status = 'stopping'; },
    } as unknown as TryOnService);
    service.command({ action: 'configure', providerMode: 'xmax' }); const generating = service.command({ action: 'begin' });
    await service.createLiveSession({ deviceId: 'gesture-screen-001', lookId: generating.selectedLookId, generationNumber: generating.generationNumber });
    for (const action of ['end', 'idle']) {
      const stopped = service.command({ action }); expect(stopped.live).toMatchObject({ sessionId: session.id, status: 'stopping' });
      assertBlocked('EXHIBITION_MIRROR_BUSY');
    }
  });

  it.each(['missing', 'invalid'] as const)('migrates %s gesture settings without resetting a customized material library', kind => {
    const { service, directory, now } = fixture();
    service.command({ action: 'configure', autoReturnSeconds: 180, switchMode: 'auto', autoSwitchSeconds: 45, enabledLookIds: ['evening', 'city'] });
    const file = join(directory, 'exhibition.json'); const stored = JSON.parse(readFileSync(file, 'utf8'));
    const uploadId = `upload-${randomUUID()}`;
    stored.state.looks.push({ ...stored.state.looks[0], id: uploadId, name: '自定义素材', source: 'upload', image: `/api/exhibition/assets/${uploadId}`,
      width: 512, height: 768, bytes: 100, mime: 'image/webp' });
    stored.state.enabledLookIds.push(uploadId); stored.state.selectedLookId = uploadId;
    stored.state.settings.gestureRecognition = kind === 'invalid' ? { ...configured, gestures: ['unknown'] } : undefined;
    writeFileSync(file, JSON.stringify(stored));
    const migrated = new ExhibitionService(directory, { now, strictStorage: true }); const state = migrated.get();
    expect(state).toMatchObject({ looks: stored.state.looks, selectedLookId: uploadId, enabledLookIds: stored.state.enabledLookIds,
      settings: { autoReturnSeconds: 180, switchMode: 'auto', autoSwitchSeconds: 45, gestureRecognition: DEFAULT_EXHIBITION_GESTURE_SETTINGS } });
    expect(state.revision).toBe(stored.state.revision + 1);
    expect(new ExhibitionService(directory, { now, strictStorage: true }).get()).toEqual(state);
  });

  it('copies settings only when selected and isolates source, target, and returned objects', () => {
    const path = directory(); const manager = new ExhibitionMirrors(path); const targetId = manager.create({ name: '复制目标' }).id;
    const source = manager.getMirror(); const target = manager.getMirror(targetId);
    const original = source.command({ action: 'configure', gestureRecognition: configured });
    manager.copy(targetId, { sourceMirrorId: 'default', copyLooks: true, copySettings: false, expectedRevision: target.get().revision });
    expect(target.get().settings.gestureRecognition).toEqual(DEFAULT_EXHIBITION_GESTURE_SETTINGS);
    const copied = manager.copy(targetId, { sourceMirrorId: 'default', copyLooks: false, copySettings: true, expectedRevision: target.get().revision });
    expect(copied.settings.gestureRecognition).toEqual(configured);
    copied.settings.gestureRecognition!.gestures.length = 0;
    expect(target.get().settings.gestureRecognition).toEqual(configured); expect(source.get()).toEqual(original);
    target.command({ action: 'configure', gestureRecognition: settings({ gestures: [], maxFps: 5 }) });
    expect(source.get()).toEqual(original);
    expect(new ExhibitionMirrors(path).getMirror(targetId).get().settings.gestureRecognition).toEqual(settings({ gestures: [], maxFps: 5 }));
  });
});

describe('gesture settings HTTP boundary', () => {
  it('round-trips per mirror, rejects invalid/stale saves, and never contacts XMAX', async () => {
    const mirrors = new ExhibitionMirrors(directory());
    const providerAccess = vi.fn(() => { throw new Error('Gesture settings must not contact XMAX.'); });
    const unrelated = new Proxy({} as TryOnService, { get: providerAccess });
    const server = createApiServer(unrelated, ['http://xuminghong.local:10200'], undefined, mirrors);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const source = mirrors.getMirror(); const before = source.get(); const otherId = mirrors.create({ name: 'HTTP 隔离镜' }).id;
      const other = mirrors.getMirror(otherId).get(); const root = `${base}/api/exhibition/mirrors/default`;
      const command = (body: unknown) => fetch(`${root}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://xuminghong.local:10200' }, body: JSON.stringify(body) });
      const invalid = await command({ action: 'configure', gestureRecognition: { ...configured, gestures: ['pinch'] }, expectedRevision: before.revision });
      expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: 'EXHIBITION_INVALID_SETTINGS' });
      const response = await command({ action: 'configure', gestureRecognition: configured, expectedRevision: before.revision });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ settings: { gestureRecognition: configured }, revision: before.revision + 1, generationNumber: 0, live: null });
      const stale = await command({ action: 'configure', gestureRecognition: settings({ gestures: [] }), expectedRevision: before.revision });
      expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
      expect(await (await fetch(root)).json()).toEqual(source.get());
      expect(mirrors.getMirror(otherId).get()).toEqual(other); expect(providerAccess).not.toHaveBeenCalled();
    } finally { server.close(); await once(server, 'close'); }
  });
});
