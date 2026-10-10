import { appUrl } from '../versionScope';

/** Logical API path; api() adds the versioned /api prefix. */
export function exhibitionApiPath(path = '', mirrorId = 'default') {
  const suffix = path.replace(/^\/+/, '');
  return `/exhibition/mirrors/${encodeURIComponent(mirrorId)}${suffix ? `/${suffix}` : ''}`;
}

/** Preserve link options and fragments while keeping navigation on one mirror. */
export function exhibitionUrl(path: string, mirrorId = 'default') {
  const hashIndex = path.indexOf('#');
  const hash = hashIndex < 0 ? '' : path.slice(hashIndex);
  const beforeHash = hashIndex < 0 ? path : path.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  const pathname = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? '' : beforeHash.slice(queryIndex + 1));
  query.set('mirror', mirrorId);
  return appUrl(`${pathname}?${query}${hash}`);
}
