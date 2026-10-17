import { materialCatalogFixture } from './support/materialCatalogFixture';
import { act, createElement, useState } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExhibitionLive, type ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { ExhibitionState } from '../shared/exhibition';
import { createReactHost, flushReact } from './support/reactHost';
import { xmaxSessionFixture } from './support/xmaxSessionFixture';

const mocks = vi.hoisted(() => ({ api: vi.fn(), createXmaxClient: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, backend: {} }));
vi.mock('../src/exhibition/xmaxWebSdk', () => ({ createExhibitionSdk: () => ({ createXmaxClient: mocks.createXmaxClient, models: { realtime: (name: string) => name } }) }));
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; await flushReact(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
function state(): ExhibitionState {
  return materialCatalogFixture({ mirrorId: 'default', revision: 1, phase: 'generating', experienceMode: 'free', selectedLookId: 'look', displayedLookId: null,
    looks: [{ id: 'look', mode: 'free', name: '隔离效果', prompt: '背景换成森林', referenceKind: 'none', image: '/fixture.png', description: '', palette: '', category: '', tags: [], source: 'sample' }],
    enabledLookIds: ['look'], categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 0, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } });
}
async function fixture() {
  host = await createReactHost();
  const originalStop = vi.fn(); const cloneStops: ReturnType<typeof vi.fn>[] = [];
  const track = { readyState: 'live', stop: originalStop, onended: null, getSettings: () => ({ deviceId: 'camera-fixture' }), clone: () => { const stop = vi.fn(); cloneStops.push(stop); return { ...track, stop }; } };
  class Stream { constructor(private tracks: typeof track[]) {} getTracks() { return this.tracks; } getVideoTracks() { return this.tracks; } }
  vi.stubGlobal('MediaStream', Stream);
  const camera = new Stream([track]);
  const getUserMedia = vi.fn(async () => camera);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => []) } });
  let snapshot = state(); let live!: ExhibitionLiveController; let update!: (next: ExhibitionState) => void;
  const callbacks: any[] = [];
  const sdks: { disconnect: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }[] = [];
  const connect = vi.fn(async (_source: unknown, options: any) => {
    const id = callbacks.length + 1; callbacks.push(options);
    const sdk = { getSessionUid: () => `ums-hook-stop-${id}`, disconnect: vi.fn(async () => {}), set: vi.fn(async () => {}) };
    sdks.push(sdk); return xmaxSessionFixture(sdk, options);
  });
  mocks.createXmaxClient.mockReturnValue({ realtime: { connect } });
  const sessions = new Map<string, any>();
  const create = vi.fn((input: any) => {
    const session = { id: `hook-stop-${sessions.size + 1}`, token: 'tk-hook-stop-fixture', model: 'x2.0', status: 'active', sourceKind: 'camera', sourceId: 'fixture', sourceName: 'fixture', targetItemId: 'look',
      referenceAsset: '', refImageUrl: '', referenceVersion: 0, expiresAt: new Date(Date.now() + 120_000).toISOString(),
      exhibition: { mirrorId: 'default', deviceId: input.deviceId, lookId: 'look', sessionNumber: snapshot.sessionNumber, generationNumber: snapshot.generationNumber, mode: 'free', prompt: '背景换成森林' } };
    sessions.set(session.id, session); return session;
  });
  mocks.api.mockImplementation(async (url: string, _method: string, input: any) => {
    if (url.endsWith('/live/session')) return create(input);
    const id = /\/sessions\/([^/]+)/.exec(url)?.[1]; const session = id && sessions.get(id);
    if (url.endsWith('/link')) return { ...session, providerSessionId: input.providerSessionId };
    if (url.endsWith('/stop')) return { ...session, status: 'stopped' };
    return {};
  });
  function Harness() {
    const [current, setCurrent] = useState(snapshot);
    update = next => { snapshot = next; flushSync(() => setCurrent(next)); };
    live = useExhibitionLive({ state: current, active: true, refresh: async () => {} }); return null;
  }
  await host.render(createElement(Harness)); await flushReact();
  return { get live() { return live; }, get snapshot() { return snapshot; }, update, sdks, callbacks, create, getUserMedia, camera, originalStop, cloneStops };
}

describe('manual stop preserves preview and freezes the stopped generation', () => {
  it('stops generated work while keeping the original local camera available', async () => {
    const f = await fixture(); expect(f.create).toHaveBeenCalledOnce();
    await act(async () => { expect(await f.live.stopGeneration()).toBe(true); }); await flushReact();
    expect(f.live.cameraStream).toBe(f.camera); expect(f.live.status).toBe('preview');
    expect(f.originalStop).not.toHaveBeenCalled(); expect(f.cloneStops[0]).toHaveBeenCalledOnce();
    await act(async () => f.update({ ...f.snapshot, revision: 2 })); await flushReact();
    expect(f.create).toHaveBeenCalledOnce(); expect(f.getUserMedia).toHaveBeenCalledOnce();
  });

  it('ignores late stopped-generation callbacks and allows only a fresh generation to connect', async () => {
    const f = await fixture(); await act(async () => { await f.live.stopGeneration(); });
    await act(async () => { f.callbacks[0].onRemoteStream({}); f.callbacks[0].onRemoteVideoFirstFrame(); f.callbacks[0].onError('late'); }); await flushReact();
    expect(f.live.outputStream).toBeNull(); expect(f.live.status).toBe('preview');
    await act(async () => f.update({ ...f.snapshot, revision: 3, generationNumber: 2 })); await flushReact();
    expect(f.create).toHaveBeenCalledTimes(2); expect(f.getUserMedia).toHaveBeenCalledOnce();
  });

  it('waits for old SDK cleanup when changing the camera source', async () => {
    const f = await fixture(); const pending = deferred<void>(); f.sdks[0].disconnect.mockReturnValueOnce(pending.promise);
    await act(async () => { await f.live.startCamera('another-camera'); }); await flushReact();
    expect(f.create).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(); }); await flushReact();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.sdks[0].disconnect).toHaveBeenCalledOnce();
  });

  it('waits for previous-generation cleanup before starting the next generation', async () => {
    const f = await fixture(); const pending = deferred<void>(); f.sdks[0].disconnect.mockReturnValueOnce(pending.promise);
    let stopping!: Promise<boolean>;
    await act(async () => { stopping = f.live.stopGeneration(); }); await flushReact();
    await act(async () => f.update({ ...f.snapshot, revision: 2, generationNumber: 2 })); await flushReact();
    expect(f.create).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(); await stopping; }); await flushReact();
    expect(f.create).toHaveBeenCalledTimes(2);
    await act(async () => f.callbacks[1].onRemoteVideoFirstFrame()); await flushReact();
    expect(f.live.status).toBe('running'); expect(f.originalStop).not.toHaveBeenCalled();
  });
});
