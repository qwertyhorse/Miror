import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExhibitionMirrorSummary } from '../shared/exhibition.ts';
import { ExhibitionService } from './exhibition.ts';
import { TryOnService } from './service.ts';
import { ApiError } from './types.ts';

/** Authenticated activity renews this lease; abandoned pages are collected sooner. */
export const BROWSER_TEST_TTL_MS = 60 * 60 * 1_000;
export const BROWSER_TEST_IDLE_MS = 60 * 1_000;
export const BROWSER_TEST_LIMIT = 8;
const TEST_ID = /^test-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
interface TestEntry {
  id: string; name: string; directory: string; tokenHash: Buffer; expiresAt: number; lastSeen: number;
  exhibition: ExhibitionService; service: TryOnService; closing: boolean; cleanup?: Promise<void>;
  source: ExhibitionService; sourceScope: string; unsubscribe?: () => void;
  invalidated?: boolean;
}
interface ClosedEntry { tokenHash: Buffer; expiresAt: number; }
export interface BrowserTestContext {
  exhibition: ExhibitionService; service: TryOnService; mirror: ExhibitionMirrorSummary; expiresAt: number;
}
export interface CreatedBrowserTest { mirror: ExhibitionMirrorSummary; token: string; expiresAt: number; }

/** Browser tests own their connection, but consume the source mirror's material catalog. */
export class BrowserTests {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly entries = new Map<string, TestEntry>();
  private readonly closed = new Map<string, ClosedEntry>();
  private liveService?: TryOnService;
  private destroyed = false;

