import { ExhibitionMirrorGestureDetector } from './mirrorGestureDetector';
import type { ExhibitionGestureHand } from './gestureDetector';
import type { ExhibitionGesturePose } from './raiseGestureDetector';

// This bundle runs in a private, offline WebView on older Android mirrors. Only
// landmarks cross the native boundary; camera frames and inference stay native.
// Keep the exact web detector instead of maintaining a second gesture algorithm.
if (!Array.prototype.at) Object.defineProperty(Array.prototype, 'at', {
  configurable: true, writable: true,
  value(this: unknown[], index: number) {
    const offset = Math.trunc(Number(index) || 0);
    return this[offset < 0 ? this.length + offset : offset];
  },
});

type Options = NonNullable<ConstructorParameters<typeof ExhibitionMirrorGestureDetector>[0]>;
export interface NativeGestureFrame {
  timestamp: number;
  hands: readonly ExhibitionGestureHand[];
  poses?: readonly ExhibitionGesturePose[];
  aspectRatio?: number;
}

function validOptions(value: Options = {}): Options {
  const options: Options = { allowRaise: false };
  if (Array.isArray(value.gestures)) options.gestures = value.gestures.filter(item => item === 'open_palm' || item === 'wave');
  for (const key of ['palmConfirmMs', 'palmReleaseMs', 'palmLowerMs', 'lowerTrackingGraceMs'] as const) {
    const duration = value[key];
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= 10_000) options[key] = duration;
  }
  return options;
}

export function createNativeGestureRuntime() {
  const detector = new ExhibitionMirrorGestureDetector({ allowRaise: false });
  let blocked = false;
  let timestamp: number | null = null;
  const snapshot = (event: 'open_palm' | 'wave' | null = null) => ({
    event, timestamp, blocked,
    operatorStatus: detector.operatorStatus,
    controlSource: detector.controlSource,
    ambiguityReason: detector.ambiguityReason,
    handDetected: detector.handDetected,
    handRaised: detector.handRaised,
    armed: detector.armed,
    needsRelease: detector.needsRelease,
    confirmationState: detector.confirmationState,
    palmHoldMs: detector.palmHoldMs,
    rawHandCount: detector.rawHandCount,
    matchedHandCount: detector.matchedHandCount,
  });
  return {
    configure(options: Options = {}) {
      detector.configure(validOptions(options));
      return snapshot();
    },
    setBlocked(value: boolean) {
      blocked = value === true;
      detector.setBlocked(blocked);
      return snapshot();
    },
    reset() {
      // Stop/retry and late inference must not rearm a continuously held palm.
      detector.reset(true);
      timestamp = null;
      return snapshot();
    },
    push(frame: NativeGestureFrame) {
      if (!frame || !Number.isFinite(frame.timestamp) || frame.timestamp < 0
        || (timestamp !== null && frame.timestamp <= timestamp) || !Array.isArray(frame.hands)) return snapshot();
      timestamp = frame.timestamp;
      const event = detector.update(frame.poses || [], frame.hands, timestamp, frame.aspectRatio ?? 1);
      return snapshot(event === 'open_palm' || event === 'wave' ? event : null);
    },
  };
}

// IIFE output has no imports, network, DOM, model or WASM dependencies.
const runtimeGlobal = typeof self === 'undefined' ? globalThis : self;
(runtimeGlobal as typeof runtimeGlobal & { NativeGestureRuntime?: ReturnType<typeof createNativeGestureRuntime> }).NativeGestureRuntime = createNativeGestureRuntime();
