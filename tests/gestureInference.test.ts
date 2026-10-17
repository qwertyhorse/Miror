import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGestureInference, type GestureInferenceResult } from '../server/gestureInference';
import type { RemoteGestureI420Metadata } from '../shared/remoteGestures';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
const settings = { minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5 };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // Decoder behavior is covered by the real Python tests.
const result: GestureInferenceResult = { hands: [], poses: [], width: 640, height: 480, inferenceMs: 12 };
const pose = { landmarks: Array.from({ length: 33 }, () => ({ x: .4, y: .5, z: -.1, visibility: .9 })) };
function worker(ready = true) {
  const process = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>;
  };
  process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.kill = vi.fn(() => { queueMicrotask(() => process.emit('exit', 0)); return true; });
  type Request = { id: number; timestamp: number; jpeg?: string; settings: typeof settings & { inputLongEdge?: number };
    frame?: RemoteGestureI420Metadata & { byteLength: number }; bytes?: Buffer };
  const requests: Request[] = [];
  let input = Buffer.alloc(0), raw: Request | undefined;
  process.stdin.on('data', value => {
    input = Buffer.concat([input, value]);
    while (input.length) {
      if (raw) {
        const size = raw.frame!.byteLength;
        if (input.length < size) return;
        requests.push({ ...raw, bytes: input.subarray(0, size) }); input = input.subarray(size); raw = undefined;
      } else {
        const newline = input.indexOf(10);
        if (newline < 0) return;
        const request = JSON.parse(input.subarray(0, newline).toString()) as Request;
        input = input.subarray(newline + 1);
        if (request.frame) raw = request; else requests.push(request);
      }
    }
  });
  spawn.mockImplementationOnce(() => { if (ready) queueMicrotask(() => process.stdout.write('{"type":"ready"}\n')); return process; });
  return { process, requests, reply(value: unknown) { process.stdout.write(`${JSON.stringify(value)}\n`); } };
}
afterEach(() => { spawn.mockReset(); vi.unstubAllEnvs(); });

