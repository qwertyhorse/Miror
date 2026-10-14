import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXHIBITION_GESTURE_SETTINGS, type ExhibitionGestureSettings } from '../shared/exhibitionGestures';
import { useExhibitionGestures } from '../src/exhibition/useExhibitionGestures';
import type { ExhibitionGestureHand, ExhibitionGestureMode } from '../src/exhibition/gestureDetector';
import type { ExhibitionGesturePose } from '../src/exhibition/raiseGestureDetector';
import type { ExhibitionGestureConfirmationState } from '../src/exhibition/mirrorGestureDetector';
import { createReactHost, flushReact } from './support/reactHost';

const motion = vi.hoisted(() => ({ update: vi.fn(), reset: vi.fn(), handRaised: false }));
const poseMotion = vi.hoisted(() => ({ update: vi.fn(), reset: vi.fn(), handRaised: false, handDetected: false,
  operatorStatus: 'searching' as 'searching' | 'locked' | 'ambiguous', armed: false, lastRaiseStartedAt: null as number | null }));
const mirrorMotion = vi.hoisted(() => ({ create: vi.fn(), configure: vi.fn(), update: vi.fn(), reset: vi.fn(), handRaised: false, handDetected: false,
  operatorStatus: 'searching' as 'searching' | 'locked' | 'ambiguous', armed: false, needsRelease: false, controlSource: 'none' as 'none' | 'body' | 'hand', ambiguityReason: null as 'people' | 'hands' | null,
  lastRaiseStartedAt: null as number | null, confirmationState: 'no_hand' as ExhibitionGestureConfirmationState,
  palmHoldMs: 0, rawHandCount: 0, matchedHandCount: 0 }));
