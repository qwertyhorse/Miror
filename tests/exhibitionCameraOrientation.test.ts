import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orientExhibitionCamera, type ExhibitionCameraRotation } from '../src/exhibition/cameraOrientation';

class Track extends EventTarget {
  readyState = 'live';
  getSettings = vi.fn((): MediaTrackSettings => ({}));
  stop = vi.fn(() => { this.readyState = 'ended'; });
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
function stream(track: Track) {
  return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
}
class Video extends EventTarget {
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
  callbacks = new Map<number, (now: number) => void>();
  sequence = 0;
  requestVideoFrameCallback = vi.fn((callback: (now: number) => void) => {
    const id = ++this.sequence; this.callbacks.set(id, callback); return id;
  });
  cancelVideoFrameCallback = vi.fn((id: number) => { this.callbacks.delete(id); });
  frame(now: number) {
    const [id, callback] = this.callbacks.entries().next().value!;
    this.callbacks.delete(id); callback(now);
  }
  ready(width = 1920, height = 1080) {
    this.readyState = 2; this.videoWidth = width; this.videoHeight = height;
  }
}
class Canvas extends EventTarget {
  width = 300;
  height = 150;
  outputTrack = new Track();
  output = stream(this.outputTrack);
  context = { setTransform: vi.fn(), drawImage: vi.fn() };
  getContext = vi.fn(() => this.context);
  captureStream = vi.fn(() => this.output);
}
const controllers: AbortController[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.abort());
  vi.useRealTimers(); vi.unstubAllGlobals();
});
function fixture() {
  const raw = new Track(); const source = stream(raw);
  const video = new Video(); const canvas = new Canvas();
  const createElement = vi.fn((tag: string) => tag === 'video' ? video : canvas);
  vi.stubGlobal('document', { createElement });
  const controller = new AbortController(); controllers.push(controller);
  const start = (rotation: ExhibitionCameraRotation = 90, maximumDimensions?: { width: number; height: number }) => orientExhibitionCamera(source, rotation, controller.signal, maximumDimensions);
  return { raw, source, video, canvas, createElement, controller, start };
}

