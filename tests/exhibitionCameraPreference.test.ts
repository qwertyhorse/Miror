import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cameraCaptureConstraints, readCameraPreference, saveCameraPreference, type ExhibitionCameraPreference } from '../src/exhibition/cameraPreference';
import { scopedStorageKey } from '../src/versionScope';

const base: ExhibitionCameraPreference = { deviceId: 'camera-a', label: 'USB Camera', profile: 'screen' };
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('camera preference resolution compatibility', () => {
  it.each(['1080p', '4k', 'l1', 'l2', 'l3', 'l4'] as const)('round trips supported %s without affecting another scope', quality => {
    saveCameraPreference(base);
    const selected = { ...base, quality, rotation: 270 as const };
    saveCameraPreference(selected, 'test/a');
    expect(readCameraPreference('test/a')).toEqual(selected);
    expect(readCameraPreference()).toEqual(base); expect(readCameraPreference('test/b')).toBeNull();
    expect(storage.has(scopedStorageKey('exhibition-camera-preference:test%2Fa'))).toBe(true);
  });

  it.each(['2k', '8k', '4K', 'L1', '', '__proto__', null, 1080, {}, []])('rejects an unsupported persisted quality %j', quality => {
    storage.set(scopedStorageKey('exhibition-camera-preference'), JSON.stringify({ ...base, quality }));
    expect(readCameraPreference()).toBeNull();
    // A malformed shared preference must not be imported into an isolated test.
    expect(readCameraPreference('test/a')).toBeNull();
  });

  it('accepts legacy preferences with no quality and does not add a resolution on save', () => {
    saveCameraPreference(base);
    expect(readCameraPreference()).toEqual(base); expect(readCameraPreference()?.quality).toBeUndefined();
    expect(cameraCaptureConstraints(undefined, readCameraPreference())).toEqual({ audio: false, video: {
      deviceId: { exact: 'camera-a' }, width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 },
    } });
    saveCameraPreference({ ...base, profile: 'default' });
    expect(cameraCaptureConstraints(undefined, readCameraPreference())).toEqual({ audio: false, video: { deviceId: { exact: 'camera-a' } } });
  });

  it('distinguishes an omitted override from explicitly choosing default capture', () => {
    const preference: ExhibitionCameraPreference = { ...base, quality: 'l4' };
    expect(cameraCaptureConstraints(undefined, preference)).toEqual({ audio: false, video: {
      deviceId: { exact: 'camera-a' }, width: { ideal: 512 }, height: { ideal: 960 }, frameRate: { ideal: 30, max: 30 },
    } });
    expect(cameraCaptureConstraints(undefined, preference, undefined)).toEqual(cameraCaptureConstraints(undefined, preference));
    expect(cameraCaptureConstraints('camera-b', preference, null)).toEqual({ audio: false, video: {
      deviceId: { exact: 'camera-b' }, width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30, max: 30 },
    } });
    expect(cameraCaptureConstraints(undefined, { ...preference, profile: 'default' }, null)).toEqual({ audio: false, video: { deviceId: { exact: 'camera-a' } } });
  });
});
