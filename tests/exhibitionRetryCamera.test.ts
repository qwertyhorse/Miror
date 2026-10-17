import { materialCatalogFixture } from './support/materialCatalogFixture';
import { readyReferenceFixture, resolvedBinding } from './readyReferenceFixture';
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExhibitionLive, type ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import type { CreatedSession } from '../src/api';
import type { ExhibitionState } from '../shared/exhibition';
import { createReactHost, flushReact } from './support/reactHost';
import type { RealtimeConnectOptions } from '../src/exhibition/xmaxSdkContract';
import { xmaxSessionFixture } from './support/xmaxSessionFixture';

const mocks = vi.hoisted(() => {
  const sdk = { getSessionUid: vi.fn(() => 'provider-retry-fixture'), set: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
  const connect = vi.fn(async (_source: unknown, options: Pick<RealtimeConnectOptions, 'onStateChange'>) => xmaxSessionFixture(sdk, options));
  const uploadAndCheckImage = vi.fn(async () => ({ url: 'https://reference.fixture/garment.png' }));
  return { api: vi.fn(), sdk, connect, uploadAndCheckImage,
    createXmaxClient: vi.fn(() => ({ files: { uploadAndCheckImage }, realtime: { connect, connectMedia: connect } })),
    models: { realtime: vi.fn((name: string) => ({ name })) } };
});
vi.mock('../src/api', () => ({ api: mocks.api, backend: {} }));
vi.mock('../src/exhibition/xmaxWebSdk', () => ({ createExhibitionSdk: () => ({ createXmaxClient: mocks.createXmaxClient, models: mocks.models }) }));

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => {
  await host?.close(); host = undefined;
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function snapshot(overrides: Partial<ExhibitionState> = {}): ExhibitionState {
  return materialCatalogFixture({
    mirrorId: 'default', revision: 1, phase: 'paused', experienceMode: 'clothx', selectedLookId: 'look', displayedLookId: null,
    looks: [{ id: 'look', mode: 'clothx', name: '测试', image: '/reference.png', source: 'sample', description: '', category: '', tags: [], palette: '' }],
    enabledLookIds: ['look'], categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 0,
      uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } }, ...overrides,
  });
}
class FixtureStream {
  constructor(private tracks: ReturnType<typeof cameraTrack>[]) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks; }
}
function cameraTrack() {
  const track = { readyState: 'live', onended: null as null | (() => void),
    getSettings: () => ({ deviceId: 'camera-retry-fixture' }), clone: () => cameraTrack(), stop: vi.fn(() => { track.readyState = 'ended'; }) };
  return track;
}
function cameraStream() {
  const track = cameraTrack();
  return { track, stream: new FixtureStream([track]) as unknown as MediaStream };
}

async function fixture(initial = snapshot()) {
  host = await createReactHost();
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('MediaStream', FixtureStream);
  const camera = cameraStream();
  const getUserMedia = vi.fn(async () => camera.stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: async () => [] } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('garment-fixture', { headers: { 'Content-Type': 'image/png' } })));
  const refresh = vi.fn(async () => {});
  const stop = vi.fn(async () => ({ status: 'stopped' }));
  let live!: ExhibitionLiveController;
  let value = { state: initial, active: true, mirrorId: initial.mirrorId ?? 'default' };
  let update!: (state: ExhibitionState, options?: { active?: boolean; mirrorId?: string }) => void;
  let created: CreatedSession & { exhibition: { mirrorId: string; deviceId: string; lookId: string; sessionNumber: number; generationNumber: number } };
  mocks.api.mockImplementation(async (path: string, _method?: string, input?: Record<string, any>) => {
    if (path.includes('/references/')) return { reference: readyReferenceFixture('https://reference.fixture/garment.png') };
    if (path.endsWith('/live/status')) return { configured: true, perSessionLimit: 30 };
    if (path.endsWith('/live/session')) {
      created = { id: 'retry-session-fixture', token: 'temporary-retry-fixture', model: 'x2.0', status: 'active', sourceId: 'camera-fixture', sourceKind: 'camera',
        sourceName: '摄像头', targetItemId: 'look', referenceScope: 'account-scope', referenceAsset: '/reference.png', refImageUrl: 'https://reference.fixture/garment.png', referenceVersion: 1,
        expiresAt: new Date(Date.now() + 120_000).toISOString(), pointsLimit: 30, consumedCredits: 0, resultAvailable: false, verification: 'none',
        exhibition: { mirrorId: value.mirrorId, deviceId: input!.deviceId, lookId: input!.lookId,
          sessionNumber: value.state.sessionNumber, generationNumber: input!.generationNumber } };
      return created;
    }
    if (path.endsWith('/reference')) return { ...created, refImageUrl: resolvedBinding(input!.bindingId), referenceVersion: 1 };
    if (path.endsWith('/link')) return { ...created, providerSessionId: input!.providerSessionId, referenceVersion: 1 };
    if (path.endsWith('/live/heartbeat') || path.endsWith('/live/error')) return {};
    if (path.endsWith('/stop')) return stop();
    throw new Error(`Unexpected fixture API path: ${path}`);
  });
  function Harness() {
    const [current, setCurrent] = useState(value);
    value = current;
    update = (state, options = {}) => setCurrent({ state, active: options.active ?? current.active, mirrorId: options.mirrorId ?? current.mirrorId });
    live = useExhibitionLive({ ...current, refresh });
    return null;
  }
  await host.render(createElement(Harness)); await flushReact();
  return { get live() { return live; }, update, camera, getUserMedia, refresh, stop,
    allocationCount: () => mocks.api.mock.calls.filter(([path]) => String(path).endsWith('/live/session')).length };
}

