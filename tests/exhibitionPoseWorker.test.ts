import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(new URL('../public/assets/exhibition-gestures/pose-landmarker.worker.js', import.meta.url), 'utf8');
const workerUrl = 'https://xuminghong.local:10202/v1.1/assets/exhibition-gestures/pose-landmarker.worker.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const modelBytes = new Uint8Array([10, 20, 30]);
  const handModelBytes = new Uint8Array([40, 50, 60]);
  const response = { ok: true, arrayBuffer: vi.fn(async () => modelBytes.buffer) };
  const handResponse = { ok: true, arrayBuffer: vi.fn(async () => handModelBytes.buffer) };
  const fetch = vi.fn(async (url: URL, _options: { signal: AbortSignal }) => url.pathname.endsWith('/hand_landmarker.task') ? handResponse : response);
  const forVisionTasks = vi.fn(async (_path: string) => ({ wasm: 'local' }));
  const makeResult = (landmarks: unknown[][] = []) => ({ landmarks, close: vi.fn() });
  const task = { detectForVideo: vi.fn((_bitmap: unknown, _time: number) => makeResult()), close: vi.fn() };
  const createFromOptions = vi.fn(async (_vision: unknown, _options: unknown) => task);
  const makeHandResult = (landmarks: unknown[][] = [], handedness: unknown[][] = []) => ({ landmarks, handedness });
  const handTask = { detectForVideo: vi.fn((_bitmap: unknown, _time: number) => makeHandResult()), close: vi.fn() };
  const handCreateFromOptions = vi.fn(async (_vision: unknown, _options: unknown) => handTask);
  const self = {
    location: { href: workerUrl },
    exports: {} as { FilesetResolver?: unknown; PoseLandmarker?: unknown; HandLandmarker?: unknown },
    postMessage: vi.fn(),
    close: vi.fn(),
    onmessage: undefined as undefined | ((event: { data: Record<string, unknown> }) => Promise<void>),
  };
  const importScripts = vi.fn((_url: string) => {
    self.exports.FilesetResolver = { forVisionTasks };
    self.exports.PoseLandmarker = { createFromOptions };
    self.exports.HandLandmarker = { createFromOptions: handCreateFromOptions };
  });
  let now = 100;
  runInContext(workerSource, createContext({ self, fetch, importScripts, URL, Uint8Array, AbortController,
    performance: { now: () => now += 7 } }), { filename: workerUrl });
  const send = (data: Record<string, unknown>) => self.onmessage!({ data });
  return { self, send, fetch, response, handResponse, modelBytes, handModelBytes, importScripts, forVisionTasks,
    createFromOptions, handCreateFromOptions, task, handTask, makeResult, makeHandResult };
}

