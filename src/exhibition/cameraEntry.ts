import { exhibitionUrl } from './mirrorApi';

export function exhibitionCameraUrl(mirrorId = 'default', href = typeof window === 'undefined' ? 'http://xuminghong.local:10200/' : window.location.href) {
  const url = new URL(exhibitionUrl('/exhibition/screen', mirrorId), href);
  url.protocol = 'https:';
  url.port = '10202';
  return url.toString();
}

export function exhibitionBrowserTestUrl(mirrorId = 'default', href?: string) {
  const url = new URL(exhibitionCameraUrl(mirrorId, href));
  url.searchParams.set('browserTest', '1');
  return url.toString();
}

/** The mirror needs the camera-capable origin; the rest of V1.1 stays on HTTP. */
export function defaultMirrorCameraEntry(href: string): string | null {
  const url = new URL(href);
  if (url.protocol !== 'http:' || !/^\/v1\.1\/exhibition\/screen\/?$/.test(url.pathname)) return null;
  url.protocol = 'https:';
  url.port = '10202';
  return url.toString();
}
