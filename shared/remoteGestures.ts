import type { ExhibitionGestureKind } from './exhibitionGestures.ts';

/** Android capture time is monotonic on that device; it is never compared with the server's clock. */
export interface RemoteGestureFrameMetadata {
  epoch: number;
  seq: number;
  timestamp: number;
  blocked: boolean;
}

export interface RemoteGestureControl {
  epoch: number;
  blocked: boolean;
  reset?: boolean;
}

export interface RemoteGestureSnapshot {
  sessionId: string;
  epoch: number;
  seq: number;
  timestamp: number | null;
  event: ExhibitionGestureKind | null;
  blocked: boolean;
  operatorStatus: 'searching' | 'locked' | 'ambiguous';
  controlSource: 'body' | 'hand' | 'none';
  ambiguityReason: 'people' | 'hands' | null;
  handDetected: boolean;
  handRaised: boolean;
  armed: boolean;
  needsRelease: boolean;
  confirmationState: string;
  palmHoldMs: number;
  rawHandCount: number;
  matchedHandCount: number;
  inferenceMs: number | null;
}

export const REMOTE_GESTURE_SESSION_TTL_MS = 30_000;
export const REMOTE_GESTURE_MAX_FRAME_BYTES = 256 * 1024;