describe('Linux gesture inference process lifecycle', () => {
  it('sends raw full-size I420 bytes through the private pipe without base64 and keeps frame boundaries', async () => {
    const child = worker(); const runtime = await createGestureInference();
    const frame: RemoteGestureI420Metadata = { format: 'i420-v1', width: 1920, height: 1080, rotation: 90, mirrored: true };
    const pixels = Buffer.alloc(1920 * 1080 * 3 / 2, 10); // Newlines inside pixels must not split protocol messages.
    const first = runtime.infer(pixels, 1, { ...settings, inputLongEdge: 480 }, frame);
    expect(child.requests).toHaveLength(1);
    expect(child.requests[0]).toMatchObject({ id: 1, frame: { ...frame, byteLength: pixels.length }, settings: { inputLongEdge: 480 } });
    expect(child.requests[0].jpeg).toBeUndefined();
    expect(child.requests[0].bytes?.equals(pixels)).toBe(true);
    await expect(runtime.infer(pixels, 2, settings, frame)).rejects.toMatchObject({ code: 'INFERENCE_BUSY' });
    child.reply({ type: 'result', id: 1, result }); await first;
    const second = runtime.infer(jpeg, 2, settings);
    expect(child.requests[1].jpeg).toBe(jpeg.toString('base64'));
    child.reply({ type: 'result', id: 2, result }); await second;
    await runtime.close();
  });

  it('rejects malformed raw geometry, exact lengths and sampling limits before touching the pipe', async () => {
    const child = worker(); const runtime = await createGestureInference();
    const frame: RemoteGestureI420Metadata = { format: 'i420-v1', width: 3, height: 3, rotation: 0, mirrored: false };
    const pixels = Buffer.alloc(17); // Odd dimensions use ceil(width/2) × ceil(height/2) chroma planes.
    for (const changed of [{ width: 0 }, { height: 4097 }, { width: 4096, height: 4096 },
      { width: 1.5 }, { rotation: 45 }, { mirrored: 'false' }, { format: 'nv12' }]) {
      await expect(runtime.infer(pixels, 1, settings, { ...frame, ...changed } as RemoteGestureI420Metadata))
        .rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    }
    for (const size of [0, 16, 18, 16 * 1024 * 1024 + 1])
      await expect(runtime.infer(Buffer.alloc(size), 1, settings, frame)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await expect(runtime.infer(pixels, 1, { ...settings, inputLongEdge: 1080 }, frame)).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
    expect(child.requests).toHaveLength(0);
    const accepted = runtime.infer(pixels, 1, settings, frame);
    child.reply({ type: 'result', id: 1, result }); await accepted;
    await runtime.close();
  });

  it('starts with the full pose model and supports explicit model path overrides', async () => {
    worker();
    const defaults = await createGestureInference();
    expect(spawn.mock.calls[0][1]).toEqual([
      '-u', expect.stringContaining('scripts/gesture-worker.py'),
      '--model', expect.stringContaining('public/assets/exhibition-gestures/hand_landmarker.task'),
      '--pose-model', expect.stringContaining('public/assets/body-scan/pose_landmarker_full.task'),
    ]);
    await defaults.close();
    vi.stubEnv('MIROR_GESTURE_POSE_MODEL', '/models/environment-pose.task');
    worker();
    const environment = await createGestureInference();
    expect(spawn.mock.calls[1][1]).toContain('/models/environment-pose.task');
    await environment.close();
    worker();
    const override = await createGestureInference({ poseModelPath: '/models/explicit-pose.task' });
    expect(spawn.mock.calls[2][1]).toContain('/models/explicit-pose.task');
    await override.close();
  });

  it('preserves both poses and visibility alongside hand landmarks', async () => {
    const child = worker(); const runtime = await createGestureInference();
    const detected: GestureInferenceResult = {
      ...result, width: 960, height: 960, poses: [pose, pose],
      hands: [{ handedness: 'Right', landmarks: Array.from({ length: 21 }, () => ({ x: .4, y: .5, z: -.1 })) }],
    };
    const pending = runtime.infer(jpeg, 1, settings);
    child.reply({ type: 'result', id: 1, result: detected });
    await expect(pending).resolves.toEqual(detected);
    await runtime.close();
  });

  it('waits for model readiness and rejects overlapping frames without writing or replaying them', async () => {
    const child = worker(false);
    let resolved = false;
    const creation = createGestureInference().then(value => { resolved = true; return value; });
    await Promise.resolve(); expect(resolved).toBe(false);
    child.reply({ type: 'ready' });
    const runtime = await creation;
    const first = runtime.infer(jpeg, 0, settings);
    await expect(runtime.infer(jpeg, 310, settings)).rejects.toMatchObject({ code: 'INFERENCE_BUSY' });
    expect(child.requests).toHaveLength(1);
    child.reply({ type: 'result', id: 1, result });
    await expect(first).resolves.toEqual(result);
    expect(child.requests).toHaveLength(1);
    const next = runtime.infer(jpeg, 310, settings);
    child.reply({ type: 'result', id: 2, result });
    await next; await runtime.close();
  });

  it('validates payload limits, confidences and timestamps before writing to the worker', async () => {
    const child = worker(); const runtime = await createGestureInference();
    for (const bytes of [Buffer.alloc(0), Buffer.from('not jpeg'), Buffer.alloc(256 * 1024 + 1)]) {
      await expect(runtime.infer(bytes, 1, settings)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    }
    await expect(runtime.infer(jpeg, Infinity, settings)).rejects.toMatchObject({ code: 'INVALID_TIMESTAMP' });
    await expect(runtime.infer(jpeg, 1, { ...settings, minTrackingConfidence: NaN })).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
    expect(child.requests).toHaveLength(0);
    const first = runtime.infer(jpeg, 10, settings); child.reply({ type: 'result', id: 1, result }); await first;
    await expect(runtime.infer(jpeg, 10, settings)).rejects.toMatchObject({ code: 'INVALID_TIMESTAMP' });
    await expect(runtime.infer(jpeg, 9, settings)).rejects.toMatchObject({ code: 'INVALID_TIMESTAMP' });
    await runtime.close();
  });

  it('keeps independently tracked terminal workers and closes one without disrupting the other', async () => {
    const first = worker(), second = worker();
    const [a, b] = await Promise.all([createGestureInference(), createGestureInference()]);
    const aFrame = a.infer(jpeg, 10, settings), bFrame = b.infer(jpeg, 10, settings);
    const rejected = expect(aFrame).rejects.toMatchObject({ code: 'RUNTIME_CLOSED' });
    await a.close(); await rejected;
    expect(first.process.kill).toHaveBeenCalledOnce(); expect(second.process.kill).not.toHaveBeenCalled();
    second.reply({ type: 'result', id: 1, result }); await expect(bFrame).resolves.toEqual(result);
    await b.close();
  });

  it('rejects pending work on a crash and permanently closes the failed context', async () => {
    const child = worker(); const runtime = await createGestureInference();
    const pending = runtime.infer(jpeg, 1, settings);
    child.process.emit('exit', 1);
    await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_EXITED' });
    await expect(runtime.infer(jpeg, 2, settings)).rejects.toMatchObject({ code: 'RUNTIME_CLOSED' });
    await runtime.close();
  });

  it('kills a hung inference and discards any late result', async () => {
    const child = worker(); const runtime = await createGestureInference({ inferenceTimeoutMs: 25 });
    await expect(runtime.infer(jpeg, 1, settings)).rejects.toMatchObject({ code: 'INFERENCE_TIMEOUT' });
    expect(child.process.kill).toHaveBeenCalledWith('SIGTERM');
    child.reply({ type: 'result', id: 1, result });
    await expect(runtime.infer(jpeg, 2, settings)).rejects.toMatchObject({ code: 'RUNTIME_CLOSED' });
    await runtime.close();
  });

  it('bounds startup failure and initialization timeout', async () => {
    const failed = worker(false); const absent = createGestureInference();
    failed.process.emit('error', new Error('private installation path'));
    await expect(absent).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE', message: 'Gesture runtime could not start.' });
    const hung = worker(false);
    await expect(createGestureInference({ startupTimeoutMs: 25 })).rejects.toMatchObject({ code: 'RUNTIME_TIMEOUT' });
    expect(hung.process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it.each([
    { type: 'result', id: 99, result },
    { type: 'result', id: 1, result: { ...result, width: 10000 } },
    { type: 'result', id: 1, result: { ...result, width: 961 } },
    { type: 'result', id: 1, result: { ...result, height: 961 } },
    { type: 'result', id: 1, result: { ...result, hands: [{ handedness: 'Left', landmarks: [] }] } },
    { type: 'result', id: 1, result: { ...result, poses: [pose, pose, pose] } },
    { type: 'result', id: 1, result: { ...result, poses: [{ landmarks: pose.landmarks.slice(1) }] } },
    { type: 'result', id: 1, result: { ...result, poses: [{ landmarks: [...pose.landmarks, pose.landmarks[0]] }] } },
    { type: 'result', id: 1, result: { ...result, poses: [{ landmarks: pose.landmarks.map(({ visibility: _visibility, ...point }) => point) }] } },
    { type: 'result', id: 1, result: { ...result, poses: [{ landmarks: pose.landmarks.map(point => ({ ...point, visibility: Infinity })) }] } },
    { type: 'result', id: 1, result: { ...result, poses: [{ landmarks: pose.landmarks.map(point => ({ ...point, z: NaN })) }] } },
    { type: 'result', id: 1, result: { ...result, poses: [null] } },
  ])('does not accept corrupt or mismatched worker output', async reply => {
    const child = worker(); const runtime = await createGestureInference();
    const pending = runtime.infer(jpeg, 1, settings); child.reply(reply);
    await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_PROTOCOL' }); await runtime.close();
  });

  it('handles an invalid decoded JPEG without accepting the same timestamp again', async () => {
    const child = worker(); const runtime = await createGestureInference();
    const pending = runtime.infer(jpeg, 1, settings); child.reply({ type: 'error', id: 1, code: 'INVALID_IMAGE' });
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await expect(runtime.infer(jpeg, 1, settings)).rejects.toMatchObject({ code: 'INVALID_TIMESTAMP' });
    const next = runtime.infer(jpeg, 2, settings); child.reply({ type: 'result', id: 2, result }); await next;
    await runtime.close();
  });

  it('bounds close, escalates to SIGKILL and rejects pending callbacks once', async () => {
    const child = worker(); child.process.kill.mockImplementation(() => true);
    const runtime = await createGestureInference({ closeGraceMs: 5 });
    const pending = expect(runtime.infer(jpeg, 1, settings)).rejects.toMatchObject({ code: 'RUNTIME_CLOSED' });
    const first = runtime.close(), second = runtime.close();
    expect(first).toBe(second); await Promise.all([first, second, pending]);
    expect(child.process.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });
});
