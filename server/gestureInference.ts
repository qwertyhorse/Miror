import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMOTE_GESTURE_MAX_FRAME_BYTES, remoteGestureI420ByteLength,
  type RemoteGestureI420Metadata } from '../shared/remoteGestures.ts';

export interface GestureInferenceSettings {
  minHandDetectionConfidence: number;
  minHandPresenceConfidence: number;
  minTrackingConfidence: number;
  inputLongEdge?: number;
}
export interface GestureInferenceResult {
  hands: Array<{ handedness: string; landmarks: Array<{ x: number; y: number; z: number }> }>;
  poses: Array<{ landmarks: Array<{ x: number; y: number; z: number; visibility: number }> }>;
  width: number;
  height: number;
  inferenceMs: number;
}
export interface GestureInference {
  infer(image: Buffer, timestamp: number, settings: GestureInferenceSettings, rawFrame?: RemoteGestureI420Metadata): Promise<GestureInferenceResult>;
  close(): Promise<void>;
}
export class GestureInferenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'GestureInferenceError'; }
}
export interface GestureInferenceOptions {
  pythonPath?: string;
  workerPath?: string;
  modelPath?: string;
  poseModelPath?: string;
  startupTimeoutMs?: number;
  inferenceTimeoutMs?: number;
  closeGraceMs?: number;
}
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const MAX_RESPONSE_BYTES = 64 * 1024;
const error = (code: string, message: string) => new GestureInferenceError(code, message);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function validResult(value: unknown): value is GestureInferenceResult {
  if (!value || typeof value !== 'object') return false;
  const item = value as GestureInferenceResult;
  return Number.isInteger(item.width) && item.width > 0 && item.width <= 960 &&
    Number.isInteger(item.height) && item.height > 0 && item.height <= 960 &&
    finite(item.inferenceMs) && item.inferenceMs >= 0 &&
    Array.isArray(item.poses) && item.poses.length <= 2 && item.poses.every(pose =>
      pose && Array.isArray(pose.landmarks) && pose.landmarks.length === 33 &&
      pose.landmarks.every(point => point && finite(point.x) && finite(point.y) && finite(point.z) && finite(point.visibility))) &&
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

/** One terminal owns warm pose and hand VIDEO models. Overlapping frames are rejected, never queued. */
export async function createGestureInference(options: GestureInferenceOptions = {}): Promise<GestureInference> {
  const startupTimeoutMs = timeout(options.startupTimeoutMs, 15_000);
  const inferenceTimeoutMs = timeout(options.inferenceTimeoutMs, 5_000);
  const closeGraceMs = timeout(options.closeGraceMs, 500);
  const python = options.pythonPath ?? process.env.MIROR_GESTURE_PYTHON ?? resolve(homedir(), '.local/share/miror/gesture-runtime/bin/python');
  const worker = options.workerPath ?? resolve(projectRoot, 'scripts/gesture-worker.py');
  const model = options.modelPath ?? process.env.MIROR_GESTURE_MODEL ?? resolve(projectRoot, 'public/assets/exhibition-gestures/hand_landmarker.task');
  const poseModel = options.poseModelPath ?? process.env.MIROR_GESTURE_POSE_MODEL ?? resolve(projectRoot, 'public/assets/body-scan/pose_landmarker_full.task');
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(python, ['-u', worker, '--model', model, '--pose-model', poseModel], {
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
        rejectPending(error('INVALID_IMAGE', 'Gesture frame pixels or dimensions are invalid.'));
      } else {
        fail(error(reply.type === 'error' ? 'INFERENCE_FAILED' : 'RUNTIME_PROTOCOL', 'Gesture inference failed.')); return;
      }
    }
  });
  try { await startup; } catch (reason) { await close(); throw reason; }
  return {
    infer(image, timestamp, settings, rawFrame) {
      if (closed || !ready) return Promise.reject(error('RUNTIME_CLOSED', 'Gesture runtime is closed.'));
      if (pending) return Promise.reject(error('INFERENCE_BUSY', 'Gesture runtime is already processing a frame.'));
      if (!Buffer.isBuffer(image) || (rawFrame === undefined
        ? image.length < 4 || image.length > REMOTE_GESTURE_MAX_FRAME_BYTES || image[0] !== 0xff || image[1] !== 0xd8 || image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9
        : remoteGestureI420ByteLength(rawFrame) !== image.length)) {
        return Promise.reject(error('INVALID_IMAGE', 'A bounded JPEG or complete I420 frame is required.'));
      }
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp <= previousTimestamp) return Promise.reject(error('INVALID_TIMESTAMP', 'Gesture frame timestamps must increase.'));
      if (!settings || ![settings.minHandDetectionConfidence, settings.minHandPresenceConfidence, settings.minTrackingConfidence].every(value => finite(value) && value >= 0 && value <= 1)
        || (settings.inputLongEdge !== undefined && ![480, 720, 960].includes(settings.inputLongEdge))) {
        return Promise.reject(error('INVALID_SETTINGS', 'Gesture inference settings are invalid.'));
      }
      previousTimestamp = timestamp;
      return new Promise<GestureInferenceResult>((yes, no) => {
        const id = ++nextId;
        pending = { id, resolve: yes, reject: no,
          timer: setTimeout(() => fail(error('INFERENCE_TIMEOUT', 'Gesture inference timed out.')), inferenceTimeoutMs) };
        const onWrite = (failure: Error | null | undefined) => {
          if (failure) fail(error('RUNTIME_EXITED', 'Gesture runtime input closed.'));
        };
        if (rawFrame) {
          // One pending frame owns the pipe; preserve binary pixels without a base64-sized copy.
          const frame = { ...rawFrame, byteLength: image.length };
          child.stdin.write(JSON.stringify({ id, type: 'infer', timestamp, settings, frame }) + '\n', onWrite);
          child.stdin.write(image, onWrite);
        } else child.stdin.write(JSON.stringify({ id, type: 'infer', timestamp, settings, jpeg: image.toString('base64') }) + '\n', onWrite);
      });
    },
    close,
  };
}
