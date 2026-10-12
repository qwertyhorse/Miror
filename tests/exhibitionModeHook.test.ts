import { act, createElement, useState } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useExhibitionLive, type ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import { exhibitionPromptForLook, type ExhibitionState } from '../shared/exhibition';
import { createReactHost, flushReact } from './support/reactHost';

const mocks = vi.hoisted(() => ({ api: vi.fn(), createXmaxClient: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, backend: {} }));
vi.mock('@xmaxai/sdk-global', () => ({ createXmaxClient: mocks.createXmaxClient, models: { realtime: (name: string) => name } }));
vi.mock('../src/exhibition/OutfitCarousel', () => ({ OutfitCarousel: () => null }));
vi.mock('../src/exhibition/MoXDragSurface', () => ({ MoXDragSurface: () => null }));
vi.mock('../src/exhibition/LiveCameraPanel', () => ({ StreamVideo: () => null, LiveCameraPanel: () => null }));

function state(mode: ExhibitionState['experienceMode'] = 'mox'): ExhibitionState {
  return { mirrorId: 'default', revision: 4, phase: 'generating', experienceMode: mode, selectedLookId: 'look', displayedLookId: null,
    looks: [{ id: 'look', mode, name: '测试素材', description: '', image: '/test.png', source: 'upload', palette: '', category: '', tags: [] }], enabledLookIds: ['look'],
    categories: [], tags: [], sessionNumber: 1, generationNumber: 1, updatedAt: 1000, generationReadyAt: null, providerMode: 'xmax', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => { await host?.close(); host = undefined; await flushReact(); vi.unstubAllGlobals(); });

async function fixture(initial = state(), renderKiosk = false) {
  host = await createReactHost();
  const media = { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) };
  vi.stubGlobal('navigator', { mediaDevices: media });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['fixture'], { type: 'image/png' }))));
  let snapshot = initial;
  let result!: ExhibitionLiveController;
  let update!: (next: ExhibitionState) => void;
  const callbacks: any[] = [];
  const sdk = { getSessionUid: () => 'provider', disconnect: vi.fn(async () => {}), set: vi.fn(async () => {}),
    media: { streamSetting: { width: 512, height: 768 } }, beginDrag: vi.fn(), endDrag: vi.fn(), sendTracks: vi.fn(async () => {}) };
  const connect = vi.fn(async (_source: unknown, options: any) => { callbacks.push(options); return sdk; });
  const upload = vi.fn(async () => ({ url: 'https://mock.test/ref.png' }));
  mocks.createXmaxClient.mockReturnValue({ files: { uploadAndCheckImage: upload }, realtime: { connectMedia: connect, connect } });
  let session: any;
  let count = 0;
  const create = vi.fn((input: any) => {
    session = { id: `session-${++count}`, token: 'test-only', model: 'x2.0', sourceKind: snapshot.experienceMode === 'mox' ? 'photo' : 'camera', referenceAsset: snapshot.looks[0].referenceKind === 'none' ? '' : '/test.png', refImageUrl: '', referenceVersion: 0, expiresAt: new Date(Date.now() + 120000).toISOString(),
      exhibition: { mirrorId: 'default', deviceId: input.deviceId, lookId: 'look', sessionNumber: snapshot.sessionNumber, generationNumber: snapshot.generationNumber, mode: snapshot.experienceMode, prompt: exhibitionPromptForLook(snapshot.looks[0]) } };
    return session;
  });
  mocks.api.mockImplementation(async (url: string, _method: string, input: any) => {
    if (url.endsWith('/live/session')) return create(input);
    if (url.endsWith('/reference')) return { ...session, refImageUrl: input.refImageUrl, referenceVersion: 1 };
    if (url.endsWith('/link')) return { ...session, providerSessionId: input.providerSessionId, referenceVersion: session.referenceAsset ? 1 : 0 };
    if (url.endsWith('/stop')) return { ...session, status: 'stopped' };
    return {};
  });
  const refresh = vi.fn(async () => {});
  const send = vi.fn(async () => true);
  function Harness() {
    const [current, setCurrent] = useState(snapshot);
    update = next => { snapshot = next; flushSync(() => setCurrent(next)); };
    result = useExhibitionLive({ state: current, active: true, refresh });
    return renderKiosk ? createElement(Kiosk, { state: current, live: result, send }) : null;
  }
  await host.render(createElement(Harness)); await flushReact();
  return { get live() { return result; }, update: (next: ExhibitionState) => update(next), sdk, connect, create, callbacks, media, refresh, send, upload };
}

