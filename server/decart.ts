import { ApiError, type Provider, type IssuedKey, type KeyStatus, type ProviderSessionStatus } from './types.ts';
import { DECART_MODEL, isDecartReference } from '../shared/providers.ts';
import type { ReferenceStorage } from './referenceAssets.ts';

/** No fictional revoke/status endpoint: Decart grants dial access and a bounded session. */
export class DecartProvider implements Provider {
  readonly kind = 'decart' as const;
  credentialSnapshot() { return this.key; }
  forCredential(key: string) { return new DecartProvider(key, this.fetcher); }
  async issueKey(_credits: number, _seconds: number): Promise<IssuedKey> { throw new ApiError('UNSUPPORTED_PROVIDER_OPERATION', '请使用 Decart 连接授权。', 409); }
  async keyStatus(_token: string): Promise<KeyStatus> { throw new ApiError('UNSUPPORTED_PROVIDER_OPERATION', 'Decart 不提供凭证停止查询。', 409); }
  async deactivate(_token: string): Promise<KeyStatus> { throw new ApiError('UNSUPPORTED_PROVIDER_OPERATION', 'Decart 不支持撤销短期凭证。', 409); }
  async sessionStatus(_token: string, _id: string): Promise<ProviderSessionStatus> { throw new ApiError('UNSUPPORTED_PROVIDER_OPERATION', 'Decart 会话状态由连接事件报告。', 409); }
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}
  get configured() { return /^dct_[A-Za-z0-9_-]+$/.test(this.key); }
  private async request(path: string, body?: BodyInit): Promise<Record<string, unknown>> {
    if (!this.configured) throw new ApiError('MISSING_API_KEY', '请配置 Decart 密钥。', 503);
    let response: Response;
    try { response = await this.fetcher(`https://api.decart.ai/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'x-api-key': this.key, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
      body, redirect: 'error', signal: AbortSignal.timeout(15_000),
    }); } catch { throw new ApiError('PROVIDER_NETWORK_ERROR', 'Decart 请求超时或网络不可用。', 502); }
    if (!response.ok) throw new ApiError(response.status === 429 ? 'PROVIDER_CAPACITY' : response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REQUEST_REJECTED', response.status === 429 ? 'Decart 暂无可用容量，请稍后重试。' : 'Decart 拒绝请求，请检查密钥与服务状态。', response.status === 429 ? 429 : 502);
    let data: unknown; try { data = await response.json(); } catch { /* fail closed */ }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('PROVIDER_INVALID_RESPONSE', 'Decart 返回格式无效。', 502);
    return data as Record<string, unknown>;
  }
  async issue(maxSessionDuration: number, origin?: string) {
    const data = await this.request('client/tokens', JSON.stringify({ expiresIn: 30, allowedModels: [DECART_MODEL], ...(origin ? { allowedOrigins: [origin] } : {}), constraints: { realtime: { maxSessionDuration } } }));
    if (typeof data.apiKey !== 'string' || !data.apiKey || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))) throw new ApiError('PROVIDER_INVALID_RESPONSE', 'Decart 未返回有效短期凭证。', 502);
    const constraints = data.constraints as { realtime?: { maxSessionDuration?: unknown } } | undefined;
    if (constraints?.realtime?.maxSessionDuration !== maxSessionDuration) throw new ApiError('PROVIDER_INVALID_RESPONSE', 'Decart 未确认连接时长限制。', 502);
    return { token: data.apiKey, dialExpiresAt: data.expiresAt };
  }
  async verify() { await this.request('realtime/quota'); }
  references(): ReferenceStorage {
    return {
      upload: async (bytes, _hash, mime) => {
        const form = new FormData(); form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'reference'); form.set('ttl_seconds', 'persistent');
        const data = await this.request('files', form);
        if (typeof data.id !== 'string' || !isDecartReference(data.id)) throw new ApiError('PROVIDER_INVALID_RESPONSE', 'Decart 未返回有效素材引用。', 502);
        // Only explicit null confirms persistence; never treat missing expiry metadata as permanent.
        const rawExpiry = 'expires_at' in data ? data.expires_at : data.expiresAt;
        const expiresAt = rawExpiry === null ? undefined : typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : NaN;
        if (expiresAt !== undefined && !Number.isFinite(expiresAt)) throw new ApiError('PROVIDER_INVALID_RESPONSE', 'Decart 素材到期信息无效。', 502);
        return { url: data.id, ...(expiresAt !== undefined ? { providerExpiresAt: expiresAt } : {}) };
      },
    };
  }
}
