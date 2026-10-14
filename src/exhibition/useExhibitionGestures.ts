import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveExhibitionGestureSettings, type ExhibitionGestureSettings } from '../../shared/exhibitionGestures';
import {
  ExhibitionGestureDetector,
  type ExhibitionGesture,
  type ExhibitionGestureHand,
  type ExhibitionGestureMode,
} from './gestureDetector';
import { ExhibitionRaiseGestureDetector, type ExhibitionGesturePose } from './raiseGestureDetector';
import { ExhibitionMirrorGestureDetector, type ExhibitionGestureConfirmationState } from './mirrorGestureDetector';

export type ExhibitionGestureStatus = 'off' | 'loading' | 'ready' | 'error';
export type ExhibitionGestureCaptureStatus = 'waiting' | 'active' | 'disabled' | 'muted' | 'stalled' | 'hidden';

/** All timestamps use this page's performance.now() clock, never Date.now(). */
export interface ExhibitionGestureMetadata {
  /** Page-local event sequence; contains no device/session identifiers or credentials. */
  eventId: string;
  frameId: number;
  /** Capture timestamp of the frame that completed the gesture. */
  sampledAt: number;
  /** Local time when the completed gesture was recognized. */
  detectedAt: number;
  /** First sampled above-shoulder frame in this successful raise, not trigger time. */
  raiseStartedAt?: number;
}

let diagnosticEventSequence = 0;

interface GestureState {
  status: ExhibitionGestureStatus;
  error: string;
  lastGesture: ExhibitionGesture | null;
  handDetected: boolean;
  handRaised: boolean;
  lastHandAt: number | null;
  captureStatus: ExhibitionGestureCaptureStatus;
  fps: number;
  inferenceMs: number;
  operatorStatus: 'searching' | 'locked' | 'ambiguous';
  armed: boolean;
  recognitionMs: number;
  inputWidth: number;
  inputHeight: number;
  needsRelease: boolean;
  controlSource: 'body' | 'hand' | 'none';
  ambiguityReason: 'people' | 'hands' | null;
  confirmationState: ExhibitionGestureConfirmationState;
  palmHoldMs: number;
  rawHandCount: number;
  matchedHandCount: number;
}

interface GestureWorkerMessage {
  type: 'ready' | 'result' | 'error';
  frameId?: number;
  timestamp?: number;
  landmarks?: ExhibitionGestureHand['landmarks'];
  handedness?: string;
  poses?: ExhibitionGesturePose[];
  hands?: ExhibitionGestureHand[];
  inferenceMs?: number;
}

const FRAME_STALE_MS = 1_200;
const EMPTY_DIAGNOSTICS = { handDetected: false, handRaised: false, lastHandAt: null, captureStatus: 'waiting', fps: 0, inferenceMs: 0,
  operatorStatus: 'searching', armed: false, recognitionMs: 0, inputWidth: 0, inputHeight: 0, needsRelease: false, controlSource: 'none', ambiguityReason: null,
  confirmationState: 'no_hand', palmHoldMs: 0, rawHandCount: 0, matchedHandCount: 0 } as const;
const OFF_STATE: GestureState = { status: 'off', error: '', lastGesture: null, ...EMPTY_DIAGNOSTICS };

function liveVideoTracks(stream: MediaStream | null): MediaStreamTrack[] {
  if (!stream || typeof stream.getVideoTracks !== 'function') return [];
  return stream.getVideoTracks().filter(track => track.readyState === 'live');
}

