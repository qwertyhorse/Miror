export type ComputerResolution = '1080p' | '2k' | '4k' | 'l1' | 'l2' | 'l3' | 'l4';
export type ComputerCameraQuality = Exclude<ComputerResolution, '2k'>;
export type ComputerDisplayQuality = ComputerResolution;
export type ComputerDisplayFrameRate = 15 | 24 | 30;

export const COMPUTER_RESOLUTION_OPTIONS = [
  { value: '1080p', label: '1080p · 1920 × 1080' },
  { value: '2k', label: '2K · 2560 × 1440' },
  { value: '4k', label: '4K · 3840 × 2160' },
  { value: 'l1', label: 'L1 · 1024 × 1920' },
  { value: 'l2', label: 'L2 · 818 × 1536' },
  { value: 'l3', label: 'L3 · 664 × 1248' },
  { value: 'l4', label: 'L4 · 512 × 960' },
] as const satisfies readonly { value: ComputerResolution; label: string }[];

export const CAMERA_RESOLUTION_OPTIONS = COMPUTER_RESOLUTION_OPTIONS.filter(option => option.value !== '2k');

// Profiles use long edge × short edge; L-series labels show the portrait reference.
const profiles = {
  '1080p': { width: 1920, height: 1080, maxBitrate: 6_000_000 },
  '2k': { width: 2560, height: 1440, maxBitrate: 12_000_000 },
  '4k': { width: 3840, height: 2160, maxBitrate: 24_000_000 },
  'l1': { width: 1920, height: 1024, maxBitrate: 5_700_000 },
  'l2': { width: 1536, height: 818, maxBitrate: 3_600_000 },
  'l3': { width: 1248, height: 664, maxBitrate: 2_400_000 },
  'l4': { width: 960, height: 512, maxBitrate: 1_400_000 },
} as const;

export function isComputerResolution(value: unknown): value is ComputerResolution {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(profiles, value);
}

export function isComputerCameraResolution(value: unknown): value is ComputerCameraQuality {
  return isComputerResolution(value) && value !== '2k';
}

export function computerCameraQuality(value: unknown): ComputerCameraQuality {
  return isComputerCameraResolution(value) ? value : '1080p';
}

/** Requested upper bounds; neither capture nor sending may upscale smaller frames. */
export function computerCameraProfile(quality: ComputerCameraQuality) {
  return profiles[quality];
}

export function computerDisplayQuality(value: unknown): ComputerDisplayQuality {
  return isComputerResolution(value) ? value : '1080p';
}

export function computerDisplayFrameRate(value: unknown): ComputerDisplayFrameRate {
  return value === 15 || value === 24 ? value : 30;
}

export function computerDisplayProfile(quality: ComputerDisplayQuality) {
  return profiles[quality];
}
