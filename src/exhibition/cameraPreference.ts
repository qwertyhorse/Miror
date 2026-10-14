import { scopedLocalStorage } from '../versionScope';

export interface ExhibitionCameraPreference {
  deviceId: string;
  label: string;
  profile: 'default' | 'screen';
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
      || !['default', 'screen'].includes(preference.profile ?? '')) return null;
    return preference as ExhibitionCameraPreference;
  } catch { return null; }
}

/** Keep the constraints that produced a real frame on the diagnostic page. */
export function cameraCaptureConstraints(cameraId?: string, preference: ExhibitionCameraPreference | null = null): MediaStreamConstraints {
  const selected = cameraId || preference?.deviceId;
  if (preference?.profile === 'default') return { audio: false, video: selected ? { deviceId: { exact: selected } } : true };
  return { audio: false, video: {
    ...(selected ? { deviceId: { exact: selected } } : { facingMode: 'user' }),
    width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 },
  } };
}
