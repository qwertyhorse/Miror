import { ApiError, type IssuedKey, type KeyStatus, type Provider, type ProviderSessionStatus } from './types.ts';
import type { XmaxRegion } from '../shared/xmax.ts';

const BASE: Record<XmaxRegion, string> = {
  cn: 'https://api.xmaxai.com/open/api/v1',
  global: 'https://api.xmax.ai/open/api/v1',
};
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('PROVIDER_INVALID_RESPONSE', 'XMax 返回格式不符合已核对的接口。', 502);
  return value as JsonObject;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ApiError('PROVIDER_INVALID_RESPONSE', 'XMax 返回的用量无效。', 502);
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ApiError('PROVIDER_INVALID_RESPONSE', 'XMax 返回的凭证有效期无效。', 502);
  return value;
}

/** Only the documented XMax Open API; no guessed fallback models or endpoints. */
export class XmaxProvider implements Provider {
  constructor(private apiKey: string, private readonly fetcher: typeof fetch = fetch, readonly region: XmaxRegion = 'global') {
    if (region !== 'cn' && region !== 'global') throw new ApiError('INVALID_PROVIDER_REGION', 'XMAX 服务区域无效。');
  }
  get configured(): boolean { return /^uk-[A-Za-z0-9_-]+$/.test(this.apiKey); }
  credentialSnapshot(): string { return this.apiKey; }
  forCredential(apiKey: string, region: XmaxRegion = this.region): XmaxProvider { return new XmaxProvider(apiKey, this.fetcher, region); }
  setApiKey(apiKey: string): void { this.apiKey = apiKey; }
  private async request(path: string, method: string, credential: string, body?: JsonObject): Promise<JsonObject> {
    if (!this.configured) throw new ApiError('MISSING_API_KEY', '尚未配置 XMax 服务端凭证。', 503);
    let response: Response;
    try {
      response = await this.fetcher(`${BASE[this.region]}${path}`, {
        method, headers: { 'X-Api-Key': credential, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12_000), redirect: 'error',
      });
    } catch {
      // Never attach the request URL: temporary credentials are path parameters.
      throw new ApiError('PROVIDER_NETWORK_ERROR', 'XMax 请求超时或网络不可用。', 502);
    }
    let envelope: JsonObject;
    try { envelope = object(await response.json()); } catch { throw new ApiError('PROVIDER_INVALID_RESPONSE', 'XMax 未返回有效 JSON。', 502); }
    if (!response.ok || envelope.success !== true) {
      const businessCode = typeof envelope.code === 'number' ? envelope.code : 0;
      const quota = businessCode === 46019;
      throw new ApiError(quota ? 'PROVIDER_QUOTA_EXHAUSTED' : 'PROVIDER_REQUEST_REJECTED', quota ? 'XMax 临时凭证额度已用完。' : 'XMax 拒绝了请求，请核对凭证与服务状态。', quota ? 429 : 502);
    }
    return object(envelope.data);
  }
  async issueKey(pointsLimit: number, expireSeconds: number): Promise<IssuedKey> {
    const data = await this.request('/temporary-api-key', 'POST', this.apiKey, { pointsLimit, expireSeconds });
    if (typeof data.temporaryApiKey !== 'string' || !/^tk-[A-Za-z0-9_-]+$/.test(data.temporaryApiKey)) throw new ApiError('PROVIDER_INVALID_RESPONSE', 'XMax 未返回有效临时凭证。', 502);
    return { token: data.temporaryApiKey, expiresAt: date(data.expireTimestamp) };
  }
  private parseKey(data: JsonObject): KeyStatus {
    if (!['active', 'inactive', 'timeout'].includes(String(data.status))) throw new ApiError('PROVIDER_INVALID_RESPONSE', 'XMax 返回的临时凭证状态无效。', 502);
    return { status: data.status as KeyStatus['status'], consumedCredit: number(data.consumedCredit), expireTimestamp: date(data.expireTimestamp) };
  }
  async keyStatus(token: string): Promise<KeyStatus> {
    return this.parseKey(await this.request(`/temporary-api-key/${encodeURIComponent(token)}/status`, 'GET', this.apiKey));
  }
  async deactivate(token: string): Promise<KeyStatus> {
    return this.parseKey(await this.request(`/temporary-api-key/${encodeURIComponent(token)}/inactive`, 'PUT', this.apiKey));
  }
  async sessionStatus(token: string, sessionUid: string): Promise<ProviderSessionStatus> {
    // Own issued tk is used, never an uk fallback. Public docs guarantee user ownership,
    // not cryptographic per-key result provenance; callers keep the SDK-reported label.
    const data = await this.request(`/session/${encodeURIComponent(sessionUid)}/status`, 'GET', token);
    if (data.sessionUid !== sessionUid || typeof data.status !== 'string') throw new ApiError('PROVIDER_SESSION_MISMATCH', 'XMax 会话信息不匹配。', 502);
    return { sessionUid, status: data.status, consumedCredit: number(data.consumedCredit) };
  }
}