describe('live hook effects for MoX and mode changes', () => {
  it('passes a prompt-only Free look through camera connection without uploading its display cover', async () => {
    const initial = state('free');
    initial.looks[0] = { ...initial.looks[0], prompt: '保持动作，背景变成童话森林', referenceKind: 'none' };
    const f = await fixture(initial);
    const track = { readyState: 'live', stop: vi.fn(), getSettings: () => ({ deviceId: 'camera-a' }), clone: vi.fn(), onended: null };
    track.clone.mockReturnValue({ ...track, stop: vi.fn() });
    class TestStream {
      constructor(private tracks: typeof track[]) {}
      getVideoTracks() { return this.tracks; }
      getTracks() { return this.tracks; }
    }
    vi.stubGlobal('MediaStream', TestStream);
    const camera = new TestStream([track]) as unknown as MediaStream;
    f.media.getUserMedia.mockResolvedValueOnce(camera);
    expect(f.create).not.toHaveBeenCalled();
    await act(async () => { await f.live.startCamera(); }); await flushReact();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.some(([path]) => path.endsWith('/reference'))).toBe(false);
    expect(f.callbacks[0].context).toEqual({ prompt: '保持动作，背景变成童话森林' });
    expect(f.sdk.set).toHaveBeenCalledExactlyOnceWith({ prompt: '保持动作，背景变成童话森林' });
    expect(f.connect.mock.calls[0][0]).toBeInstanceOf(TestStream);
  });

  it('starts MoX without requesting camera permission', async () => {
    const f = await fixture();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.live.interaction).toMatchObject({ width: 512, height: 768 });
    await act(async () => { await f.live.startCamera(); });
    expect(f.media.getUserMedia).not.toHaveBeenCalled();
    expect(f.connect.mock.calls[0][0]).toBeInstanceOf(File);
  });
  it('retries a failed MoX generation without any phase or camera change', async () => {
    const f = await fixture();
    await act(async () => f.callbacks[0].onError(new Error('mock connection failure')));
    await flushReact();
    expect(f.live.error).not.toBe('');
    expect(f.sdk.disconnect).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
    let retried = false;
    await act(async () => { retried = await f.live.retry(); });
    await flushReact();
    expect(retried).toBe(true);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.sdk.set).toHaveBeenCalledTimes(2);
    expect(f.live.interaction).not.toBeNull();
    expect(f.media.getUserMedia).not.toHaveBeenCalled();
  });
  it('uses the refreshed paused phase when the visible generating error is retried', async () => {
    const f = await fixture(state(), true);
    await act(async () => f.callbacks[0].onError(new Error('mock connection failure')));
    await flushReact();
    const retryButton = host!.find(node => node.getReactProps().className === 'ex-kiosk-retry');
    expect(retryButton).toBeDefined();
    f.refresh.mockImplementationOnce(async () => { f.update({ ...state(), phase: 'paused', revision: 7 }); });
    f.send.mockImplementationOnce(async () => {
      f.update({ ...state(), phase: 'generating', generationNumber: 2, revision: 8 });
      return true;
    });
    await act(async () => { await retryButton!.getReactProps().onClick(); });
    await flushReact();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'resume' });
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.live.interaction).not.toBeNull();
    expect(f.media.getUserMedia).not.toHaveBeenCalled();
  });
  it('does not resume or reconnect if refresh shows the experience has ended', async () => {
    const f = await fixture(state(), true);
    await act(async () => f.callbacks[0].onError(new Error('mock connection failure')));
    await flushReact();
    const retryButton = host!.find(node => node.getReactProps().className === 'ex-kiosk-retry');
    f.refresh.mockImplementationOnce(async () => { f.update({ ...state(), phase: 'idle', revision: 8 }); });
    await act(async () => { await retryButton!.getReactProps().onClick(); });
    await flushReact();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.live.opening).toBe(false);
    expect(f.live.interaction).toBeNull();
  });
  it('disposes a pending camera result when the mode changes to MoX', async () => {
    const f = await fixture({ ...state('clothx'), phase: 'idle' });
    const pending = deferred<MediaStream>();
    f.media.getUserMedia.mockReturnValueOnce(pending.promise);
    let opening!: Promise<void>;
    await act(async () => { opening = f.live.startCamera(); });
    expect(f.live.opening).toBe(true);
    await act(async () => f.update({ ...state(), phase: 'idle', revision: 5 }));
    const stop = vi.fn();
    const stream = { getVideoTracks: () => [{ readyState: 'live', stop }], getTracks: () => [{ stop }] } as unknown as MediaStream;
    await act(async () => { pending.resolve(stream); await opening; });
    await flushReact();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(f.live.cameraStream).toBeNull();
    expect(f.live.opening).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.media.enumerateDevices).not.toHaveBeenCalled();
  });
  it('ignores old presentation and stream callbacks after mode switch and a new session', async () => {
    const f = await fixture();
    const old = f.callbacks[0];
    const original = { instant: true, inputImageUrl: 'blob:old', showInputImage: true, suppressLoading: true };
    await act(async () => old.onPresentationChange(original));
    expect(f.live.presentation).toEqual(original);
    await act(async () => f.update({ ...state('clothx'), phase: 'idle', revision: 5 }));
    expect(f.live.presentation).toBeNull(); expect(f.live.interaction).toBeNull();
    await act(async () => f.update({ ...state(), generationNumber: 2, revision: 6 }));
    await flushReact();
    expect(f.create).toHaveBeenCalledTimes(2);
    const current = { ...original, inputImageUrl: 'blob:current', showInputImage: false };
    await act(async () => f.callbacks[1].onPresentationChange(current));
    await act(async () => {
      old.onPresentationChange(original);
      old.onRemoteStream({} as MediaStream);
      old.onDisconnect();
      old.onError(new Error('late error'));
    });
    expect(f.live.presentation).toEqual(current);
    expect(f.live.outputStream).toBeNull();
    expect(f.live.error).toBe('');
    expect(f.live.interaction).not.toBeNull();
    expect(f.sdk.disconnect).toHaveBeenCalledTimes(1);
  });
});
