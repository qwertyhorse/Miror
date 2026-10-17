import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExhibitionSdk } from '../src/exhibition/xmaxWebSdk';
import { connectXmaxWithLifecycle } from '../src/exhibition/xmaxRealtimeLifecycle';
import type { RealtimeConnectOptions } from '../src/exhibition/xmaxSdkContract';

const sdk = vi.hoisted(() => ({ client: vi.fn(), manager: vi.fn(), media: vi.fn(), register: vi.fn(), videoInput: vi.fn() }));
vi.mock('@xmaxai/web-sdk', () => ({
  XmaxConfiguration: class { constructor(options: object) { Object.assign(this, options); } },
  RealtimeConfiguration: class { constructor(options: object) { Object.assign(this, options); } },
  RealtimeVideoFormat: class { constructor(options: object) { Object.assign(this, options); } },
  RealtimeContext: class {
    prompt: string; referencePath?: string;
    constructor(options: { prompt: string; referencePath?: string }) { this.prompt = options.prompt; this.referencePath = options.referencePath?.trim() || undefined; }
  },
  XmaxEnvironment: { china: 'china', global: 'global' }, XmaxLoggerOption: { none: 0, all: 3 },
  apiBaseURL: (environment: string) => environment === 'china' ? 'https://china.example/api' : 'https://global.example/api',
  defaultCameraVideoFormat: () => ({ width: 1024, height: 1920, fps: 30 }),
  XmaxClient: class {
    constructor(configuration: object) { sdk.client(configuration); }
    createRealtimeManager(configuration: object) { return sdk.manager(configuration); }
    createMediaService(model: string) { return sdk.media(model); }
  },
}));
vi.mock('../src/exhibition/xmaxVideoBinding', () => ({ registerXmaxVideoStream: sdk.register }));
vi.mock('../src/exhibition/xmaxCameraStream', () => ({ prepareXmaxVideoInput: sdk.videoInput }));

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
function track(width = 1024, height = 1920, frameRate = 30) {
  const value = Object.assign(new EventTarget(), { readyState: 'live', kind: 'video', getSettings: () => ({ width, height, frameRate }), stop: vi.fn(), clone: vi.fn() });
  value.clone.mockImplementation(() => track(width, height, frameRate));
  return value;
}
type Track = ReturnType<typeof track>;
class Stream {
  constructor(private tracks: Track[] = []) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks; }
}
function fixture(width = 1024, height = 1920, frameRate = 30) {
  const original = track(width, height, frameRate);
  const source = new Stream([original]) as unknown as MediaStream;
  const disposeInput = vi.fn();
  sdk.videoInput.mockResolvedValue({ stream: source, dispose: disposeInput });
  const remoteTrack = { mediaStreamTrack: undefined as Track | undefined, stop: vi.fn() };
  const remote = { videoTrack: remoteTrack };
  const local = { videoTrack: { mediaStreamTrack: undefined as Track | undefined } };
  type State = { connectionState: string; sessionID?: string; reason?: { kind: string; error: unknown } };
  let listener: ((state: State) => void) | undefined;
  const manager = {
    currentState: { connectionState: 'Idle' } as State,
    setStateListener: vi.fn(async (callback?: (state: State) => void) => { listener = callback; callback?.(manager.currentState); }),
    setLocalAudioVolume: vi.fn(async () => {}), setRemoteAudioVolume: vi.fn(async () => {}),
    createExternalVideoStream: vi.fn(async ({ videoTrack }: { videoTrack: Track }) => { local.videoTrack.mediaStreamTrack = videoTrack.clone(); return local; }),
    createLocalImageStream: vi.fn(async () => local), updateUplinkVideoFormat: vi.fn(async () => {}),
    connect: vi.fn(async () => { emit('Connected', 'session-123'); return remote; }),
    startGeneration: vi.fn(async () => { remoteTrack.mediaStreamTrack = track(); emit('Starting', 'session-123'); return remote; }),
    close: vi.fn(async () => { emit('Idle'); local.videoTrack.mediaStreamTrack?.stop(); }),
  };
  function emit(connectionState: string, sessionID?: string, error?: unknown) {
    manager.currentState = { connectionState, sessionID, ...(error ? { reason: { kind: 'failure', error } } : {}) };
    listener?.(manager.currentState);
  }
  const resolveModelInputSize = vi.fn((size: { width: number; height: number }) => {
    if (!((size.width === 1024 && size.height === 1920) || (size.width === 1920 && size.height === 1024))) throw new Error('Unsupported model input size');
    return size;
  });
  sdk.manager.mockReturnValue(manager); sdk.media.mockReturnValue({ resolveModelInputSize });
  const releases: ReturnType<typeof vi.fn>[] = [];
  const bindings = new Map<MediaStream, unknown>();
  sdk.register.mockImplementation((stream: MediaStream, value: unknown) => {
    bindings.set(stream, value); const cleanup = vi.fn(() => { bindings.delete(stream); }); releases.push(cleanup); return cleanup;
  });
  const onRemoteStream = vi.fn((stream: MediaStream) => { expect(bindings.get(stream)).toBe(remoteTrack); });
  const callbacks = { onRemoteStream, onRemoteVideoFirstFrame: vi.fn(), onError: vi.fn(), onDisconnect: vi.fn(), onStateChange: vi.fn() };
  const client = createExhibitionSdk('global').createXmaxClient({ apiKey: 'fixture-key', locale: 'zh', telemetry: false });
  const options: RealtimeConnectOptions = { model: { name: 'x2.1.1-preview-us' }, autoStart: false, context: { prompt: 'initial', refImageUrl: 'image-1' }, ...callbacks };
  return { original, source, local, remote, remoteTrack, manager, client, options, callbacks, emit, bindings, releases, resolveModelInputSize, disposeInput };
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('MediaStream', Stream); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('XMAX web SDK compatibility facade', () => {
  it.each([['cn', 'china', 'x2.1.1-preview-cn'], ['global', 'global', 'x2.1.1-preview-us']] as const)('uses explicit %s environment, model and business/performance logs', async (region, environment, model) => {
    const f = fixture(); sdk.client.mockClear();
    const facade = createExhibitionSdk(region);
    const client = facade.createXmaxClient({ apiKey: 'fixture-key', locale: 'zh', telemetry: false });
    expect(sdk.client).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ apiKey: 'fixture-key', environment, loggerOptions: 3 }));
    expect(facade.XMAX_OPEN_API_PRODUCTION_BASE_URL).toBe(`https://${environment}.example/api`);
    const session = await client.realtime.connect(f.source, { ...f.options, model: facade.models.realtime(model) });
    expect(sdk.manager).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model }));
    await session.disconnect();
  });

  it('rejects a model from another region before creating media or a realtime manager', async () => {
    const f = fixture();
    await expect(f.client.realtime.connect(f.source, { ...f.options, model: { name: 'x2.1.1-preview-cn' } })).rejects.toMatchObject({ code: 'MODEL_REGION_MISMATCH', details: { failure_stage: 'model_config' } });
    expect(sdk.manager).not.toHaveBeenCalled(); expect(sdk.media).not.toHaveBeenCalled(); expect(f.original.clone).not.toHaveBeenCalled();
  });

  it('connects without generation and exposes its session ID before the first set', async () => {
    const f = fixture(); const session = await f.client.realtime.connect(f.source, f.options);
    expect(session.getSessionUid()).toBe('session-123'); expect(session.nativeInteraction).toBe(true); expect(session.state).toBe('idle');
    expect(f.manager.startGeneration).not.toHaveBeenCalled(); expect(f.manager.connect).toHaveBeenCalledExactlyOnceWith(f.local);
    expect(f.manager.setLocalAudioVolume).toHaveBeenCalledExactlyOnceWith(0); expect(f.manager.setRemoteAudioVolume).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.callbacks.onRemoteStream).toHaveBeenCalledOnce(); expect(f.callbacks.onRemoteStream.mock.calls[0][0].getTracks()).toEqual([]);
    expect(f.callbacks.onRemoteVideoFirstFrame).not.toHaveBeenCalled(); await session.disconnect();
  });

  it('updates conditions within the associated session and explicitly clears an old reference', async () => {
    const f = fixture(); const session = await f.client.realtime.connect(f.source, f.options);
    await session.set({ prompt: 'first' }); await session.set({ prompt: 'second', refImageUrl: null }); await session.set({ prompt: 'third' });
    const requests = f.manager.startGeneration.mock.calls as unknown as Array<[{ localStream: unknown; faceRestoration: boolean; context: { prompt: string; referencePath: string | null } }]>;
    expect(requests.map(([value]) => value.context)).toEqual([
      { prompt: 'first', referencePath: 'image-1' }, { prompt: 'second', referencePath: null }, { prompt: 'third', referencePath: null },
    ]);
    expect(requests.every(([value]) => value.localStream === f.local)).toBe(true);
    expect(requests.map(([value]) => value.faceRestoration)).toEqual([true, true, true]);
    expect(sdk.manager).toHaveBeenCalledOnce(); expect(f.manager.connect).toHaveBeenCalledOnce();
    expect(f.callbacks.onRemoteStream.mock.calls.at(-1)![0].getVideoTracks()).toEqual([f.remoteTrack.mediaStreamTrack]);
    await session.disconnect(); expect(f.original.stop).not.toHaveBeenCalled(); expect(f.local.videoTrack.mediaStreamTrack!.stop).toHaveBeenCalledOnce();
  });

  it('uses the compatible input dimensions and keeps its relay alive until SDK release completes', async () => {
    const f = fixture(); const relayed = track(512, 960);
    const relayStream = new Stream([relayed]) as unknown as MediaStream;
    sdk.videoInput.mockResolvedValueOnce({ stream: relayStream, dispose: f.disposeInput });
    const session = await f.client.realtime.connect(f.source, f.options);
    expect(sdk.videoInput).toHaveBeenCalledExactlyOnceWith(f.source, undefined, expect.any(Function));
    expect(f.manager.createExternalVideoStream).toHaveBeenCalledExactlyOnceWith({ videoTrack: relayed, videoFormat: { width: 1024, height: 1920, fps: 30 } });
    expect(f.manager.updateUplinkVideoFormat).toHaveBeenCalledExactlyOnceWith({ width: 512, height: 960, fps: 30 });
    const closing = deferred<void>(); f.manager.close.mockReturnValueOnce(closing.promise);
    const pending = session.disconnect(); await flush();
    expect(f.disposeInput).not.toHaveBeenCalled(); closing.resolve(); await pending;
    expect(f.disposeInput).toHaveBeenCalledOnce(); expect(f.original.stop).not.toHaveBeenCalled();
    await session.disconnect(); expect(f.disposeInput).toHaveBeenCalledOnce();
  });

  it('reports an encoding failure at its actual stage and releases the relay', async () => {
    const f = fixture(512, 960);
    const failure = Object.assign(new Error('Agora operation failed (UNEXPECTED_ERROR)'), { code: 'RTC_ERROR' });
    f.manager.updateUplinkVideoFormat.mockImplementationOnce(async () => { f.emit('Idle', undefined, failure); throw failure; });
    await expect(f.client.realtime.connect(f.source, f.options)).rejects.toMatchObject({ details: { failure_stage: 'uplink_format' } });
    expect(f.callbacks.onError.mock.calls[0][1]).toMatchObject({ details: { failure_stage: 'uplink_format' } });
    expect(f.disposeInput).toHaveBeenCalledOnce(); expect(f.manager.connect).not.toHaveBeenCalled();
  });

  it.each([
    [2160, 3840, 1024, 1920, 1024, 1820],
    [3840, 2160, 1920, 1024, 1820, 1024],
  ])('selects the model before shrinking decoded %dx%d, even without track dimensions', async (width, height, modelWidth, modelHeight, inputWidth, inputHeight) => {
    const f = fixture(0, 0, 24); const relayed = track(inputWidth, inputHeight, 30);
    sdk.videoInput.mockImplementationOnce(async (source, signal, resolveSize) => {
      expect(source).toBe(f.source); expect(signal).toBeUndefined();
      expect(resolveSize({ width, height })).toEqual({ width: modelWidth, height: modelHeight, fps: 24 });
      return { stream: new Stream([relayed]), dispose: f.disposeInput };
    });
    const session = await f.client.realtime.connect(f.source, f.options);
    expect(f.resolveModelInputSize.mock.calls).toEqual([[{ width, height }], [{ width: modelWidth, height: modelHeight }]]);
    expect(f.manager.createExternalVideoStream).toHaveBeenCalledExactlyOnceWith({ videoTrack: relayed, videoFormat: { width: modelWidth, height: modelHeight, fps: 24 } });
    expect(f.manager.updateUplinkVideoFormat).toHaveBeenCalledExactlyOnceWith({ width: inputWidth, height: inputHeight, fps: 24 });
    expect(f.original.getSettings()).toEqual({ width: 0, height: 0, frameRate: 24 });
    await session.disconnect(); expect(f.disposeInput).toHaveBeenCalledOnce(); expect(f.original.stop).not.toHaveBeenCalled();
  });

  it('reports a relay interruption without waiting for a cloned SDK track to end', async () => {
    const f = fixture(); const relayed = track(512, 960);
    sdk.videoInput.mockResolvedValueOnce({ stream: new Stream([relayed]), dispose: f.disposeInput });
    const session = await f.client.realtime.connect(f.source, f.options);
    relayed.dispatchEvent(new Event('ended'));
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({
      code: 'CAMERA_INPUT_ERROR', details: { reason_code: 'local_outbound_track_ended', failure_stage: 'video_input' },
    }));
    await session.disconnect(); relayed.dispatchEvent(new Event('ended'));
    expect(f.callbacks.onError).toHaveBeenCalledOnce(); expect(f.original.stop).not.toHaveBeenCalled();
  });

  it('disposes a late relay when the borrowed source was silently stopped during preparation', async () => {
    const f = fixture(); const prepared = deferred<{ stream: MediaStream; dispose(): void }>();
    sdk.videoInput.mockReturnValueOnce(prepared.promise);
    const pending = f.client.realtime.connect(f.source, f.options).catch(error => error);
    await flush(); f.original.readyState = 'ended';
    prepared.resolve({ stream: new Stream([track(512, 960)]) as unknown as MediaStream, dispose: f.disposeInput });
    expect(await pending).toMatchObject({ code: 'CAMERA_INPUT_ERROR', details: { reason_code: 'local_outbound_track_ended' } });
    expect(f.manager.createExternalVideoStream).not.toHaveBeenCalled(); expect(f.manager.connect).not.toHaveBeenCalled();
    expect(f.disposeInput).toHaveBeenCalledOnce();
  });

  it('actively closes an in-flight join when the relay fails and rejects a late connected result', async () => {
    const f = fixture(); const relayed = track(512, 960); const joining = deferred<typeof f.remote>();
    sdk.videoInput.mockResolvedValueOnce({ stream: new Stream([relayed]), dispose: f.disposeInput });
    f.manager.connect.mockReturnValueOnce(joining.promise);
    const pending = f.client.realtime.connect(f.source, f.options).catch(error => error);
    await flush(); expect(f.manager.connect).toHaveBeenCalledOnce();
    relayed.dispatchEvent(new Event('ended')); await flush();
    expect(f.manager.close).toHaveBeenCalledOnce(); expect(f.disposeInput).toHaveBeenCalledOnce();
    joining.resolve(f.remote); expect(await pending).toMatchObject({ name: 'Error', code: 'SESSION_ERROR' });
    expect(f.callbacks.onRemoteStream).not.toHaveBeenCalled(); expect(f.callbacks.onError).toHaveBeenCalledOnce();
  });

  it.each([
    [512, 960, 30, 1024, 1920, 512, 960], [664, 1248, 24, 1024, 1920, 664, 1248],
    [818, 1536, 15, 1024, 1920, 818, 1536], [1024, 1920, 30, 1024, 1920, 1024, 1920],
    [3840, 2160, 60, 1920, 1024, 1820, 1024], [1080, 1920, 30, 1024, 1920, 1024, 1820],
    [513, 961, 30, 1024, 1920, 512, 960],
  ])('keeps %dx%d@%d source within its model bucket without upscaling', async (width, height, fps, generationWidth, generationHeight, uplinkWidth, uplinkHeight) => {
    const f = fixture(width, height, fps); const session = await f.client.realtime.connect(f.source, f.options);
    const expectedFps = Math.min(30, fps);
    expect(f.manager.createExternalVideoStream).toHaveBeenCalledExactlyOnceWith({ videoTrack: f.original, videoFormat: { width: generationWidth, height: generationHeight, fps: expectedFps } });
    if (generationWidth === uplinkWidth && generationHeight === uplinkHeight) expect(f.manager.updateUplinkVideoFormat).not.toHaveBeenCalled();
    else {
      expect(f.manager.updateUplinkVideoFormat).toHaveBeenCalledExactlyOnceWith({ width: uplinkWidth, height: uplinkHeight, fps: expectedFps });
      expect(f.manager.updateUplinkVideoFormat.mock.invocationCallOrder[0]).toBeGreaterThan(f.manager.createExternalVideoStream.mock.invocationCallOrder[0]);
      expect(f.manager.updateUplinkVideoFormat.mock.invocationCallOrder[0]).toBeLessThan(f.manager.connect.mock.invocationCallOrder[0]);
    }
    expect(f.resolveModelInputSize).toHaveBeenLastCalledWith({ width: generationWidth, height: generationHeight });
    expect(f.original.stop).not.toHaveBeenCalled(); await session.disconnect();
  });

  it('uses a decoded image with its model orientation and never opens a camera for connectMedia', async () => {
    const f = fixture(); const image = { width: 4000, height: 2000, close: vi.fn() }; vi.stubGlobal('createImageBitmap', vi.fn(async () => image));
    const file = new File(['image'], 'input.png', { type: 'image/png' });
    const session = await f.client.realtime.connectMedia(file, f.options);
    expect(image.close).toHaveBeenCalledOnce(); expect(f.manager.createLocalImageStream).toHaveBeenCalledExactlyOnceWith({ file, videoFormat: { width: 1920, height: 1024, fps: 30 } });
    expect(f.manager.createExternalVideoStream).not.toHaveBeenCalled(); expect(f.manager.startGeneration).not.toHaveBeenCalled();
    await session.set({ prompt: 'image prompt', refImageUrl: null }); await session.disconnect();
  });

  it('publishes delayed native tracks for Android while keeping SDK rendering bound to the same track', async () => {
    const f = fixture(); const session = await f.client.realtime.connect(f.source, f.options);
    const native = track(); f.remoteTrack.mediaStreamTrack = native;
    await vi.advanceTimersByTimeAsync(250); expect(f.callbacks.onRemoteStream).toHaveBeenCalledTimes(2);
    expect(f.callbacks.onRemoteStream.mock.calls[1][0].getVideoTracks()).toEqual([native]);
    await vi.advanceTimersByTimeAsync(1000); expect(f.callbacks.onRemoteStream).toHaveBeenCalledTimes(2);
    f.emit('Generating', 'session-123'); f.emit('Generating', 'session-123');
    expect(session.state).toBe('running'); expect(f.callbacks.onRemoteVideoFirstFrame).toHaveBeenCalledOnce();
    const replacement = track(); f.remoteTrack.mediaStreamTrack = replacement; await vi.advanceTimersByTimeAsync(250);
    expect(f.callbacks.onRemoteStream.mock.calls[2][0].getVideoTracks()).toEqual([replacement]);
    await session.disconnect(); expect(f.releases.every(release => release.mock.calls.length === 1)).toBe(true);
    expect(native.stop).not.toHaveBeenCalled(); expect(replacement.stop).not.toHaveBeenCalled(); expect(f.remoteTrack.stop).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for actual async release, shares close and suppresses intentional disconnect errors', async () => {
    const f = fixture(); const session = await f.client.realtime.connect(f.source, f.options); const closing = deferred<void>();
    f.manager.close.mockImplementationOnce(() => { f.emit('Idle'); f.emit('Idle', undefined, new Error('already closing')); return closing.promise; });
    let done = false; const first = session.disconnect(); const second = session.stopLocalStream(); expect(second).toBe(first);
    const result = first.then(() => { done = true; }); await flush();
    expect(done).toBe(false); expect(session.state).toBe('idle'); expect(f.callbacks.onStateChange).not.toHaveBeenCalled();
    expect(f.callbacks.onError).not.toHaveBeenCalled(); expect(f.callbacks.onDisconnect).not.toHaveBeenCalled();
    closing.resolve(); await result;
    expect(session.state).toBe('disconnected'); expect(f.callbacks.onStateChange).toHaveBeenCalledExactlyOnceWith('disconnected');
    await session.stopGeneration(); expect(f.manager.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a failed release retryable and reports terminal even if listener cleanup fails', async () => {
    const f = fixture(); const session = await f.client.realtime.connect(f.source, f.options);
    const error = new Error('release temporarily failed'); f.manager.close.mockRejectedValueOnce(error);
    await expect(session.disconnect()).rejects.toBe(error); expect(session.state).toBe('idle'); expect(f.callbacks.onStateChange).not.toHaveBeenCalled();
    f.manager.setStateListener.mockRejectedValueOnce(new Error('listener cleanup failed')); await session.disconnect();
    expect(f.manager.close).toHaveBeenCalledTimes(2); expect(session.state).toBe('disconnected');
    expect(f.callbacks.onStateChange).toHaveBeenCalledExactlyOnceWith('disconnected'); await session.disconnect(); expect(f.manager.close).toHaveBeenCalledTimes(2);
  });

  it('retries failed bootstrap cleanup and rejects only after confirmed release', async () => {
    const f = fixture(); const error = Object.assign(new Error('publish failed'), { code: 'RTC_ERROR' });
    f.manager.connect.mockRejectedValueOnce(error); const closing = deferred<void>();
    f.manager.close.mockRejectedValueOnce(new Error('release failed')).mockImplementationOnce(() => { f.emit('Idle'); return closing.promise; });
    let done = false;
    const pending = connectXmaxWithLifecycle(callbacks => f.client.realtime.connect(f.source, { ...f.options, ...callbacks }), f.callbacks).catch(cause => { done = true; return cause; });
    await flush(); expect(f.callbacks.onError).toHaveBeenCalledOnce(); expect(done).toBe(false); expect(f.manager.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); expect(f.manager.close).toHaveBeenCalledTimes(2); expect(done).toBe(false);
    closing.resolve(); expect(await pending).toMatchObject({ code: 'RTC_ERROR', details: { failure_stage: 'rtc_connect' } });
    expect(f.callbacks.onStateChange).toHaveBeenCalledExactlyOnceWith('disconnected'); expect(f.original.stop).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['rtc_connect', 'context_set'] as const)('retains native API business and HTTP evidence for %s failures', async stage => {
    const f = fixture();
    const error = Object.assign(new Error('用户积分余额不足'), {
      code: 'API_ERROR', apiCode: 46019, httpStatus: 200, token: 'tk-private', apiKey: 'uk-private',
    });
    let failure: unknown;
    if (stage === 'rtc_connect') {
      f.manager.connect.mockRejectedValueOnce(error);
      failure = await f.client.realtime.connect(f.source, f.options).catch(cause => cause);
    } else {
      const session = await f.client.realtime.connect(f.source, f.options);
      f.manager.startGeneration.mockRejectedValueOnce(error);
      failure = await session.set({ prompt: 'next outfit' }).catch(cause => cause);
    }
    expect(failure).toMatchObject({ message: '用户积分余额不足', code: 'API_ERROR',
      details: { business_code: 46019, http_status: 200, failure_stage: stage } });
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith('用户积分余额不足', failure);
    expect(failure).not.toHaveProperty('token'); expect(failure).not.toHaveProperty('apiKey');
    expect(JSON.stringify(failure)).not.toContain('private');
    expect(f.manager.close).toHaveBeenCalledOnce(); expect(f.original.stop).not.toHaveBeenCalled();
  });

  it('preserves existing normalized error details when native top-level fields are also present', async () => {
    const f = fixture();
    f.manager.connect.mockRejectedValueOnce(Object.assign(new Error('request rejected'), {
      code: 'API_ERROR', apiCode: 46019, httpStatus: 200,
      details: { business_code: 46001, http_status: 403, reason_code: 'remote_bind_failed' },
    }));
    await expect(f.client.realtime.connect(f.source, f.options)).rejects.toMatchObject({ code: 'API_ERROR',
      details: { business_code: 46001, http_status: 403, reason_code: 'remote_bind_failed', failure_stage: 'rtc_connect' } });
  });

  it('does not copy malformed native API fields or arbitrary error properties into diagnostics', async () => {
    const f = fixture();
    f.manager.connect.mockRejectedValueOnce(Object.assign(new Error('request rejected'), {
      code: 'API_ERROR', apiCode: { token: 'tk-private' }, httpStatus: NaN, token: 'tk-private',
    }));
    const error = await f.client.realtime.connect(f.source, f.options).catch(cause => cause);
    expect(error.details).toEqual({ failure_stage: 'rtc_connect' });
    expect(JSON.stringify(error)).not.toContain('private');
  });

  it('fails closed if model-size uplink application is rejected', async () => {
    const f = fixture(512, 960); f.manager.updateUplinkVideoFormat.mockRejectedValueOnce(new Error('cannot apply encoding'));
    await expect(f.client.realtime.connect(f.source, f.options)).rejects.toThrow('cannot apply encoding');
    expect(f.manager.connect).not.toHaveBeenCalled(); expect(f.manager.close).toHaveBeenCalledOnce(); expect(f.callbacks.onStateChange).toHaveBeenCalledExactlyOnceWith('disconnected');
  });

  it('cleans up a failed generation before rejecting without stopping the borrowed source', async () => {
    const f = fixture(); const session = await f.client.realtime.connect(f.source, f.options);
    f.manager.startGeneration.mockRejectedValueOnce(Object.assign(new Error('generation rejected'), { code: 'GENERATION_ERROR' }));
    const closing = deferred<void>(); f.manager.close.mockReturnValueOnce(closing.promise); let done = false;
    const pending = session.set({ prompt: 'fail' }).catch(cause => { done = true; return cause; });
    await flush(); expect(done).toBe(false); expect(f.callbacks.onError).toHaveBeenCalledOnce(); closing.resolve();
    expect(await pending).toMatchObject({ code: 'GENERATION_ERROR', details: { failure_stage: 'context_set' } });
    expect(session.state).toBe('disconnected'); expect(f.original.stop).not.toHaveBeenCalled();
    await expect(session.set({ prompt: 'too late' })).rejects.toThrow('已关闭');
  });
});