describe('exhibition pose worker', () => {
  it('loads only version-scoped local assets and requests video poses without segmentation', async () => {
    const f = fixture();
    await f.send({ type: 'init' });
    expect(f.importScripts).toHaveBeenCalledExactlyOnceWith('https://xuminghong.local:10202/v1.1/assets/exhibition-gestures/vision_bundle.js');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][0].href).toBe('https://xuminghong.local:10202/v1.1/assets/body-scan/pose_landmarker_full.task');
    expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(false);
    expect(f.forVisionTasks).toHaveBeenCalledExactlyOnceWith('https://xuminghong.local:10202/v1.1/assets/body-scan/wasm');
    expect(f.createFromOptions).toHaveBeenCalledExactlyOnceWith({ wasm: 'local' }, {
      baseOptions: { modelAssetBuffer: f.modelBytes, delegate: 'CPU' },
      runningMode: 'VIDEO', numPoses: 2, outputSegmentationMasks: false,
      minPoseDetectionConfidence: 0.6, minPosePresenceConfidence: 0.6, minTrackingConfidence: 0.6,
    });
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ready' });
    expect(f.handCreateFromOptions).not.toHaveBeenCalled();
  });

  it('does not create parallel detectors or reload an initialized detector', async () => {
    const f = fixture();
    const loading = deferred<typeof f.task>();
    const entered = deferred<void>();
    f.createFromOptions.mockImplementationOnce(() => { entered.resolve(); return loading.promise; });
    const first = f.send({ type: 'init' });
    await entered.promise;
    await f.send({ type: 'init' });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.createFromOptions).toHaveBeenCalledTimes(1);
    loading.resolve(f.task);
    await first;
    await f.send({ type: 'init' });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ready' });
  });

  it.each([0, 1, 2])('forwards all %i detected poses, confidence fields and frame identity, then closes frame resources', async count => {
    const f = fixture();
    await f.send({ type: 'init' });
    f.self.postMessage.mockClear();
    const landmarks = Array.from({ length: count }, (_, person) => Array.from({ length: 33 }, (_, point) => ({
      x: person * 0.25 + point / 100, y: point / 50, z: -0.12, visibility: 0.95, presence: 0.91,
    })));
    const result = f.makeResult(landmarks);
    f.task.detectForVideo.mockReturnValueOnce(result);
    const bitmap = { close: vi.fn() };
    await f.send({ type: 'detect', frameId: 81, timestamp: 1234.5, bitmap });
    expect(f.task.detectForVideo).toHaveBeenCalledExactlyOnceWith(bitmap, 1234.5);
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', frameId: 81, timestamp: 1234.5,
      poses: landmarks.map(points => ({ landmarks: points })), inferenceMs: 7 });
    expect(result.close).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(f.self.postMessage.mock.invocationCallOrder[0]).toBeLessThan(result.close.mock.invocationCallOrder[0]);
    expect(result.close.mock.invocationCallOrder[0]).toBeLessThan(bitmap.close.mock.invocationCallOrder[0]);
  });

  it('rejects detection before initialization and releases the supplied bitmap', async () => {
    const f = fixture();
    const bitmap = { close: vi.fn() };
    await f.send({ type: 'detect', frameId: 4, timestamp: 22, bitmap });
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'error', frameId: 4 });
    expect(f.task.detectForVideo).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('reports inference failure with frame identity, releases the bitmap and can process the next frame', async () => {
    const f = fixture();
    await f.send({ type: 'init' });
    f.self.postMessage.mockClear();
    f.task.detectForVideo.mockImplementationOnce(() => { throw new Error('Inference failed'); });
    const failed = { close: vi.fn() };
    const next = { close: vi.fn() };
    await f.send({ type: 'detect', frameId: 5, timestamp: 40, bitmap: failed });
    await f.send({ type: 'detect', frameId: 6, timestamp: 50, bitmap: next });
    expect(f.self.postMessage.mock.calls.map(([message]) => message.type)).toEqual(['error', 'result']);
    expect(f.self.postMessage).toHaveBeenNthCalledWith(1, { type: 'error', frameId: 5 });
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(next.close).toHaveBeenCalledTimes(1);
    expect(f.task.close).not.toHaveBeenCalled();
  });

  it('releases result and bitmap when transferring the inference result fails', async () => {
    const f = fixture();
    await f.send({ type: 'init' });
    f.self.postMessage.mockClear();
    f.self.postMessage.mockImplementationOnce(() => { throw new Error('Cannot clone message'); });
    const result = f.makeResult();
    const bitmap = { close: vi.fn() };
    f.task.detectForVideo.mockReturnValueOnce(result);
    await f.send({ type: 'detect', frameId: 9, timestamp: 100, bitmap });
    expect(f.self.postMessage).toHaveBeenLastCalledWith({ type: 'error', frameId: 9 });
    expect(result.close).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it.each(['bundle', 'fetch', 'http', 'model', 'wasm', 'create'] as const)('reports %s initialization failure and allows a clean retry', async stage => {
    const f = fixture();
    if (stage === 'bundle') f.importScripts.mockImplementationOnce(() => { throw new Error('Bundle failed'); });
    if (stage === 'fetch') f.fetch.mockRejectedValueOnce(new Error('Fetch failed'));
    if (stage === 'http') f.fetch.mockResolvedValueOnce({ ...f.response, ok: false });
    if (stage === 'model') f.response.arrayBuffer.mockRejectedValueOnce(new Error('Read failed'));
    if (stage === 'wasm') f.forVisionTasks.mockRejectedValueOnce(new Error('WASM failed'));
    if (stage === 'create') f.createFromOptions.mockRejectedValueOnce(new Error('Create failed'));
    await f.send({ type: 'init' });
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'error' });
    expect(f.task.close).not.toHaveBeenCalled();
    f.self.postMessage.mockClear();
    await f.send({ type: 'init' });
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ready' });
  });

  it('closes an initialized detector, aborts loading, and drops all later work while releasing incoming bitmaps', async () => {
    const f = fixture();
    await f.send({ type: 'init' });
    f.self.postMessage.mockClear();
    await f.send({ type: 'close' });
    const bitmap = { close: vi.fn() };
    await f.send({ type: 'detect', frameId: 10, timestamp: 120, bitmap });
    await f.send({ type: 'init' });
    expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(f.task.close).toHaveBeenCalledTimes(1);
    expect(f.self.close).toHaveBeenCalledTimes(1);
    expect(f.task.detectForVideo).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(f.self.postMessage).not.toHaveBeenCalled();
  });

  it('can close before initialization without loading any assets', async () => {
    const f = fixture();
    await f.send({ type: 'close' });
    await f.send({ type: 'init' });
    expect(f.self.close).toHaveBeenCalledTimes(1);
    expect(f.importScripts).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.self.postMessage).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'model', 'wasm', 'create'] as const)('never announces readiness or retains a detector when closed during %s loading', async stage => {
    const f = fixture();
    const entered = deferred<void>();
    const pending = deferred<unknown>();
    if (stage === 'fetch') f.fetch.mockImplementationOnce(() => { entered.resolve(); return pending.promise as Promise<typeof f.response>; });
    if (stage === 'model') f.response.arrayBuffer.mockImplementationOnce(() => { entered.resolve(); return pending.promise as Promise<ArrayBuffer>; });
    if (stage === 'wasm') f.forVisionTasks.mockImplementationOnce(() => { entered.resolve(); return pending.promise as Promise<{ wasm: string }>; });
    if (stage === 'create') f.createFromOptions.mockImplementationOnce(() => { entered.resolve(); return pending.promise as Promise<typeof f.task>; });
    const initializing = f.send({ type: 'init' });
    await entered.promise;
    await f.send({ type: 'close' });
    pending.resolve(stage === 'fetch' ? f.response : stage === 'model' ? f.modelBytes.buffer : stage === 'wasm' ? { wasm: 'local' } : f.task);
    await initializing;
    expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(f.self.close).toHaveBeenCalledTimes(1);
    expect(f.self.postMessage).not.toHaveBeenCalled();
    if (f.createFromOptions.mock.calls.length) expect(f.task.close).toHaveBeenCalledTimes(1);
    else expect(f.task.close).not.toHaveBeenCalled();
    if (stage === 'fetch' || stage === 'model') expect(f.createFromOptions).not.toHaveBeenCalled();
  });

  it('suppresses a late initialization rejection after closing', async () => {
    const f = fixture();
    const pending = deferred<typeof f.response>();
    f.fetch.mockReturnValueOnce(pending.promise);
    const initializing = f.send({ type: 'init' });
    await f.send({ type: 'close' });
    pending.reject(new Error('Aborted'));
    await initializing;
    expect(f.self.postMessage).not.toHaveBeenCalled();
    expect(f.createFromOptions).not.toHaveBeenCalled();
  });
});

