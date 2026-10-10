import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionMirrorClient } from '../src/exhibition/useExhibition';
import { exhibitionApiPath, exhibitionUrl } from '../src/exhibition/mirrorApi';
import { appUrl } from '../src/versionScope';
import type { ExhibitionState } from '../shared/exhibition';

const clients: ExhibitionMirrorClient[] = [];
function client(id = 'default') { const value = new ExhibitionMirrorClient(id); clients.push(value); return value; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function state(mirrorId: string, revision = 1, name = mirrorId): ExhibitionState {
  return { mirrorId, revision, phase: 'select', selectedLookId: 'commute', displayedLookId: null,
    enabledLookIds: ['commute'], looks: [{ id: 'commute', name, description: '', image: '/asset.png', palette: '', category: '通勤', tags: [], source: 'sample' }],
    categories: ['通勤'], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
    settings: { autoReturnSeconds: 0, uploadLimits: { maxFileSizeMB: 10, minWidth: 512, maxWidth: 4096, minHeight: 512, maxHeight: 4096 } },
    providerMode: 'demo', live: null, logs: [] };
}
const response = (value: unknown, status = 200) => Response.json(value, { status });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { clients.splice(0).forEach(value => value.stop()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('mirror-scoped exhibition client', () => {
  it('binds every mutation and copy to its initiating mirror and retains revision checks', async () => {
    let revision = 3;
    const fetcher = vi.fn(async () => response(state('east', revision++)));
    vi.stubGlobal('fetch', fetcher);
    const east = client('east'); east.start(); await flush();
    await east.send({ action: 'begin' });
    const uploaded = await east.upload({ name: '服装', category: '通勤', tags: [], imageBase64: 'fixture' });
    expect(uploaded).toEqual({ lookId: 'commute', index: 0 });
    await east.updateLook('uploaded/id', { name: '新名称', category: '通勤', tags: [] });
    await east.deleteLook('uploaded/id', { expectedRevision: 6 });
    await east.saveTaxonomy({ categories: ['通勤'], tags: ['简约'] });
    await east.copyData({ sourceMirrorId: 'west', copyLooks: true, copySettings: false, expectedRevision: 8 });
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual(['', 'command', 'looks', 'looks/uploaded%2Fid', 'looks/uploaded%2Fid', 'taxonomy', 'copy']
      .map(path => appUrl(`/api${exhibitionApiPath(path, 'east')}`)));
    expect(calls.slice(1).map(([, init]) => init.method)).toEqual(['POST', 'POST', 'PATCH', 'DELETE', 'POST', 'POST']);
    expect(JSON.parse(calls[1][1].body as string)).toMatchObject({ expectedRevision: 3 });
    expect(JSON.parse(calls[2][1].body as string)).not.toHaveProperty('expectedRevision');
    expect(JSON.parse(calls.at(-1)![1].body as string)).toEqual({ sourceMirrorId: 'west', copyLooks: true, copySettings: false, expectedRevision: 8 });
    expect(east.getSnapshot()).toMatchObject({ pending: false, connected: true, state: { mirrorId: 'east', revision: 9 } });
  });

  it('aborts the old poll and ignores a late equal-revision response after switching mirrors', async () => {
    const old = deferred<Response>();
    const fetcher = vi.fn((url: string) => url.endsWith('/east') ? old.promise : Promise.resolve(response(state('west', 7))));
    vi.stubGlobal('fetch', fetcher);
    const east = client('east'); const events = vi.fn(); east.subscribe(events); east.start();
    const firstSignal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    east.stop();
    const west = client('west'); west.start(); await flush();
    const stoppedEvents = events.mock.calls.length;
    expect(firstSignal.aborted).toBe(true);
    old.resolve(response(state('east', 7))); await flush();
    expect(events).toHaveBeenCalledTimes(stoppedEvents);
    expect(east.getSnapshot().state).toBeNull();
    expect(west.getSnapshot()).toMatchObject({ state: { mirrorId: 'west', revision: 7 }, connected: true });
    await vi.advanceTimersByTimeAsync(850);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/east'))).toHaveLength(1);
  });

  it('uses an epoch even when a stopped client restarts on the same mirror', async () => {
    const old = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(response(state('east', 4, '新一轮')));
    vi.stubGlobal('fetch', fetcher);
    const east = client('east'); east.start(); east.stop(); east.start(); await flush();
    old.resolve(response(state('east', 999, '旧一轮'))); await flush();
    expect(east.getSnapshot().state?.looks[0].name).toBe('新一轮');
    expect(east.getSnapshot().state?.revision).toBe(4);
  });

  it('does not complete an old upload into the new mirror or clear its pending command', async () => {
    const upload = deferred<Response>(); const command = deferred<Response>();
    const fetcher = vi.fn((url: string) => url.endsWith('/looks') ? upload.promise : url.endsWith('/command') ? command.promise
      : Promise.resolve(response(state(url.endsWith('/east') ? 'east' : 'west', 5))));
    vi.stubGlobal('fetch', fetcher);
    const east = client('east'); east.start(); await flush();
    const saving = east.upload({ name: '旧素材', category: '通勤', tags: [], imageBase64: 'fixture' });
    const uploadSignal = (fetcher.mock.calls.at(-1) as unknown as [string, RequestInit])[1].signal!;
    east.stop();
    const west = client('west'); west.start(); await flush();
    const sending = west.send({ action: 'begin' });
    expect(uploadSignal.aborted).toBe(true);
    upload.resolve(response(state('east', 6))); expect(await saving).toBeNull();
    expect(west.getSnapshot()).toMatchObject({ pending: true, state: { mirrorId: 'west', revision: 5 }, error: '' });
    command.resolve(response(state('west', 6))); expect(await sending).toBe(true);
    expect(west.getSnapshot()).toMatchObject({ pending: false, state: { mirrorId: 'west', revision: 6 } });
  });

  it('rejects a wrong-mirror mutation result before adopting state or signaling success', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(state('east', 2))).mockResolvedValueOnce(response(state('west', 100)));
    vi.stubGlobal('fetch', fetcher);
    const east = client('east'); east.start(); await flush();
    expect(await east.send({ action: 'begin' })).toBe(false);
    expect(east.getSnapshot()).toMatchObject({ state: { mirrorId: 'east', revision: 2 }, pending: false, error: expect.stringContaining('不匹配') });
  });

  it('fails explicitly for an unknown mirror and accepts metadata-free responses only for default', async () => {
    const legacy = state('default'); delete legacy.mirrorId;
    const fetcher = vi.fn().mockResolvedValueOnce(response({ message: '未找到这面试衣镜。' }, 404))
      .mockResolvedValueOnce(response(legacy)).mockResolvedValueOnce(response(legacy));
    vi.stubGlobal('fetch', fetcher);
    const missing = client('missing'); missing.start(); await flush();
    expect(missing.getSnapshot()).toMatchObject({ state: null, connected: false, error: '未找到这面试衣镜。' });
    const east = client('east'); east.start(); await flush();
    expect(east.getSnapshot()).toMatchObject({ state: null, connected: false, error: expect.stringContaining('不匹配') });
    const legacyClient = client(); legacyClient.start(); await flush();
    expect(legacyClient.getSnapshot()).toMatchObject({ connected: true, state: { revision: 1 } });
  });

  it('refreshes a stale mutation against the same mirror and keeps the actionable error', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(state('east', 2)))
      .mockResolvedValueOnce(response({ code: 'EXHIBITION_STALE_REVISION', message: 'stale' }, 409))
      .mockImplementation(async () => response(state('east', 3)));
    vi.stubGlobal('fetch', fetcher);
    const east = client('east'); east.start(); await flush();
    expect(await east.deleteLook('commute', { expectedRevision: 2 })).toBe(false);
    await east.refresh();
    expect(east.getSnapshot()).toMatchObject({ state: { revision: 3 }, pending: false, error: '后台状态已变化，请重新打开素材后再删除。' });
  });

  it('allows large copy operations longer than a normal request but aborts them on departure', async () => {
    const copying = deferred<Response>();
    const fetcher = vi.fn((url: string) => url.endsWith('/copy') ? copying.promise : Promise.resolve(response(state('east', 2))));
    vi.stubGlobal('fetch', fetcher);
    const east = client('east'); east.start(); await flush();
    const saving = east.copyData({ sourceMirrorId: 'west', copyLooks: true, copySettings: true, expectedRevision: 2 });
    const signal = (fetcher.mock.calls.at(-1) as unknown as [string, RequestInit])[1].signal!;
    await vi.advanceTimersByTimeAsync(6000);
    expect(signal.aborted).toBe(false);
    east.stop(); expect(signal.aborted).toBe(true);
    copying.resolve(response(state('east', 3))); expect(await saving).toBe(false);
  });

  it('uploads and removes a skin on the initiating mirror with revision checks and adopts the result', async () => {
    const current = state('east', 2);
    const saved = state('east', 3);
    saved.settings.uiSkin = { image: '/api/exhibition/mirrors/east/skin/skin-id', width: 1080, height: 1920, bytes: 1234 };
    const restored = state('east', 4); restored.settings.uiSkin = null;
    const fetcher = vi.fn().mockResolvedValueOnce(response(current)).mockResolvedValueOnce(response(saved)).mockResolvedValueOnce(response(restored));
    vi.stubGlobal('fetch', fetcher);
    const east = client('east'); east.start(); await flush();
    expect(await east.uploadUiSkin({ imageBase64: 'data:image/png;base64,fixture', expectedRevision: 2 })).toBe(true);
    expect(east.getSnapshot().state?.settings.uiSkin).toEqual(saved.settings.uiSkin);
    expect(await east.removeUiSkin()).toBe(true);
    expect(east.getSnapshot().state?.settings.uiSkin).toBeNull();
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.slice(1).map(([url, init]) => [url, init.method, JSON.parse(init.body as string)])).toEqual([
      [appUrl(`/api${exhibitionApiPath('skin', 'east')}`), 'POST', { imageBase64: 'data:image/png;base64,fixture', expectedRevision: 2 }],
      [appUrl(`/api${exhibitionApiPath('skin', 'east')}`), 'DELETE', { expectedRevision: 3 }],
    ]);
  });

  it('keeps skin uploads alive beyond the normal timeout and aborts them on mirror departure', async () => {
    const uploading = deferred<Response>();
    const fetcher = vi.fn((url: string) => url.endsWith('/skin') ? uploading.promise : Promise.resolve(response(state('east', 2))));
    vi.stubGlobal('fetch', fetcher);
    const east = client('east'); east.start(); await flush();
    const saving = east.uploadUiSkin({ imageBase64: 'fixture' });
    const signal = (fetcher.mock.calls.at(-1) as unknown as [string, RequestInit])[1].signal!;
    await vi.advanceTimersByTimeAsync(6000);
    expect(signal.aborted).toBe(false);
    east.stop(); expect(signal.aborted).toBe(true);
    uploading.resolve(response(state('east', 3))); expect(await saving).toBe(false);
  });

  it('refreshes a stale skin upload and explains how to retry without replacing the latest skin', async () => {
    const latest = state('east', 3); latest.settings.uiSkin = { image: '/latest.webp', width: 1080, height: 1920, bytes: 1000 };
    const fetcher = vi.fn().mockResolvedValueOnce(response(state('east', 2)))
      .mockResolvedValueOnce(response({ code: 'EXHIBITION_STALE_REVISION' }, 409)).mockResolvedValueOnce(response(latest));
    vi.stubGlobal('fetch', fetcher);
    const east = client('east'); east.start(); await flush();
    expect(await east.uploadUiSkin({ imageBase64: 'fixture', expectedRevision: 2 })).toBe(false);
    expect(east.getSnapshot()).toMatchObject({ pending: false, state: latest, error: '后台状态已变化，请重新选择皮肤后再保存。' });
  });
});

describe('mirror navigation URLs', () => {
  it('keeps existing options and fragments, replaces stale mirror bindings and versions relative links', () => {
    expect(exhibitionUrl('/exhibition/control?mode=touch&mirror=old#wardrobe', 'east')).toBe(appUrl('/exhibition/control?mode=touch&mirror=east#wardrobe'));
    expect(exhibitionUrl('/exhibition/screen')).toBe(appUrl('/exhibition/screen?mirror=default'));
    expect(exhibitionUrl('https://xuminghong.local:10202/v1.1/exhibition/screen?mode=touch', 'east')).toBe('https://xuminghong.local:10202/v1.1/exhibition/screen?mode=touch&mirror=east');
    expect(exhibitionApiPath('/sessions/abc/stop', 'floor/2')).toBe('/exhibition/mirrors/floor%2F2/sessions/abc/stop');
  });
});
