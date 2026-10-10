export type XmaxRegion = 'cn' | 'global';

export function isXmaxRegion(value: unknown): value is XmaxRegion {
  return value === 'cn' || value === 'global';
}