describe('clockwise camera pixel orientation', () => {
  it('passes 0° through without allocating DOM or taking ownership of the source', async () => {
    const f = fixture(); f.raw.getSettings.mockReturnValue({ width: 3840, height: 2160 });
    const result = await f.start(0);
    expect(result.stream).toBe(f.source); result.dispose(); result.dispose(); f.controller.abort();
    expect(f.createElement).not.toHaveBeenCalled(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.raw.getSettings).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [0, ['ABCD', 'EFGH']],
    [90, ['EA', 'FB', 'GC', 'HD']],
    [180, ['HGFE', 'DCBA']],
    [270, ['DH', 'CG', 'BF', 'AE']],
  ] as const)('turns an asymmetric pixel grid %i° clockwise', async (rotation, expected) => {
    const f = fixture(); f.video.ready(4, 2); await f.start(rotation, rotation === 0 ? { width: 4, height: 2 } : undefined);
    const [a, b, c, d, e, g] = f.canvas.context.setTransform.mock.calls[0] as number[];
    const output = Array.from({ length: f.canvas.height }, () => Array<string>(f.canvas.width).fill('?'));
    ['ABCD', 'EFGH'].forEach((row, y) => [...row].forEach((value, x) => {
      const ox = Math.floor(a * (x + 0.5) + c * (y + 0.5) + e);
      const oy = Math.floor(b * (x + 0.5) + d * (y + 0.5) + g);
      output[oy][ox] = value;
    }));
    expect(output.map(row => row.join(''))).toEqual(expected);
    expect(f.canvas.context.drawImage).toHaveBeenCalledExactlyOnceWith(f.video, 0, 0, 4, 2);
    expect(f.canvas.captureStream).toHaveBeenCalledExactlyOnceWith(30);
  });

  it.each([
    [3840, 2160, 90, 1080, 1920], [3840, 2160, 180, 1920, 1080],
    [2160, 3840, 270, 1920, 1080], [1280, 720, 90, 720, 1280],
    [1600, 1200, 90, 1080, 1440], [8192, 512, 270, 120, 1920],
    [1921, 1081, 180, 1918, 1080],
  ])('uses actual %i×%i input at %i°, independent of camera request', async (width, height, rotation, outWidth, outHeight) => {
    const f = fixture(); f.video.ready(width, height); await f.start(rotation as ExhibitionCameraRotation);
    expect([f.canvas.width, f.canvas.height]).toEqual([outWidth, outHeight]);
    expect(f.canvas.width * f.canvas.height).toBeLessThanOrEqual(1920 * 1080);
    expect(f.canvas.width % 2).toBe(0); expect(f.canvas.height % 2).toBe(0);
    expect(f.canvas.context.drawImage).toHaveBeenLastCalledWith(f.video, 0, 0, width, height);
  });

  it('adapts the same output to source resolution changes from applyConstraints', async () => {
    const f = fixture(); f.video.ready(3840, 2160); const result = await f.start();
    f.video.ready(1280, 720); f.video.frame(performance.now() + 40);
    expect([f.canvas.width, f.canvas.height]).toEqual([720, 1280]);
    expect(f.canvas.context.setTransform).toHaveBeenLastCalledWith(0, 1, -1, 0, 720, 0);
    f.video.ready(720, 1280); f.video.frame(performance.now() + 80);
    expect([f.canvas.width, f.canvas.height]).toEqual([1280, 720]);
    expect(f.canvas.context.setTransform).toHaveBeenLastCalledWith(0, 1, -1, 0, 1280, 0);
    expect(f.canvas.captureStream).toHaveBeenCalledOnce(); expect(result.stream).toBe(f.canvas.output);
    expect(f.raw.stop).not.toHaveBeenCalled();
  });

  it('waits for a drawable frame, not only metadata or play()', async () => {
    const f = fixture(); const done = vi.fn(); const pending = f.start().then(done);
    await Promise.resolve(); f.video.readyState = 1; f.video.videoWidth = 1920; f.video.videoHeight = 1080;
    f.video.dispatchEvent(new Event('loadeddata')); f.video.frame(performance.now());
    expect(done).not.toHaveBeenCalled(); expect(f.canvas.captureStream).not.toHaveBeenCalled();
    f.video.ready(); f.video.frame(performance.now() + 40); await pending;
    expect(done).toHaveBeenCalledOnce(); expect(f.canvas.context.drawImage).toHaveBeenCalledOnce();
    expect(f.video.muted && f.video.playsInline && f.video.autoplay).toBe(true);
  });

  it('draws every other callback from 60 fps input and limits output capture to 30 fps', async () => {
    const f = fixture(); f.video.ready(); await f.start(); const start = performance.now();
    for (let frame = 1; frame <= 60; frame++) f.video.frame(start + frame * 1000 / 60);
    expect(f.canvas.context.drawImage).toHaveBeenCalledTimes(31);
    expect(f.canvas.captureStream).toHaveBeenCalledExactlyOnceWith(30);
    expect(f.video.callbacks.size).toBe(1);
  });

  it.each([
    [[3, -3]],
    [[0, 3, 0, -3]],
    [[-3, 1, 3, -1, 2, -2, 0]],
  ])('keeps all 30 fps frames with bounded scheduling jitter %j', async jitter => {
    const f = fixture(); f.video.ready(); await f.start(); const start = performance.now();
    for (let frame = 1; frame <= 300; frame++) {
      f.video.frame(start + frame * 1000 / 30 + jitter[(frame - 1) % jitter.length]);
    }
    expect(f.canvas.context.drawImage).toHaveBeenCalledTimes(301);
  });

  it('still limits a jittering 60 fps source to 30 fps without saving a backlog after a pause', async () => {
    const f = fixture(); f.video.ready(); await f.start(); const start = performance.now();
    for (let frame = 1; frame <= 600; frame++) f.video.frame(start + frame * 1000 / 60 + (frame % 2 ? 3 : -3));
    expect(f.canvas.context.drawImage).toHaveBeenCalledTimes(301);
    f.video.frame(start + 20_000);
    const resumed = f.canvas.context.drawImage.mock.calls.length;
    for (let callback = 0; callback < 10; callback++) f.video.frame(start + 20_000);
    f.video.frame(start + 20_000 + 1000 / 60);
    expect(f.canvas.context.drawImage).toHaveBeenCalledTimes(resumed);
    f.video.frame(start + 20_000 + 1000 / 30);
    expect(f.canvas.context.drawImage).toHaveBeenCalledTimes(resumed + 1);
  });
});

