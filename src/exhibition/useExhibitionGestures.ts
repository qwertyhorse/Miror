import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExhibitionGestureDetector,
  type ExhibitionGesture,
  type ExhibitionGestureHand,
  type ExhibitionGestureMode,
} from './gestureDetector';

export type ExhibitionGestureStatus = 'off' | 'loading' | 'ready' | 'error';
export type ExhibitionGestureCaptureStatus = 'waiting' | 'active' | 'disabled' | 'muted' | 'stalled' | 'hidden';

interface GestureState {
  status: ExhibitionGestureStatus;
  error: string;
  lastGesture: ExhibitionGesture | null;
  handDetected: boolean;
  lastHandAt: number | null;
  captureStatus: ExhibitionGestureCaptureStatus;
  fps: number;
  inferenceMs: number;
}

interface GestureWorkerMessage {
  type: 'ready' | 'result' | 'error';
  frameId?: number;
  timestamp?: number;
  landmarks?: ExhibitionGestureHand['landmarks'];
  handedness?: string;
  inferenceMs?: number;
}

const FRAME_INTERVAL_MS = Math.ceil(1_000 / 15);
const INPUT_LONG_EDGE = 720;
const FRAME_STALE_MS = 1_200;
const EMPTY_DIAGNOSTICS = { handDetected: false, lastHandAt: null, captureStatus: 'waiting', fps: 0, inferenceMs: 0 } as const;
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
}: {
  stream: MediaStream | null;
  enabled: boolean;
  mode?: ExhibitionGestureMode;
  mirrored?: boolean;
  onGesture: (gesture: ExhibitionGesture) => void;
  resetKey?: unknown;
}): GestureState & { retry: () => void } {
  const [state, setState] = useState<GestureState>(OFF_STATE);
  const [attempt, setAttempt] = useState(0);
  const callback = useRef(onGesture);
  const settings = useRef({ mode, mirrored });
  const detector = useRef<ExhibitionGestureDetector | null>(null);
  const resetSequence = useRef(0);
  callback.current = onGesture;
  settings.current = { mode, mirrored };

  useEffect(() => {
    resetSequence.current += 1;
    detector.current?.reset();
    setState(previous => previous.lastGesture ? { ...previous, lastGesture: null } : previous);
  }, [mode, mirrored, resetKey]);

  useEffect(() => {
    const tracks = liveVideoTracks(stream);
    if (!enabled || !tracks.length) {
      setState(OFF_STATE);
      return;
    }
    setState({ ...OFF_STATE, status: 'loading' });
    if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') {
      setState({ ...OFF_STATE, status: 'error', error: '浏览器不支持挥手识别，请使用新版 Chrome。' });
      return;
    }

    const motion = new ExhibitionGestureDetector();
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
    let lastHandAt: number | null = null;
    let inferenceMs = 0;
    const resultTimes: number[] = [];
    let tickTimer: ReturnType<typeof setTimeout> | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;

    const resetMotion = () => {
      resetSequence.current += 1;
      motion.reset();
    };
    const report = (nextCapture: ExhibitionGestureCaptureStatus, nextHand = false, force = false) => {
      const now = performance.now();
      const changed = captureStatus !== nextCapture || handDetected !== nextHand;
      if (captureStatus !== nextCapture && nextCapture !== 'active') resetMotion();
      captureStatus = nextCapture;
      handDetected = nextHand;
      if (!force && !changed && now - lastReportedAt < 250) return;
      lastReportedAt = now;
      const span = resultTimes.length > 1 ? resultTimes.at(-1)! - resultTimes[0] : 0;
      const fps = nextCapture === 'active' && span > 0
        ? Math.round((resultTimes.length - 1) * 1_000 / span) : 0;
      setState(previous => ({ ...previous, captureStatus, handDetected, lastHandAt, fps, inferenceMs }));
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

    const tick = () => {
      if (disposed) return;
      tickTimer = setTimeout(tick, FRAME_INTERVAL_MS);
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
        if (timestamp - lastResultAt > 800 && handDetected) { resultTimes.length = 0; report('active', false); }
        return;
      }
      if (video.currentTime === previousVideoTime) return;
      if (timestamp - previousFrameAt < FRAME_INTERVAL_MS) return;
      previousFrameAt = timestamp;
      previousVideoTime = video.currentTime;
      busy = true;
      pendingResetSequence = resetSequence.current;
      const ratio = Math.min(1, INPUT_LONG_EDGE / Math.max(video.videoWidth, video.videoHeight));
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
        frameTimer = setTimeout(() => fail('挥手识别超时，请重试。'), 15_000);
        void createImageBitmap(canvas).then(bitmap => {
          if (disposed || !worker) { bitmap.close(); return; }
          // There is only one frame in flight: inference cannot create a backlog.
          try { worker.postMessage({ type: 'detect', bitmap, timestamp, frameId: id }, [bitmap]); }
          catch { bitmap.close(); fail('挥手识别未能启动，请重试。'); }
        }, () => fail('摄像头画面无法读取，请重试。'));
      } catch {
        fail('摄像头画面无法读取，请重试。');
      }
    };

    try {
      if (!context) throw new Error('Canvas unavailable');
      worker = new Worker(`${import.meta.env.BASE_URL}assets/exhibition-gestures/hand-landmarker.worker.js`);
      worker.onerror = () => fail('挥手识别加载失败，请重试。');
      worker.onmessageerror = () => fail('挥手识别通信失败，请重试。');
      worker.onmessage = (event: MessageEvent<GestureWorkerMessage>) => {
        if (disposed) return;
        const result = event.data;
        if (result.type === 'error') { fail('挥手识别加载失败，请重试。'); return; }
        if (result.type === 'ready') {
          clearTimeout(loadTimer);
          ready = true;
          setState(previous => ({ ...previous, status: 'ready', error: '', lastGesture: null }));
          return;
        }
        if (result.type !== 'result' || result.frameId !== frameId) return;
        clearTimeout(frameTimer);
        busy = false;
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
        resultTimes.push(receivedAt);
        while (resultTimes.length > 2 && receivedAt - resultTimes[0] > 2_000) resultTimes.shift();
        inferenceMs = typeof result.inferenceMs === 'number' && Number.isFinite(result.inferenceMs)
          ? Math.max(0, Math.round(result.inferenceMs)) : 0;
        if (hand) lastHandAt = Date.now();
        report('active', !!hand);
        const gesture = motion.update(hand, result.timestamp!, settings.current.mode);
        if (!gesture) return;
        setState(previous => ({ ...previous, status: 'ready', error: '', lastGesture: gesture }));
        callback.current(gesture);
      };
      document.addEventListener('visibilitychange', visibilityChanged);
      for (const track of tracks) track.addEventListener('ended', cameraEnded);
      loadTimer = setTimeout(() => fail('挥手识别加载超时，请重试。'), 45_000);
      worker.postMessage({ type: 'init' });
      void video.play().catch(() => fail('摄像头预览未就绪，请重试。'));
      tickTimer = setTimeout(tick, FRAME_INTERVAL_MS);
    } catch {
      fail('挥手识别未能启动，请重试。');
    }
    return dispose;
  }, [stream, enabled, attempt]);

  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return { ...state, retry };
}
