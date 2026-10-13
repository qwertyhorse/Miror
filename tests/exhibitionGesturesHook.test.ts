import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useExhibitionGestures } from '../src/exhibition/useExhibitionGestures';
import { createReactHost, flushReact } from './support/reactHost';

const motion = vi.hoisted(() => ({ update: vi.fn(), reset: vi.fn() }));
vi.mock('../src/exhibition/gestureDetector', () => ({
  ExhibitionGestureDetector: class {
    update = motion.update;
    reset = motion.reset;
  },
}));

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(readonly url: string) { TestWorker.instances.push(this); }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  TestWorker.instances = [];
  motion.update.mockReturnValue('wave');
});
afterEach(async () => {
  await host?.close();
  host = undefined;
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture(initial: { enabled?: boolean; stream?: MediaStream; mirrored?: boolean; resetKey?: string } = {}) {
  host = await createReactHost();
  const track = Object.assign(new EventTarget(), { readyState: 'live', enabled: true, muted: false, stop: vi.fn() });
  const stream = initial.stream ?? { getVideoTracks: () => [track] } as unknown as MediaStream;
  const createElementOriginal = document.createElement.bind(document);
  const video = Object.assign(createElementOriginal('video'), { muted: false, autoplay: false, playsInline: false, srcObject: null as MediaStream | null,
    videoWidth: 640, videoHeight: 480, currentTime: 0, readyState: 2, play: vi.fn(async () => {}), pause: vi.fn() });
  const context = { drawImage: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: () => context };
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => tag === 'video' ? video
    : tag === 'canvas' ? canvas : createElementOriginal(tag)) as typeof document.createElement);
  const bitmap = { close: vi.fn() };
  const createBitmap = vi.fn(async () => bitmap);
  const getUserMedia = vi.fn();
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('createImageBitmap', createBitmap);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  Object.assign(document, { hidden: false });
  const onGesture = vi.fn();
  let result!: ReturnType<typeof useExhibitionGestures>;
  let props = { stream, enabled: initial.enabled ?? true, mode: 'wave' as const,
    mirrored: initial.mirrored ?? true, resetKey: initial.resetKey, onGesture };
  function Harness() { result = useExhibitionGestures(props); return null; }
  async function render(update: Partial<typeof props> = {}) {
    props = { ...props, ...update };
    await host!.render(createElement(Harness));
    await flushReact();
  }
  await render();
  async function ready() {
    await act(async () => { TestWorker.instances.at(-1)!.emit({ type: 'ready' }); });
  }
  async function frame() {
    video.currentTime += 1 / 15;
    await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    return TestWorker.instances.at(-1)!.postMessage.mock.calls.findLast(([data]) => data.type === 'detect')?.[0];
  }
  async function reply(frameData: { frameId: number; timestamp: number }, landmarks = [{ x: 0.2, y: 0.4 }]) {
    await act(async () => { TestWorker.instances.at(-1)!.emit({ ...frameData, type: 'result', landmarks, handedness: 'Left', inferenceMs: 18.4 }); });
  }
  return { get result() { return result; }, track, stream, video, canvas, bitmap, createBitmap, getUserMedia,
    onGesture, render, ready, frame, reply };
}

