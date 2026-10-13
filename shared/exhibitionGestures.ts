export type ExhibitionGestureKind = 'open_palm' | 'wave';

export interface ExhibitionGestureSettings {
  gestures: ExhibitionGestureKind[];
  minHandDetectionConfidence: number;
  minHandPresenceConfidence: number;
  minTrackingConfidence: number;
  palmConfirmMs: number;
  palmReleaseMs: number;
  maxFps: number;
  inputLongEdge: 480 | 720 | 960;
}

export const DEFAULT_EXHIBITION_GESTURE_SETTINGS: ExhibitionGestureSettings = {
  gestures: ['open_palm'],
  minHandDetectionConfidence: 0.35,
  minHandPresenceConfidence: 0.35,
  minTrackingConfidence: 0.5,
  palmConfirmMs: 300,
  palmReleaseMs: 500,
  maxFps: 15,
  inputLongEdge: 720,
};
Object.freeze(DEFAULT_EXHIBITION_GESTURE_SETTINGS.gestures);
Object.freeze(DEFAULT_EXHIBITION_GESTURE_SETTINGS);

const confidence = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0.1 && value <= 0.9;
const integerIn = (value: unknown, min: number, max: number): value is number => typeof value === 'number'
  && Number.isInteger(value) && value >= min && value <= max;

/** A settings update is complete and atomic; an empty gesture list disables recognition. */
export function isExhibitionGestureSettings(value: unknown): value is ExhibitionGestureSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return Array.isArray(settings.gestures) && settings.gestures.length <= 2
    && Array.from(settings.gestures).every(gesture => gesture === 'open_palm' || gesture === 'wave')
    && new Set(settings.gestures).size === settings.gestures.length
    && confidence(settings.minHandDetectionConfidence) && confidence(settings.minHandPresenceConfidence)
    && confidence(settings.minTrackingConfidence) && integerIn(settings.palmConfirmMs, 150, 1000)
    && integerIn(settings.palmReleaseMs, 300, 1500) && integerIn(settings.maxFps, 5, 30)
    && (settings.inputLongEdge === 480 || settings.inputLongEdge === 720 || settings.inputLongEdge === 960);
}

/** Legacy or invalid persisted settings safely fall back without sharing mutable arrays. */
export function resolveExhibitionGestureSettings(value?: unknown): ExhibitionGestureSettings {
  const settings = isExhibitionGestureSettings(value) ? value : DEFAULT_EXHIBITION_GESTURE_SETTINGS;
  return {
    gestures: [...settings.gestures],
    minHandDetectionConfidence: settings.minHandDetectionConfidence,
    minHandPresenceConfidence: settings.minHandPresenceConfidence,
    minTrackingConfidence: settings.minTrackingConfidence,
    palmConfirmMs: settings.palmConfirmMs,
    palmReleaseMs: settings.palmReleaseMs,
    maxFps: settings.maxFps,
    inputLongEdge: settings.inputLongEdge,
  };
}
