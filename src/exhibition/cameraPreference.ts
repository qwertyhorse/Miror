import { scopedLocalStorage } from '../versionScope';
import type { ExhibitionCameraRotation } from './cameraOrientation';
import { computerCameraProfile, isComputerCameraResolution, type ComputerCameraQuality } from './cameraQuality';

export interface ExhibitionCameraPreference {
  deviceId: string;
  label: string;
  profile: 'default' | 'screen';
  rotation?: ExhibitionCameraRotation;
  quality?: ComputerCameraQuality;
}

function preferenceKey(scope?: string) {
  return scope === undefined ? 'exhibition-camera-preference' : `exhibition-camera-preference:${encodeURIComponent(scope)}`;
}

export function saveCameraPreference(preference: ExhibitionCameraPreference, scope?: string): void {
  scopedLocalStorage.setItem(preferenceKey(scope), JSON.stringify(preference));
}

/** Normal mirrors share this browser's camera; isolated tests never fall back to that preference. */
export function readCameraPreference(scope?: string): ExhibitionCameraPreference | null {
  try {
    const saved = scopedLocalStorage.getItem(preferenceKey(scope));
    if (!saved) return null;
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== 'object') return null;
    const preference = value as Partial<ExhibitionCameraPreference>;
    if (typeof preference.deviceId !== 'string' || !preference.deviceId || preference.deviceId.length > 512
      || /[\u0000-\u001f\u007f]/.test(preference.deviceId)
      || typeof preference.label !== 'string' || preference.label.length > 300
      || !['default', 'screen'].includes(preference.profile ?? '')
      || (preference.rotation !== undefined && ![0, 90, 180, 270].includes(preference.rotation))
      || (preference.quality !== undefined && !isComputerCameraResolution(preference.quality))) return null;
    return preference as ExhibitionCameraPreference;
  } catch { return null; }
}

/** Keep the constraints that produced a real frame on the diagnostic page. */
export function cameraCaptureConstraints(cameraId?: string, preference: ExhibitionCameraPreference | null = null,
  quality: ComputerCameraQuality | null | undefined = preference?.quality): MediaStreamConstraints {
  const selected = cameraId || preference?.deviceId;
  const dimensions = quality ? computerCameraProfile(quality) : undefined;
  if (preference?.profile === 'default' && !dimensions) return { audio: false, video: selected ? { deviceId: { exact: selected } } : true };
  return { audio: false, video: {
    ...(selected ? { deviceId: { exact: selected } } : { facingMode: 'user' }),
    width: { ideal: dimensions?.height ?? 1080 }, height: { ideal: dimensions?.width ?? 1920 }, frameRate: { ideal: 30, max: 30 },
  } };
}
