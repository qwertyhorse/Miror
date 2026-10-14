import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBenchmarkAddress } from './network.ts';
import { ApiError, type Provider, type SessionRecord, type SessionRequest } from './types.ts';
import type { XmaxRegion } from '../shared/xmax.ts';
import { apiKeyBudgetScope, SecretBox, SessionStore } from './store.ts';
import { MirrorCredentialStore } from './mirrorCredentials.ts';
import { XmaxProvider } from './provider.ts';
import { EXHIBITION_EXPERIENCE_MODES, EXHIBITION_FREE_PROMPT_MAX_LENGTH, exhibitionPromptForLook, type ExhibitionExperienceMode, type ExhibitionReferenceKind, type ExhibitionCredentialsStatus } from '../shared/exhibition.ts';

import { ReferenceAssets, type ReferenceStorage } from './referenceAssets.ts';
import { referenceStorage } from './referenceStorage.ts';
import type { ReferencePreparationStatus } from '../shared/referencePreparation.ts';
import { CONTINUOUS_SEGMENT_CREDITS, DEFAULT_CREDENTIAL_LIMITS, isSessionLimits, type ExhibitionSessionLimits } from '../shared/sessionLimits.ts';

export interface ServiceOptions {
  provider: Provider; store: SessionStore; secrets: SecretBox;
  perSessionLimit?: number; expireSeconds?: number;
  referenceAssets?: ReferenceAssets;
  referenceStorage?: (key: string, region: XmaxRegion) => ReferenceStorage;
  resolveHost?: (host: string) => Promise<string[]>;
  mirrorCredentials?: MirrorCredentialStore;
  providerForApiKey?: (apiKey: string, region?: XmaxRegion) => Provider;
}
export function publicAddress(address: string): boolean {
  if (isBenchmarkAddress(address)) return false;
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped, unspecified, loopback, local, documentation and multicast.
    return !(/^(::|fc|fd|fe[89ab]|ff|2001:db8)/.test(lower));
  }
  return false;
}
function httpsUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError('INVALID_REMOTE_URL', '媒体链接无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash || isIP(url.hostname)) throw new ApiError('INVALID_REMOTE_URL', '仅允许已核验的 HTTPS 媒体链接。');
  return url;
}
function boundedText(value: unknown, name: string, max = 150): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new ApiError('INVALID_INPUT', `${name}无效。`);
  return value.trim();
}
export class TryOnService {
  private readonly referenceProviders = new Map<string, ReferenceStorage>();
  readonly perSessionLimit: number; readonly expireSeconds: number;
  private readonly stoppingSessions = new Map<string, Promise<Omit<SessionRecord, 'tokenCipher' | 'providerKeyCipher'>>>();
  private readonly issuingMirrors = new Map<string, string>();
  private readonly reconcilingMirrors = new Map<string, Promise<void>>();
  private readonly orphanRetryAt = new Map<string, number>();
  constructor(readonly options: ServiceOptions) {
    this.perSessionLimit = options.perSessionLimit === undefined ? DEFAULT_CREDENTIAL_LIMITS.credits : options.perSessionLimit;
    this.expireSeconds = options.expireSeconds === undefined ? DEFAULT_CREDENTIAL_LIMITS.expireSeconds : options.expireSeconds;
    if (this.perSessionLimit === null || !isSessionLimits({ credits: this.perSessionLimit, expireSeconds: this.expireSeconds })) throw new Error('Invalid temporary credential configuration');
  }
  private token(record: SessionRecord): string {
    if (!record.tokenCipher) throw new ApiError('SESSION_NOT_READY', '会话尚未签发临时凭证。', 409);
    return this.options.secrets.decrypt(record.tokenCipher);
  }
  private providerForApiKey(apiKey: string, region: XmaxRegion = 'global'): Provider { return this.options.providerForApiKey?.(apiKey, region) ?? this.options.provider.forCredential?.(apiKey, region) ?? new XmaxProvider(apiKey, undefined, region); }
  private credentialContext(mirrorId?: string): { provider: Provider; scope: string; region: XmaxRegion; key?: string } {
    const override = mirrorId === undefined ? undefined : this.options.mirrorCredentials?.apiKey(mirrorId);
    const config = mirrorId === undefined ? undefined : this.options.mirrorCredentials?.configuration(mirrorId);
    const region = override === undefined ? this.options.provider.region ?? 'global' : config?.region ?? 'global';
    const key = override ?? this.options.provider.credentialSnapshot?.();
    if (key && /^uk-[A-Za-z0-9_-]+$/u.test(key)) return { provider: override === undefined ? this.options.provider : this.providerForApiKey(key, region), scope: apiKeyBudgetScope(key), region, key };
    return { provider: this.options.provider, scope: this.options.store.currentBudgetScope(), region };
  }
  /** Independent browser ownership uses a frozen source credential, never its mutable mirror configuration. */
  forBrowserTest(sourceMirrorId: string): TryOnService {
    const context = this.credentialContext(sourceMirrorId);
    if (!context.key || !/^uk-[A-Za-z0-9_-]+$/u.test(context.key) || !context.provider.configured) {
      throw new ApiError('MISSING_API_KEY', '请先为这台智能镜配置 XMAX 密钥。', 503);
    }
    const key = context.key; const region = context.region;
    // Rebuild even a default provider: its key can be changed in place after this snapshot.
    const frozen = this.providerForApiKey(key, region);
    const provider: Provider = {
      configured: frozen.configured, region, credentialSnapshot: () => key,
      forCredential: (value, nextRegion) => this.providerForApiKey(value, nextRegion),
      issueKey: (credits, seconds) => frozen.issueKey(credits, seconds),
      keyStatus: token => frozen.keyStatus(token),
      deactivate: token => frozen.deactivate(token),
      sessionStatus: (token, sessionUid) => frozen.sessionStatus(token, sessionUid),
    };
    return new TryOnService({ ...this.options, provider, mirrorCredentials: undefined });
  }
  private referenceContext(mirrorId: string) {
    const context = this.credentialContext(mirrorId);
    const scope = createHash('sha256').update(`${context.region}:${context.scope}`).digest('hex');
    return { ...context, scope };
  }
  readyReference(mirrorId: string, bytes: Buffer, mime: string) {
    const context = this.referenceContext(mirrorId);
    return context.provider.configured ? this.options.referenceAssets?.ready({ scope: context.scope, bytes, mime }) ?? null : null;
  }
  referencePreparationStatus(mirrorId: string, sha256: string, mime: string): ReferencePreparationStatus {
    const context = this.referenceContext(mirrorId);
    if (!context.key || !context.provider.configured || !this.options.referenceAssets) return { state: 'unconfigured' };
    return this.options.referenceAssets.status({ scope: context.scope, sha256, mime });
  }
  async prepareReference(mirrorId: string, bytes: Buffer, mime: string) {
    const context = this.referenceContext(mirrorId);
    if (!context.key || !context.provider.configured || !this.options.referenceAssets) return null;
    let provider = this.referenceProviders.get(context.scope);
    if (!provider) {
      provider = this.options.referenceStorage?.(context.key, context.region) ?? referenceStorage(context.key, context.region);
      this.referenceProviders.set(context.scope, provider);
      while (this.referenceProviders.size > 16) this.referenceProviders.delete(this.referenceProviders.keys().next().value!);
    }
    const prepared = await this.options.referenceAssets.prepare({ scope: context.scope, bytes, mime }, provider);
    return this.referenceContext(mirrorId).scope === prepared.scope ? prepared : null;
  }
  private sessionProvider(record: SessionRecord): Provider {
    const region = record.providerRegion ?? 'global';
    if (record.providerKeyCipher) {
      try { return this.providerForApiKey(this.options.secrets.decrypt(record.providerKeyCipher), region); }
      catch { throw new ApiError('SESSION_CREDENTIALS_UNAVAILABLE', '会话原始密钥无法读取，停止状态尚未确认。', 503); }
    }
    // Old records did not retain their signing key. Only use the current default
    // when its persistent scope proves ownership; never try a different UK.
    const context = this.credentialContext();
    if (context.key && this.options.store.sessionBudgetScope(record.id) !== context.scope) throw new ApiError('SESSION_CREDENTIALS_UNAVAILABLE', '会话原始密钥不可用，请保留原始配置后重试。', 503);
    if (context.region !== region) {
      if (!context.key) throw new ApiError('SESSION_CREDENTIALS_UNAVAILABLE', '会话原始区域配置不可用，停止状态尚未确认。', 503);
      return this.providerForApiKey(context.key, region);
    }
    return context.provider;
  }
  public(record: SessionRecord) {
    const { tokenCipher: _secret, providerKeyCipher: _providerSecret, ...safe } = record;
    return safe.exhibition ? { ...safe, exhibition: { ...safe.exhibition, mirrorId: safe.exhibition.mirrorId ?? 'default' } } : safe;
  }
  /** Check immutable session ownership before reading provider state or mutating a session. */
  assertSessionMirror(id: string, mirrorId = 'default', requireExhibition = false): void {
    const record = this.options.store.get(id);
    if ((!record.exhibition && requireExhibition) || (record.exhibition && (record.exhibition.mirrorId ?? 'default') !== mirrorId)) {
      throw new ApiError('EXHIBITION_MIRROR_MISMATCH', '这个会话不属于当前试衣镜。', 409);
    }
  }
  isUnconfirmedExhibitionSession(id: string, mirrorId: string): boolean {
    this.assertSessionMirror(id, mirrorId, true);
    return this.isUnknownIssuance(this.options.store.get(id));
  }
  /** Archive unknown historical issuance without claiming its cloud state is stopped. */
  hasBlockingMirrorSessions(mirrorId: string): boolean {
    if ([...this.issuingMirrors.values()].includes(mirrorId)) return true;
    return this.options.store.unreleasedMirror(mirrorId).some(record => record.status !== 'issuance_unknown'
      || !!record.tokenCipher || !!record.expiresAt || !!record.providerSessionId);
  }
  /** Reconcile detached credentials without touching a mirror's current lease or issuing another key. */
  reconcileMirrorSessions(mirrorId: string, currentSessionId?: string): Promise<void> {
    const existing = this.reconcilingMirrors.get(mirrorId);
    if (existing) return existing;
    const pending = this.reconcileMirrorSessionsNow(mirrorId, currentSessionId).finally(() => {
      if (this.reconcilingMirrors.get(mirrorId) === pending) this.reconcilingMirrors.delete(mirrorId);
    });
    this.reconcilingMirrors.set(mirrorId, pending);
    return pending;
  }
  private async reconcileMirrorSessionsNow(mirrorId: string, currentSessionId?: string): Promise<void> {
    const records = this.options.store.unreleasedMirror(mirrorId);
    for (const id of this.orphanRetryAt.keys()) {
      if (this.options.store.get(id).status === 'stopped') this.orphanRetryAt.delete(id);
    }
    await Promise.all(records.map(async record => {
      if (record.id === currentSessionId || this.issuingMirrors.has(record.id) || !record.tokenCipher
        || (this.orphanRetryAt.get(record.id) ?? 0) > Date.now()) return;
      try {
        // A previous revoke may have succeeded while its response was lost.
        const current = await this.get(record.id);
        if (current.status !== 'stopped' && !this.issuingMirrors.has(record.id)) await this.stop(record.id);
      } catch { /* Keep unconfirmed records blocking until a later provider confirmation. */ }
      finally {
        if (this.options.store.get(record.id).status === 'stopped') this.orphanRetryAt.delete(record.id);
        else this.orphanRetryAt.set(record.id, Date.now() + 5_000);
      }
    }));
  }
  status(mirrorId?: string) {
    const context = this.credentialContext(mirrorId);
    return { configured: context.provider.configured, model: 'x2.0', providerRegion: context.region,
      perSessionLimit: this.perSessionLimit,
      activeSessions: this.options.store.list().filter(s => ['reserved', 'active', 'stopping', 'issuance_unknown'].includes(s.status) && (mirrorId === undefined || (s.exhibition && (s.exhibition.mirrorId ?? 'default') === mirrorId))).map(s => this.public(s)),
    };
  }
  private canChangeMirrorCredentials(mirrorId: string): boolean {
    return this.options.store.list().filter(row => ['reserved', 'active', 'stopping', 'issuance_unknown'].includes(row.status) && row.exhibition && (row.exhibition.mirrorId ?? 'default') === mirrorId).every(row => {
      if (row.status !== 'issuance_unknown' || row.tokenCipher || !row.providerKeyCipher || (row.providerRegion !== undefined && !['cn', 'global'].includes(row.providerRegion))) return false;
      try { return /^uk-[A-Za-z0-9_-]+$/u.test(this.options.secrets.decrypt(row.providerKeyCipher)); }
      catch { return false; }
    });
  }
  mirrorCredentialsStatus(mirrorId: string, editable = true): ExhibitionCredentialsStatus {
    const config = this.options.mirrorCredentials?.configuration(mirrorId) ?? { revision: 0, hasOverride: false, region: 'global' as const };
    const context = this.credentialContext(mirrorId);
    return { configured: context.provider.configured, source: config.hasOverride ? 'mirror' : 'default', revision: config.revision, region: context.region,
      hasUnconfirmedSession: this.options.store.list().some(row => row.exhibition && (row.exhibition.mirrorId ?? 'default') === mirrorId && (row.status === 'issuance_unknown' || this.isUnknownIssuance(row))),
      editable: editable && !!this.options.mirrorCredentials && this.canChangeMirrorCredentials(mirrorId), perSessionLimit: this.perSessionLimit };
  }
  saveMirrorCredentials(mirrorId: string, input: { apiKey?: unknown; expectedRevision?: unknown; region?: unknown }, editable = true): ExhibitionCredentialsStatus {
    if (!this.options.mirrorCredentials) throw new ApiError('SETTINGS_UNAVAILABLE', '当前服务暂不支持镜端密钥设置。', 503);
    if (!editable || !this.canChangeMirrorCredentials(mirrorId)) throw new ApiError('EXHIBITION_MIRROR_BUSY', '请先结束此镜的体验并等待会话停止，再更换密钥。', 409);
    this.options.mirrorCredentials.save(mirrorId, input.apiKey, input.expectedRevision, input.region);
    return this.mirrorCredentialsStatus(mirrorId);
  }
  /** Mirror-only session issuance; supplier quota is authoritative. */
  async createExhibition(input: { mirrorId?: string; lookId: string; deviceId: string; name: string; referenceAsset: string; referenceKind?: ExhibitionReferenceKind; mode?: ExhibitionExperienceMode; prompt?: string; sessionNumber: number; generationNumber: number; sessionLimits?: ExhibitionSessionLimits }, hooks?: { onReserved?: (id: string) => void; cancelled?: () => boolean }) {
    const lookId = boundedText(input.lookId, '展会服装 ID');
    const deviceId = boundedText(input.deviceId, '设备 ID');
    const mirrorId = input.mirrorId ?? 'default';
    const mode = input.mode ?? 'clothx';
    if (!EXHIBITION_EXPERIENCE_MODES.includes(mode)) throw new ApiError('EXHIBITION_INVALID_MODE', '请选择有效的体验模式。');
    const noReference = input.referenceKind === 'none';
    if ((input.referenceKind !== undefined && input.referenceKind !== 'image' && !noReference) || (noReference && (mode !== 'free' || input.referenceAsset !== ''))) throw new ApiError('EXHIBITION_INVALID_REFERENCE', '仅 Free 模式可以不使用参考图，封面图不能作为参考图发送。');
    if (mode === 'free' && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > EXHIBITION_FREE_PROMPT_MAX_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt))) throw new ApiError('EXHIBITION_INVALID_PROMPT', 'Free 模式需要有效的提示词。');
    const prompt = exhibitionPromptForLook({ mode, prompt: input.prompt });
    if (typeof mirrorId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(mirrorId)) throw new ApiError('EXHIBITION_INVALID_MIRROR', '试衣镜编号无效。');
    const sample = ['commute', 'city', 'evening'].includes(lookId) && input.referenceAsset === `/assets/exhibition/${lookId}-cutout.png`;
    const uploaded = /^\/api\/exhibition\/(?:mirrors\/([a-z0-9-]+)\/)?assets\/((?:upload-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})|commute|city|evening)(?:\/(display|reference)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/.exec(input.referenceAsset);
    if (!noReference && !sample && (!uploaded || (uploaded[1] ?? 'default') !== mirrorId || uploaded[2] !== lookId || (!uploaded[2].startsWith('upload-') && !uploaded[3]))) throw new ApiError('EXHIBITION_INVALID_REFERENCE', '展会参考图必须来自当前试衣镜的服装库。');
    if (!Number.isSafeInteger(input.sessionNumber) || input.sessionNumber < 1 || !Number.isSafeInteger(input.generationNumber) || input.generationNumber < 1) throw new ApiError('EXHIBITION_INVALID_SESSION', '请先开始一轮展会体验。');
    return this.reserveSession({ targetItemId: lookId, sourceId: `exhibition:${deviceId}`, sourceKind: mode === 'mox' ? 'photo' : 'camera', sourceName: boundedText(input.name, '展会服装名称') }, '', input.referenceAsset, hooks,
      { exhibition: { mirrorId, lookId, deviceId, mode, prompt, sessionNumber: input.sessionNumber, generationNumber: input.generationNumber, ...(input.sessionLimits?.credits === null ? { continuous: true } : {}) } }, input.sessionLimits);
  }
  private async reserveSession(request: SessionRequest, reference: string, referenceAsset: string | undefined,
    hooks?: { onReserved?: (id: string) => void; cancelled?: () => boolean }, extra: Pick<SessionRecord, 'exhibition'> = {}, sessionLimits?: ExhibitionSessionLimits) {
    const limits = sessionLimits === undefined ? { credits: this.perSessionLimit, expireSeconds: this.expireSeconds } : { ...sessionLimits };
    if (!isSessionLimits(limits)) throw new ApiError('EXHIBITION_INVALID_SETTINGS', '请设置有效的单轮积分上限与凭证有效期。');
    const credits = limits.credits ?? CONTINUOUS_SEGMENT_CREDITS;
    const context = this.credentialContext(extra.exhibition ? extra.exhibition.mirrorId ?? 'default' : undefined);
    if (!context.provider.configured) throw new ApiError('MISSING_API_KEY', '尚未配置 XMax 服务端凭证。', 503);
    const now = new Date().toISOString();
    const record: SessionRecord = { ...request, ...extra, id: randomUUID(), status: 'reserved', pointsLimit: credits,
      refImageUrl: reference, referenceAsset, referenceVersion: 0, consumedCredits: 0, resultAvailable: false, verification: 'none', createdAt: now, updatedAt: now,
      referenceScope: createHash('sha256').update(`${context.region}:${context.scope}`).digest('hex'),
      providerRegion: context.region, ...(context.key ? { providerKeyCipher: this.options.secrets.encrypt(context.key) } : {}) };
    // Keep ambiguous issuance records for cancellation and revocation. No local cumulative budget.
    if (extra.exhibition) this.issuingMirrors.set(record.id, extra.exhibition.mirrorId ?? 'default');
    try {
      this.options.store.reserve(record, undefined, context.scope); hooks?.onReserved?.(record.id);
      try {
        if (hooks?.cancelled?.() || this.options.store.get(record.id).status === 'stopping') { this.options.store.update(record.id, { status: 'stopped' }); throw new ApiError('SESSION_CANCELLED', '试穿已取消。', 409); }
        const issued = await context.provider.issueKey(credits, limits.expireSeconds);
        this.options.store.update(record.id, { tokenCipher: this.options.secrets.encrypt(issued.token), expiresAt: issued.expiresAt });
        if (hooks?.cancelled?.() || this.options.store.get(record.id).status === 'stopping') {
          await this.stop(record.id);
          // A stop requested before issuance can still be settling without a token.
          // Once it settles, retry with the late token and require confirmation.
          if (this.options.store.get(record.id).status !== 'stopped') await this.stop(record.id);
          if (this.options.store.get(record.id).status !== 'stopped') throw new ApiError('STOP_NOT_CONFIRMED', '临时凭证停止尚未确认，请重试停止。', 502);
          throw new ApiError('SESSION_CANCELLED', '试穿已取消，临时凭证已停止。', 409);
        }
        const active = this.options.store.update(record.id, { status: 'active' });
        return { ...this.public(active), token: issued.token, model: 'x2.0' };
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'PROVIDER_UNKNOWN_ERROR';
        const current = this.options.store.get(record.id);
        if (code !== 'SESSION_CANCELLED' && current.status !== 'stopped') this.options.store.update(record.id, { status: current.tokenCipher ? 'stopping' : 'issuance_unknown', errorCode: code });
        this.options.store.error(record.id, code);
        throw error instanceof ApiError ? error : new ApiError(code, 'XMax 会话签发状态未确认，请联系工作人员。', 502);
      }
    } finally { this.issuingMirrors.delete(record.id); }
  }
  async get(id: string, sync = true) {
    let record = this.options.store.get(id);
    if (sync && record.tokenCipher) {
      try {
        const provider = this.sessionProvider(record);
        if (!provider.configured) return this.public(record);
        const current = await provider.keyStatus(this.token(record));
        const latest = this.options.store.get(id);
        const stopped = current.status !== 'active';
        record = this.options.store.update(id, { consumedCredits: Math.max(latest.consumedCredits, current.consumedCredit), expiresAt: current.expireTimestamp,
          status: stopped ? 'stopped' : latest.status, errorCode: stopped || latest.status === 'active' ? undefined : latest.errorCode });
      } catch (error) { this.options.store.error(id, error instanceof ApiError ? error.code : 'USAGE_SYNC_FAILED'); }
    }
    return this.public(this.options.store.get(id));
  }
  async link(id: string, providerSessionId: string) {
    const record = this.options.store.get(id); const uid = boundedText(providerSessionId, '供应商会话 ID');
    if (record.exhibition && record.status !== 'active') throw new ApiError('SESSION_INACTIVE', '展会会话已停止，不能关联供应商会话。', 409);
    const promptOnlyExhibition = record.exhibition?.mode === 'free' && record.referenceAsset === '' && record.refImageUrl === '';
    if (!record.refImageUrl && !promptOnlyExhibition) throw new ApiError('REFERENCE_NOT_READY', '请先上传并绑定服装参考图。', 409);
    if (!/^ums-[A-Za-z0-9_-]+$/.test(uid)) throw new ApiError('INVALID_PROVIDER_SESSION', '供应商会话 ID 格式无效。');
    if (record.providerSessionId && record.providerSessionId !== uid) throw new ApiError('SESSION_LINK_IMMUTABLE', '同一会话不可更换供应商会话 ID。', 409);
    if (this.options.store.list().some(s => s.id !== id && s.providerSessionId === uid)) throw new ApiError('SESSION_ALREADY_LINKED', '供应商会话已关联其他本地记录。', 409);
    const info = await this.sessionProvider(record).sessionStatus(this.token(record), uid);
    // Re-check after await; another request may have stopped the exhibition or won the same link.
    const latest = this.options.store.get(id);
    if (record.exhibition && latest.status !== 'active') throw new ApiError('SESSION_INACTIVE', '展会会话已停止，不能关联供应商会话。', 409);
    if (this.options.store.list().some(s => s.id !== id && s.providerSessionId === uid)) throw new ApiError('SESSION_ALREADY_LINKED', '供应商会话已关联其他本地记录。', 409);
    const updated = this.options.store.update(id, { providerSessionId: uid, consumedCredits: Math.max(latest.consumedCredits, info.consumedCredit) });
    return this.public(updated);
  }
  async firstFrame(id: string, firstFrameMs: number) {
    const record = this.options.store.get(id);
    if (record.exhibition && record.status !== 'active') throw new ApiError('SESSION_INACTIVE', '展会会话已停止，不能报告首帧。', 409);
    if (!record.providerSessionId) throw new ApiError('SESSION_NOT_LINKED', '请先关联供应商会话。', 409);
    if (typeof firstFrameMs !== 'number' || !Number.isFinite(firstFrameMs) || firstFrameMs < 0 || firstFrameMs > 120_000) throw new ApiError('INVALID_INPUT', '首帧耗时无效。');
    return this.public(this.options.store.update(id, { firstFrameMs: record.firstFrameMs ?? firstFrameMs }));
  }
  stop(id: string): Promise<Omit<SessionRecord, 'tokenCipher' | 'providerKeyCipher'>> {
    const existing = this.stoppingSessions.get(id);
    if (existing) return existing;
    const pending = this.stopNow(id).finally(() => { if (this.stoppingSessions.get(id) === pending) this.stoppingSessions.delete(id); });
    this.stoppingSessions.set(id, pending);
    return pending;
  }
  /** Close the local session immediately; provider revocation is reconciled next. */
  cancelExhibitionSession(id: string, mirrorId: string): void {
    this.assertSessionMirror(id, mirrorId, true);
    const record = this.options.store.get(id);
    if (this.isUnknownIssuance(record)) {
      if (record.status !== 'issuance_unknown') this.options.store.update(id, { status: 'issuance_unknown' });
      return;
    }
    if (!['stopped', 'stopping'].includes(record.status)) this.options.store.update(id, { status: 'stopping' });
  }
  private isUnknownIssuance(record: SessionRecord): boolean {
    return !record.tokenCipher && (record.status === 'issuance_unknown' || (record.status === 'stopping' && !!record.errorCode));
  }
  private async stopNow(id: string) {
    const record = this.options.store.get(id);
    if (record.status === 'stopped') return this.public(record);
    if (this.isUnknownIssuance(record)) {
      return this.public(record.status === 'issuance_unknown' ? record : this.options.store.update(id, { status: 'issuance_unknown' }));
    }
    this.options.store.update(id, { status: 'stopping' });
    if (!record.tokenCipher) return this.public(this.options.store.get(id));
    try {
      const info = await this.sessionProvider(record).deactivate(this.token(record));
      if (info.status === 'active') throw new ApiError('REVOCATION_NOT_CONFIRMED', 'XMax 未确认临时凭证停止。', 502);
      const latest = this.options.store.get(id);
      return this.public(this.options.store.update(id, { status: 'stopped', consumedCredits: Math.max(latest.consumedCredits, info.consumedCredit), expiresAt: info.expireTimestamp, errorCode: undefined }));
    } catch (error) {
      // A failed PUT is ambiguous: its effect may already be visible to GET.
      // Only the provider's inactive/timeout response can confirm release.
      const verified = await this.get(id);
      if (verified.status === 'stopped') return verified;
      const latest = this.options.store.get(id);
      if (latest.status === 'stopped') return this.public(latest);
      const code = error instanceof ApiError ? error.code : 'REVOCATION_FAILED';
      this.options.store.update(id, { status: 'stopping', errorCode: code }); this.options.store.error(id, code);
      throw new ApiError('STOP_NOT_CONFIRMED', '临时凭证停止尚未确认，请重试停止。', 502);
    }
  }
  async bindExhibitionReference(id: string, input: { mirrorId?: string; deviceId: string; lookId: string; refImageUrl: string }) {
    this.assertSessionMirror(id, input.mirrorId ?? 'default', true);
    const record = this.options.store.get(id);
    if (!record.exhibition || record.exhibition.deviceId !== input.deviceId || record.exhibition.lookId !== input.lookId) throw new ApiError('EXHIBITION_OWNER_MISMATCH', '当前设备或服装与会话不匹配。', 409);
    if (record.exhibition.mode === 'free' && record.referenceAsset === '') throw new ApiError('EXHIBITION_REFERENCE_NOT_REQUIRED', '此 Free 素材仅使用提示词，不能绑定封面或参考图。', 409);
    if (record.status !== 'active' || record.providerSessionId || record.refImageUrl) throw new ApiError('EXHIBITION_REFERENCE_LOCKED', '展会参考图已锁定或会话已结束。', 409);
    const refImageUrl = boundedText(input.refImageUrl, '参考图链接', 4096); const url = httpsUrl(refImageUrl);
    const addresses = await (this.options.resolveHost ? this.options.resolveHost(url.hostname) : lookup(url.hostname, { all: true }).then(rows => rows.map(row => row.address)));
    if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new ApiError('REFERENCE_ADDRESS_BLOCKED', '参考图必须是 SDK 上传后可访问的云端链接。');
    const latest = this.options.store.get(id);
    if (latest.status !== 'active' || latest.refImageUrl || latest.providerSessionId) throw new ApiError('EXHIBITION_REFERENCE_LOCKED', '会话已停止或参考已锁定。', 409);
    return this.public(this.options.store.update(id, { refImageUrl, referenceVersion: 1 }));
  }
  async recover() {
    for (const record of this.options.store.list()) {
      if (['reserved', 'stopping'].includes(record.status) && !record.tokenCipher) this.options.store.update(record.id, { status: 'issuance_unknown', errorCode: record.errorCode ?? 'RESTART_DURING_ISSUANCE' });
      if (record.tokenCipher && ['active', 'stopping', 'reserved'].includes(record.status)) {
        try { await this.stop(record.id); } catch { /* persisted stopping state; never claim revocation succeeded */ }
      }
    }
  }
  canUpdateExhibitionCondition(id: string, mirrorId: string): boolean {
    let record: SessionRecord;
    try { record = this.options.store.get(id); } catch { return false; }
    return !!record.exhibition && (record.exhibition.mirrorId ?? 'default') === mirrorId && record.status === 'active' && !!record.providerSessionId && record.sourceKind === 'camera' && record.exhibition.mode !== 'mox';
  }
  /** Change conditions within an existing camera lease; credential and RTC ownership stay fixed. */
  async updateExhibitionCondition(id: string, input: { mirrorId?: string; deviceId: string; lookId: string; sessionNumber: number; generationNumber: number; referenceAsset: string; referenceKind?: ExhibitionReferenceKind; mode?: ExhibitionExperienceMode; prompt?: string; refImageUrl?: string }, isCurrent: () => boolean) {
    const mirrorId = input.mirrorId ?? 'default';
    if (typeof mirrorId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(mirrorId)) throw new ApiError('EXHIBITION_INVALID_MIRROR', '试衣镜编号无效。');
    this.assertSessionMirror(id, mirrorId, true);
    const record = this.options.store.get(id);
    const lookId = boundedText(input.lookId, '展会服装 ID');
    const deviceId = boundedText(input.deviceId, '设备 ID');
    const mode = input.mode ?? 'clothx';
    if (!EXHIBITION_EXPERIENCE_MODES.includes(mode)) throw new ApiError('EXHIBITION_INVALID_MODE', '请选择有效的体验模式。');
    if (!Number.isSafeInteger(input.sessionNumber) || input.sessionNumber < 1 || !Number.isSafeInteger(input.generationNumber) || input.generationNumber < 1) throw new ApiError('EXHIBITION_INVALID_SESSION', '请先开始一轮展会体验。');
    if (!record.exhibition || record.exhibition.deviceId !== deviceId || record.exhibition.sessionNumber !== input.sessionNumber) throw new ApiError('EXHIBITION_OWNER_MISMATCH', '当前设备或体验轮次与会话不匹配。', 409);
    if (record.status !== 'active') throw new ApiError('SESSION_INACTIVE', '展会会话已停止，不能更换素材。', 409);
    if (!record.providerSessionId) throw new ApiError('SESSION_NOT_LINKED', '请先关联供应商会话。', 409);
    if (record.sourceKind !== 'camera' || mode === 'mox' || (record.exhibition.mode ?? 'clothx') !== mode) throw new ApiError('EXHIBITION_SESSION_INCOMPATIBLE', '当前会话不能直接切换此体验模式。', 409);
    const noReference = input.referenceKind === 'none';
    if ((input.referenceKind !== undefined && input.referenceKind !== 'image' && !noReference) || (noReference && (mode !== 'free' || input.referenceAsset !== '' || (input.refImageUrl !== undefined && input.refImageUrl !== '')))) throw new ApiError('EXHIBITION_INVALID_REFERENCE', '仅 Free 模式可以不使用参考图，封面图不能作为参考图发送。');
    if (mode === 'free' && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > EXHIBITION_FREE_PROMPT_MAX_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt))) throw new ApiError('EXHIBITION_INVALID_PROMPT', 'Free 模式需要有效的提示词。');
    const prompt = exhibitionPromptForLook({ mode, prompt: input.prompt });
    const sample = ['commute', 'city', 'evening'].includes(lookId) && input.referenceAsset === `/assets/exhibition/${lookId}-cutout.png`;
    const uploaded = /^\/api\/exhibition\/(?:mirrors\/([a-z0-9-]+)\/)?assets\/((?:upload-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})|commute|city|evening)(?:\/(display|reference)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/.exec(input.referenceAsset);
    if (!noReference && !sample && (!uploaded || (uploaded[1] ?? 'default') !== mirrorId || uploaded[2] !== lookId || (!uploaded[2].startsWith('upload-') && !uploaded[3]))) throw new ApiError('EXHIBITION_INVALID_REFERENCE', '展会参考图必须来自当前试衣镜的服装库。');
    const refImageUrl = noReference ? '' : boundedText(input.refImageUrl, '参考图链接', 4096);
    const sameCondition = (current: SessionRecord) => current.sourceKind === 'camera' && current.providerSessionId === record.providerSessionId && current.exhibition?.deviceId === deviceId && current.exhibition.sessionNumber === input.sessionNumber && (current.exhibition.mirrorId ?? 'default') === mirrorId && (current.exhibition.mode ?? 'clothx') === mode && current.exhibition.lookId === lookId && current.exhibition.generationNumber === input.generationNumber && current.exhibition.prompt === prompt && current.referenceAsset === input.referenceAsset && current.refImageUrl === refImageUrl;
    const stale = () => new ApiError('EXHIBITION_STALE_GENERATION', '素材选择已更新，请使用当前素材。', 409);
    if (!isCurrent() || input.generationNumber < record.exhibition.generationNumber || (input.generationNumber === record.exhibition.generationNumber && !sameCondition(record))) throw stale();
    if (input.generationNumber === record.exhibition.generationNumber) return this.public(record);
    if (!noReference) {
      const url = httpsUrl(refImageUrl);
      const addresses = await (this.options.resolveHost ? this.options.resolveHost(url.hostname) : lookup(url.hostname, { all: true }).then(rows => rows.map(row => row.address)));
      if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new ApiError('REFERENCE_ADDRESS_BLOCKED', '参考图必须是 SDK 上传后可访问的云端链接。');
    }
    // DNS validation yields. A stop, another material change or a newer selection must win.
    const latest = this.options.store.get(id);
    if (latest.status !== 'active') throw new ApiError('SESSION_INACTIVE', '展会会话已停止，不能更换素材。', 409);
    if (!isCurrent()) throw stale();
    if (latest.sourceKind !== record.sourceKind || latest.referenceVersion !== record.referenceVersion || latest.refImageUrl !== record.refImageUrl || latest.referenceAsset !== record.referenceAsset || latest.providerSessionId !== record.providerSessionId || JSON.stringify(latest.exhibition) !== JSON.stringify(record.exhibition)) {
      if (sameCondition(latest)) return this.public(latest);
      throw stale();
    }
    return this.public(this.options.store.update(id, {
      targetItemId: lookId, referenceAsset: input.referenceAsset, refImageUrl, referenceVersion: record.referenceVersion + 1,
      exhibition: { ...record.exhibition, lookId, mode, prompt, generationNumber: input.generationNumber },
      resultUrl: undefined, resultAvailable: false, verification: 'none', errorCode: undefined,
    }));
  }

}