describe('exhibition retry keeps the local camera independent of cloud failures', () => {
  it('reuses a healthy camera grant without stopping it, requesting permission or allocating while paused', async () => {
    const f = await fixture();
    expect(f.live.cameraStream).toBe(f.camera.stream);
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
    let result: boolean | undefined;
    await act(async () => { result = await f.live.retry(); }); await flushReact();
    expect(result).toBe(true); expect(f.live.cameraStream).toBe(f.camera.stream);
    expect(f.live.status).toBe('preview'); expect(f.live.opening).toBe(false);
    expect(f.camera.track.stop).not.toHaveBeenCalled(); expect(f.getUserMedia).toHaveBeenCalledTimes(1);
    expect(f.refresh).toHaveBeenCalledOnce(); expect(f.allocationCount()).toBe(0);
  });

  it('reopens an ended camera grant only when the user retries', async () => {
    const f = await fixture(); const replacement = cameraStream();
    f.camera.track.readyState = 'ended';
    f.getUserMedia.mockResolvedValueOnce(replacement.stream);
    let result: boolean | undefined;
    await act(async () => { result = await f.live.retry(); }); await flushReact();
    expect(result).toBe(true); expect(f.live.cameraStream).toBe(replacement.stream);
    expect(f.camera.track.stop).toHaveBeenCalledOnce(); expect(replacement.track.stop).not.toHaveBeenCalled();
    expect(f.getUserMedia).toHaveBeenCalledTimes(2); expect(f.allocationCount()).toBe(0);
  });

  it('waits for the old credential stop while keeping the healthy camera, then still requires manual continuation', async () => {
    const f = await fixture(snapshot({ phase: 'generating' }));
    expect(f.allocationCount()).toBe(1); expect(mocks.connect).toHaveBeenCalledOnce();
    const stopping = deferred<{ status: string }>(); f.stop.mockImplementationOnce(() => stopping.promise);
    let retry!: Promise<boolean>;
    await act(async () => { retry = f.live.retry(); await Promise.resolve(); });
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.live.opening).toBe(true);
    expect(f.camera.track.stop).not.toHaveBeenCalled(); expect(f.getUserMedia).toHaveBeenCalledTimes(1);
    expect(f.allocationCount()).toBe(1);
    await act(async () => f.update(snapshot({ phase: 'paused', revision: 2 })));
    let result: boolean | undefined;
    await act(async () => { stopping.resolve({ status: 'stopped' }); result = await retry; }); await flushReact();
    expect(result).toBe(true); expect(f.live.status).toBe('preview'); expect(f.live.cameraStream).toBe(f.camera.stream);
    expect(f.camera.track.stop).not.toHaveBeenCalled(); expect(f.allocationCount()).toBe(1);
  });

  it('does not reopen or allocate when the old credential stop is unconfirmed', async () => {
    const f = await fixture(snapshot({ phase: 'generating' }));
    expect(f.allocationCount()).toBe(1);
    f.stop.mockResolvedValueOnce({ status: 'active' });
    let result: boolean | undefined;
    await act(async () => { result = await f.live.retry(); }); await flushReact();
    expect(result).toBe(false); expect(f.live.error).toContain('停止状态未确认'); expect(f.live.status).toBe('error');
    expect(f.camera.track.stop).not.toHaveBeenCalled(); expect(f.live.cameraStream).toBe(f.camera.stream);
    expect(f.getUserMedia).toHaveBeenCalledTimes(1); expect(f.allocationCount()).toBe(1);
  });

  it('blocks a newer generation while retry is still confirming the previous stop', async () => {
    const f = await fixture(snapshot({ phase: 'generating' }));
    const stopping = deferred<{ status: string }>(); f.stop.mockImplementationOnce(() => stopping.promise);
    let retry!: Promise<boolean>;
    await act(async () => { retry = f.live.retry(); await Promise.resolve(); });

    await act(async () => f.update(snapshot({ phase: 'generating', generationNumber: 2, revision: 2 }))); await flushReact();
    expect(f.allocationCount()).toBe(1);
    expect(mocks.connect).toHaveBeenCalledOnce();

    await act(async () => { stopping.resolve({ status: 'stopped' }); await retry; }); await flushReact();
    expect(f.allocationCount()).toBe(2);
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('retains an unconfirmed stop across generation updates and retries that stop before allocating again', async () => {
    const f = await fixture(snapshot({ phase: 'generating' }));
    f.stop.mockResolvedValueOnce({ status: 'active' });
    await act(async () => { await f.live.retry(); }); await flushReact();

    await act(async () => f.update(snapshot({ phase: 'generating', generationNumber: 2, revision: 2 }))); await flushReact();
    expect(f.allocationCount()).toBe(1);
    expect(f.stop).toHaveBeenCalledOnce();

    let result: boolean | undefined;
    await act(async () => { result = await f.live.retry(); }); await flushReact();
    expect(result).toBe(true);
    expect(f.stop).toHaveBeenCalledTimes(2);
    expect(f.allocationCount()).toBe(2);
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it.each(['leave', 'stop-camera', 'end-round'] as const)('does not revive a retry cancelled by %s while refreshing', async cancellation => {
    const f = await fixture(); const refreshing = deferred<void>();
    f.refresh.mockImplementationOnce(() => refreshing.promise);
    let retry!: Promise<boolean>;
    await act(async () => { retry = f.live.retry(); await Promise.resolve(); });
    await act(async () => {
      if (cancellation === 'leave') f.update(snapshot(), { active: false });
      else if (cancellation === 'stop-camera') f.live.stopCamera();
      else f.update(snapshot({ phase: 'select', revision: 2 }));
    });
    let result: boolean | undefined;
    await act(async () => { refreshing.resolve(); result = await retry; }); await flushReact();
    expect(result).toBe(false); expect(f.getUserMedia).toHaveBeenCalledTimes(1); expect(f.allocationCount()).toBe(0);
    expect(f.live.opening).toBe(false);
    if (cancellation !== 'end-round') expect(f.live.cameraStream).toBeNull();
    else { expect(f.live.cameraStream).toBe(f.camera.stream); expect(f.live.status).toBe('preview'); }
  });

  it('does not let an A-to-B-to-A mirror transition revive an obsolete retry', async () => {
    const f = await fixture(); const refreshing = deferred<void>();
    f.refresh.mockImplementationOnce(() => refreshing.promise);
    let retry!: Promise<boolean>;
    await act(async () => { retry = f.live.retry(); await Promise.resolve(); });
    const east = cameraStream(); f.getUserMedia.mockResolvedValueOnce(east.stream);
    await act(async () => f.update(snapshot({ mirrorId: 'east' }), { mirrorId: 'east' })); await flushReact();
    const returned = cameraStream(); f.getUserMedia.mockResolvedValueOnce(returned.stream);
    await act(async () => f.update(snapshot(), { mirrorId: 'default' })); await flushReact();
    let result: boolean | undefined;
    await act(async () => { refreshing.resolve(); result = await retry; }); await flushReact();
    expect(result).toBe(false); expect(f.live.cameraStream).toBe(returned.stream);
    expect(f.getUserMedia).toHaveBeenCalledTimes(3); expect(returned.track.stop).not.toHaveBeenCalled(); expect(f.allocationCount()).toBe(0);
  });

  it('keeps MoX retry camera-free and does not allocate until manual continuation', async () => {
    const f = await fixture(snapshot({ experienceMode: 'mox' }));
    let result: boolean | undefined;
    await act(async () => { result = await f.live.retry(); }); await flushReact();
    expect(result).toBe(true); expect(f.live.cameraStream).toBeNull(); expect(f.live.status).toBe('off');
    expect(f.live.opening).toBe(false); expect(f.getUserMedia).not.toHaveBeenCalled(); expect(f.allocationCount()).toBe(0);
  });
});