describe('combined exhibition pose and hand worker', () => {
  it('applies validated hand confidences while retaining pose settings and two-hand ambiguity detection', async () => {
    const f = fixture();
    const options = { minHandDetectionConfidence: 0.2, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.7 };
    await f.send({ type: 'init', hands: true, options });
    expect(f.handCreateFromOptions).toHaveBeenCalledWith({ wasm: 'local' }, expect.objectContaining({ ...options, numHands: 2 }));
    expect(f.createFromOptions).toHaveBeenCalledWith({ wasm: 'local' }, expect.objectContaining({
      numPoses: 2, minPoseDetectionConfidence: 0.6, minPosePresenceConfidence: 0.6, minTrackingConfidence: 0.6,
    }));
  });

  it.each([null, {}, [], { minHandDetectionConfidence: 0.2 },
    ...[NaN, Infinity, '0.2', 0, 1].map(value => ({
      minHandDetectionConfidence: value, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.7,
    }))])('falls back atomically for invalid hand confidence options %j', async options => {
    const f = fixture();
    await f.send({ type: 'init', hands: true, options });
    expect(f.handCreateFromOptions).toHaveBeenCalledWith({ wasm: 'local' }, expect.objectContaining({
      numHands: 2, minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.5,
    }));
  });

  it('loads both local models with one shared WASM resolver and waits for both before readiness', async () => {
    const f = fixture();
    const loading = deferred<typeof f.handTask>();
    const entered = deferred<void>();
    f.handCreateFromOptions.mockImplementationOnce(() => { entered.resolve(); return loading.promise; });
    const initializing = f.send({ type: 'init', hands: true });
    await entered.promise;
    expect(f.self.postMessage).not.toHaveBeenCalled();
    await f.send({ type: 'init', hands: true });
    expect(f.importScripts).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls.map(([url]) => url.href)).toEqual([
      'https://xuminghong.local:10202/v1.1/assets/body-scan/pose_landmarker_full.task',
      'https://xuminghong.local:10202/v1.1/assets/exhibition-gestures/hand_landmarker.task',
    ]);
    expect(f.fetch.mock.calls[1][1].signal).toBe(f.fetch.mock.calls[0][1].signal);
    expect(f.forVisionTasks).toHaveBeenCalledExactlyOnceWith('https://xuminghong.local:10202/v1.1/assets/body-scan/wasm');
    expect(f.handCreateFromOptions).toHaveBeenCalledExactlyOnceWith({ wasm: 'local' }, {
      baseOptions: { modelAssetBuffer: f.handModelBytes, delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.5,
    });
    loading.resolve(f.handTask);
    await initializing;
    await f.send({ type: 'init', hands: true });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ready' });
  });

  it('runs Pose and Hands on the identical bitmap and timestamp and returns both people and hands', async () => {
    const f = fixture();
    await f.send({ type: 'init', hands: true });
    f.self.postMessage.mockClear();
    const poses = [[{ x: 0.2, y: 0.3, visibility: 0.9, presence: 0.8 }], [{ x: 0.8, y: 0.4 }]];
    const hands = [[{ x: 0.1, y: 0.2, z: -0.1 }], [{ x: 0.9, y: 0.3, z: 0.2 }]];
    const result = f.makeResult(poses);
    f.task.detectForVideo.mockReturnValueOnce(result);
    f.handTask.detectForVideo.mockReturnValueOnce(f.makeHandResult(hands, [[{ categoryName: 'Left' }], [{ categoryName: 'Right' }]]));
    const bitmap = { close: vi.fn() };
    await f.send({ type: 'detect', frameId: 91, timestamp: 678, bitmap });
    expect(f.task.detectForVideo).toHaveBeenCalledExactlyOnceWith(bitmap, 678);
    expect(f.handTask.detectForVideo).toHaveBeenCalledExactlyOnceWith(bitmap, 678);
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', frameId: 91, timestamp: 678,
      poses: poses.map(landmarks => ({ landmarks })),
      hands: hands.map((landmarks, index) => ({ landmarks, handedness: index === 0 ? 'Left' : 'Right' })), inferenceMs: 7 });
    expect(f.task.detectForVideo.mock.invocationCallOrder[0]).toBeLessThan(f.handTask.detectForVideo.mock.invocationCallOrder[0]);
    expect(f.handTask.detectForVideo.mock.invocationCallOrder[0]).toBeLessThan(bitmap.close.mock.invocationCallOrder[0]);
    expect(result.close).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('releases pose results and bitmaps on hand inference failure and accepts the next frame', async () => {
    const f = fixture();
    await f.send({ type: 'init', hands: true });
    f.self.postMessage.mockClear();
    const result = f.makeResult();
    f.task.detectForVideo.mockReturnValueOnce(result);
    f.handTask.detectForVideo.mockImplementationOnce(() => { throw new Error('Hand inference failed'); });
    const bitmap = { close: vi.fn() };
    await f.send({ type: 'detect', frameId: 92, timestamp: 700, bitmap });
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'error', frameId: 92 });
    expect(result.close).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(f.task.close).not.toHaveBeenCalled();
    expect(f.handTask.close).not.toHaveBeenCalled();
    await f.send({ type: 'detect', frameId: 93, timestamp: 770, bitmap: { close: vi.fn() } });
    expect(f.self.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'result', frameId: 93, hands: [] }));
  });

  it.each(['fetch', 'http', 'model', 'create'] as const)('closes the existing pose detector after hand %s failure and permits a clean retry', async stage => {
    const f = fixture();
    if (stage === 'fetch') f.fetch.mockResolvedValueOnce(f.response).mockRejectedValueOnce(new Error('Hand fetch failed'));
    if (stage === 'http') f.fetch.mockResolvedValueOnce(f.response).mockResolvedValueOnce({ ...f.handResponse, ok: false });
    if (stage === 'model') f.handResponse.arrayBuffer.mockRejectedValueOnce(new Error('Hand model failed'));
    if (stage === 'create') f.handCreateFromOptions.mockRejectedValueOnce(new Error('Hand create failed'));
    await f.send({ type: 'init', hands: true });
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'error' });
    expect(f.task.close).toHaveBeenCalledTimes(1);
    expect(f.handTask.close).not.toHaveBeenCalled();
    f.self.postMessage.mockClear();
    await f.send({ type: 'init', hands: true });
    expect(f.createFromOptions).toHaveBeenCalledTimes(2);
    expect(f.self.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ready' });
  });

  it.each(['fetch', 'model', 'create'] as const)('closes pose immediately during hand %s loading and closes any late hand task', async stage => {
    const f = fixture();
    const entered = deferred<void>();
    const pending = deferred<unknown>();
    if (stage === 'fetch') f.fetch.mockResolvedValueOnce(f.response).mockImplementationOnce(() => { entered.resolve(); return pending.promise as Promise<typeof f.handResponse>; });
    if (stage === 'model') f.handResponse.arrayBuffer.mockImplementationOnce(() => { entered.resolve(); return pending.promise as Promise<ArrayBuffer>; });
    if (stage === 'create') f.handCreateFromOptions.mockImplementationOnce(() => { entered.resolve(); return pending.promise as Promise<typeof f.handTask>; });
    const initializing = f.send({ type: 'init', hands: true });
    await entered.promise;
    await f.send({ type: 'close' });
    expect(f.task.close).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(f.self.close).toHaveBeenCalledTimes(1);
    expect(f.self.postMessage).not.toHaveBeenCalled();
    pending.resolve(stage === 'fetch' ? f.handResponse : stage === 'model' ? f.handModelBytes.buffer : f.handTask);
    await initializing;
    expect(f.task.close).toHaveBeenCalledTimes(1);
    expect(f.handTask.close).toHaveBeenCalledTimes(stage === 'create' ? 1 : 0);
    expect(f.self.postMessage).not.toHaveBeenCalled();
  });

  it('closes both initialized tasks and rejects late work without retaining frame resources', async () => {
    const f = fixture();
    await f.send({ type: 'init', hands: true });
    f.self.postMessage.mockClear();
    await f.send({ type: 'close' });
    const bitmap = { close: vi.fn() };
    await f.send({ type: 'detect', frameId: 94, timestamp: 800, bitmap });
    expect(f.task.close).toHaveBeenCalledTimes(1);
    expect(f.handTask.close).toHaveBeenCalledTimes(1);
    expect(f.task.detectForVideo).not.toHaveBeenCalled();
    expect(f.handTask.detectForVideo).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(f.self.postMessage).not.toHaveBeenCalled();
  });
});
