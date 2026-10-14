/** Product input bounds; the provider can apply its own account/service limits. */
export const SESSION_CREDIT_MAX = 1_000_000;
export const SESSION_EXPIRY_MAX = 86_400;
/** Each continuing segment still has an explicit, revocable provider quota. */
export const CONTINUOUS_SEGMENT_CREDITS = 3_000;
export const CONTINUOUS_MIN_EXPIRY_SECONDS = 60;
export const SESSION_RENEWAL_LEAD_MS = 15_000;

export interface ExhibitionSessionLimits {
  /** null requests a continuing experience, using successive bounded credentials. */
  credits: number | null;
  expireSeconds: number;
}

export const DEFAULT_SESSION_LIMITS: Readonly<ExhibitionSessionLimits> = { credits: null, expireSeconds: 120 };
/** Numeric defaults for standalone credentials and the optional finite mode. */
export const DEFAULT_CREDENTIAL_LIMITS: Readonly<{ credits: number; expireSeconds: number }> = { credits: 30, expireSeconds: 120 };

export function isSessionLimits(value: unknown): value is ExhibitionSessionLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every(key => key === 'credits' || key === 'expireSeconds')
    && (input.credits === null || (typeof input.credits === 'number' && Number.isSafeInteger(input.credits) && input.credits >= 1 && input.credits <= SESSION_CREDIT_MAX))
    && typeof input.expireSeconds === 'number' && Number.isSafeInteger(input.expireSeconds)
    && input.expireSeconds >= (input.credits === null ? CONTINUOUS_MIN_EXPIRY_SECONDS : 1) && input.expireSeconds <= SESSION_EXPIRY_MAX;
}

export function resolveSessionLimits(value?: unknown, fallback: Readonly<ExhibitionSessionLimits> = DEFAULT_SESSION_LIMITS): ExhibitionSessionLimits {
  const valid = isSessionLimits(value) ? value : fallback;
  return { credits: valid.credits, expireSeconds: valid.expireSeconds };
}
