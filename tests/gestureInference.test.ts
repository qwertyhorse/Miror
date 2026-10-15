import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGestureInference, type GestureInferenceResult } from '../server/gestureInference';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
const settings = { minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5 };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // Decoder behavior is covered by the real Python tests.
const result: GestureInferenceResult = { hands: [], poses: [], width: 640, height: 480, inferenceMs: 12 };
function worker(ready = true) {
  const process = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>;
  };
  process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.kill = vi.fn(() => { queueMicrotask(() => process.emit('exit', 0)); return true; });
  const requests: Array<{ id: number; timestamp: number; jpeg: string }> = [];
  process.stdin.on('data', value => requests.push(JSON.parse(value.toString())));
  spawn.mockImplementationOnce(() => { if (ready) queueMicrotask(() => process.stdout.write('{"type":"ready"}\n')); return process; });
  return { process, requests, reply(value: unknown) { process.stdout.write(`${JSON.stringify(value)}\n`); } };
}
afterEach(() => { spawn.mockReset(); });

describe('Linux gesture inference process lifecycle', () => {
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
    { type: 'result', id: 1, result: { ...result, hands: [{ handedness: 'Left', landmarks: [] }] } },
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
