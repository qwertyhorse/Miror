import { isIP } from 'node:net';
import { isBenchmarkAddress, resolveMediaHost } from './network.ts';
import { createHash, createHmac } from 'node:crypto';
import type { ReferenceStorage } from './referenceAssets.ts';
import { safeReferenceUrl } from './referenceAssets.ts';
import type { ReferencePreparationStage } from '../shared/referencePreparation.ts';
import { ReferencePreparationError } from './referencePreparation.ts';

export type ReplicaFailure =
  | 'network'
  | 'timeout'
  | 'status'
  | 'malformed'
  | 'not_found'
  | 'denied'
  | 'not_configured'
  | 'invalid_request';
export interface ReferenceReplicaProvider {
  upload(
    bytes: Buffer,
    sha256: string,
    mime?: string,
    onStage?: (stage: ReferencePreparationStage) => void,
  ): Promise<{ ok: true; url: string } | { ok: false; error: ReplicaFailure }>;
}
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
/** Tencent COS v5 signing, identical canonicalization to the pinned SDK's host-only signature. */
export function cosPutAuthorization(input: {
  secretId: string;
  secretKey: string;
  host: string;
  key: string;
  now: number;
}) {
  const time = `${Math.floor(input.now / 1000) - 1};${Math.floor(input.now / 1000) + 299}`;
  const signKey = createHmac('sha1', input.secretKey).update(time).digest('hex');
  const canonical = `put\n/${input.key}\n\nhost=${encode(input.host)}\n`;
  const toSign = `sha1\n${time}\n${createHash('sha1').update(canonical).digest('hex')}\n`;
  const signature = createHmac('sha1', signKey).update(toSign).digest('hex');
  return `q-sign-algorithm=sha1&q-ak=${input.secretId}&q-sign-time=${time}&q-key-time=${time}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
}
/** SDK 1.1.13 uploads to the standard bucket host; never follows an STS-supplied URL. */
export function createReferenceCosProvider(options: {
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  baseUrl?: string;
  validateUrl?: (url: string) => Promise<void>;
}): ReferenceReplicaProvider {
  const call = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 20_000;
  const errorFor = (status: number): ReplicaFailure =>
    status === 404 ? 'not_found' : status === 401 || status === 403 ? 'denied'
      : status >= 400 && status < 500 && status !== 429 ? 'invalid_request' : 'status';
  type Sts = {
    bucket: string;
    region: string;
    prefix: string;
    credentials: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken: string;
      expiration?: string;
    };
  };
  let cached: { value: Sts; until: number } | null = null;
  let pending: Promise<{ ok: true; value: Sts } | { ok: false; error: ReplicaFailure }> | null =
    null;
  async function getSts(): Promise<
    { ok: true; value: Sts } | { ok: false; error: ReplicaFailure }
  > {
    const now = (options.now ?? Date.now)();
    if (cached && now < cached.until) return { ok: true, value: cached.value };
    if (pending) return pending;
    pending = (async () => {
      const signal = AbortSignal.timeout(timeout);
      try {
        const response = await call((options.baseUrl ?? 'https://api.xmax.ai/open/api/v1') + '/cos/sts', {
          headers: { 'X-Api-Key': options.apiKey! },
          signal, redirect: 'error',
        });
        if (!response.ok) return { ok: false as const, error: errorFor(response.status) };
        const payload = await response.json();
        const s = payload?.success === true ? payload.data : null;
        if (
          !s ||
          !/^[a-z0-9-]+-\d+$/.test(s.bucket) ||
          !/^[a-z0-9-]+$/.test(s.region) ||
          typeof s.prefix !== 'string' ||
          !/^[A-Za-z0-9_/-]*$/.test(s.prefix) ||
          s.prefix.includes('..') ||
          !s.credentials ||
          ['accessKeyId', 'secretAccessKey', 'sessionToken'].some(
            (k) => typeof s.credentials[k] !== 'string' || !s.credentials[k],
          )
        )
          return { ok: false as const, error: 'malformed' as const };
        const expiration = Date.parse(s.credentials.expiration ?? '');
        // SDK1.1.13 refreshes 30min STS five minutes early; honor an earlier explicit expiry.
        cached = {
          value: s,
          until: Math.min(
            now + 25 * 60_000,
            Number.isFinite(expiration) ? expiration - 5 * 60_000 : Infinity,
          ),
        };
        return { ok: true as const, value: cached.value };
      } catch {
        return {
          ok: false as const,
          error: signal.aborted ? ('timeout' as const) : ('network' as const),
        };
      }
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }
  return {
    async upload(bytes, sha256, mime = 'image/webp', onStage) {
      if (!options.apiKey?.trim()) return { ok: false, error: 'not_configured' };
      if (
        !/^[a-f0-9]{64}$/.test(sha256) ||
        createHash('sha256').update(bytes).digest('hex') !== sha256
      )
        return { ok: false, error: 'malformed' };
      for (let attempt = 0; attempt < 2; attempt++) {
        onStage?.('credentials');
        const sts = await getSts();
        if (!sts.ok) return sts;
        const s = sts.value;
        const signal = AbortSignal.timeout(timeout);
        try {
          onStage?.('upload');
          const key = `${s.prefix}${s.prefix && !s.prefix.endsWith('/') ? '/' : ''}miror-reference-${sha256}.${mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'}`;
          const host = `${s.bucket}.cos.${s.region}.myqcloud.com`;
          const url = `https://${host}/${key.split('/').map(encode).join('/')}`;
          await options.validateUrl?.(url);
          const authorization = cosPutAuthorization({
            secretId: s.credentials.accessKeyId,
            secretKey: s.credentials.secretAccessKey,
            host,
            key,
            now: (options.now ?? Date.now)(),
          });
          const put = await call(url, {
            method: 'PUT',
            headers: {
              Authorization: authorization,
              'x-cos-security-token': s.credentials.sessionToken,
              'Content-Type': mime,
            },
            body: new Uint8Array(bytes),
            signal,
            redirect: 'error',
          });
          if (put.ok) return { ok: true, url };
          // Only an explicit expired STS token permits one refresh/retry, never generic 403/network.
          const code = /<Code>([^<]+)<\/Code>/.exec((await put.text()).slice(0, 8192))?.[1];
          if (attempt === 0 && (code === 'ExpiredToken' || code === 'TokenExpired')) {
            if (cached?.value === s) cached = null;
            continue;
          }
          return { ok: false, error: errorFor(put.status) };
        } catch (error) {
          if (error instanceof ReferencePreparationError) throw error;
          return { ok: false, error: signal.aborted ? 'timeout' : 'network' };
        }
      }
      return { ok: false, error: 'denied' };
    },
  };
}

