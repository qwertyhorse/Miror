import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExhibitionLiveConnection, type ExhibitionLiveDeps } from '../src/exhibition/useExhibitionLive';
import type { SdkSession } from '../src/liveTryOn';
import { attachExhibitionStream } from '../src/exhibition/LiveCameraPanel';

const controllers: ExhibitionLiveConnection[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop();
  vi.clearAllTimers(); vi.useRealTimers();
});
function fixture() {
  const originalStop = vi.fn();
  const cloneStop = vi.fn();
  const track = { readyState: 'live', stop: originalStop };
  const cloneTrack = { readyState: 'live', stop: cloneStop, onended: null };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const cloned = { getVideoTracks: () => [cloneTrack], getTracks: () => [cloneTrack] } as unknown as MediaStream;
  const created = {
    id: 'local-1', token: 'temporary-test-token', model: 'x2.0', status: 'active', sourceId: 'camera-device-a', sourceKind: 'camera' as const,
    sourceName: '展会摄像头', targetItemId: 'exhibition-commute', lookId: 'commute', referenceAsset: '/assets/exhibition/commute-cutout.png',
    expiresAt: new Date(Date.now() + 120000).toISOString(), pointsLimit: 30, consumedCredits: 0,
    refImageUrl: '', referenceVersion: 0, resultAvailable: false, verification: 'none' as const,
    exhibition: { deviceId: 'screen-device-a', lookId: 'commute', sessionNumber: 1, generationNumber: 1 },
  };
  let callbacks!: Parameters<ExhibitionLiveDeps['connect']>[2];
  const sdk: SdkSession = {
    getSessionUid: vi.fn(() => 'provider-1'), set: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    stopGeneration: vi.fn(async () => {}), stopLocalStream: vi.fn(async () => {}),
  };
  const deps = {
    create: vi.fn(async () => ({ ...created })),
    reference: vi.fn(async () => new File(['garment'], 'garment.png', { type: 'image/png' })),
    prepare: vi.fn(async () => {}), upload: vi.fn(async () => 'https://reference.example/garment.png'),
    bind: vi.fn(async (_id, input) => ({ ...created, refImageUrl: input.refImageUrl, referenceVersion: 1 })),
    connect: vi.fn(async (_stream, _local, value) => { callbacks = value; return sdk; }),
    link: vi.fn(async (_id, providerSessionId) => ({ ...created, providerSessionId, referenceVersion: 1 })),
    firstFrame: vi.fn(async () => ({ ...created })), stop: vi.fn(async () => ({ ...created, status: 'stopped' })),
    heartbeat: vi.fn(async () => ({})), reportError: vi.fn(async () => ({})), clone: vi.fn(() => cloned), now: vi.fn(() => 1000),
  } satisfies ExhibitionLiveDeps;
  const events = { status: vi.fn(), stream: vi.fn(), refresh: vi.fn() };
  const controller = new ExhibitionLiveConnection({ deviceId: 'screen-device-a', lookId: 'commute', sessionNumber: 1, generationNumber: 1, expectedRevision: 3, image: created.referenceAsset, stream }, events, deps);
  controllers.push(controller);
  return { deps, controller, events, created, sdk, stream, originalStop, cloneStop, cloned, callbacks: () => callbacks };
}
describe('exhibition live client lifecycle', () => {
  it('starts from a prepared account-scoped reference without downloading or uploading the image', async () => {
    const f = fixture();
    const input = { deviceId: 'screen-device-a', lookId: 'commute', sessionNumber: 1, generationNumber: 1,
      expectedRevision: 3, image: f.created.referenceAsset, stream: f.stream };
    const controller = new ExhibitionLiveConnection(input, f.events, { ...f.deps,
      create: async () => ({ ...f.created, referenceScope: 'account-scope' }),
      preparedReference: async () => ({ url: 'https://reference.example/ready.webp', scope: 'account-scope', freshUntil: Date.now() + 60000 }),
    });
    controllers.push(controller);
    await controller.start();
    expect(f.deps.reference).not.toHaveBeenCalled();
    expect(f.deps.upload).not.toHaveBeenCalled();
    expect(f.sdk.set).toHaveBeenCalledWith(expect.objectContaining({ refImageUrl: 'https://reference.example/ready.webp' }));
  });
  it.each(['different-account', 'expired'])('falls back to a scoped upload for %s preparation', async reason => {
    const f = fixture();
    const controller = new ExhibitionLiveConnection({ deviceId: 'screen-device-a', lookId: 'commute', sessionNumber: 1, generationNumber: 1,
      expectedRevision: 3, image: f.created.referenceAsset, stream: f.stream }, f.events, { ...f.deps,
      create: async () => ({ ...f.created, referenceScope: 'current-account' }),
      preparedReference: async () => ({ url: 'https://reference.example/stale.png', scope: reason === 'expired' ? 'current-account' : 'old-account',
        freshUntil: Date.now() + (reason === 'expired' ? -1 : 60000) }),
    });
    controllers.push(controller); await controller.start();
    expect(f.deps.reference).toHaveBeenCalledOnce(); expect(f.deps.upload).toHaveBeenCalledOnce();
    expect(f.sdk.set).toHaveBeenCalledWith(expect.objectContaining({ refImageUrl: 'https://reference.example/garment.png' }));
  });
  it('measures first-frame latency from preparation before credential allocation', async () => {
    const f = fixture(); let now = 1000; f.deps.now.mockImplementation(() => now);
    f.deps.reference.mockImplementationOnce(async () => { now += 700; return new File(['image'], 'a.png'); });
    await f.controller.start(); now += 300;
    f.controller.reportFirstFrame(); await flush();
    expect(f.deps.firstFrame).toHaveBeenCalledWith('local-1', 1000);
  });
  it('preflights before allocating, binds/links before one generation, reports only a remote frame', async () => {
    const f = fixture();
    await f.controller.start();
    expect(f.deps.reference.mock.invocationCallOrder[0]).toBeLessThan(f.deps.create.mock.invocationCallOrder[0]);
    expect(f.deps.bind.mock.invocationCallOrder[0]).toBeLessThan(f.deps.connect.mock.invocationCallOrder[0]);
    expect(f.deps.link.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.sdk.set).mock.invocationCallOrder[0]);
    expect(f.sdk.set).toHaveBeenCalledTimes(1);
    expect(f.deps.firstFrame).not.toHaveBeenCalled();
    f.callbacks().onRemoteStream(f.cloned);
    expect(f.events.stream).toHaveBeenCalledWith(f.cloned);
    f.controller.reportFirstFrame(); f.controller.reportFirstFrame();
    await flush();
    expect(f.deps.firstFrame).toHaveBeenCalledTimes(1);
    expect(f.events.status).toHaveBeenCalledWith('running');
    await f.controller.stop();
    expect(f.originalStop).not.toHaveBeenCalled();
    expect(f.cloneStop).toHaveBeenCalledTimes(1);
    expect(f.deps.stop).toHaveBeenCalledWith('local-1');
  });
  it('does not allocate a credential if local garment preflight fails', async () => {
    const f = fixture();
    f.deps.reference.mockRejectedValueOnce(new Error('reference unavailable'));
    await f.controller.start();
    expect(f.deps.create).not.toHaveBeenCalled();
    expect(f.deps.reportError).toHaveBeenCalledWith(expect.objectContaining({ sessionNumber: 1, lookId: 'commute', message: 'reference unavailable' }));
  });

  it('identifies reference binding failures before connecting or generating', async () => {
    const f = fixture();
    f.deps.bind.mockRejectedValueOnce(Object.assign(new Error('素材地址解析失败，请重试。'), { code: 'MEDIA_DNS_UNAVAILABLE' }));
    await f.controller.start();
    expect(f.events.status).toHaveBeenCalledWith('error', '素材地址解析失败，请重试。');
    expect(f.deps.reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('client_stage=bind_reference; code=MEDIA_DNS_UNAVAILABLE'),
    }));
    expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.sdk.set).not.toHaveBeenCalled();
    expect(f.deps.stop).toHaveBeenCalledOnce(); expect(f.deps.create).toHaveBeenCalledOnce();
    expect(f.originalStop).not.toHaveBeenCalled();
  });
  it('deactivates a late credential after a stop while create is pending', async () => {
    const f = fixture();
    const pending = deferred<typeof f.created>();
    f.deps.create.mockImplementationOnce(() => pending.promise);
    const starting = f.controller.start(); await flush();
    await f.controller.stop(); pending.resolve(f.created); await starting;
    expect(f.deps.stop).toHaveBeenCalledWith(f.created.id);
    expect(f.deps.upload).not.toHaveBeenCalled();
    expect(f.sdk.set).not.toHaveBeenCalled();
  });
  it('disconnects a late SDK connection without generating', async () => {
    const f = fixture();
    const pending = deferred<SdkSession>();
    f.deps.connect.mockImplementationOnce(() => pending.promise);
    const starting = f.controller.start(); await flush();
    await f.controller.stop(); pending.resolve(f.sdk); await starting;
    expect(f.sdk.disconnect).toHaveBeenCalledTimes(1);
    expect(f.sdk.set).not.toHaveBeenCalled();
    expect(f.cloneStop).toHaveBeenCalledTimes(1);
  });
  it('heartbeats immediately during reference upload and stops on lost ownership', async () => {
    const f = fixture();
    const pending = deferred<string>(); f.deps.upload.mockImplementationOnce(() => pending.promise);
    const starting = f.controller.start(); await flush();
    expect(f.deps.heartbeat).toHaveBeenCalledTimes(1);
    f.deps.heartbeat.mockRejectedValueOnce(new Error('owner lost'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.deps.stop).toHaveBeenCalledWith(f.created.id);
    pending.resolve('https://reference.example/late.png'); await starting;
    expect(f.deps.connect).not.toHaveBeenCalled();
    expect(f.deps.create).toHaveBeenCalledTimes(1);
  });
  it('rejects the wrong device/garment metadata without sending camera frames', async () => {
    const f = fixture();
    f.deps.create.mockResolvedValueOnce({ ...f.created, exhibition: { ...f.created.exhibition, deviceId: 'another-device' } });
    await f.controller.start();
    expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.deps.stop).toHaveBeenCalledWith(f.created.id);
  });
  it('stops a connection that never yields its first decoded frame, without auto retry', async () => {
    const f = fixture(); await f.controller.start();
    await vi.advanceTimersByTimeAsync(45000);
    expect(f.controller.stopped).toBe(true);
    expect(f.deps.stop).toHaveBeenCalledTimes(1); expect(f.deps.create).toHaveBeenCalledTimes(1);
    f.controller.reportFirstFrame(); expect(f.deps.firstFrame).not.toHaveBeenCalled();
  });
  it('ignores a late frame from the previous output or from the original camera', async () => {
    const f = fixture(); await f.controller.start();
    f.callbacks().onRemoteStream(f.cloned);
    f.controller.reportRenderedFrame(f.stream);
    expect(f.deps.firstFrame).not.toHaveBeenCalled();
    const replacement = {} as MediaStream;
    f.callbacks().onRemoteStream(replacement);
    f.controller.reportRenderedFrame(f.cloned);
    expect(f.deps.firstFrame).not.toHaveBeenCalled();
    f.controller.reportRenderedFrame(replacement); await flush();
    expect(f.deps.firstFrame).toHaveBeenCalledTimes(1);
  });
  it('rejects a prior generation even when look and experience number match', async () => {
    const f = fixture();
    f.deps.create.mockResolvedValueOnce({ ...f.created, exhibition: { ...f.created.exhibition, generationNumber: 0 } });
    await f.controller.start();
    expect(f.deps.connect).not.toHaveBeenCalled();
    expect(f.deps.stop).toHaveBeenCalledWith(f.created.id);
  });
  it('does not restart an explicitly stopped controller', async () => {
    const f = fixture(); await f.controller.stop(); await f.controller.start();
    expect(f.deps.create).not.toHaveBeenCalled();
  });

  it('retains SDK failure details when the callback precedes the rejected connection', async () => {
    const f = fixture();
    const error = Object.assign(new Error('provider error tk-secret sk-secret https://example.test/private'), {
      code: 'WEB_RTC_ERROR', details: { reason_code: 'local_publish_failed', failure_stage: 'publish', rtc_error_code: '1006' },
    });
    f.deps.connect.mockImplementationOnce(async (_stream, _local, callbacks) => {
      callbacks.onError(error.message, error);
      throw error;
    });
    await f.controller.start(); await flush();
    expect(f.deps.reportError).toHaveBeenCalledOnce();
    const report = f.deps.reportError.mock.calls[0][0];
    expect(report.message).toContain('local_publish_failed'); expect(report.message).toContain('publish');
    expect(report.message).not.toMatch(/tk-secret|sk-secret|example\.test/);
    expect(f.events.status).toHaveBeenCalledWith('error', '摄像头画面未能上传，请检查镜端网络后重试。');
    expect(f.deps.stop).toHaveBeenCalledOnce(); expect(f.deps.create).toHaveBeenCalledOnce();
    expect(f.sdk.set).not.toHaveBeenCalled(); expect(f.originalStop).not.toHaveBeenCalled();
  });

  it('reports a remote output timeout separately from local camera failure without another generation', async () => {
    const f = fixture(); await f.controller.start();
    f.callbacks().onError('service output timeout', { code: 'WEB_RTC_ERROR', details: {
      reason_code: 'remote_first_frame_timeout', failure_stage: 'wait_first_frame', failure_type: 'timeout',
    } });
    await flush();
    expect(f.events.status).toHaveBeenCalledWith('error', '生成画面等待超时，请检查镜端网络后重试。');
    expect(f.deps.reportError.mock.calls[0][0].message).toContain('remote_first_frame_timeout');
    expect(f.deps.reportError.mock.calls[0][0].message).toContain('wait_first_frame');
    expect(f.sdk.disconnect).toHaveBeenCalledOnce(); expect(f.deps.stop).toHaveBeenCalledOnce();
    expect(f.deps.create).toHaveBeenCalledOnce(); expect(f.sdk.set).toHaveBeenCalledOnce();
  });

  it('preserves disconnect evidence and ignores callbacks from the closed connection', async () => {
    const f = fixture(); await f.controller.start();
    f.callbacks().onDisconnect('rtc_reconnect_timeout', { connection_state: 'disconnected', failure_stage: 'rtc_join' });
    f.callbacks().onError('late error', { code: 'UNKNOWN_ERROR' });
    await flush();
    expect(f.events.status).toHaveBeenCalledWith('error', '实时视频连接失败，请检查镜端网络后重试。');
    expect(f.deps.reportError).toHaveBeenCalledOnce();
    expect(f.deps.reportError.mock.calls[0][0].message).toContain('rtc_reconnect_timeout');
    expect(f.deps.reportError.mock.calls[0][0].message).toContain('disconnected');
    expect(f.deps.create).toHaveBeenCalledOnce();
  });

  it('keeps the specific SDK disconnect reason instead of the broad overloaded category', async () => {
    const f = fixture(); await f.controller.start();
    f.callbacks().onDisconnect('overloaded', { reason_code: 'remote_first_frame_timeout', failure_stage: 'wait_first_frame' });
    await flush();
    expect(f.events.status).toHaveBeenCalledWith('error', '生成画面等待超时，请检查镜端网络后重试。');
    expect(f.deps.reportError.mock.calls[0][0].message).toContain('remote_first_frame_timeout');
    expect(f.deps.reportError.mock.calls[0][0].message).not.toContain('reason_code=overloaded');
  });
});

