import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GestureInferenceSettings {
  minHandDetectionConfidence: number;
  minHandPresenceConfidence: number;
  minTrackingConfidence: number;
}
export interface GestureInferenceResult {
  hands: Array<{ handedness: string; landmarks: Array<{ x: number; y: number; z: number }> }>;
  poses: [];
  width: number;
  height: number;
  inferenceMs: number;
}
export interface GestureInference {
  infer(jpeg: Buffer, timestamp: number, settings: GestureInferenceSettings): Promise<GestureInferenceResult>;
  close(): Promise<void>;
}
export class GestureInferenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'GestureInferenceError'; }
}
export interface GestureInferenceOptions {
  pythonPath?: string;
  workerPath?: string;
  modelPath?: string;
  startupTimeoutMs?: number;
  inferenceTimeoutMs?: number;
  closeGraceMs?: number;
}
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const error = (code: string, message: string) => new GestureInferenceError(code, message);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function validResult(value: unknown): value is GestureInferenceResult {
  if (!value || typeof value !== 'object') return false;
  const item = value as GestureInferenceResult;
  return Number.isInteger(item.width) && item.width > 0 && item.width <= 640 &&
    Number.isInteger(item.height) && item.height > 0 && item.height <= 640 &&
    finite(item.inferenceMs) && item.inferenceMs >= 0 && Array.isArray(item.poses) && item.poses.length === 0 &&
    Array.isArray(item.hands) && item.hands.length <= 2 && item.hands.every(hand =>
      hand && ['Left', 'Right'].includes(hand.handedness) && Array.isArray(hand.landmarks) &&
      hand.landmarks.length === 21 && hand.landmarks.every(point => point &&
        finite(point.x) && finite(point.y) && finite(point.z)));
}
function timeout(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1 || value > 120_000) throw error('INVALID_CONFIGURATION', 'Invalid gesture runtime timeout.');
  return value;
}