  constructor(dataDirectory: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    // A fresh namespace never reloads an old browser token or active test. Previous
    // runs remain archived while the shared session store recovers cloud revocation.
    this.directory = join(dataDirectory, 'browser-tests', `run-${randomUUID()}`);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  attachLiveService(service: TryOnService): void { this.liveService = service; }
  owns(id: string): boolean { return TEST_ID.test(id); }

  create(source: ExhibitionService, sourceName?: string): CreatedBrowserTest {
    if (this.destroyed || !this.liveService) throw new ApiError('BROWSER_TEST_UNAVAILABLE', '浏览器测试暂不可用。', 503);
    if (this.entries.size >= BROWSER_TEST_LIMIT) throw new ApiError('BROWSER_TEST_LIMIT', '浏览器测试已满，请先关闭一个测试。', 429);
    const sourceScope = this.liveService.materialScope(source.mirrorId);
    const service = this.liveService.forBrowserTest(source.mirrorId);
    const id = `test-${randomUUID()}`; const token = randomBytes(32).toString('hex');
    const directory = join(this.directory, id); const expiresAt = this.now() + BROWSER_TEST_TTL_MS;
    let exhibition: ExhibitionService | undefined;
    try {
      exhibition = new ExhibitionService(directory, { now: this.now, mirrorId: id,
        assetBasePath: `/api/exhibition/mirrors/${id}/assets`, strictStorage: true });
      exhibition.attachLiveService(service);
      exhibition.syncSourceCatalog(source);
      exhibition.command({ action: 'configure', providerMode: 'xmax' });
      const selectedLookId = source.read().selectedLookId;
      if (selectedLookId && exhibition.read().catalog?.availableLookIds.includes(selectedLookId)) {
        exhibition.command({ action: 'select', lookId: selectedLookId });
      }
      const entry: TestEntry = { id, name: sourceName ? `${sourceName} · 浏览器测试` : '浏览器测试', directory,
        tokenHash: this.hash(token), expiresAt, lastSeen: this.now(), exhibition, service, closing: false, source, sourceScope };
      this.entries.set(id, entry);
      entry.unsubscribe = source.subscribe(() => this.synchronize(entry));
      return { mirror: this.summary(entry), token, expiresAt };
    } catch (error) {
      exhibition?.markRemoved();
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  resolve(id: string, token: unknown): BrowserTestContext {
    const entry = this.authorized(id, token);
    if (entry && !entry.closing) this.synchronize(entry);
    if (entry?.invalidated) throw new ApiError('BROWSER_TEST_SOURCE_CHANGED', '设备配置已更新，请重新打开浏览器测试。', 410);
    if (!entry || entry.closing) throw this.expired();
    const now = this.now();
    if (now >= entry.expiresAt || now - entry.lastSeen >= BROWSER_TEST_IDLE_MS) {
      void this.finish(entry).catch(() => undefined);
      throw this.expired();
    }
    // Validate the old deadline first: a late request cannot revive an expired page.
    entry.lastSeen = now;
    entry.expiresAt = now + BROWSER_TEST_TTL_MS;
    return { exhibition: entry.exhibition, service: entry.service, mirror: this.summary(entry), expiresAt: entry.expiresAt };
  }

  async close(id: string, token: unknown): Promise<void> {
    const entry = this.authorized(id, token);
    if (!entry) return;
    await this.finish(entry);
    if (this.entries.has(id)) throw new ApiError('BROWSER_TEST_STOP_PENDING', '停止尚未确认，请重试。', 409);
  }

  async sweep(): Promise<void> {
    for (const [id, entry] of this.closed) if (this.now() >= entry.expiresAt) this.closed.delete(id);
    await Promise.allSettled([...this.entries.values()].map(async entry => {
      if (!entry.closing) this.synchronize(entry);
      if (entry.closing || this.now() >= entry.expiresAt || this.now() - entry.lastSeen >= BROWSER_TEST_IDLE_MS || this.destroyed) await this.finish(entry);
      else await entry.exhibition.sweepLive();
    }));
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await Promise.allSettled([...this.entries.values()].map(entry => this.finish(entry)));
  }

  private finish(entry: TestEntry): Promise<void> {
    if (entry.cleanup) return entry.cleanup;
    // Close admission synchronously, including when expiry is discovered by resolve.
    entry.closing = true;
    entry.unsubscribe?.(); entry.unsubscribe = undefined;
    entry.cleanup = this.cleanup(entry).finally(() => { entry.cleanup = undefined; });
    return entry.cleanup;
  }
  private synchronize(entry: TestEntry): void {
    if (entry.closing) return;
    try {
      if (this.liveService?.materialScope(entry.source.mirrorId) !== entry.sourceScope) throw new Error('Source account changed');
      entry.exhibition.syncSourceCatalog(entry.source);
    } catch {
      entry.invalidated = true;
      // Revoke only this test's credentials; the physical mirror owns its own session.
      void this.finish(entry).catch(() => undefined);
    }
  }
  private async cleanup(entry: TestEntry): Promise<void> {
    entry.exhibition.command({ action: 'idle' });
    await entry.exhibition.reconcileLive();
    // Retain even detached or unknown issuance records until revocation is confirmed.
    const store = entry.service.options.store;
    const currentSessionId = entry.exhibition.read().live?.sessionId;
    await Promise.allSettled(store.unreleasedMirror(entry.id).filter(record => record.id !== currentSessionId).map(record => entry.service.stop(record.id)));
    if (store.unreleasedMirror(entry.id).length || entry.service.hasBlockingMirrorSessions(entry.id)) return;
    try { entry.exhibition.assertRemovable({ expectedRevision: entry.exhibition.read().revision }); }
    catch (error) { if (error instanceof ApiError && error.statusCode === 409) return; throw error; }
    rmSync(entry.directory, { recursive: true, force: true });
    entry.exhibition.markRemoved();
    this.entries.delete(entry.id);
    this.closed.set(entry.id, { tokenHash: entry.tokenHash, expiresAt: Math.max(entry.expiresAt, this.now() + BROWSER_TEST_TTL_MS) });
  }

  private authorized(id: string, token: unknown): TestEntry | undefined {
    const entry = this.entries.get(id); const known = entry ?? this.closed.get(id);
    if (!this.owns(id) || !known) throw new ApiError('BROWSER_TEST_NOT_FOUND', '浏览器测试已结束，请重新打开。', 404);
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token) || !timingSafeEqual(this.hash(token), known.tokenHash)) {
      throw new ApiError('BROWSER_TEST_UNAUTHORIZED', '请从后台重新打开浏览器测试。', 401);
    }
    return entry;
  }
  private hash(token: string): Buffer { return createHash('sha256').update(token).digest(); }
  private expired() { return new ApiError('BROWSER_TEST_EXPIRED', '浏览器测试已结束，请重新打开。', 410); }
  private summary(entry: TestEntry): ExhibitionMirrorSummary {
    const { phase, revision, providerMode, updatedAt } = entry.exhibition.read();
    return { id: entry.id, name: entry.name, phase, revision, providerMode, updatedAt, binding: null };
  }
}
