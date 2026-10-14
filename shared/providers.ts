/** Product capabilities are explicit; a provider model is not an experience mode. */
export type RealtimeProvider = 'xmax' | 'decart';
export const DECART_MODEL = 'lucy-vton-3.6';
export const isRealtimeProvider = (value: unknown): value is RealtimeProvider => value === 'xmax' || value === 'decart';
export const providerLabel = (value: RealtimeProvider) => value === 'decart' ? 'Decart · Lucy VTON 3.6' : 'XMAX';
export interface ProviderSettings {
  revision: number;
  active: RealtimeProvider;
  desired: RealtimeProvider;
  pending: boolean;
  applyAfterStop?: boolean;
  accounts: Record<RealtimeProvider, { configured: boolean }>;
}
export const isDecartReference = (value: string) => /^file_[A-Za-z0-9_-]{1,200}$/.test(value);