/** One terminal owns one warm VIDEO model. Frames arriving during inference are rejected, never queued. */
export async function createGestureInference(options: GestureInferenceOptions = {}): Promise<GestureInference> {
  const startupTimeoutMs = timeout(options.startupTimeoutMs, 15_000);
  const inferenceTimeoutMs = timeout(options.inferenceTimeoutMs, 5_000);
  const closeGraceMs = timeout(options.closeGraceMs, 500);
  const python = options.pythonPath ?? process.env.MIROR_GESTURE_PYTHON ?? resolve(homedir(), '.local/share/miror/gesture-runtime/bin/python');
  const worker = options.workerPath ?? resolve(projectRoot, 'scripts/gesture-worker.py');
  const model = options.modelPath ?? process.env.MIROR_GESTURE_MODEL ?? resolve(projectRoot, 'public/assets/exhibition-gestures/hand_landmarker.task');
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(python, ['-u', worker, '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1',
        GLOG_minloglevel: '2', TF_CPP_MIN_LOG_LEVEL: '2', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1' },
    });
  } catch { throw error('RUNTIME_UNAVAILABLE', 'Gesture runtime could not start.'); }
  let closed = false, ready = false, exited = false, nextId = 0, previousTimestamp = -1;
  let output = '';
  let closing: Promise<void> | undefined;
  let startupResolve!: () => void;
  let startupReject!: (reason: Error) => void;
  const startup = new Promise<void>((yes, no) => { startupResolve = yes; startupReject = no; });
  let pending: { id: number; resolve: (result: GestureInferenceResult) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout } | undefined;
  let exitResolve!: () => void;
  const exit = new Promise<void>(yes => { exitResolve = yes; });
  const startupTimer = setTimeout(() => fail(error('RUNTIME_TIMEOUT', 'Gesture model initialization timed out.')), startupTimeoutMs);

  function rejectPending(reason: Error) {
    const active = pending; pending = undefined;
    if (active) { clearTimeout(active.timer); active.reject(reason); }
  }
  function finishExit() { if (!exited) { exited = true; exitResolve(); } }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    clearTimeout(startupTimer);
    startupReject(error('RUNTIME_CLOSED', 'Gesture runtime closed.'));
    rejectPending(error('RUNTIME_CLOSED', 'Gesture runtime closed.'));
    closing = (async () => {
      if (!exited) {
        child.stdin.destroy();
        child.kill('SIGTERM');
        let deadline!: NodeJS.Timeout;
        await Promise.race([exit, new Promise<void>(yes => { deadline = setTimeout(yes, closeGraceMs); })]);
        clearTimeout(deadline);
        if (!exited) {
          child.kill('SIGKILL');
          // Never let an unresponsive child hold an API close request indefinitely.
          await Promise.race([exit, new Promise<void>(yes => { deadline = setTimeout(yes, closeGraceMs); })]);
          clearTimeout(deadline);
        }
      }
      child.stdout.destroy(); child.stderr.destroy();
    })();
    return closing;
  }
  function fail(reason: Error) {
    if (closed) return;
    startupReject(reason);
    rejectPending(reason);
    void close();
  }
  child.once('error', () => { finishExit(); fail(error('RUNTIME_UNAVAILABLE', 'Gesture runtime could not start.')); });
  child.once('exit', () => { finishExit(); fail(error('RUNTIME_EXITED', 'Gesture runtime stopped unexpectedly.')); });
  child.stdin.on('error', () => fail(error('RUNTIME_EXITED', 'Gesture runtime input closed.')));
  // MediaPipe may write native diagnostics. Drain without retaining image data or sending logs to clients.
  child.stderr.on('data', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (closed) return;
    output += chunk;
    if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES) { fail(error('RUNTIME_PROTOCOL', 'Gesture runtime response exceeded its limit.')); return; }
    let newline: number;
    while (!closed && (newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      let reply: { type?: string; id?: number; result?: unknown; code?: string };
      try { reply = JSON.parse(line); if (!reply || typeof reply !== 'object') throw new Error(); }
      catch { fail(error('RUNTIME_PROTOCOL', 'Gesture runtime returned invalid data.')); return; }
      if (!ready && reply.type === 'ready') {
        ready = true; clearTimeout(startupTimer); startupResolve(); continue;
      }
      const active = pending;
      if (!ready || !active || reply.id !== active.id || !['result', 'error'].includes(reply.type ?? '')) {
        fail(error('RUNTIME_PROTOCOL', 'Gesture runtime returned an unexpected response.')); return;
      }
      if (reply.type === 'result' && validResult(reply.result)) {
        pending = undefined; clearTimeout(active.timer); active.resolve(reply.result);
      } else if (reply.type === 'error' && reply.code === 'INVALID_IMAGE') {
        rejectPending(error('INVALID_IMAGE', 'Only complete JPEG frames of at most 640 × 640 are supported.'));
      } else {
        fail(error(reply.type === 'error' ? 'INFERENCE_FAILED' : 'RUNTIME_PROTOCOL', 'Gesture inference failed.')); return;
      }
    }
  });
  try { await startup; } catch (reason) { await close(); throw reason; }
  return {
    infer(jpeg, timestamp, settings) {
      if (closed || !ready) return Promise.reject(error('RUNTIME_CLOSED', 'Gesture runtime is closed.'));
      if (pending) return Promise.reject(error('INFERENCE_BUSY', 'Gesture runtime is already processing a frame.'));
      if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg.length > MAX_IMAGE_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
        return Promise.reject(error('INVALID_IMAGE', 'A JPEG frame of at most 256 KiB is required.'));
      }
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp <= previousTimestamp) return Promise.reject(error('INVALID_TIMESTAMP', 'Gesture frame timestamps must increase.'));
      if (!settings || ![settings.minHandDetectionConfidence, settings.minHandPresenceConfidence, settings.minTrackingConfidence].every(value => finite(value) && value >= 0 && value <= 1)) {
        return Promise.reject(error('INVALID_SETTINGS', 'Gesture confidence settings must be between zero and one.'));
      }
      previousTimestamp = timestamp;
      return new Promise<GestureInferenceResult>((yes, no) => {
        const id = ++nextId;
        pending = { id, resolve: yes, reject: no,
          timer: setTimeout(() => fail(error('INFERENCE_TIMEOUT', 'Gesture inference timed out.')), inferenceTimeoutMs) };
        child.stdin.write(JSON.stringify({ id, type: 'infer', timestamp, settings, jpeg: jpeg.toString('base64') }) + '\n', failure => {
          if (failure) fail(error('RUNTIME_EXITED', 'Gesture runtime input closed.'));
        });
      });
    },
    close,
  };
}
