import { exhibitionWirelessUrl } from './computerDisplay';

const windows = new Map<string, Window>();
export function openWirelessWindow(mirrorId: string, href?: string): 'opened' | 'focused' | 'blocked' {
  const url = exhibitionWirelessUrl(mirrorId, href);
  const key = JSON.stringify([new URL(url).origin, mirrorId]);
  const previous = windows.get(key);
  if (previous && !previous.closed) {
    try { previous.focus(); } catch { /* Keep the existing shared page and session. */ }
    return 'focused';
  }
  windows.delete(key);
  try {
    // A regular tab appears clearly in Chrome's tab-sharing picker.
    const opened = window.open(url, '_blank');
    if (!opened) return 'blocked';
    windows.set(key, opened);
    try { opened.focus(); } catch { /* Already open. */ }
    return 'opened';
  } catch { return 'blocked'; }
}