describe('camera transform ownership and failure boundaries', () => {
  it('disposes only owned output once and prevents a stale callback from drawing or rescheduling', async () => {
    const f = fixture(); f.video.ready(); const result = await f.start();
    const stale = [...f.video.callbacks.values()][0]; const ended = vi.fn();
    f.canvas.outputTrack.addEventListener('ended', ended);
    result.dispose(); result.dispose(); stale(performance.now() + 100);
    expect(f.canvas.outputTrack.stop).toHaveBeenCalledOnce(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled(); expect(f.video.callbacks.size).toBe(0);
    expect(f.canvas.context.drawImage).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(f.video.srcObject).toBeNull(); expect(f.video.pause).toHaveBeenCalledOnce(); expect(f.video.load).toHaveBeenCalledOnce();
    expect([f.canvas.width, f.canvas.height]).toEqual([0, 0]);
  });

  it('rejects cancellation before allocation, including the 0° path', async () => {
    const f = fixture(); f.controller.abort();
    await expect(f.start(0)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(f.start()).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.createElement).not.toHaveBeenCalled(); expect(f.raw.stop).not.toHaveBeenCalled();
  });

  it('cancels a pending play and ignores its eventual success', async () => {
    const f = fixture(); let play!: () => void;
    f.video.play.mockReturnValue(new Promise(resolve => { play = resolve; }));
    const rejected = expect(f.start()).rejects.toMatchObject({ name: 'AbortError' });
    f.controller.abort(); await rejected; f.video.ready(); play(); await Promise.resolve();
    expect(f.canvas.captureStream).not.toHaveBeenCalled(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.video.srcObject).toBeNull(); expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an already resolved transform silently without stopping the borrowed camera', async () => {
    const f = fixture(); f.video.ready(); await f.start(); const ended = vi.fn();
    f.canvas.outputTrack.addEventListener('ended', ended); f.controller.abort();
    expect(f.canvas.outputTrack.stop).toHaveBeenCalledOnce(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled(); expect(f.video.callbacks.size).toBe(0);
  });

  it('bounds waiting for the first frame and cleans up after timeout', async () => {
    const f = fixture(); const rejected = expect(f.start()).rejects.toThrow('等待摄像头画面超时');
    await vi.advanceTimersByTimeAsync(8000); await rejected;
    expect(f.video.srcObject).toBeNull(); expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(f.raw.stop).not.toHaveBeenCalled(); expect(f.canvas.captureStream).not.toHaveBeenCalled();
  });

  it.each(['play', 'draw', 'capture', 'empty-output'] as const)('cleans up initial %s failure without exposing browser details', async fault => {
    const f = fixture(); f.video.ready();
    if (fault === 'play') f.video.play.mockRejectedValue(new Error('sensitive device detail'));
    if (fault === 'draw') f.canvas.context.drawImage.mockImplementation(() => { throw new Error('sensitive device detail'); });
    if (fault === 'capture') f.canvas.captureStream.mockImplementation(() => { throw new Error('sensitive device detail'); });
    if (fault === 'empty-output') f.canvas.outputTrack.readyState = 'ended';
    await expect(f.start()).rejects.toThrow('摄像头方向调整失败，请重新开启。');
    expect(f.video.srcObject).toBeNull(); expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(f.raw.stop).not.toHaveBeenCalled();
    if (fault === 'empty-output') expect(f.canvas.outputTrack.stop).toHaveBeenCalledOnce();
    if (fault === 'draw') expect(f.canvas.captureStream).not.toHaveBeenCalled();
  });

  it('rejects a source ending before the first frame', async () => {
    const f = fixture(); const rejected = expect(f.start()).rejects.toThrow('摄像头已断开');
    f.raw.end(); await rejected;
    expect(f.raw.stop).not.toHaveBeenCalled(); expect(f.video.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['source-ended', 'video-error', 'context-lost', 'draw'] as const)('notifies output consumers after runtime %s failure', async fault => {
    const f = fixture(); f.video.ready(); const result = await f.start(); const ended = vi.fn(() => result.dispose());
    f.canvas.outputTrack.addEventListener('ended', ended);
    if (fault === 'source-ended') f.raw.end();
    if (fault === 'video-error') f.video.dispatchEvent(new Event('error'));
    if (fault === 'context-lost') f.canvas.dispatchEvent(new Event('contextlost'));
    if (fault === 'draw') {
      f.canvas.context.drawImage.mockImplementation(() => { throw new Error('GPU failure'); });
      f.video.frame(performance.now() + 40);
    }
    expect(ended).toHaveBeenCalledOnce(); expect(f.canvas.outputTrack.readyState).toBe('ended');
    expect(f.canvas.outputTrack.stop).toHaveBeenCalledOnce(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.video.callbacks.size).toBe(0); expect(f.video.srcObject).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a cancellable timer on browsers without video frame callbacks', async () => {
    const f = fixture(); Object.assign(f.video, { requestVideoFrameCallback: undefined });
    const pending = f.start(); await Promise.resolve(); f.video.ready();
    await vi.advanceTimersByTimeAsync(34); const result = await pending;
    expect(f.canvas.context.drawImage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100); expect(f.canvas.context.drawImage).toHaveBeenCalledTimes(4);
    result.dispose(); await vi.advanceTimersByTimeAsync(100);
    expect(f.canvas.context.drawImage).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
    expect(f.raw.stop).not.toHaveBeenCalled();
  });

  it('rejects invalid rotations or an ended source without allocating auxiliaries', async () => {
    const f = fixture(); await expect(f.start(45 as ExhibitionCameraRotation)).rejects.toThrow('方向无效');
    f.raw.end(); await expect(f.start()).rejects.toThrow('没有返回有效画面');
    expect(f.createElement).not.toHaveBeenCalled(); expect(f.raw.stop).not.toHaveBeenCalled();
  });
});

class InputFrame {
  close = vi.fn();
  constructor(public timestamp: number, public displayWidth = 1920, public displayHeight = 1080) {}
}
async function flushFrames() { for (let step = 0; step < 8; step++) await Promise.resolve(); }
function processorFixture() {
  const f = fixture(); const outputs: InputFrame[] = []; const canvases: Canvas[] = []; const writes: InputFrame[] = [];
  let pendingRead: ((value: ReadableStreamReadResult<InputFrame>) => void) | undefined;
  let queued: InputFrame | undefined;
  const reader = {
    read: vi.fn(() => new Promise<ReadableStreamReadResult<InputFrame>>(resolve => {
      if (queued) { const frame = queued; queued = undefined; resolve({ value: frame, done: false }); }
      else pendingRead = resolve;
    })),
    cancel: vi.fn(async () => {
      queued?.close(); queued = undefined;
      pendingRead?.({ done: true, value: undefined }); pendingRead = undefined;
    }),
    releaseLock: vi.fn(),
  };
  const writer = {
    write: vi.fn(async (frame: InputFrame) => { writes.push(frame); }),
    abort: vi.fn(async () => {}), releaseLock: vi.fn(),
  };
  const constructed = vi.fn(); let generated!: Track;
  vi.stubGlobal('MediaStreamTrackProcessor', class {
    readable = { getReader: () => reader };
    constructor(options: unknown) { constructed(options); }
  });
  vi.stubGlobal('MediaStreamTrackGenerator', class extends Track {
    writable = { getWriter: () => writer };
    constructor() { super(); generated = this; }
  });
  vi.stubGlobal('OffscreenCanvas', class extends Canvas {
    constructor(width: number, height: number) { super(); this.width = width; this.height = height; canvases.push(this); }
  });
  vi.stubGlobal('VideoFrame', class extends InputFrame {
    constructor(canvas: Canvas, init: { timestamp: number }) {
      super(init.timestamp, canvas.width, canvas.height); outputs.push(this);
    }
  });
  vi.stubGlobal('MediaStream', class {
    constructor(private tracks: Track[]) {}
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks; }
  });
  const push = (frame: InputFrame) => {
    if (pendingRead) { const read = pendingRead; pendingRead = undefined; read({ value: frame, done: false }); }
    else { queued?.close(); queued = frame; }
  };
  return { ...f, reader, writer, constructed, outputs, canvases, writes, push, get generated() { return generated; } };
}

describe('frame-driven orientation without page rendering callbacks', () => {
  it('writes actual rotated frames while the document is hidden and preserves camera timestamps', async () => {
    const f = processorFixture(); Object.assign(document, { hidden: true });
    const pending = f.start(270); const first = new InputFrame(9_000_000, 3840, 2160);
    f.push(first); const result = await pending;
    expect(f.constructed).toHaveBeenCalledExactlyOnceWith({ track: f.raw, maxBufferSize: 1 });
    expect(f.createElement).not.toHaveBeenCalled(); expect(f.canvases[0].captureStream).not.toHaveBeenCalled();
    expect(f.outputs[0]).toMatchObject({ timestamp: 9_000_000, displayWidth: 1080, displayHeight: 1920 });
    expect(f.canvases[0].context.setTransform).toHaveBeenLastCalledWith(0, -0.5, 0.5, 0, 0, 1920);
    expect(result.stream.getVideoTracks()[0]).toBe(f.generated);
    const next = new InputFrame(9_033_333, 1280, 720); f.push(next); await flushFrames();
    expect(f.outputs[1]).toMatchObject({ timestamp: 9_033_333, displayWidth: 720, displayHeight: 1280 });
    expect(first.close).toHaveBeenCalledOnce(); expect(next.close).toHaveBeenCalledOnce();
    for (const output of f.outputs) expect(output.close).toHaveBeenCalledOnce();
    expect(f.writes).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('uses source frame timestamps despite irregular JavaScript scheduling and closes skipped 60 fps frames', async () => {
    const f = processorFixture(); const pending = f.start(270, { width: 3840, height: 2160 }); const first = new InputFrame(0, 3840, 2160); f.push(first); await pending;
    const inputs = [first];
    for (let index = 1; index <= 60; index++) {
      const frame = new InputFrame(Math.round(index * 1_000_000 / 60), 3840, 2160); inputs.push(frame);
      f.push(frame); await flushFrames();
    }
    expect(f.writes).toHaveLength(31);
    expect(f.outputs.every(frame => frame.displayWidth === 2160 && frame.displayHeight === 3840)).toBe(true);
    for (const frame of inputs) expect(frame.close).toHaveBeenCalledOnce();
    expect(f.createElement).not.toHaveBeenCalled();
  });

  it('waits for the first successful write and applies backpressure while releasing the camera frame immediately', async () => {
    const f = processorFixture(); let write!: () => void;
    f.writer.write.mockImplementationOnce(async frame => { f.writes.push(frame); await new Promise<void>(resolve => { write = resolve; }); });
    const ready = vi.fn(); const pending = f.start().then(ready); const first = new InputFrame(0); f.push(first); await flushFrames();
    expect(ready).not.toHaveBeenCalled(); expect(f.reader.read).toHaveBeenCalledOnce(); expect(first.close).toHaveBeenCalledOnce();
    expect(f.outputs[0].close).not.toHaveBeenCalled();
    const stale = new InputFrame(33_333); const newest = new InputFrame(66_666); f.push(stale); f.push(newest);
    expect(stale.close).toHaveBeenCalledOnce(); write(); await pending; await flushFrames();
    expect(f.writes.map(frame => frame.timestamp)).toEqual([0, 66_666]);
    expect(newest.close).toHaveBeenCalledOnce(); expect(f.outputs[0].close).toHaveBeenCalledOnce();
  });

  it('cancels during an unfinished write, closes its output immediately and ignores late success', async () => {
    const f = processorFixture(); let write!: () => void;
    f.writer.write.mockImplementationOnce(() => new Promise<void>(resolve => { write = resolve; }));
    const rejected = expect(f.start()).rejects.toMatchObject({ name: 'AbortError' });
    const frame = new InputFrame(0); f.push(frame); await flushFrames(); f.controller.abort(); await rejected;
    expect(frame.close).toHaveBeenCalledOnce(); expect(f.outputs[0].close).toHaveBeenCalledOnce();
    expect(f.reader.cancel).toHaveBeenCalledOnce(); expect(f.writer.abort).toHaveBeenCalledOnce();
    expect(f.generated.stop).toHaveBeenCalledOnce(); expect(f.raw.stop).not.toHaveBeenCalled();
    write(); await flushFrames(); expect(f.outputs[0].close).toHaveBeenCalledOnce();
    expect(f.reader.read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an outstanding read and disposes a successful transform silently and idempotently', async () => {
    const f = processorFixture(); const pending = f.start(); f.push(new InputFrame(0)); const result = await pending;
    const ended = vi.fn(); f.generated.addEventListener('ended', ended); result.dispose(); result.dispose(); await flushFrames();
    expect(f.reader.cancel).toHaveBeenCalledOnce(); expect(f.writer.abort).toHaveBeenCalledOnce();
    expect(f.reader.releaseLock).toHaveBeenCalledOnce(); expect(f.writer.releaseLock).toHaveBeenCalledOnce();
    expect(f.generated.stop).toHaveBeenCalledOnce(); expect(f.raw.stop).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
    expect([f.canvases[0].width, f.canvases[0].height]).toEqual([0, 0]);
  });

  it('closes a frame that arrives from an old read after cancellation', async () => {
    const f = processorFixture(); f.reader.cancel.mockResolvedValue();
    const rejected = expect(f.start()).rejects.toMatchObject({ name: 'AbortError' });
    f.controller.abort(); await rejected;
    const late = new InputFrame(0); f.push(late); await flushFrames();
    expect(late.close).toHaveBeenCalledOnce(); expect(f.writer.write).not.toHaveBeenCalled();
    expect(f.outputs).toHaveLength(0); expect(f.raw.stop).not.toHaveBeenCalled();
  });

  it('cleans up a rejected first write and reports a sanitized failure', async () => {
    const f = processorFixture(); f.writer.write.mockRejectedValue(new Error('sensitive native details'));
    const rejected = expect(f.start()).rejects.toThrow('摄像头方向调整失败，请重新开启。');
    const input = new InputFrame(0); f.push(input); await rejected; await flushFrames();
    expect(input.close).toHaveBeenCalledOnce(); expect(f.outputs[0].close).toHaveBeenCalledOnce();
    expect(f.generated.stop).toHaveBeenCalledOnce(); expect(f.reader.cancel).toHaveBeenCalledOnce();
    expect(f.raw.stop).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('notifies output consumers on a runtime write failure without stopping the borrowed source', async () => {
    const f = processorFixture(); const pending = f.start(); f.push(new InputFrame(0)); const result = await pending;
    const ended = vi.fn(() => result.dispose()); f.generated.addEventListener('ended', ended);
    f.writer.write.mockRejectedValue(new Error('native error')); f.push(new InputFrame(33_333)); await flushFrames();
    expect(ended).toHaveBeenCalledOnce(); expect(f.generated.stop).toHaveBeenCalledOnce();
    expect(f.raw.stop).not.toHaveBeenCalled(); for (const frame of f.outputs) expect(frame.close).toHaveBeenCalledOnce();
  });

  it('releases the input and notifies consumers if constructing a new output frame fails', async () => {
    const f = processorFixture(); const pending = f.start(); f.push(new InputFrame(0)); const result = await pending;
    const ended = vi.fn(() => result.dispose()); f.generated.addEventListener('ended', ended);
    vi.stubGlobal('VideoFrame', class { constructor() { throw new Error('GPU allocation failed'); } });
    const input = new InputFrame(33_333); f.push(input); await flushFrames();
    expect(input.close).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledOnce();
    expect(f.generated.stop).toHaveBeenCalledOnce(); expect(f.reader.cancel).toHaveBeenCalledOnce();
    expect(f.raw.stop).not.toHaveBeenCalled(); expect(f.writer.write).toHaveBeenCalledOnce();
  });

  it('times out when the processor never delivers a frame', async () => {
    const f = processorFixture(); const rejected = expect(f.start()).rejects.toThrow('等待摄像头画面超时');
    await vi.advanceTimersByTimeAsync(8000); await rejected;
    expect(f.reader.cancel).toHaveBeenCalledOnce(); expect(f.writer.abort).toHaveBeenCalledOnce();
    expect(f.raw.stop).not.toHaveBeenCalled(); expect(f.generated.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(['processor', 'fallback'] as const)('configurable resolution in the %s path', path => {
  it.each([[1920, 1080], [1080, 1920], [640, 360]])('passes known %i×%i input through at 0° when it fits the explicit limit', async (width, height) => {
    const f = path === 'processor' ? processorFixture() : fixture();
    f.raw.getSettings.mockReturnValue({ width, height });
    const result = await f.start(0, { width: 1080, height: 1920 });
    expect(result.stream).toBe(f.source);
    expect(f.createElement).not.toHaveBeenCalled();
    if ('constructed' in f) expect(f.constructed).not.toHaveBeenCalled();
    result.dispose(); expect(f.raw.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [3840, 2160, true, 1920, 1080], [2160, 3840, true, 1080, 1920],
    [3840, 2160, false, 1920, 1080], [640, 360, false, 640, 360],
    [1921, 1081, true, 1918, 1080],
  ])('bounds %i×%i at 0° with known dimensions %s without rotating or enlarging the picture', async (width, height, known, outWidth, outHeight) => {
    const f = path === 'processor' ? processorFixture() : fixture();
    if (known) f.raw.getSettings.mockReturnValue({ width, height });
    f.video.ready(width, height);
    const pending = f.start(0, { width: 1920, height: 1080 });
    const frame = new InputFrame(0, width, height);
    if ('push' in f) f.push(frame);
    const result = await pending;
    const canvas = 'canvases' in f ? f.canvases[0] : f.canvas;
    expect(result.stream).not.toBe(f.source);
    expect([canvas.width, canvas.height]).toEqual([outWidth, outHeight]);
    expect(canvas.context.setTransform).toHaveBeenLastCalledWith(outWidth / width, 0, 0, outHeight / height, 0, 0);
    expect(canvas.width).toBeLessThanOrEqual(width); expect(canvas.height).toBeLessThanOrEqual(height);
    expect(canvas.width % 2).toBe(0); expect(canvas.height % 2).toBe(0);
    result.dispose(); expect(f.raw.stop).not.toHaveBeenCalled();
  });

  describe.each([[1024, 1920], [818, 1536], [664, 1248], [512, 960]])('L profile %i×%i', (shortEdge, longEdge) => {
    it.each([0, 90, 180, 270] as const)('limits both edges at %i° using actual frames even when capture exceeds the request', async rotation => {
      const f = path === 'processor' ? processorFixture() : fixture();
      const width = longEdge * 3; const height = shortEdge * 3;
      f.raw.getSettings.mockReturnValue({ width, height }); f.video.ready(width, height);
      const pending = f.start(rotation, { width: shortEdge, height: longEdge });
      const frame = new InputFrame(0, width, height);
      if ('push' in f) f.push(frame);
      const result = await pending;
      const canvas = 'canvases' in f ? f.canvases[0] : f.canvas;
      expect([canvas.width, canvas.height]).toEqual(rotation === 90 || rotation === 270
        ? [shortEdge, longEdge] : [longEdge, shortEdge]);
      expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(longEdge);
      expect(Math.min(canvas.width, canvas.height)).toBeLessThanOrEqual(shortEdge);
      expect(canvas.width % 2).toBe(0); expect(canvas.height % 2).toBe(0);
      result.dispose(); expect(f.raw.stop).not.toHaveBeenCalled();
    });
  });

  it.each([
    [3840, 2160, 90, 2160, 3840], [2160, 3840, 90, 3840, 2160],
    [3840, 2160, 270, 2160, 3840], [2160, 3840, 270, 3840, 2160],
    [3840, 2160, 180, 3840, 2160], [2160, 3840, 180, 2160, 3840],
    [7680, 4320, 270, 2160, 3840], [1280, 720, 90, 720, 1280],
  ])('allows actual %i×%i input at %i° up to 4K without upscaling', async (width, height, rotation, outWidth, outHeight) => {
    const f = path === 'processor' ? processorFixture() : fixture();
    f.video.ready(width, height);
    const pending = f.start(rotation as ExhibitionCameraRotation, { width: 3840, height: 2160 });
    const frame = new InputFrame(10_000_000, width, height);
    if ('push' in f) f.push(frame);
    const result = await pending;
    const canvas = 'canvases' in f ? f.canvases[0] : f.canvas;
    expect([canvas.width, canvas.height]).toEqual([outWidth, outHeight]);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(3840 * 2160);
    if ('outputs' in f) {
      expect(f.outputs[0]).toMatchObject({ timestamp: frame.timestamp, displayWidth: outWidth, displayHeight: outHeight });
      expect(frame.close).toHaveBeenCalledOnce(); expect(f.outputs[0].close).toHaveBeenCalledOnce();
    }
    result.dispose(); expect(f.raw.stop).not.toHaveBeenCalled();
  });

  it('uses an orientation-independent snapshot of the selected resolution', async () => {
    const f = path === 'processor' ? processorFixture() : fixture();
    const dimensions = { width: 2160, height: 3840 };
    const pending = f.start(270, dimensions);
    dimensions.width = 1080; dimensions.height = 1920;
    if ('push' in f) f.push(new InputFrame(0, 3840, 2160));
    else { f.video.ready(3840, 2160); f.video.frame(performance.now()); }
    await pending;
    const canvas = 'canvases' in f ? f.canvases[0] : f.canvas;
    expect([canvas.width, canvas.height]).toEqual([2160, 3840]);
  });
});

it.each([0, NaN, Infinity, 1080.5])('rejects an invalid maximum dimension %s before allocating resources', async width => {
  const f = fixture(); await expect(f.start(270, { width, height: 2160 })).rejects.toThrow('摄像头画面尺寸无效');
  expect(f.createElement).not.toHaveBeenCalled(); expect(f.raw.stop).not.toHaveBeenCalled();
});