describe('remote video element binding', () => {
  function videoFixture() {
    let decode: (() => void) | undefined;
    let frame: (() => void) | undefined;
    const video = {
      srcObject: null as MediaStream | null, readyState: 0, videoWidth: 0, videoHeight: 0,
      play: vi.fn(async () => {}), pause: vi.fn(),
      addEventListener: vi.fn((_type, callback) => { decode = callback; }),
      removeEventListener: vi.fn(),
      requestVideoFrameCallback: vi.fn(callback => { frame = callback; return 1; }), cancelVideoFrameCallback: vi.fn(),
    };
    return { video, element: video as unknown as HTMLVideoElement, decode: () => decode?.(), frame: () => frame?.() };
  }
  it('reports one decoded frame with the bound stream identity, never an empty frame', async () => {
    const f = videoFixture(); const stream = {} as MediaStream; const report = vi.fn();
    const dispose = attachExhibitionStream(f.element, stream, report, vi.fn());
    f.frame(); expect(report).not.toHaveBeenCalled();
    Object.assign(f.video, { readyState: 2, videoWidth: 720, videoHeight: 1280 });
    f.decode(); f.frame(); expect(report).toHaveBeenCalledExactlyOnceWith(stream);
    dispose(); expect(f.video.srcObject).toBeNull(); expect(f.video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
  });
  it('ignores queued old-stream events after disposal', async () => {
    const f = videoFixture(); const report = vi.fn();
    const dispose = attachExhibitionStream(f.element, {} as MediaStream, report, vi.fn());
    dispose(); Object.assign(f.video, { readyState: 2, videoWidth: 720, videoHeight: 1280 });
    f.frame(); f.decode(); expect(report).not.toHaveBeenCalled();
  });
});
