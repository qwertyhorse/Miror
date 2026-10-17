import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareXmaxCameraStream, prepareXmaxVideoInput, type XmaxInputDimensions } from '../src/exhibition/xmaxCameraStream';

function fixture(initial: MediaTrackSettings) {
  let settings = initial;
  const track = {
    kind: 'video', readyState: 'live', stop: vi.fn(),
    getSettings: vi.fn(function (this: unknown) {
      if (this !== track) throw new TypeError('Illegal invocation');
      return settings;
    }),
  };
  const nativeGetSettings = track.getSettings;
  const audio = { kind: 'audio', getSettings: vi.fn(() => ({ sampleRate: 48000 })) };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track, audio] } as unknown as MediaStream;
  return { track, audio, stream, nativeGetSettings, setSettings: (next: MediaTrackSettings) => { settings = next; } };
}

describe('XMAX camera track settings', () => {
  it('keeps the native stream and track while normalizing a later generator Infinity', () => {
    const f = fixture({ width: 2160, height: 3840, frameRate: 30, deviceId: 'fixture' });
    const originalStop = f.track.stop;
    expect(prepareXmaxCameraStream(f.stream)).toBe(f.stream);
    expect(f.stream.getVideoTracks()[0]).toBe(f.track);
    expect(f.track.getSettings()).toEqual({ width: 2160, height: 3840, frameRate: 30, deviceId: 'fixture' });

    // ByteRTC applies constraints before publishing, so settings must be read each time.
    const constrained = { width: 1080, height: 1920, frameRate: Infinity, deviceId: 'fixture' };
    f.setSettings(constrained);
    expect(f.track.getSettings()).toEqual({ ...constrained, frameRate: 30 });
    expect(constrained.frameRate).toBe(Infinity);
    expect(f.track.stop).toBe(originalStop);
    expect(f.audio.getSettings()).toEqual({ sampleRate: 48000 });
    expect(f.nativeGetSettings).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, NaN, Infinity, -Infinity, 0, -1])('returns a finite positive rate for %s', frameRate => {
    const f = fixture({ width: 2160, height: 3840, frameRate });
    prepareXmaxCameraStream(f.stream);
    expect(f.track.getSettings().frameRate).toBe(30);
  });

  it.each([1, 15, 23.976, 29.97, 30, 60])('preserves an available %s fps setting', frameRate => {
    const settings = { width: 2160, height: 3840, frameRate };
    const f = fixture(settings);
    prepareXmaxCameraStream(f.stream);
    expect(f.track.getSettings()).toBe(settings);
  });

  it('does not stack wrappers or affect a different track sharing the same settings object', () => {
    const settings = { width: 2160, height: 3840, frameRate: Infinity };
    const f = fixture(settings);
    const camera = fixture(settings);
    prepareXmaxCameraStream(f.stream);
    const first = f.track.getSettings;
    prepareXmaxCameraStream(f.stream);
    expect(f.track.getSettings).toBe(first);
    expect(f.track.getSettings().frameRate).toBe(30);
    expect(f.nativeGetSettings).toHaveBeenCalledOnce();
    expect(camera.track.getSettings().frameRate).toBe(Infinity);

    f.setSettings({ width: 1080, height: 1920, frameRate: 24 });
    expect(f.track.getSettings()).toEqual({ width: 1080, height: 1920, frameRate: 24 });
    expect(camera.track.getSettings().frameRate).toBe(Infinity);
  });
});

