import { isRealtimeProvider, type RealtimeProvider, type ProviderSettings } from '../shared/providers.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecretBox } from './store.ts';
import { ApiError } from './types.ts';
import type { XmaxRegion } from '../shared/xmax.ts';

interface CredentialEntry { revision: number; keyCipher: string; region?: XmaxRegion }
interface StoredCredentials { schemaVersion: 1 | 2; mirrors: Record<string, CredentialEntry>; providers?: Record<string, { revision: number; active: RealtimeProvider; desired: RealtimeProvider; decartKeyCipher?: string; applyAfterStop?: boolean }> }
const validMirror = (id: string) => /^[a-z0-9][a-z0-9-]{0,63}$/u.test(id);
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && /^uk-[A-Za-z0-9_-]+$/u.test(value);
const validRegion = (value: unknown): value is XmaxRegion => value === 'cn' || value === 'global';

/** Private credential storage deliberately lives outside mirror material/copy directories. */
export class MirrorCredentialStore {
  private readonly filename: string;
  private stored: StoredCredentials = { schemaVersion: 1, mirrors: {} };
  constructor(dataDirectory: string, private readonly secrets: SecretBox) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.filename = join(dataDirectory, 'exhibition-credentials.json');
    try {
      const value = JSON.parse(readFileSync(this.filename, 'utf8')) as StoredCredentials;
      if (![1, 2].includes(value?.schemaVersion) || !value.mirrors || typeof value.mirrors !== 'object' || Array.isArray(value.mirrors)) throw new Error('Invalid credential data');
      for (const [id, entry] of Object.entries(value.mirrors)) {
        if (!validMirror(id) || !entry || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || typeof entry.keyCipher !== 'string' || !validKey(secrets.decrypt(entry.keyCipher)) || (entry.region !== undefined && !validRegion(entry.region))) throw new Error('Invalid credential data');
      }
      for (const [id, entry] of Object.entries(value.providers ?? {})) {
        if (!validMirror(id) || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !isRealtimeProvider(entry.active) || !isRealtimeProvider(entry.desired)
          || (entry.applyAfterStop !== undefined && typeof entry.applyAfterStop !== 'boolean')
          || (entry.decartKeyCipher !== undefined && !/^dct_[A-Za-z0-9_-]+$/.test(secrets.decrypt(entry.decartKeyCipher)))) throw new Error('Invalid provider configuration');
      }
      this.stored = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ApiError('EXHIBITION_CREDENTIALS_UNAVAILABLE', '镜端密钥配置无法读取，请检查本地存储。', 503);
    }
  }
  configuration(mirrorId: string): { revision: number; hasOverride: boolean; region: XmaxRegion } {
    if (!validMirror(mirrorId)) throw new ApiError('EXHIBITION_INVALID_MIRROR', '试衣镜编号无效。');
    const entry = Object.hasOwn(this.stored.mirrors, mirrorId) ? this.stored.mirrors[mirrorId] : undefined;
    return { revision: entry?.revision ?? 0, hasOverride: !!entry, region: entry?.region ?? 'global' };
  }
  apiKey(mirrorId: string): string | undefined {
    if (!this.configuration(mirrorId).hasOverride) return undefined;
    try { return this.secrets.decrypt(this.stored.mirrors[mirrorId].keyCipher); }
    catch { throw new ApiError('EXHIBITION_CREDENTIALS_UNAVAILABLE', '镜端密钥配置无法读取，请检查本地存储。', 503); }
  }
  providerSettings(mirrorId: string, defaultConfigured = false): ProviderSettings {
    this.configuration(mirrorId);
    const entry = this.stored.providers?.[mirrorId];
    return { revision: entry?.revision ?? 0, active: entry?.active ?? 'xmax', desired: entry?.desired ?? 'xmax', pending: entry?.active !== entry?.desired, applyAfterStop: entry?.applyAfterStop ?? false,
      accounts: { xmax: { configured: this.configuration(mirrorId).hasOverride || defaultConfigured }, decart: { configured: !!entry?.decartKeyCipher } } };
  }
  decartKey(mirrorId: string): string | undefined {
    this.configuration(mirrorId); const cipher = this.stored.providers?.[mirrorId]?.decartKeyCipher;
    return cipher ? this.secrets.decrypt(cipher) : undefined;
  }
  saveProvider(mirrorId: string, input: { provider?: unknown; apiKey?: unknown; expectedRevision?: unknown }, apply: boolean, defaultConfigured = false) {
    const current = this.providerSettings(mirrorId, defaultConfigured);
    if (input.expectedRevision !== current.revision) throw new ApiError('EXHIBITION_STALE_CREDENTIALS', '配置已变化，请刷新后重试。', 409);
    if (!isRealtimeProvider(input.provider)) throw new ApiError('INVALID_PROVIDER', '请选择有效的换装服务。');
    const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined;
    if (input.apiKey !== undefined && (!key || key.length > 512 || input.provider !== 'decart' || !/^dct_[A-Za-z0-9_-]+$/.test(key))) throw new ApiError('INVALID_API_KEY', '请输入有效的 Decart 密钥。');
    if (!key && !current.accounts[input.provider].configured) throw new ApiError('MISSING_API_KEY', '请先配置所选服务的密钥。');
    const next = structuredClone(this.stored); next.schemaVersion = 2; next.providers ??= {};
    next.providers[mirrorId] = { ...next.providers[mirrorId], revision: current.revision + 1, active: apply ? input.provider : current.active, desired: input.provider, applyAfterStop: false,
      ...(key ? { decartKeyCipher: this.secrets.encrypt(key) } : {}) };
    this.persist(next); return this.providerSettings(mirrorId, defaultConfigured);
  }
  requestProviderSwitch(mirrorId: string, revision: unknown) {
    const current = this.providerSettings(mirrorId);
    if (current.revision !== revision || !current.pending) throw new ApiError('EXHIBITION_STALE_CREDENTIALS', '待生效配置已变化，请刷新后重试。', 409);
    const next = structuredClone(this.stored); next.providers![mirrorId].applyAfterStop = true; next.providers![mirrorId].revision++; this.persist(next);
  }
  activateProvider(mirrorId: string) {
    const current = this.providerSettings(mirrorId);
    if (!current.pending) return;
    const next = structuredClone(this.stored); const entry = next.providers![mirrorId]; entry.active = entry.desired; entry.applyAfterStop = false; entry.revision++;
    this.persist(next);
  }
  private persist(next: StoredCredentials) {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.filename); this.stored = next; }
    catch { throw new ApiError('SETTINGS_SAVE_FAILED', '配置保存失败，原配置已保留。', 500); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* retain authoritative file */ } }
  }
  save(mirrorId: string, value: unknown, expectedRevision: unknown, region: unknown = 'global'): void {
    const current = this.configuration(mirrorId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) throw new ApiError('EXHIBITION_STALE_CREDENTIALS', '密钥设置已变化，请刷新后重试。', 409);
    const key = typeof value === 'string' ? value.trim() : value;
    if (!validKey(key)) throw new ApiError('INVALID_API_KEY', '请填写 uk- 开头的 XMAX API 密钥。');
    if (!validRegion(region)) throw new ApiError('INVALID_PROVIDER_REGION', 'XMAX 服务区域无效。');
    const next = structuredClone(this.stored);
    Object.defineProperty(next.mirrors, mirrorId, { value: { revision: current.revision + 1, keyCipher: this.secrets.encrypt(key), region }, writable: true, enumerable: true, configurable: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.filename); this.stored = next;
    } catch { throw new ApiError('SETTINGS_SAVE_FAILED', '密钥保存失败，原有配置已保留。', 500); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* An unreferenced encrypted temporary file is never loaded. */ } }
  }
}
