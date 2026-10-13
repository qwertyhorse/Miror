import type { XmaxRegion } from '../../shared/xmax';

// Share the same import with upload/connect, so entry preparation warms their code too.
export function exhibitionSdk(region: XmaxRegion = 'global') {
  return region === 'cn' ? import('@xmaxai/sdk') : import('@xmaxai/sdk-global');
}

/** Code + HTTPS transport hint only. Never creates a client, credential, RTC room or generation. */
export function prepareExhibitionEntry(region: XmaxRegion): () => void {
  let cancelled = false;
  let hint: HTMLLinkElement | undefined;
  void exhibitionSdk(region).then(sdk => {
    if (cancelled || typeof document === 'undefined' || !document.head) return;
    // Use the installed regional SDK's public API origin; no credential or image URL is included.
    const origin = new URL(sdk.XMAX_OPEN_API_PRODUCTION_BASE_URL).origin;
    hint = document.createElement('link');
    hint.rel = 'preconnect'; hint.href = origin; hint.crossOrigin = 'anonymous';
    document.head.appendChild(hint);
  }).catch(() => { /* Foreground upload/connect retains its normal retry and error handling. */ });
  return () => { cancelled = true; hint?.remove(); };
}