/** Preserve the SDK upload + safety-check contract while preparing server-side. */
export function referenceStorage(apiKey: string, region: 'cn' | 'global', call: typeof fetch = fetch, resolveHost: (host: string) => Promise<string[]> = resolveMediaHost, options: { dnsTimeoutMs?: number } = {}): ReferenceStorage {
  const dnsTimeoutMs = options.dnsTimeoutMs ?? 8_000;
  if (!Number.isFinite(dnsTimeoutMs) || dnsTimeoutMs <= 0 || dnsTimeoutMs > 30_000) throw new Error('Invalid reference DNS timeout');
  const baseUrl = region === 'cn' ? 'https://api.xmaxai.com/open/api/v1' : 'https://api.xmax.ai/open/api/v1';
  const provider = createReferenceCosProvider({ apiKey, baseUrl, fetch: call, validateUrl: url => validateAddress(url) });
  const validateAddress = async (url: string) => {
    if (!safeReferenceUrl(url) || url.startsWith('file_')) throw new ReferencePreparationError('availability', 'malformed');
    let addresses: string[];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        Promise.resolve().then(() => resolveHost(new URL(url).hostname)),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new ReferencePreparationError('availability', 'timeout')), dnsTimeoutMs);
          deadline.unref();
        }),
      ]);
    } catch (error) {
      if (error instanceof ReferencePreparationError) throw error;
      throw new ReferencePreparationError('availability', 'network');
    } finally { if (deadline) clearTimeout(deadline); }
    const publicAddress = (address: string) => {
      if (isBenchmarkAddress(address)) return false;
      if (isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127));
      }
      return isIP(address) === 6 && !/^(::|fc|fd|fe[89ab]|ff|2001:db8)/.test(address.toLowerCase());
    };
    if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new ReferencePreparationError('availability', 'unsafe');
  };
  return {
    async upload(bytes, sha256, mime, onStage) {
      let stage: ReferencePreparationStage = 'credentials';
      const report = (next: ReferencePreparationStage) => { stage = next; onStage?.(next); };
      const result = await provider.upload(bytes, sha256, mime, report);
      if (!result.ok) throw new ReferencePreparationError(stage, result.error);
      report('check');
      const signal = AbortSignal.timeout(20_000);
      let response: Response;
      try {
        response = await call(baseUrl + '/cos/image/check', {
          method: 'POST', headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: result.url }), signal, redirect: 'error',
        });
      } catch { throw new ReferencePreparationError('check', signal.aborted ? 'timeout' : 'network'); }
      if (!response.ok) throw new ReferencePreparationError('check', response.status === 401 || response.status === 403 ? 'denied' : response.status >= 400 && response.status < 500 && response.status !== 429 ? 'invalid_request' : 'status');
      let value;
      try { value = await response.json(); } catch { throw new ReferencePreparationError('check', 'malformed'); }
      if (value?.data?.safe === false) throw new ReferencePreparationError('check', 'unsafe');
      if (value?.success !== true || typeof value.data?.url !== 'string' || !safeReferenceUrl(value.data.url)) throw new ReferencePreparationError('check', 'malformed');
      await validateAddress(value.data.url);
      return value.data.url;
    },
  };
}
