/** Only supplier errors determine rejection; local usage never stands for its balance. */
export function exhibitionProviderRejection(cause: unknown): 'balance' | 'credential' | 'request' | null {
  const error = cause && typeof cause === 'object' ? cause as Record<string, unknown> : undefined;
  const details = error?.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : undefined;
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  const signals = [code, error?.message, details?.reason_code, details?.server_close_reason, details?.business_code, error?.apiCode]
    .filter((value): value is string => typeof value === 'string');
  // The SDK reports a running session as SESSION_ERROR/POINTS_INSUFFICIENT,
  // then rejects a fresh connection as API_ERROR/用户积分余额不足.
  const insufficient = /\b(?:POINTS_INSUFFICIENT|INSUFFICIENT_POINTS|INSUFFICIENT_CREDITS?|CREDITS?_EXHAUSTED|INSUFFICIENT_BALANCE|BALANCE_INSUFFICIENT)\b|(?:积分|余额|额度)不足|积分余额不足|\binsufficient\s+(?:account\s+)?(?:credits?|points?|balance)\b|\bnot enough\s+(?:credits?|points?)\b/i;
  if (signals.some(value => insufficient.test(value))) return 'balance';
  if (code === 'INVALID_API_KEY') return 'credential';
  if (/AUTH|CREDIT|QUOTA|BALANCE|INVALID|REQUEST_REJECTED|PROVIDER_REJECTED/.test(code)
    || [401, 403].includes(Number(details?.http_status ?? error?.httpStatus))) return 'request';
  return null;
}
