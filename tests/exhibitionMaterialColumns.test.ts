import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionService } from '../server/exhibition.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { createApiServer } from '../server/http.ts';
import type { TryOnService } from '../server/service.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'openbuy-material-columns-')); directories.push(path); return path; }
function fixture() {
  const path = directory(); let time = 1_800_000_000_000; const now = () => time;
  return { directory: path, now, service: new ExhibitionService(path, { now }), advance: (ms: number) => { time += ms; } };
}
const code = (value: string) => expect.objectContaining({ code: value });

describe('per-mirror material drawer columns', () => {
  it('defaults to two columns and persists an independent choice without changing the experience', () => {
    const path = directory(); const now = () => 1_800_000_000_000;
    const mirrors = new ExhibitionMirrors(path, { now }); const source = mirrors.getMirror();
    const second = mirrors.getMirror(mirrors.create({ name: '第二台镜' }).id);
    const before = source.get(); const secondBefore = second.get();
    expect(before.settings.materialDrawerColumns).toBe(2); expect(secondBefore.settings.materialDrawerColumns).toBe(2);
    const saved = source.command({ action: 'configure', materialDrawerColumns: 1, expectedRevision: before.revision });
    expect(saved).toMatchObject({ ...before, revision: before.revision + 1, logs: expect.any(Array),
      settings: { ...before.settings, materialDrawerColumns: 1 } });
    expect(second.get()).toEqual(secondBefore);
    const restored = new ExhibitionMirrors(path, { now });
    expect(restored.getMirror().get()).toEqual(saved);
    expect(restored.getMirror(second.mirrorId).get()).toEqual(secondBefore);
    saved.settings.materialDrawerColumns = 2;
    expect(source.get().settings.materialDrawerColumns).toBe(1);
    expect(source.command({ action: 'configure', materialDrawerColumns: 2 }).settings.materialDrawerColumns).toBe(2);
  });

  it('rejects invalid values and rolls back another valid setting without changing memory or disk', () => {
    const { service, directory } = fixture(); const before = service.get();
    const file = join(directory, 'exhibition.json'); const persisted = readFileSync(file);
    for (const materialDrawerColumns of [null, '1', '2', 0, 3, -1, 1.5, NaN, Infinity, true, {}, []]) {
      expect(() => service.command({ action: 'configure', materialDrawerColumns, switchMode: 'auto' })).toThrow(code('EXHIBITION_INVALID_SETTINGS'));
      expect(service.get()).toEqual(before); expect(readFileSync(file)).toEqual(persisted);
    }
    expect(() => service.command({ action: 'configure', materialDrawerColumns: 1, autoReturnSeconds: 14 })).toThrow(code('EXHIBITION_INVALID_SETTINGS'));
    expect(service.get()).toEqual(before); expect(readFileSync(file)).toEqual(persisted);
  });

  it('rejects stale revisions without overwriting a newer column choice', () => {
    const { service } = fixture(); const before = service.get();
    const saved = service.command({ action: 'configure', materialDrawerColumns: 1, expectedRevision: before.revision });
    expect(() => service.command({ action: 'configure', materialDrawerColumns: 2, expectedRevision: before.revision })).toThrow(code('EXHIBITION_STALE_REVISION'));
    expect(service.get()).toEqual(saved);
  });

  it('requires idle or select and blocks a retained live lease after stopping', async () => {
    const { service, advance, now } = fixture(); service.command({ action: 'begin' });
    const assertBlocked = (expectedCode: string) => {
      const before = service.get();
      expect(() => service.command({ action: 'configure', materialDrawerColumns: 1, expectedRevision: before.revision })).toThrow(code(expectedCode));
      expect(service.get()).toEqual(before);
    };
    assertBlocked('EXHIBITION_INVALID_PHASE'); advance(2_200); assertBlocked('EXHIBITION_INVALID_PHASE');
    service.command({ action: 'pause' }); assertBlocked('EXHIBITION_INVALID_PHASE');
    service.command({ action: 'end' });
    expect(service.command({ action: 'configure', materialDrawerColumns: 1 }).settings.materialDrawerColumns).toBe(1);
    service.command({ action: 'idle' });
    expect(service.command({ action: 'configure', materialDrawerColumns: 2 }).settings.materialDrawerColumns).toBe(2);
    const session = { id: 'column-test-session', status: 'active', expiresAt: new Date(now() + 120_000).toISOString(), pointsLimit: 30, consumedCredits: 0 };
    service.attachLiveService({ status: () => ({ configured: true }),
      createExhibition: async (_input: unknown, hooks: { onReserved: (id: string) => void }) => { hooks.onReserved(session.id); return session; },
      cancelExhibitionSession: () => { session.status = 'stopping'; },
    } as unknown as TryOnService);
    service.command({ action: 'configure', providerMode: 'xmax' }); const generating = service.command({ action: 'begin' });
    await service.createLiveSession({ deviceId: 'column-screen-001', lookId: generating.selectedLookId, generationNumber: generating.generationNumber });
    for (const action of ['end', 'idle']) {
      expect(service.command({ action }).live).toMatchObject({ sessionId: session.id, status: 'stopping' });
      assertBlocked('EXHIBITION_MIRROR_BUSY');
    }
  });

  it.each(['missing', 'invalid'] as const)('migrates %s columns without resetting catalog, selection, or other settings', kind => {
    const { service, directory, now } = fixture();
    const original = service.command({ action: 'configure', enabledLookIds: ['evening', 'city'], autoReturnSeconds: 180,
      switchMode: 'auto', autoSwitchSeconds: 45, uiSkinPreset: 'brand' });
    const file = join(directory, 'exhibition.json'); const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (kind === 'missing') delete stored.state.settings.materialDrawerColumns;
    else stored.state.settings.materialDrawerColumns = '1';
    writeFileSync(file, JSON.stringify(stored));
    const migrated = new ExhibitionService(directory, { now, strictStorage: true }).get();
    expect(migrated).toMatchObject({ ...original, revision: original.revision + 1, logs: expect.any(Array),
      settings: { ...original.settings, materialDrawerColumns: 2 } });
    expect(new ExhibitionService(directory, { now, strictStorage: true }).get()).toEqual(migrated);
  });

  it('copies the column choice only when settings are selected and keeps mirrors independent', () => {
    const path = directory(); const mirrors = new ExhibitionMirrors(path); const source = mirrors.getMirror();
    const target = mirrors.getMirror(mirrors.create({ name: '复制目标' }).id);
    const original = source.command({ action: 'configure', materialDrawerColumns: 1 });
    mirrors.copy(target.mirrorId, { sourceMirrorId: source.mirrorId, copyLooks: true, copySettings: false, expectedRevision: target.get().revision });
    expect(target.get().settings.materialDrawerColumns).toBe(2);
    const copied = mirrors.copy(target.mirrorId, { sourceMirrorId: source.mirrorId, copyLooks: false, copySettings: true, expectedRevision: target.get().revision });
    expect(copied.settings.materialDrawerColumns).toBe(1);
    copied.settings.materialDrawerColumns = 2;
    expect(target.get().settings.materialDrawerColumns).toBe(1); expect(source.get()).toEqual(original);
    target.command({ action: 'configure', materialDrawerColumns: 2 }); expect(source.get()).toEqual(original);
    expect(new ExhibitionMirrors(path).getMirror(target.mirrorId).get().settings.materialDrawerColumns).toBe(2);
  });

  it('round-trips through the per-mirror HTTP API with validation and revision protection', async () => {
    const mirrors = new ExhibitionMirrors(directory());
    const providerAccess = vi.fn(() => { throw new Error('Column settings must not contact XMAX.'); });
    const service = new Proxy({} as TryOnService, { get: providerAccess });
    const origin = 'http://xuminghong.local:10200';
    const server = createApiServer(service, [origin], undefined, mirrors);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition/mirrors/default`;
      const before = mirrors.getMirror().get();
      const command = (body: unknown) => fetch(`${root}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
      const invalid = await command({ action: 'configure', materialDrawerColumns: '1', expectedRevision: before.revision });
      expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: 'EXHIBITION_INVALID_SETTINGS' });
      expect(mirrors.getMirror().get()).toEqual(before);
      const saved = await command({ action: 'configure', materialDrawerColumns: 1, expectedRevision: before.revision });
      expect(saved.status).toBe(200); expect(saved.headers.get('cache-control')).toBe('no-store');
      expect(await saved.json()).toMatchObject({ revision: before.revision + 1, settings: { materialDrawerColumns: 1 } });
      const stale = await command({ action: 'configure', materialDrawerColumns: 2, expectedRevision: before.revision });
      expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
      expect(await (await fetch(root)).json()).toEqual(mirrors.getMirror().get());
      expect(providerAccess).not.toHaveBeenCalled();
    } finally { server.close(); await once(server, 'close'); }
  });
});