class RelayTrack extends EventTarget {
  readyState = 'live';
  getCapabilities = vi.fn((): MediaTrackCapabilities => ({}));
  stop = vi.fn(() => { this.readyState = 'ended'; });
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
function relayStream(track: RelayTrack) {
  return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
}
class RelayVideo extends EventTarget {
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  muted = false;
  playsInline = false;
  autoplay = false;
  srcObject: MediaStream | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  callbacks = new Map<number, () => void>();
  sequence = 0;
  requestVideoFrameCallback = vi.fn((callback: () => void) => {
    const id = ++this.sequence; this.callbacks.set(id, callback); return id;
  });
  cancelVideoFrameCallback = vi.fn((id: number) => { this.callbacks.delete(id); });
  frame(width = 1080, height = 1920) {
    this.readyState = 2; this.videoWidth = width; this.videoHeight = height;
    const [id, callback] = this.callbacks.entries().next().value!;
    this.callbacks.delete(id); callback();
  }
}
class RelayCanvas extends EventTarget {
  width = 300;
  height = 150;
  outputTrack = new RelayTrack();
  output = relayStream(this.outputTrack);
  context = { drawImage: vi.fn() };
  getContext = vi.fn(() => this.context);
  captureStream = vi.fn(() => this.output);
}
const relayControllers: AbortController[] = [];
function relayFixture() {
  const raw = new RelayTrack(); const source = relayStream(raw);
  const video = new RelayVideo(); const canvas = new RelayCanvas();
  const createElement = vi.fn((tag: string) => tag === 'video' ? video : canvas);
  vi.stubGlobal('document', { createElement });
  const controller = new AbortController(); relayControllers.push(controller);
  const start = (resolveSize?: (decoded: XmaxInputDimensions) => XmaxInputDimensions) => prepareXmaxVideoInput(source, controller.signal, resolveSize);
  return { raw, source, video, canvas, createElement, controller, start };
}

describe('XMAX constraint-compatible video input', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    relayControllers.splice(0).forEach(controller => controller.abort());
    vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it.each(['camera', 'canvas', 'legacy'] as const)('passes a supported %s stream through without taking ownership', async kind => {
    const f = relayFixture();
    if (kind === 'legacy') Object.assign(f.raw, { getCapabilities: undefined });
    else f.raw.getCapabilities.mockReturnValue({
      width: { min: kind === 'canvas' ? 0 : 1, max: 1920 }, height: { min: 1, max: 1080 },
    });
    const resolveSize = vi.fn(() => ({ width: 1024, height: 1920 }));
    const result = await f.start(resolveSize);
    expect(result.stream).toBe(f.source); result.dispose(); f.controller.abort();
    expect(resolveSize).not.toHaveBeenCalled();
    expect(f.createElement).not.toHaveBeenCalled(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a decoded frame and relays its real dimensions at 30 fps without upscaling', async () => {
    const f = relayFixture(); const done = vi.fn(); const pending = f.start().then(result => { done(); return result; });
    await Promise.resolve();
    f.video.readyState = 1; f.video.videoWidth = 1080; f.video.videoHeight = 1920;
    f.video.dispatchEvent(new Event('loadeddata'));
    expect(done).not.toHaveBeenCalled(); expect(f.canvas.captureStream).not.toHaveBeenCalled();
    f.video.frame(720, 1280); const result = await pending;
    expect(result.stream).toBe(f.canvas.output); expect(result.stream).not.toBe(f.source);
    expect([f.canvas.width, f.canvas.height]).toEqual([720, 1280]);
    expect(f.canvas.context.drawImage).toHaveBeenCalledExactlyOnceWith(f.video, 0, 0, 720, 1280);
    expect(f.canvas.captureStream).toHaveBeenCalledExactlyOnceWith(30);
    expect(f.video.srcObject).toBe(f.source);
    expect(f.video.muted && f.video.playsInline && f.video.autoplay).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues forwarding frames and later source sizes through the same output', async () => {
    const f = relayFixture(); const pending = f.start();
    await Promise.resolve(); f.video.frame(); const result = await pending;
    f.video.frame(); f.video.frame(640, 360);
    expect(f.canvas.context.drawImage).toHaveBeenCalledTimes(3);
    expect(f.canvas.context.drawImage).toHaveBeenLastCalledWith(f.video, 0, 0, 640, 360);
    expect([f.canvas.width, f.canvas.height]).toEqual([640, 360]);
    expect(f.canvas.captureStream).toHaveBeenCalledOnce(); expect(result.stream).toBe(f.canvas.output);
    expect(f.video.callbacks.size).toBe(1);
  });

  it.each([
    [2160, 3840, 1024, 1920, 1024, 1820],
    [3840, 2160, 1920, 1024, 1820, 1024],
    [2048, 3840, 1024, 1920, 1024, 1920],
    [512, 960, 1024, 1920, 512, 960],
    [513, 961, 1024, 1920, 512, 960],
  ])('bounds decoded %dx%d to model %dx%d without cropping or upscaling', async (sourceWidth, sourceHeight, modelWidth, modelHeight, width, height) => {
    const f = relayFixture();
    const resolveSize = vi.fn(() => ({ width: modelWidth, height: modelHeight }));
    const pending = f.start(resolveSize); await Promise.resolve();
    f.video.frame(sourceWidth, sourceHeight); const result = await pending;
    expect(resolveSize).toHaveBeenCalledExactlyOnceWith({ width: sourceWidth, height: sourceHeight });
    expect([f.canvas.width, f.canvas.height]).toEqual([width, height]);
    // The five-argument draw uses the entire source, without a cropped source rectangle.
    expect(f.canvas.context.drawImage).toHaveBeenCalledExactlyOnceWith(f.video, 0, 0, width, height);
    expect(width).toBeLessThanOrEqual(sourceWidth); expect(height).toBeLessThanOrEqual(sourceHeight);
    expect(Math.abs(width / height - sourceWidth / sourceHeight)).toBeLessThan(0.005);
    expect(result.stream).toBe(f.canvas.output); expect(f.raw.stop).not.toHaveBeenCalled();
  });

  it('keeps model bounds across later frames and source resizing without recreating the track', async () => {
    const f = relayFixture(); const resolveSize = vi.fn(() => ({ width: 1024, height: 1920 }));
    const pending = f.start(resolveSize); await Promise.resolve(); f.video.frame(2160, 3840);
    const result = await pending;
    f.video.frame(2160, 3840); f.video.frame(512, 960);
    expect([f.canvas.width, f.canvas.height]).toEqual([512, 960]);
    f.video.frame(3840, 2160);
    expect([f.canvas.width, f.canvas.height]).toEqual([1024, 576]);
    expect(resolveSize).toHaveBeenCalledOnce(); expect(f.canvas.captureStream).toHaveBeenCalledOnce();
    expect(result.stream).toBe(f.canvas.output); expect(f.raw.stop).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, 0, -1, 1.5])('releases the relay when model bounds are invalid: %s', async width => {
    const f = relayFixture();
    const rejected = expect(f.start(() => ({ width, height: 1920 }))).rejects.toThrow('视频连接准备失败');
    await Promise.resolve(); f.video.frame(2160, 3840); await rejected;
    expect(f.canvas.context.drawImage).not.toHaveBeenCalled(); expect(f.canvas.captureStream).not.toHaveBeenCalled();
    expect(f.raw.stop).not.toHaveBeenCalled(); expect(f.video.srcObject).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes only owned resources once and prevents late callbacks from reviving the relay', async () => {
    const f = relayFixture(); const pending = f.start(); await Promise.resolve(); f.video.frame();
    const result = await pending; const stale = [...f.video.callbacks.values()][0];
    const ended = vi.fn(); f.canvas.outputTrack.addEventListener('ended', ended);
    result.dispose(); result.dispose(); stale(); f.raw.end(); f.controller.abort();
    expect(f.canvas.outputTrack.stop).toHaveBeenCalledOnce(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled(); expect(f.video.callbacks.size).toBe(0);
    expect(f.canvas.context.drawImage).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(f.video.srcObject).toBeNull(); expect(f.video.pause).toHaveBeenCalledOnce(); expect(f.video.load).toHaveBeenCalledOnce();
    expect([f.canvas.width, f.canvas.height]).toEqual([0, 0]);
  });

  it('rejects an already aborted or ended input before allocating resources', async () => {
    const f = relayFixture(); f.controller.abort();
    await expect(f.start()).rejects.toMatchObject({ name: 'AbortError' });
    f.raw.end(); await expect(prepareXmaxVideoInput(f.source)).rejects.toThrow('没有返回有效画面');
    expect(f.createElement).not.toHaveBeenCalled(); expect(f.raw.stop).not.toHaveBeenCalled();
  });

  it('cancels pending playback without taking ownership of the source or accepting its late resolution', async () => {
    const f = relayFixture(); let play!: () => void;
    f.video.play.mockReturnValue(new Promise(resolve => { play = resolve; }));
    const rejected = expect(f.start()).rejects.toMatchObject({ name: 'AbortError' });
    f.controller.abort(); await rejected;
    f.video.readyState = 2; f.video.videoWidth = 1080; f.video.videoHeight = 1920;
    play(); await Promise.resolve();
    expect(f.canvas.captureStream).not.toHaveBeenCalled(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.video.srcObject).toBeNull(); expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('silently releases an established relay on cancellation', async () => {
    const f = relayFixture(); const pending = f.start(); await Promise.resolve(); f.video.frame(); await pending;
    const ended = vi.fn(); f.canvas.outputTrack.addEventListener('ended', ended); f.controller.abort();
    expect(f.canvas.outputTrack.stop).toHaveBeenCalledOnce(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled(); expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects when the source ends before its first frame', async () => {
    const f = relayFixture(); const rejected = expect(f.start()).rejects.toThrow('摄像头已断开');
    f.raw.end(); await rejected;
    expect(f.video.srcObject).toBeNull(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a silently stopped source instead of publishing a cached first frame', async () => {
    const f = relayFixture(); const rejected = expect(f.start()).rejects.toThrow('摄像头已断开');
    await Promise.resolve(); f.raw.stop(); f.video.frame(); await rejected;
    expect(f.canvas.context.drawImage).not.toHaveBeenCalled(); expect(f.canvas.captureStream).not.toHaveBeenCalled();
    expect(f.video.srcObject).toBeNull(); expect(f.raw.stop).toHaveBeenCalledOnce();
    expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('ends an established relay when a silently stopped source yields a cached frame', async () => {
    const f = relayFixture(); const pending = f.start(); await Promise.resolve(); f.video.frame();
    const result = await pending; const ended = vi.fn(() => result.dispose());
    f.canvas.outputTrack.addEventListener('ended', ended);
    f.raw.stop(); f.video.frame();
    expect(f.canvas.context.drawImage).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledOnce();
    expect(f.canvas.outputTrack.stop).toHaveBeenCalledOnce(); expect(f.raw.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull(); expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['source-ended', 'video-error', 'context-lost', 'draw-error'] as const)('notifies output consumers and cleans up runtime %s', async fault => {
    const f = relayFixture(); const pending = f.start(); await Promise.resolve(); f.video.frame();
    const result = await pending; const ended = vi.fn(() => result.dispose());
    f.canvas.outputTrack.addEventListener('ended', ended);
    if (fault === 'source-ended') f.raw.end();
    if (fault === 'video-error') f.video.dispatchEvent(new Event('error'));
    if (fault === 'context-lost') f.canvas.dispatchEvent(new Event('contextlost'));
    if (fault === 'draw-error') {
      f.canvas.context.drawImage.mockImplementation(() => { throw new Error('Draw failed'); }); f.video.frame();
    }
    expect(ended).toHaveBeenCalledOnce(); expect(f.canvas.outputTrack.readyState).toBe('ended');
    expect(f.canvas.outputTrack.stop).toHaveBeenCalledOnce(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.video.srcObject).toBeNull(); expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects failed canvas capture instead of passing the incompatible input to the SDK', async () => {
    const f = relayFixture(); f.canvas.captureStream.mockImplementation(() => { throw new Error('Capture failed'); });
    const rejected = expect(f.start()).rejects.toThrow('视频连接准备失败');
    await Promise.resolve(); f.video.frame(); await rejected;
    expect(f.video.srcObject).toBeNull(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the first-frame wait and releases the borrowed video on timeout', async () => {
    const f = relayFixture(); const rejected = expect(f.start()).rejects.toThrow('等待摄像头画面超时');
    await vi.advanceTimersByTimeAsync(8000); await rejected;
    expect(f.video.srcObject).toBeNull(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.canvas.captureStream).not.toHaveBeenCalled(); expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a cancellable frame timer when video frame callbacks are unavailable', async () => {
    const f = relayFixture(); Object.assign(f.video, { requestVideoFrameCallback: undefined });
    const pending = f.start(); await Promise.resolve();
    f.video.readyState = 2; f.video.videoWidth = 720; f.video.videoHeight = 1280;
    await vi.advanceTimersByTimeAsync(34); const result = await pending;
    expect(f.canvas.context.drawImage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100); expect(f.canvas.context.drawImage).toHaveBeenCalledTimes(4);
    result.dispose(); await vi.advanceTimersByTimeAsync(100);
    expect(f.canvas.context.drawImage).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
    expect(f.raw.stop).not.toHaveBeenCalled();
  });
});