/** Reuses the screen's camera stream. Only this hook's video/worker are disposed. */
export function useExhibitionGestures({
  stream,
  enabled,
  mode = 'wave',
  mirrored = true,
  onGesture,
  resetKey,
  diagnostics = false,
  recognitionSettings,
}: {
  stream: MediaStream | null;
  enabled: boolean;
  mode?: ExhibitionGestureMode;
  mirrored?: boolean;
  onGesture: (gesture: ExhibitionGesture, metadata?: ExhibitionGestureMetadata) => void;
  resetKey?: unknown;
  diagnostics?: boolean;
  recognitionSettings?: ExhibitionGestureSettings;
}): GestureState & { retry: () => void } {
  const [state, setState] = useState<GestureState>(OFF_STATE);
  const [attempt, setAttempt] = useState(0);
  const callback = useRef(onGesture);
  const diagnosticsEnabled = useRef(diagnostics);
  const settings = useRef({ mode, mirrored });
  const detector = useRef<ExhibitionGestureDetector | ExhibitionRaiseGestureDetector | ExhibitionMirrorGestureDetector | null>(null);
  const resetSequence = useRef(0);
  // A worker can restart after tuning without rearming the same visible palm.
  const combinedDetector = useRef<{ stream: MediaStream; motion: ExhibitionMirrorGestureDetector } | null>(null);
  const resolved = resolveExhibitionGestureSettings(recognitionSettings);
  resolved.gestures = (['open_palm', 'wave'] as const).filter(gesture => resolved.gestures.includes(gesture));
  const recognition = useRef(resolved);
  recognition.current = resolved;
  const recognitionKey = JSON.stringify(resolved);
  const combinedMode = mode === 'palm_wave';
  const poseMode = mode === 'raise' || combinedMode;
  const recognitionEnabled = enabled && (!combinedMode || resolved.gestures.length > 0);
  const confidenceKey = combinedMode ? [resolved.minHandDetectionConfidence, resolved.minHandPresenceConfidence, resolved.minTrackingConfidence].join(',') : '';
  callback.current = onGesture;
  diagnosticsEnabled.current = diagnostics;
  settings.current = { mode, mirrored };

  useEffect(() => {
    resetSequence.current += 1;
    if (detector.current instanceof ExhibitionMirrorGestureDetector) detector.current.reset(true);
    else detector.current?.reset();
    setState(previous => ({ ...previous, lastGesture: null, handDetected: false, handRaised: false, operatorStatus: 'searching', armed: false, controlSource: 'none', ambiguityReason: null,
      confirmationState: 'no_hand', palmHoldMs: 0, rawHandCount: 0, matchedHandCount: 0 }));
  }, [mode, mirrored, resetKey]);

  useEffect(() => {
    if (!combinedMode) return;
    resetSequence.current += 1;
    combinedDetector.current?.motion.configure(recognition.current);
    setState(previous => ({ ...previous, lastGesture: null, ...EMPTY_DIAGNOSTICS,
      needsRelease: combinedDetector.current?.motion.needsRelease ?? false }));
  }, [combinedMode, recognitionKey]);

  useEffect(() => {
    const tracks = liveVideoTracks(stream);
    if (!recognitionEnabled || !tracks.length) {
      setState(OFF_STATE);
      return;
    }
    setState({ ...OFF_STATE, status: 'loading' });
    if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') {
      setState({ ...OFF_STATE, status: 'error', error: '浏览器不支持手势识别，请使用新版 Chrome。' });
      return;
    }

    if (combinedMode && stream && combinedDetector.current?.stream !== stream) {
      combinedDetector.current = { stream, motion: new ExhibitionMirrorGestureDetector(recognition.current) };
    }
    if (!combinedMode) combinedDetector.current = null;
    const combinedMotion = combinedMode ? combinedDetector.current!.motion : null;
    // Pending evidence belongs to the old worker; retain only its consumed latch.
    combinedMotion?.reset(true);
    const raiseMotion = combinedMotion ?? (poseMode ? new ExhibitionRaiseGestureDetector() : null);
    const handMotion = poseMode ? null : new ExhibitionGestureDetector();
    const motion = (raiseMotion ?? handMotion)!;
    detector.current = motion;
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.tabIndex = -1;
    video.setAttribute('aria-hidden', 'true');
    // Keep decoding active in browsers that throttle completely detached media elements.
    video.style.cssText = 'position:fixed;width:1px;height:1px;left:0;top:0;opacity:0;pointer-events:none;z-index:-1';
    video.srcObject = stream;
    document.body.appendChild(video);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    let worker: Worker | null = null;
    let disposed = false;
    let ready = false;
    let busy = false;
    let frameId = 0;
    let pendingResetSequence = 0;
    let previousVideoTime = -1;
    let observedVideoTime = -1;
    let previousFrameAt = -Infinity;
    let lastDecodedAt = performance.now();
    let lastResultAt = -Infinity;
    let lastReportedAt = -Infinity;
    let captureStatus: ExhibitionGestureCaptureStatus = 'waiting';
    let handDetected = false;
    let handRaised = false;
    let operatorStatus: GestureState['operatorStatus'] = 'searching';
    let armed = false;
    let needsRelease = false;
    let controlSource: GestureState['controlSource'] = 'none';
    let ambiguityReason: GestureState['ambiguityReason'] = null;
    let confirmationState: GestureState['confirmationState'] = 'no_hand';
    let rawHandCount = 0;
    let matchedHandCount = 0;
    let recognitionMs = 0;
    let reportedResetSequence = resetSequence.current;
    let lastHandAt: number | null = null;
    let inferenceMs = 0;
    const resultTimes: number[] = [];
    let tickTimer: ReturnType<typeof setTimeout> | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;

    const resetMotion = () => {
      resetSequence.current += 1;
      if (combinedMotion) combinedMotion.reset(true);
      else motion.reset();
    };
    const report = (nextCapture: ExhibitionGestureCaptureStatus, nextHand = false, force = false) => {
      const now = performance.now();
      if (captureStatus !== nextCapture && nextCapture !== 'active') resetMotion();
      const nextHandRaised = nextCapture === 'active' && nextHand && motion.handRaised;
      const nextOperator = nextCapture === 'active' && raiseMotion ? raiseMotion.operatorStatus : 'searching';
      const nextArmed = nextCapture === 'active' && !!raiseMotion?.armed;
      const nextNeedsRelease = !!combinedMotion?.needsRelease;
      const nextSource = nextCapture !== 'active' ? 'none' : combinedMotion?.controlSource ?? (nextOperator === 'locked' ? 'body' : 'none');
      const nextAmbiguity = nextCapture !== 'active' ? null : combinedMotion?.ambiguityReason ?? (nextOperator === 'ambiguous' ? 'people' : null);
      const nextConfirmation = nextCapture === 'active' && combinedMotion ? combinedMotion.confirmationState : 'no_hand';
      const nextPalmHoldMs = nextCapture === 'active' && combinedMotion ? combinedMotion.palmHoldMs : 0;
      const nextRawHandCount = nextCapture === 'active' && combinedMotion ? combinedMotion.rawHandCount : 0;
      const nextMatchedHandCount = nextCapture === 'active' && combinedMotion ? combinedMotion.matchedHandCount : 0;
      const changed = captureStatus !== nextCapture || handDetected !== nextHand || handRaised !== nextHandRaised
        || operatorStatus !== nextOperator || armed !== nextArmed || needsRelease !== nextNeedsRelease
        || controlSource !== nextSource || ambiguityReason !== nextAmbiguity || confirmationState !== nextConfirmation
        || rawHandCount !== nextRawHandCount || matchedHandCount !== nextMatchedHandCount || reportedResetSequence !== resetSequence.current;
      captureStatus = nextCapture;
      handDetected = nextHand;
      handRaised = nextHandRaised;
      operatorStatus = nextOperator;
      armed = nextArmed;
      needsRelease = nextNeedsRelease;
      controlSource = nextSource;
      ambiguityReason = nextAmbiguity;
      confirmationState = nextConfirmation;
      rawHandCount = nextRawHandCount;
      matchedHandCount = nextMatchedHandCount;
      if (!force && !changed && now - lastReportedAt < 250) return;
      lastReportedAt = now;
      reportedResetSequence = resetSequence.current;
      const span = resultTimes.length > 1 ? resultTimes.at(-1)! - resultTimes[0] : 0;
      const fps = nextCapture === 'active' && span > 0
        ? Math.round((resultTimes.length - 1) * 1_000 / span) : 0;
      setState(previous => ({ ...previous, captureStatus, handDetected, handRaised, lastHandAt, fps, inferenceMs, operatorStatus, armed, needsRelease, controlSource, ambiguityReason,
        confirmationState, palmHoldMs: nextPalmHoldMs, rawHandCount, matchedHandCount, recognitionMs, inputWidth: canvas.width, inputHeight: canvas.height }));
    };
    const visibilityChanged = () => {
      resetMotion();
      if (document.hidden) report('hidden', false, true);
      else { lastDecodedAt = performance.now(); report('waiting', false, true); }
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(tickTimer);
      clearTimeout(loadTimer);
      clearTimeout(frameTimer);
      document.removeEventListener('visibilitychange', visibilityChanged);
      for (const track of tracks) track.removeEventListener('ended', cameraEnded);
      video.pause();
      video.srcObject = null;
      video.parentNode?.removeChild(video);
      canvas.width = canvas.height = 0;
      if (detector.current === motion) detector.current = null;
      if (worker) {
        const closingWorker = worker;
        closingWorker.onmessage = null;
        closingWorker.onerror = null;
        closingWorker.onmessageerror = null;
        try { closingWorker.postMessage({ type: 'close' }); } catch { /* Already stopped. */ }
        // Allow the task to close its WASM graph; termination also cancels an unfinished load.
        setTimeout(() => closingWorker.terminate(), 100);
        worker = null;
      }
    };
    const fail = (message: string) => {
      if (disposed) return;
      setState({ ...OFF_STATE, status: 'error', error: message });
      dispose();
    };
    function cameraEnded() { fail('摄像头已断开。'); }

    const frameInterval = () => Math.ceil(1_000 / (combinedMode ? recognition.current.maxFps : 15));
    const scheduleTick = (delay: number) => {
      clearTimeout(tickTimer);
      // Browser timers truncate fractional delays; round up to avoid waking just
      // before a frame's deadline and losing another complete sampling interval.
      if (!disposed) tickTimer = setTimeout(tick, Math.max(0, Math.ceil(delay)));
    };
    const tick = () => {
      if (disposed) return;
      const frameIntervalMs = frameInterval();
      // Keep observing camera/visibility health even while inference is in flight.
      scheduleTick(frameIntervalMs);
      const timestamp = performance.now();
      if (document.hidden) { report('hidden'); return; }
      if (tracks.every(track => track.enabled === false)) { report('disabled'); return; }
      if (tracks.every(track => track.muted)) { report('muted'); return; }
      if (!ready) return;
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        if (timestamp - lastDecodedAt > FRAME_STALE_MS) report('stalled');
        return;
      }
      // Observe decoded-frame progress even while the worker is busy.
      if (video.currentTime !== observedVideoTime) { observedVideoTime = video.currentTime; lastDecodedAt = timestamp; }
      if (timestamp - lastDecodedAt > FRAME_STALE_MS) { report('stalled'); return; }
      if (busy) {
        if (timestamp - lastResultAt > 800 && (handDetected || operatorStatus !== 'searching')) {
          resultTimes.length = 0;
          resetMotion();
          report('active', false);
        }
        return;
      }
      if (video.currentTime === previousVideoTime) return;
      const remainingMs = previousFrameAt + frameIntervalMs - timestamp;
      if (remainingMs > 0) { scheduleTick(remainingMs); return; }
      previousFrameAt = timestamp;
      previousVideoTime = video.currentTime;
      busy = true;
      pendingResetSequence = resetSequence.current;
      const ratio = Math.min(1, (combinedMode ? recognition.current.inputLongEdge : 720) / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * ratio));
      const height = Math.max(1, Math.round(video.videoHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        resetMotion();
        pendingResetSequence = resetSequence.current;
      }
      try {
        context!.drawImage(video, 0, 0, width, height);
        const id = ++frameId;
        frameTimer = setTimeout(() => fail('手势识别超时，请重试。'), 15_000);
        void createImageBitmap(canvas).then(bitmap => {
          if (disposed || !worker) { bitmap.close(); return; }
          // There is only one frame in flight: inference cannot create a backlog.
          try { worker.postMessage({ type: 'detect', bitmap, timestamp, frameId: id }, [bitmap]); }
          catch { bitmap.close(); fail('手势识别未能启动，请重试。'); }
        }, () => fail('摄像头画面无法读取，请重试。'));
      } catch {
        fail('摄像头画面无法读取，请重试。');
      }
    };

    try {
      if (!context) throw new Error('Canvas unavailable');
      worker = new Worker(`${import.meta.env.BASE_URL}assets/exhibition-gestures/${poseMode ? 'pose' : 'hand'}-landmarker.worker.js`);
      worker.onerror = () => fail('手势识别加载失败，请重试。');
      worker.onmessageerror = () => fail('手势识别通信失败，请重试。');
      worker.onmessage = (event: MessageEvent<GestureWorkerMessage>) => {
        if (disposed) return;
        const result = event.data;
        if (result.type === 'error') { fail('手势识别加载失败，请重试。'); return; }
        if (result.type === 'ready') {
          clearTimeout(loadTimer);
          ready = true;
          setState(previous => ({ ...previous, status: 'ready', error: '', lastGesture: null }));
          return;
        }
        if (result.type !== 'result' || !busy || result.frameId !== frameId) return;
        clearTimeout(frameTimer);
        busy = false;
        // Start the latest frame as soon as both inference and the rate limit allow.
        // A fixed polling tick would add a whole interval to slower inference.
        scheduleTick(previousFrameAt + frameInterval() - performance.now());
        if (document.hidden || tracks.every(track => track.enabled === false) || tracks.every(track => track.muted)
          || pendingResetSequence !== resetSequence.current) return;
        const hand = result.landmarks?.length ? {
          landmarks: result.landmarks.map(point => ({
            ...point,
            x: settings.current.mirrored ? 1 - point.x : point.x,
          })),
          handedness: result.handedness,
        } : null;
        const receivedAt = performance.now();
        lastResultAt = receivedAt;
        if (typeof result.timestamp !== 'number' || !Number.isFinite(result.timestamp)
          || receivedAt - result.timestamp > 800 || result.timestamp > receivedAt) {
          resetMotion(); report('active', false, true); return;
        }
        // Capture-to-landmarks processing time only, not cloud garment appearance latency.
        recognitionMs = Math.max(0, Math.round(receivedAt - result.timestamp));
        resultTimes.push(receivedAt);
        while (resultTimes.length > 2 && receivedAt - resultTimes[0] > 2_000) resultTimes.shift();
        inferenceMs = typeof result.inferenceMs === 'number' && Number.isFinite(result.inferenceMs)
          ? Math.max(0, Math.round(result.inferenceMs)) : 0;
        const poses = (result.poses ?? []).map(pose => ({ landmarks: pose.landmarks.map(point => ({
          ...point, x: settings.current.mirrored ? 1 - point.x : point.x,
        })) }));
        const hands = (result.hands ?? []).map(hand => ({ ...hand, landmarks: hand.landmarks.map(point => ({
          ...point, x: settings.current.mirrored ? 1 - point.x : point.x,
        })) }));
        const gesture = combinedMotion ? combinedMotion.update(poses, hands, result.timestamp, canvas.width / canvas.height)
          : raiseMotion instanceof ExhibitionRaiseGestureDetector ? raiseMotion.update(poses, result.timestamp, canvas.width / canvas.height)
          : handMotion!.update(hand, result.timestamp, settings.current.mode);
        const detected = raiseMotion ? raiseMotion.handDetected : !!hand;
        if (detected) lastHandAt = Date.now();
        report('active', detected);
        if (!gesture || (combinedMode && !recognition.current.gestures.includes(gesture as 'open_palm' | 'wave'))) return;
        setState(previous => ({ ...previous, status: 'ready', error: '', lastGesture: gesture }));
        if (diagnosticsEnabled.current) {
          const raiseStartedAt = gesture === 'raise_hand' ? raiseMotion?.lastRaiseStartedAt : null;
          const metadata: ExhibitionGestureMetadata = {
            eventId: `gesture-${++diagnosticEventSequence}`,
            frameId,
            sampledAt: result.timestamp,
            detectedAt: performance.now(),
            ...(typeof raiseStartedAt === 'number' && Number.isFinite(raiseStartedAt)
              && raiseStartedAt >= 0 && raiseStartedAt <= result.timestamp ? { raiseStartedAt } : {}),
          };
          callback.current(gesture, metadata);
        } else callback.current(gesture);
      };
      document.addEventListener('visibilitychange', visibilityChanged);
      for (const track of tracks) track.addEventListener('ended', cameraEnded);
      loadTimer = setTimeout(() => fail('手势识别加载超时，请重试。'), 45_000);
      worker.postMessage({ type: 'init', ...(combinedMode ? { hands: true, options: {
        minHandDetectionConfidence: recognition.current.minHandDetectionConfidence,
        minHandPresenceConfidence: recognition.current.minHandPresenceConfidence,
        minTrackingConfidence: recognition.current.minTrackingConfidence,
      } } : {}) });
      void video.play().catch(() => fail('摄像头预览未就绪，请重试。'));
      scheduleTick(frameInterval());
    } catch {
      fail('手势识别未能启动，请重试。');
    }
    return dispose;
  }, [stream, recognitionEnabled, attempt, poseMode, combinedMode, confidenceKey]);

  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return { ...state, retry };
}
