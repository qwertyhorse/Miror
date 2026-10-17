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

/** Tight Y + U + V planes; rotation and unmirroring are applied by the inference host. */
export interface RemoteGestureI420Metadata {
  format: 'i420-v1';
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
}

export interface RemoteGestureOpenSnapshot extends RemoteGestureSnapshot {
  frameFormat: 'i420-v1';
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
export const REMOTE_GESTURE_MAX_RAW_FRAME_BYTES = 16 * 1024 * 1024;
export const REMOTE_GESTURE_I420_CONTENT_TYPE = 'application/x-openbuy-i420';

/** Returns the exact bounded payload size without allocating or decoding pixels. */
export function remoteGestureI420ByteLength(frame: RemoteGestureI420Metadata): number | null {
  if (!frame || frame.format !== 'i420-v1' || typeof frame.mirrored !== 'boolean'
    || ![0, 90, 180, 270].includes(frame.rotation)
    || ![frame.width, frame.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096)
    || frame.width * frame.height > 3840 * 2160) return null;
  const length = frame.width * frame.height + 2 * Math.ceil(frame.width / 2) * Math.ceil(frame.height / 2);
  return length <= REMOTE_GESTURE_MAX_RAW_FRAME_BYTES ? length : null;
}
