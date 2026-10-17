import { exhibitionHdmiUrl } from './computerDisplay';

export type HdmiWindowResult = 'opened' | 'focused' | 'blocked';

// Keep handles when the console changes mirror or remounts. The HTTPS child is
// cross-origin from the HTTP console: only closed and focus are accessed here.
const windows = new Map<string, Window>();

export function openHdmiWindow(mirrorId: string, href?: string): HdmiWindowResult {
  const url = exhibitionHdmiUrl(mirrorId, href);
  const key = JSON.stringify([new URL(url).origin, mirrorId]);
  const existing = windows.get(key);
  if (existing && !existing.closed) {
    try { existing.focus(); } catch { /* A focus restriction must not restart the active window. */ }
    return 'focused';
  }
  windows.delete(key);
  let opened: Window | null;
  try {
    // This call must stay synchronous within the console button's user gesture.
    opened = window.open(url, '_blank', 'popup=yes,width=960,height=720');
  } catch { return 'blocked'; }
  if (!opened) return 'blocked';
  windows.set(key, opened);
  try { opened.focus(); } catch { /* The new window is already open. */ }
  return 'opened';
}