vi.mock('../src/exhibition/mirrorGestureDetector', () => ({
  ExhibitionMirrorGestureDetector: class {
    constructor(options: unknown) { mirrorMotion.create(options); }
    configure = mirrorMotion.configure;
    update = mirrorMotion.update;
    reset = mirrorMotion.reset;
    get handRaised() { return mirrorMotion.handRaised; }
    get handDetected() { return mirrorMotion.handDetected; }
    get operatorStatus() { return mirrorMotion.operatorStatus; }
    get armed() { return mirrorMotion.armed; }
    get needsRelease() { return mirrorMotion.needsRelease; }
    get controlSource() { return mirrorMotion.controlSource; }
    get ambiguityReason() { return mirrorMotion.ambiguityReason; }
    get confirmationState() { return mirrorMotion.confirmationState; }
    get palmHoldMs() { return mirrorMotion.palmHoldMs; }
    get rawHandCount() { return mirrorMotion.rawHandCount; }
    get matchedHandCount() { return mirrorMotion.matchedHandCount; }
    get lastRaiseStartedAt() { return mirrorMotion.lastRaiseStartedAt; }
  },
}));
vi.mock('../src/exhibition/raiseGestureDetector', () => ({
  ExhibitionRaiseGestureDetector: class {
    update = poseMotion.update;
    reset = poseMotion.reset;
    get handRaised() { return poseMotion.handRaised; }
    get handDetected() { return poseMotion.handDetected; }
    get operatorStatus() { return poseMotion.operatorStatus; }
    get armed() { return poseMotion.armed; }
    get lastRaiseStartedAt() { return poseMotion.lastRaiseStartedAt; }
  },
}));
vi.mock('../src/exhibition/gestureDetector', () => ({
  ExhibitionGestureDetector: class {
    update = motion.update;
    reset = motion.reset;
    get handRaised() { return motion.handRaised; }
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
  motion.handRaised = false;
  motion.reset.mockImplementation(() => { motion.handRaised = false; });
  motion.update.mockReturnValue('wave');
  const clearPose = () => { poseMotion.handRaised = false; poseMotion.handDetected = false; poseMotion.operatorStatus = 'searching'; poseMotion.armed = false; poseMotion.lastRaiseStartedAt = null; };
  clearPose();
  poseMotion.reset.mockImplementation(clearPose);
  poseMotion.update.mockReturnValue(null);
  const clearMirror = (preserveLatch = false) => {
    mirrorMotion.handRaised = false; mirrorMotion.handDetected = false; mirrorMotion.operatorStatus = 'searching';
    mirrorMotion.armed = false; mirrorMotion.controlSource = 'none'; mirrorMotion.ambiguityReason = null; mirrorMotion.lastRaiseStartedAt = null;
    mirrorMotion.confirmationState = 'no_hand'; mirrorMotion.palmHoldMs = 0; mirrorMotion.rawHandCount = 0; mirrorMotion.matchedHandCount = 0;
    if (!preserveLatch) mirrorMotion.needsRelease = false;
  };
  clearMirror();
  mirrorMotion.reset.mockImplementation(clearMirror);
  mirrorMotion.configure.mockImplementation(() => clearMirror(true));
  mirrorMotion.update.mockReturnValue(null);
});
afterEach(async () => {
  await host?.close();
  host = undefined;
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture(initial: { enabled?: boolean; stream?: MediaStream; mirrored?: boolean; resetKey?: string; mode?: ExhibitionGestureMode; diagnostics?: boolean; recognitionSettings?: ExhibitionGestureSettings } = {}) {
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
  let props = { stream, enabled: initial.enabled ?? true, mode: initial.mode ?? 'wave' as ExhibitionGestureMode,
    mirrored: initial.mirrored ?? true, resetKey: initial.resetKey, diagnostics: initial.diagnostics, recognitionSettings: initial.recognitionSettings, onGesture };
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
  async function replyPose(frameData: { frameId: number; timestamp: number }, poses = [{ landmarks: [{ x: 0.2, y: 0.4, visibility: 0.9, presence: 0.8 }] }]) {
    await act(async () => { TestWorker.instances.at(-1)!.emit({ ...frameData, type: 'result', poses, inferenceMs: 42 }); });
  }
  async function replyCombined(frameData: { frameId: number; timestamp: number },
    poses: ExhibitionGesturePose[] = [{ landmarks: [{ x: 0.2, y: 0.4, visibility: 0.9, presence: 0.8 }] }],
    hands: ExhibitionGestureHand[] = [{ landmarks: [{ x: 0.2, y: 0.4 }], handedness: 'Left' }]) {
    await act(async () => { TestWorker.instances.at(-1)!.emit({ ...frameData, type: 'result', poses, hands, inferenceMs: 58.4 }); });
  }
  return { get result() { return result; }, track, stream, video, canvas, bitmap, createBitmap, getUserMedia,
    onGesture, render, ready, frame, reply, replyPose, replyCombined };
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
    expect(f.result).toMatchObject({ status: 'ready', handDetected: false, handRaised: false, lastHandAt: null, captureStatus: 'waiting', fps: 0 });
    let frame = await f.frame(); await f.reply(frame);
    expect(f.result).toMatchObject({ captureStatus: 'active', handDetected: true, inferenceMs: 18 });
    expect(f.result.lastHandAt).toBeGreaterThan(0);
    frame = await f.frame(); await f.reply(frame, []);
    expect(f.result).toMatchObject({ status: 'ready', captureStatus: 'active', handDetected: false });
    expect(f.result.fps).toBeGreaterThan(0);
    expect(f.result.fps).toBeLessThanOrEqual(15);
  });

  it('reports raised-hand changes from the same frame without issuing a gesture callback', async () => {
    const f = await fixture();
    motion.update.mockReturnValue(null);
    await f.ready();
    let frame = await f.frame(); await f.reply(frame);
    expect(f.result).toMatchObject({ handDetected: true, handRaised: false, lastGesture: null });
    motion.update.mockImplementation(() => { motion.handRaised = true; return null; });
    frame = await f.frame(); await f.reply(frame);
    expect(f.result).toMatchObject({ handDetected: true, handRaised: true, lastGesture: null });
    motion.update.mockImplementation(() => { motion.handRaised = false; return null; });
    frame = await f.frame(); await f.reply(frame);
    expect(f.result.handRaised).toBe(false);
    expect(f.onGesture).not.toHaveBeenCalled();
  });

  it('clears raised-hand readiness on reset and ignores a frame from the preceding screen', async () => {
    const f = await fixture();
    motion.update.mockImplementation(() => { motion.handRaised = true; return null; });
    await f.ready();
    let frame = await f.frame(); await f.reply(frame);
    expect(f.result.handRaised).toBe(true);
    const stale = await f.frame();
    await f.render({ resetKey: 'another-mirror' });
    expect(f.result.handRaised).toBe(false);
    await f.reply(stale);
    expect(f.result.handRaised).toBe(false);
    // A valid post-reset frame must restore readiness immediately, even inside the reporting throttle.
    frame = await f.frame(); await f.reply(frame);
    expect(f.result.handRaised).toBe(true);
    expect(f.onGesture).not.toHaveBeenCalled();
  });

  it('clears raised-hand readiness when the hand disappears, capture pauses or recognition closes', async () => {
    const f = await fixture();
    motion.update.mockImplementation(() => { motion.handRaised = true; return null; });
    await f.ready();
    let frame = await f.frame(); await f.reply(frame);
    expect(f.result.handRaised).toBe(true);
    frame = await f.frame(); await f.reply(frame, []);
    expect(f.result).toMatchObject({ handDetected: false, handRaised: false });
    frame = await f.frame(); await f.reply(frame);
    expect(f.result.handRaised).toBe(true);
    f.track.muted = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    expect(f.result).toMatchObject({ captureStatus: 'muted', handRaised: false });
    f.track.muted = false;
    frame = await f.frame(); await f.reply(frame);
    expect(f.result.handRaised).toBe(true);
    await f.render({ enabled: false });
    expect(f.result).toMatchObject({ status: 'off', handRaised: false });
    expect(f.onGesture).not.toHaveBeenCalled();
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

describe('completion-driven gesture frame scheduling', () => {
  async function advance(milliseconds: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  }
  const frames = () => TestWorker.instances.at(-1)!.postMessage.mock.calls
    .filter(([data]) => data.type === 'detect').map(([data]) => data);

  it('samples immediately after 70–90 ms inference instead of waiting for another 67 ms polling boundary', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    await advance(67);
    let pending = frames().at(-1)!;
    for (const inferenceDuration of [70, 90, 70, 90]) {
      f.video.currentTime += 0.1;
      const count = frames().length;
      await advance(inferenceDuration);
      expect(frames()).toHaveLength(count);
      await f.replyCombined(pending);
      await advance(0);
      expect(frames()).toHaveLength(count + 1);
      const next = frames().at(-1)!;
      expect(next.timestamp - pending.timestamp).toBe(inferenceDuration);
      expect(next.frameId).toBe(pending.frameId + 1);
      pending = next;
    }
    expect(f.createBitmap).toHaveBeenCalledTimes(5);
    expect(TestWorker.instances).toHaveLength(1);
  });

  it.each([5, 15, 30])('waits for the configured %s FPS limit when inference completes early', async maxFps => {
    const f = await fixture({ mode: 'palm_wave', recognitionSettings: { ...DEFAULT_EXHIBITION_GESTURE_SETTINGS, maxFps } });
    const interval = Math.ceil(1000 / maxFps);
    await f.ready();
    await advance(interval);
    let pending = frames().at(-1)!;
    for (let index = 0; index < 3; index += 1) {
      f.video.currentTime += 0.1;
      const count = frames().length;
      await advance(8);
      await f.replyCombined(pending);
      await advance(interval - 9);
      expect(frames()).toHaveLength(count);
      await advance(1);
      expect(frames()).toHaveLength(count + 1);
      const next = frames().at(-1)!;
      expect(next.timestamp - pending.timestamp).toBe(interval);
      pending = next;
    }
  });

  it('rounds up a fractional deadline and reschedules only the remainder after an early timer wakeup', async () => {
    const clockNow = performance.now.bind(performance);
    let submillisecond = 0.5;
    vi.spyOn(performance, 'now').mockImplementation(() => clockNow() + submillisecond);
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    await advance(67);
    const pending = frames()[0];
    expect(pending.timestamp).toBe(67.5);
    f.video.currentTime += 0.1;
    await advance(8);
    submillisecond = 0.7;
    await f.replyCombined(pending); // Remaining 58.8 ms must round up to 59 ms.
    await advance(58);
    expect(frames()).toHaveLength(1);
    // Simulate a timer arriving slightly before performance.now()'s deadline.
    submillisecond = 0;
    await advance(1);
    expect(frames()).toHaveLength(1);
    await advance(1);
    expect(frames()).toHaveLength(2);
    expect(frames()[1].timestamp - pending.timestamp).toBe(67.5);
  });

  it.each(['hidden', 'muted', 'disabled'] as const)('checks %s capture before immediately resampling a completed frame', async pause => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    await advance(67);
    const pending = frames()[0];
    f.video.currentTime += 0.1;
    await advance(90);
    if (pause === 'hidden') Object.assign(document, { hidden: true });
    else if (pause === 'muted') f.track.muted = true;
    else f.track.enabled = false;
    await f.replyCombined(pending);
    await advance(0);
    expect(frames()).toHaveLength(1);
    expect(f.result.captureStatus).toBe(pause);
    expect(mirrorMotion.update).not.toHaveBeenCalled();
    Object.assign(document, { hidden: false });
    f.track.muted = false; f.track.enabled = true;
    await advance(67);
    expect(frames()).toHaveLength(2);
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it('cancels the immediate follow-up on unmount and rejects duplicate completed results', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    await advance(67);
    const pending = frames()[0];
    f.video.currentTime += 0.1;
    await advance(90);
    await f.replyCombined(pending);
    await f.replyCombined(pending);
    expect(mirrorMotion.update).toHaveBeenCalledTimes(1);
    await host!.close(); host = undefined;
    await advance(500);
    expect(frames()).toHaveLength(1);
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it('still times out a stuck inference after 15 seconds without queuing another frame', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    await advance(67);
    f.video.currentTime += 0.1;
    await advance(14_999);
    expect(f.result.status).toBe('ready');
    expect(frames()).toHaveLength(1);
    await advance(1);
    expect(f.result).toMatchObject({ status: 'error', error: '手势识别超时，请重试。' });
    await advance(500);
    expect(frames()).toHaveLength(1);
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
});

describe('body-relative raise recognition integration', () => {
  it('loads only the pose worker and forwards all poses with visibility and mirrored coordinates', async () => {
    const f = await fixture({ mode: 'raise' });
    expect(TestWorker.instances[0].url).toBe('/assets/exhibition-gestures/pose-landmarker.worker.js');
    await f.ready();
    expect(f.result).toMatchObject({ operatorStatus: 'searching', armed: false });
    const frame = await f.frame();
    poseMotion.update.mockImplementation(() => {
      poseMotion.operatorStatus = 'locked'; poseMotion.handDetected = true; poseMotion.armed = true;
      return null;
    });
    await f.replyPose(frame, [
      { landmarks: [{ x: 0.2, y: 0.4, visibility: 0.9, presence: 0.8 }] },
      { landmarks: [{ x: 0.9, y: 0.3, visibility: 0.6, presence: 0.7 }] },
    ]);
    const [poses, timestamp] = poseMotion.update.mock.lastCall!;
    expect(poses[0].landmarks[0]).toEqual({ x: 0.8, y: 0.4, visibility: 0.9, presence: 0.8 });
    expect(poses[1].landmarks[0].x).toBeCloseTo(0.1);
    expect(timestamp).toBe(frame.timestamp);
    expect(f.result).toMatchObject({ operatorStatus: 'locked', handDetected: true, armed: true, inferenceMs: 42 });
    expect(motion.update).not.toHaveBeenCalled();
    expect(f.onGesture).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('reports a completed raise and ambiguity without retaining readiness', async () => {
    const f = await fixture({ mode: 'raise', mirrored: false });
    await f.ready();
    let frame = await f.frame();
    poseMotion.update.mockImplementation(() => {
      poseMotion.operatorStatus = 'locked'; poseMotion.handDetected = true; poseMotion.handRaised = true;
      return 'raise_hand';
    });
    await f.replyPose(frame);
    expect(f.onGesture).toHaveBeenCalledExactlyOnceWith('raise_hand');
    expect(f.result).toMatchObject({ handRaised: true, operatorStatus: 'locked', lastGesture: 'raise_hand' });
    expect(poseMotion.update.mock.lastCall![0][0].landmarks[0].x).toBe(0.2);
    poseMotion.update.mockImplementation(() => {
      poseMotion.operatorStatus = 'ambiguous'; poseMotion.handDetected = false; poseMotion.handRaised = false;
      return null;
    });
    frame = await f.frame(); await f.replyPose(frame, []);
    expect(f.result).toMatchObject({ operatorStatus: 'ambiguous', handRaised: false, armed: false });
    expect(f.onGesture).toHaveBeenCalledTimes(1);
  });

  it('rejects delayed pose results and clears the operator on visibility/reset boundaries', async () => {
    const f = await fixture({ mode: 'raise' });
    await f.ready();
    poseMotion.update.mockImplementation(() => {
      poseMotion.operatorStatus = 'locked'; poseMotion.handDetected = true; poseMotion.armed = true;
      return null;
    });
    let frame = await f.frame(); await f.replyPose(frame);
    expect(f.result.operatorStatus).toBe('locked');
    frame = await f.frame();
    await act(async () => { await vi.advanceTimersByTimeAsync(850); });
    const calls = poseMotion.update.mock.calls.length;
    await f.replyPose(frame);
    expect(poseMotion.update).toHaveBeenCalledTimes(calls);
    expect(f.result).toMatchObject({ operatorStatus: 'searching', armed: false, handDetected: false });
    frame = await f.frame(); await f.replyPose(frame);
    expect(f.result.operatorStatus).toBe('locked');
    await f.render({ resetKey: 'new-experience' });
    expect(f.result).toMatchObject({ operatorStatus: 'searching', armed: false });
    frame = await f.frame(); await f.replyPose(frame);
    await act(async () => { Object.assign(document, { hidden: true }); document.dispatchEvent(new Event('visibilitychange')); });
    expect(f.result).toMatchObject({ operatorStatus: 'searching', armed: false, captureStatus: 'hidden' });
    expect(f.onGesture).not.toHaveBeenCalled();
  });

  it('replaces the worker when changing recognition mode without reopening or stopping the camera', async () => {
    const f = await fixture();
    await f.ready();
    const old = TestWorker.instances[0];
    await f.render({ mode: 'raise' });
    expect(TestWorker.instances).toHaveLength(2);
    expect(old.postMessage).toHaveBeenCalledWith({ type: 'close' });
    expect(TestWorker.instances[1].url).toContain('pose-landmarker.worker.js');
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });
});

describe('combined palm and wave recognition integration', () => {
  it('loads Pose and Hands in one local worker while retaining the existing camera and bitmap pipeline', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    const worker = TestWorker.instances[0];
    expect(worker.url).toBe('/assets/exhibition-gestures/pose-landmarker.worker.js');
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'init', hands: true, options: { minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.5 } });
    await f.ready();
    expect(f.result).toMatchObject({ status: 'ready', operatorStatus: 'searching', handDetected: false, armed: false, needsRelease: false });
    const frame = await f.frame();
    await f.frame();
    expect(f.createBitmap).toHaveBeenCalledExactlyOnceWith(f.canvas);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ ...frame, bitmap: f.bitmap }, [f.bitmap]);
    await f.replyCombined(frame);
    expect(mirrorMotion.update).toHaveBeenCalledTimes(1);
    expect(poseMotion.update).not.toHaveBeenCalled();
    expect(motion.update).not.toHaveBeenCalled();
    expect(f.video.srcObject).toBe(f.stream);
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it.each([true, false])('maps both pose and hand coordinates consistently with mirrored=%s', async mirrored => {
    const f = await fixture({ mode: 'palm_wave', mirrored });
    await f.ready();
    const frame = await f.frame();
    const poses = [
      { landmarks: [{ x: 0.25, y: 0.4, z: -0.1, visibility: 0.9, presence: 0.8 }] },
      { landmarks: [{ x: 0.75, y: 0.3, z: 0.2, visibility: 0.6, presence: 0.7 }] },
    ];
    const hands = [
      { landmarks: [{ x: 0.125, y: 0.4, z: -0.2 }], handedness: 'Left' },
      { landmarks: [{ x: 0.875, y: 0.3, z: 0.1 }], handedness: 'Right' },
    ];
    mirrorMotion.update.mockImplementation(() => {
      mirrorMotion.operatorStatus = 'locked'; mirrorMotion.handDetected = true; mirrorMotion.armed = true;
      return null;
    });
    await f.replyCombined(frame, poses, hands);
    expect(mirrorMotion.update).toHaveBeenCalledExactlyOnceWith(
      poses.map(pose => ({ landmarks: pose.landmarks.map(point => ({ ...point, x: mirrored ? 1 - point.x : point.x })) })),
      hands.map(hand => ({ ...hand, landmarks: hand.landmarks.map(point => ({ ...point, x: mirrored ? 1 - point.x : point.x })) })),
      frame.timestamp, 640 / 480,
    );
    expect(poses[0].landmarks[0].x).toBe(0.25);
    expect(hands[0].landmarks[0].x).toBe(0.125);
    expect(f.result).toMatchObject({ operatorStatus: 'locked', handDetected: true, armed: true,
      inferenceMs: 58, inputWidth: 640, inputHeight: 480 });
    expect(f.onGesture).not.toHaveBeenCalled();
  });

  it.each(['reset-key', 'mirroring', 'hidden', 'muted', 'expired'] as const)('preserves the consumed-action latch and drops old frames across a %s boundary', async boundary => {
    const f = await fixture({ mode: 'palm_wave', recognitionSettings: { ...DEFAULT_EXHIBITION_GESTURE_SETTINGS, gestures: ['open_palm', 'wave'] } });
    await f.ready();
    mirrorMotion.update.mockImplementation(() => {
      mirrorMotion.operatorStatus = 'locked'; mirrorMotion.handDetected = true;
      if (mirrorMotion.needsRelease) return null;
      mirrorMotion.needsRelease = true;
      return 'wave';
    });
    let frame = await f.frame(); await f.replyCombined(frame);
    expect(f.result).toMatchObject({ needsRelease: true, lastGesture: 'wave' });
    expect(f.onGesture).toHaveBeenCalledExactlyOnceWith('wave');
    const pending = await f.frame();
    const updates = mirrorMotion.update.mock.calls.length;
    mirrorMotion.reset.mockClear();
    if (boundary === 'reset-key') await f.render({ resetKey: 'switch-completed' });
    else if (boundary === 'mirroring') await f.render({ mirrored: false });
    else if (boundary === 'hidden') await act(async () => {
      Object.assign(document, { hidden: true }); document.dispatchEvent(new Event('visibilitychange'));
    });
    else if (boundary === 'muted') {
      f.track.muted = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    } else await act(async () => { await vi.advanceTimersByTimeAsync(850); });
    expect(mirrorMotion.reset).toHaveBeenCalled();
    expect(mirrorMotion.reset.mock.calls.every(args => args.length === 1 && args[0] === true)).toBe(true);
    expect(mirrorMotion.needsRelease).toBe(true);
    expect(f.result).toMatchObject({ needsRelease: true, handDetected: false, armed: false, operatorStatus: 'searching' });
    await f.replyCombined(pending);
    expect(mirrorMotion.update).toHaveBeenCalledTimes(updates);
    if (boundary === 'hidden') await act(async () => {
      Object.assign(document, { hidden: false }); document.dispatchEvent(new Event('visibilitychange'));
    });
    if (boundary === 'muted') f.track.muted = false;
    frame = await f.frame(); await f.replyCombined(frame);
    expect(mirrorMotion.update).toHaveBeenCalledTimes(updates + 1);
    expect(f.result.needsRelease).toBe(true);
    expect(f.onGesture).toHaveBeenCalledTimes(1);
    expect(TestWorker.instances).toHaveLength(1);
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it('reports hand-only ownership and multiple-hand ambiguity from the same results', async () => {
    const f = await fixture({ mode: 'palm_wave' }); await f.ready();
    mirrorMotion.update.mockImplementation(() => {
      mirrorMotion.operatorStatus = 'locked'; mirrorMotion.controlSource = 'hand'; mirrorMotion.handDetected = true;
      return null;
    });
    let frame = await f.frame(); await f.replyCombined(frame);
    expect(f.result).toMatchObject({ operatorStatus: 'locked', controlSource: 'hand', ambiguityReason: null });
    mirrorMotion.update.mockImplementation(() => {
      mirrorMotion.operatorStatus = 'ambiguous'; mirrorMotion.controlSource = 'none'; mirrorMotion.ambiguityReason = 'hands';
      return null;
    });
    frame = await f.frame(); await f.replyCombined(frame);
    expect(f.result).toMatchObject({ operatorStatus: 'ambiguous', controlSource: 'none', ambiguityReason: 'hands' });
    expect(f.onGesture).not.toHaveBeenCalled();
    expect(TestWorker.instances).toHaveLength(1);
  });

  it('replaces a pose-only worker for combined mode without acquiring or stopping the shared camera', async () => {
    const f = await fixture({ mode: 'raise' });
    const previous = TestWorker.instances[0];
    expect(previous.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'init' });
    await f.render({ mode: 'palm_wave' });
    expect(previous.postMessage).toHaveBeenCalledWith({ type: 'close' });
    expect(TestWorker.instances).toHaveLength(2);
    expect(TestWorker.instances[1].postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'init', hands: true, options: { minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.5 } });
    expect(f.result).toMatchObject({ status: 'loading', operatorStatus: 'searching', needsRelease: false });
    expect(f.video.srcObject).toBe(f.stream);
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it('closes a still-loading combined worker and ignores its late ready message', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    const worker = TestWorker.instances[0];
    const lateMessage = worker.onmessage!;
    await f.render({ enabled: false });
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'close' });
    expect(f.video.srcObject).toBeNull();
    expect(document.body.contains(f.video)).toBe(false);
    await act(async () => {
      lateMessage({ data: { type: 'ready' } } as MessageEvent);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(f.result).toMatchObject({ status: 'off', needsRelease: false });
    expect(f.createBitmap).not.toHaveBeenCalled();
    expect(f.onGesture).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it('closes a bitmap completed after combined recognition has been disabled instead of transferring it', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    let resolve!: (bitmap: typeof f.bitmap) => void;
    f.createBitmap.mockReturnValueOnce(new Promise<typeof f.bitmap>(yes => { resolve = yes; }));
    await f.frame();
    await f.render({ enabled: false });
    await act(async () => { resolve(f.bitmap); });
    expect(f.bitmap.close).toHaveBeenCalledTimes(1);
    expect(TestWorker.instances[0].postMessage.mock.calls.map(([data]) => data.type)).toEqual(['init', 'close']);
    expect(f.result.status).toBe('off');
    expect(f.onGesture).not.toHaveBeenCalled();
  });
});

describe('palm confirmation state reporting', () => {
  const emptyConfirmation = { confirmationState: 'no_hand', palmHoldMs: 0, rawHandCount: 0, matchedHandCount: 0 };

  it('starts with empty confirmation details before a model or current camera observation is available', async () => {
    const f = await fixture({ mode: 'palm_wave', enabled: false });
    expect(f.result).toMatchObject({ status: 'off', ...emptyConfirmation });
    await f.render({ enabled: true });
    expect(f.result).toMatchObject({ status: 'loading', ...emptyConfirmation });
    await f.ready();
    expect(f.result).toMatchObject({ status: 'ready', ...emptyConfirmation });
    expect(mirrorMotion.update).not.toHaveBeenCalled();
    expect(f.createBitmap).not.toHaveBeenCalled();
  });

  it('reports changed confirmation reasons and hand counts immediately even within the normal reporting throttle', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    const details = { confirmationState: 'incomplete' as ExhibitionGestureConfirmationState, rawHandCount: 1, matchedHandCount: 1 };
    mirrorMotion.update.mockImplementation(() => {
      mirrorMotion.handDetected = true; mirrorMotion.operatorStatus = 'locked'; mirrorMotion.controlSource = 'body'; mirrorMotion.armed = true;
      Object.assign(mirrorMotion, details);
      return null;
    });
    let frame = await f.frame(); await f.replyCombined(frame);
    expect(f.result).toMatchObject({ confirmationState: 'incomplete', rawHandCount: 1, matchedHandCount: 1, palmHoldMs: 0 });
    details.confirmationState = 'fingers_folded';
    frame = await f.frame(); await f.replyCombined(frame);
    expect(f.result.confirmationState).toBe('fingers_folded');
    details.rawHandCount = 2;
    frame = await f.frame(); await f.replyCombined(frame);
    expect(f.result.rawHandCount).toBe(2);
    details.matchedHandCount = 2;
    frame = await f.frame(); await f.replyCombined(frame);
    expect(f.result).toMatchObject({ confirmationState: 'fingers_folded', rawHandCount: 2, matchedHandCount: 2 });
    expect(f.onGesture).not.toHaveBeenCalled();
  });

  it('keeps palm hold progress on the existing 250 ms reporting throttle without resetting or reopening recognition', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    let holdMs = 40;
    mirrorMotion.update.mockImplementation(() => {
      mirrorMotion.handDetected = true; mirrorMotion.operatorStatus = 'locked'; mirrorMotion.controlSource = 'hand'; mirrorMotion.armed = true;
      mirrorMotion.confirmationState = 'holding'; mirrorMotion.palmHoldMs = holdMs; mirrorMotion.rawHandCount = 1; mirrorMotion.matchedHandCount = 1;
      return null;
    });
    let frame = await f.frame(); await f.replyCombined(frame);
    expect(f.result).toMatchObject({ confirmationState: 'holding', palmHoldMs: 40, rawHandCount: 1, matchedHandCount: 1 });
    const resets = mirrorMotion.reset.mock.calls.length;
    for (holdMs of [110, 180, 250]) {
      frame = await f.frame(); await f.replyCombined(frame);
      expect(f.result.palmHoldMs).toBe(40);
    }
    holdMs = 300;
    frame = await f.frame(); await f.replyCombined(frame);
    expect(f.result.palmHoldMs).toBe(300);
    await f.render({ diagnostics: true });
    expect(mirrorMotion.reset).toHaveBeenCalledTimes(resets);
    expect(TestWorker.instances).toHaveLength(1);
    expect(f.video.srcObject).toBe(f.stream);
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.onGesture).not.toHaveBeenCalled();
  });

  it.each(['reset-key', 'hidden', 'muted', 'disabled-track', 'stalled', 'expired', 'off', 'error'] as const)('clears confirmation details at a %s boundary and ignores its prior frame', async boundary => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    mirrorMotion.update.mockImplementation(() => {
      mirrorMotion.handDetected = true; mirrorMotion.operatorStatus = 'locked'; mirrorMotion.controlSource = 'body'; mirrorMotion.armed = true;
      mirrorMotion.confirmationState = 'holding'; mirrorMotion.palmHoldMs = 180; mirrorMotion.rawHandCount = 2; mirrorMotion.matchedHandCount = 1;
      return null;
    });
    const frame = await f.frame(); await f.replyCombined(frame);
    expect(f.result).toMatchObject({ confirmationState: 'holding', palmHoldMs: 180, rawHandCount: 2, matchedHandCount: 1 });
    const pending = await f.frame();
    const calls = mirrorMotion.update.mock.calls.length;
    if (boundary === 'reset-key') await f.render({ resetKey: 'new-round' });
    else if (boundary === 'hidden') await act(async () => {
      Object.assign(document, { hidden: true }); document.dispatchEvent(new Event('visibilitychange'));
    });
    else if (boundary === 'off') await f.render({ enabled: false });
    else if (boundary === 'error') await act(async () => { TestWorker.instances[0].onerror!(); });
    else {
      if (boundary === 'muted') f.track.muted = true;
      if (boundary === 'disabled-track') f.track.enabled = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(boundary === 'stalled' ? 1400 : boundary === 'expired' ? 850 : 70); });
    }
    expect(f.result).toMatchObject(emptyConfirmation);
    await f.replyCombined(pending);
    expect(f.result).toMatchObject(emptyConfirmation);
    expect(mirrorMotion.update).toHaveBeenCalledTimes(calls);
    expect(f.onGesture).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });
});

describe('live mirror recognition configuration', () => {
  const config = (update: Partial<ExhibitionGestureSettings> = {}): ExhibitionGestureSettings => ({
    ...DEFAULT_EXHIBITION_GESTURE_SETTINGS, gestures: ['open_palm'], ...update,
  });

  it('defaults to palm only and filters an unselected result before callbacks', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    expect(mirrorMotion.create).toHaveBeenCalledExactlyOnceWith(config());
    await f.ready();
    mirrorMotion.update.mockReturnValue('wave');
    await f.replyCombined(await f.frame());
    expect(f.onGesture).not.toHaveBeenCalled();
    mirrorMotion.update.mockReturnValue('open_palm');
    await f.replyCombined(await f.frame());
    expect(f.onGesture).toHaveBeenCalledExactlyOnceWith('open_palm');
  });

  it('empty selection loads no model and closes existing recognition without touching camera tracks', async () => {
    const f = await fixture({ mode: 'palm_wave', recognitionSettings: config({ gestures: [] }) });
    expect(TestWorker.instances).toHaveLength(0);
    expect(f.result.status).toBe('off');
    await f.render({ recognitionSettings: config() });
    await f.ready();
    const previous = TestWorker.instances[0];
    const late = previous.onmessage!;
    const frame = await f.frame();
    await f.render({ recognitionSettings: config({ gestures: [] }) });
    await act(async () => late({ data: { ...frame, type: 'result', poses: [], hands: [] } } as MessageEvent));
    expect(f.result.status).toBe('off');
    expect(mirrorMotion.update).not.toHaveBeenCalled();
    expect(previous.postMessage).toHaveBeenCalledWith({ type: 'close' });
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('same-value polls and reordered selections preserve the worker and recognition progress', async () => {
    const f = await fixture({ mode: 'palm_wave', recognitionSettings: config({ gestures: ['open_palm', 'wave'] }) });
    await f.ready();
    const configured = mirrorMotion.configure.mock.calls.length;
    const resets = mirrorMotion.reset.mock.calls.length;
    await f.render({ recognitionSettings: config({ gestures: ['wave', 'open_palm'] }) });
    await f.render({ recognitionSettings: config({ gestures: ['open_palm', 'wave'] }) });
    expect(mirrorMotion.configure).toHaveBeenCalledTimes(configured);
    expect(mirrorMotion.reset).toHaveBeenCalledTimes(resets);
    expect(TestWorker.instances).toHaveLength(1);
    expect(f.video.pause).not.toHaveBeenCalled();
  });

  it('updates gesture timing in place, preserves consumed state, and rejects a preceding frame', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    const pending = await f.frame();
    mirrorMotion.needsRelease = true;
    const next = config({ gestures: ['wave'], palmConfirmMs: 600, palmReleaseMs: 900 });
    await f.render({ recognitionSettings: next });
    expect(mirrorMotion.configure).toHaveBeenLastCalledWith(next);
    expect(mirrorMotion.needsRelease).toBe(true);
    await f.replyCombined(pending);
    expect(mirrorMotion.update).not.toHaveBeenCalled();
    expect(TestWorker.instances).toHaveLength(1);
    mirrorMotion.update.mockReturnValue('open_palm');
    await f.replyCombined(await f.frame());
    expect(f.onGesture).not.toHaveBeenCalled();
    mirrorMotion.update.mockReturnValue('wave');
    await f.replyCombined(await f.frame());
    expect(f.onGesture).toHaveBeenCalledExactlyOnceWith('wave');
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('restarts only the worker for confidence changes while retaining detector ownership and dropping late results', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    const frame = await f.frame();
    const previous = TestWorker.instances[0];
    const late = previous.onmessage!;
    mirrorMotion.needsRelease = true;
    await f.render({ recognitionSettings: config({ minHandDetectionConfidence: 0.2, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.7 }) });
    expect(TestWorker.instances).toHaveLength(2);
    expect(mirrorMotion.create).toHaveBeenCalledTimes(1);
    expect(mirrorMotion.needsRelease).toBe(true);
    expect(TestWorker.instances[1].postMessage).toHaveBeenCalledWith({ type: 'init', hands: true, options: {
      minHandDetectionConfidence: 0.2, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.7,
    } });
    await act(async () => late({ data: { ...frame, type: 'result', poses: [], hands: [] } } as MessageEvent));
    expect(mirrorMotion.update).not.toHaveBeenCalled();
    expect(f.onGesture).not.toHaveBeenCalled();
    expect(f.video.srcObject).toBe(f.stream);
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    await f.ready();
    await f.replyCombined(await f.frame());
    expect(mirrorMotion.update).toHaveBeenCalledTimes(1);
  });

  it('applies only lowering and tracking-grace changes without restarting the camera or worker', async () => {
    const f = await fixture({ mode: 'palm_wave' });
    await f.ready();
    const pending = await f.frame();
    mirrorMotion.needsRelease = true;
    const next = config({ palmLowerMs: 700, lowerTrackingGraceMs: 800 });
    await f.render({ recognitionSettings: next });
    expect(mirrorMotion.configure).toHaveBeenLastCalledWith(next);
    expect(mirrorMotion.needsRelease).toBe(true);
    await f.replyCombined(pending);
    expect(mirrorMotion.update).not.toHaveBeenCalled();
    await f.replyCombined(await f.frame());
    expect(mirrorMotion.update).toHaveBeenCalledTimes(1);
    const configured = mirrorMotion.configure.mock.calls.length;
    await f.render({ recognitionSettings: { ...next } });
    expect(mirrorMotion.configure).toHaveBeenCalledTimes(configured);
    expect(TestWorker.instances).toHaveLength(1);
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('applies input resolution and maximum sample rate to actual captured frames without another worker', async () => {
    const f = await fixture({ mode: 'palm_wave', recognitionSettings: config({ maxFps: 5, inputLongEdge: 480 }) });
    f.video.videoWidth = 1080; f.video.videoHeight = 1920;
    await f.ready();
    await f.frame(); await f.frame();
    expect(f.createBitmap).not.toHaveBeenCalled();
    const frame = await f.frame();
    expect(frame.type).toBe('detect');
    expect(f.canvas).toMatchObject({ width: 270, height: 480 });
    await f.replyCombined(frame);
    await f.frame(); await f.frame();
    expect(f.createBitmap).toHaveBeenCalledTimes(1);
    await f.replyCombined(await f.frame());
    await f.render({ recognitionSettings: config({ maxFps: 30, inputLongEdge: 960 }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const next = await f.frame();
    expect(f.canvas).toMatchObject({ width: 540, height: 960 });
    await f.replyCombined(next);
    const before = f.createBitmap.mock.calls.length;
    await f.replyCombined(await f.frame());
    expect(f.createBitmap).toHaveBeenCalledTimes(before + 1);
    expect(TestWorker.instances).toHaveLength(1);
    expect(f.track.stop).not.toHaveBeenCalled();
  });
});

describe('optional local gesture diagnostics', () => {
  it.each(['wave', 'open_palm'] as const)('emits minimal combined %s metadata without a stale raise start and can disable diagnostics in place', async gesture => {
    const f = await fixture({ mode: 'palm_wave', diagnostics: true, recognitionSettings: { ...DEFAULT_EXHIBITION_GESTURE_SETTINGS, gestures: ['open_palm', 'wave'] } });
    await f.ready();
    let frame = await f.frame();
    mirrorMotion.update.mockImplementation(() => {
      mirrorMotion.lastRaiseStartedAt = frame.timestamp - 20;
      mirrorMotion.operatorStatus = 'locked'; mirrorMotion.handDetected = true; mirrorMotion.needsRelease = true;
      return gesture;
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(30); });
    await f.replyCombined(frame);
    expect(f.onGesture).toHaveBeenCalledExactlyOnceWith(gesture, {
      eventId: expect.stringMatching(/^gesture-\d+$/), frameId: frame.frameId,
      sampledAt: frame.timestamp, detectedAt: performance.now(),
    });
    expect(f.onGesture.mock.lastCall![1]).not.toHaveProperty('raiseStartedAt');
    expect(f.result.recognitionMs).toBe(Math.round(performance.now() - frame.timestamp));
    const resets = mirrorMotion.reset.mock.calls.length;
    await f.render({ diagnostics: false });
    expect(mirrorMotion.reset).toHaveBeenCalledTimes(resets);
    frame = await f.frame(); await f.replyCombined(frame);
    expect(f.onGesture.mock.lastCall).toEqual([gesture]);
    expect(TestWorker.instances).toHaveLength(1);
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('uses the performance clock for capture, successful raise start and local detection despite wall-clock changes', async () => {
    vi.setSystemTime(new Date('2035-01-01T00:00:00+14:00'));
    const f = await fixture({ mode: 'raise', diagnostics: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await f.ready();
    const frame = await f.frame();
    poseMotion.update.mockImplementation(() => {
      poseMotion.lastRaiseStartedAt = frame.timestamp - 300;
      poseMotion.operatorStatus = 'locked'; poseMotion.handDetected = true;
      return 'raise_hand';
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    vi.setSystemTime(new Date('2001-01-01T00:00:00-08:00'));
    const detectionTime = performance.now();
    await f.replyPose(frame);
    const [gesture, metadata] = f.onGesture.mock.lastCall!;
    expect(gesture).toBe('raise_hand');
    expect(metadata).toEqual({ eventId: expect.stringMatching(/^gesture-\d+$/), frameId: frame.frameId,
      sampledAt: frame.timestamp, detectedAt: detectionTime, raiseStartedAt: frame.timestamp - 300 });
    expect(metadata.raiseStartedAt).toBeLessThan(metadata.sampledAt);
    expect(metadata.sampledAt).toBeLessThan(metadata.detectedAt);
    expect(metadata.detectedAt).toBeLessThan(1_000);
    expect(f.result.recognitionMs).toBe(Math.round(metadata.detectedAt - metadata.sampledAt));
  });

  it('toggles diagnostics in place without resetting recognition, recreating a worker or changing the camera', async () => {
    const f = await fixture();
    await f.ready();
    let frame = await f.frame(); await f.reply(frame);
    expect(f.onGesture.mock.lastCall).toEqual(['wave']);
    const resetCount = motion.reset.mock.calls.length;
    const worker = TestWorker.instances[0];
    const plays = f.video.play.mock.calls.length;
    await f.render({ diagnostics: true });
    expect(motion.reset).toHaveBeenCalledTimes(resetCount);
    expect(TestWorker.instances).toEqual([worker]);
    frame = await f.frame(); await f.reply(frame);
    expect(f.onGesture.mock.lastCall).toEqual(['wave', {
      eventId: expect.any(String), frameId: frame.frameId, sampledAt: frame.timestamp, detectedAt: performance.now(),
    }]);
    expect(f.onGesture.mock.lastCall![1]).not.toHaveProperty('raiseStartedAt');
    await f.render({ diagnostics: false });
    frame = await f.frame(); await f.reply(frame);
    expect(f.onGesture.mock.lastCall).toEqual(['wave']);
    expect(motion.reset).toHaveBeenCalledTimes(resetCount);
    expect(TestWorker.instances).toEqual([worker]);
    expect(f.video.play).toHaveBeenCalledTimes(plays);
    expect(f.video.srcObject).toBe(f.stream);
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it('keeps event identifiers distinct when the worker restarts and frame numbering starts over', async () => {
    const f = await fixture({ diagnostics: true });
    await f.ready();
    let frame = await f.frame(); await f.reply(frame);
    const first = f.onGesture.mock.lastCall![1];
    await f.render({ enabled: false });
    await f.render({ enabled: true });
    await f.ready();
    frame = await f.frame(); await f.reply(frame);
    const second = f.onGesture.mock.lastCall![1];
    expect(second.frameId).toBe(first.frameId);
    expect(second.eventId).not.toBe(first.eventId);
    expect(Object.keys(second).sort()).toEqual(['detectedAt', 'eventId', 'frameId', 'sampledAt']);
  });

  it.each(['frame-id', 'reset', 'expired', 'future', 'invalid'] as const)('emits no event or diagnostics for a discarded %s frame', async cause => {
    const f = await fixture({ mode: 'raise', diagnostics: true });
    await f.ready();
    const frame = { ...await f.frame() };
    poseMotion.update.mockReturnValue('raise_hand');
    if (cause === 'frame-id') frame.frameId += 1;
    else if (cause === 'reset') await f.render({ resetKey: 'different-interaction' });
    else if (cause === 'expired') await act(async () => { await vi.advanceTimersByTimeAsync(850); });
    else if (cause === 'future') frame.timestamp = performance.now() + 100;
    else frame.timestamp = NaN;
    await f.replyPose(frame);
    expect(poseMotion.update).not.toHaveBeenCalled();
    expect(f.onGesture).not.toHaveBeenCalled();
  });
});