describe('exhibition gesture stream ownership and lifecycle', () => {
  it('leaves disabled or placeholder streams alone without loading a model', async () => {
    const f = await fixture({ enabled: false });
    expect(f.result.status).toBe('off');
    expect(TestWorker.instances).toHaveLength(0);
    await f.render({ enabled: true, stream: {} as MediaStream });
    expect(f.result.status).toBe('off');
    expect(TestWorker.instances).toHaveLength(0);
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('reuses the exact stream and releases only its own video/worker on unmount', async () => {
    const f = await fixture();
    const worker = TestWorker.instances[0];
    expect(f.result.status).toBe('loading');
    expect(f.video.srcObject).toBe(f.stream);
    expect(document.body.contains(f.video)).toBe(true);
    expect(f.video.getAttribute?.('aria-hidden') ?? f.video.attributes['aria-hidden']).toBe('true');
    expect(worker.url).toBe('/assets/exhibition-gestures/hand-landmarker.worker.js');
    await f.ready();
    expect(f.result.status).toBe('ready');
    const frame = await f.frame();
    expect(frame.type).toBe('detect');
    expect(f.canvas.width).toBe(640);
    expect(f.canvas.height).toBe(480);
    await host!.close(); host = undefined;
    expect(f.video.pause).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    expect(document.body.contains(f.video)).toBe(false);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'close' });
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('keeps one frame in flight, skips repeated video frames and maps mirrored coordinates', async () => {
    const f = await fixture();
    await f.ready();
    const frame = await f.frame();
    await f.frame();
    expect(f.createBitmap).toHaveBeenCalledOnce();
    await f.reply(frame);
    expect(motion.update).toHaveBeenCalledWith({ landmarks: [{ x: 0.8, y: 0.4 }], handedness: 'Left' }, frame.timestamp, 'wave');
    expect(f.onGesture).toHaveBeenCalledWith('wave');
    // The latest decoded frame was not yet sampled because inference was busy.
    await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    const next = TestWorker.instances[0].postMessage.mock.calls.findLast(([data]) => data.type === 'detect')![0];
    await f.reply(next);
    await act(async () => { await vi.advanceTimersByTimeAsync(210); });
    expect(f.createBitmap).toHaveBeenCalledTimes(2);
  });

  it('rejects in-flight results after reset and pauses while the page is hidden', async () => {
    const f = await fixture();
    await f.ready();
    const frame = await f.frame();
    await f.render({ resetKey: 'another-mirror' });
    await f.reply(frame);
    expect(f.onGesture).not.toHaveBeenCalled();
    expect(TestWorker.instances).toHaveLength(1);
    const next = await f.frame();
    Object.assign(document, { hidden: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await f.reply(next);
    await f.frame();
    expect(f.onGesture).not.toHaveBeenCalled();
    expect(f.createBitmap).toHaveBeenCalledTimes(2);
  });

  it('retries in a new worker after failure and ignores old asynchronous results', async () => {
    const f = await fixture();
    const oldWorker = TestWorker.instances[0];
    const stale = oldWorker.onmessage!;
    await act(async () => { oldWorker.onerror!(); });
    expect(f.result.status).toBe('error');
    await act(async () => { f.result.retry(); });
    expect(TestWorker.instances).toHaveLength(2);
    expect(f.result.status).toBe('loading');
    await act(async () => { stale({ data: { type: 'ready' } } as MessageEvent); });
    expect(f.result.status).toBe('loading');
    await f.ready();
    expect(f.result.status).toBe('ready');
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it('stops recognition when the shared camera ends without stopping that track', async () => {
    const f = await fixture();
    await f.ready();
    await act(async () => { f.track.dispatchEvent(new Event('ended')); });
    expect(f.result.status).toBe('error');
    expect(f.result.error).toBe('摄像头已断开。');
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(TestWorker.instances[0].postMessage).toHaveBeenCalledWith({ type: 'close' });
  });

  it('reports real hand presence separately from a ready model and retains local timing only', async () => {
    const f = await fixture();
    await f.ready();
    expect(f.result).toMatchObject({ status: 'ready', handDetected: false, lastHandAt: null, captureStatus: 'waiting', fps: 0 });
    let frame = await f.frame(); await f.reply(frame);
    expect(f.result).toMatchObject({ captureStatus: 'active', handDetected: true, inferenceMs: 18 });
    expect(f.result.lastHandAt).toBeGreaterThan(0);
    frame = await f.frame(); await f.reply(frame, []);
    expect(f.result).toMatchObject({ status: 'ready', captureStatus: 'active', handDetected: false });
    expect(f.result.fps).toBeGreaterThan(0);
    expect(f.result.fps).toBeLessThanOrEqual(15);
  });

  it('observes a disabled shared track, drops its in-flight result and resumes without changing the track', async () => {
    const f = await fixture();
    await f.ready();
    const pending = await f.frame();
    f.track.enabled = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    expect(f.result).toMatchObject({ captureStatus: 'disabled', handDetected: false, fps: 0 });
    await f.reply(pending);
    expect(f.onGesture).not.toHaveBeenCalled();
    expect(f.createBitmap).toHaveBeenCalledOnce();
    expect(f.track.enabled).toBe(false);
    f.track.enabled = true;
    const resumed = await f.frame(); await f.reply(resumed);
    expect(f.result).toMatchObject({ captureStatus: 'active', handDetected: true });
    expect(f.onGesture).toHaveBeenCalledOnce();
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(TestWorker.instances).toHaveLength(1);
  });

  it('reports muted or stalled video without retaining an old detected hand', async () => {
    const f = await fixture();
    await f.ready();
    let frame = await f.frame(); await f.reply(frame);
    f.track.muted = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    expect(f.result).toMatchObject({ captureStatus: 'muted', handDetected: false });
    f.track.muted = false;
    frame = await f.frame(); await f.reply(frame);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_400); });
    expect(f.result).toMatchObject({ status: 'ready', captureStatus: 'stalled', handDetected: false, fps: 0 });
    expect(f.track.stop).not.toHaveBeenCalled();
  });
});
