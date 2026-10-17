export type XmaxRegion = 'cn' | 'global';
export type XmaxRealtimeModel = 'x2.1.1-preview-cn' | 'x2.1.1-preview-us';
export const XMAX_NATIVE_MODEL_FAMILY = 'x2.1.1-preview';

export function xmaxNativeModel(region: XmaxRegion): XmaxRealtimeModel {
  return region === 'cn' ? 'x2.1.1-preview-cn' : 'x2.1.1-preview-us';
}

export function isXmaxRealtimeModel(value: unknown): value is XmaxRealtimeModel {
  return value === 'x2.1.1-preview-cn' || value === 'x2.1.1-preview-us';
}

export function isXmaxRegion(value: unknown): value is XmaxRegion {
  return value === 'cn' || value === 'global';
}
