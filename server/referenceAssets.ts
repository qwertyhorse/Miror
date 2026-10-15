import { isDecartReference } from '../shared/providers.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReferencePreparationStage, ReferencePreparationStatus } from '../shared/referencePreparation.ts';
import { preparationFailureMessage, ReferencePreparationError } from './referencePreparation.ts';

export interface ReferenceSource { scope: string; bytes: Buffer; mime: string }
export interface ReferenceIdentity { scope: string; sha256: string; mime: string }
export interface ReadyReference { bindingId: string; url: string; sha256: string; scope: string; freshUntil: number; providerExpiresAt?: number }
export interface ReferenceStorage {
  upload(bytes: Buffer, sha256: string, mime: string, onStage?: (stage: ReferencePreparationStage) => void): Promise<string | { url: string; providerExpiresAt?: number }>;
  check(url: string): Promise<boolean>;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function safeReferenceUrl(value: string): boolean {
  if (isDecartReference(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash
      && /^[a-z0-9-]+-\d+\.cos\.[a-z0-9-]+\.myqcloud\.com$/.test(url.hostname);
  } catch { return false; }
}
/** Recoverable distribution copies. Local source bytes remain authoritative. */
export class ReferenceAssets {
  private readonly pending = new Map<string, Promise<ReadyReference>>();
  private readonly retryAfter = new Map<string, number>();
  private readonly progress = new Map<string, ReferencePreparationStatus>();
  private readonly directory: string;
  private readonly now: () => number;
  constructor(directory: string, options: { now?: () => number } = {}) {
    this.directory = join(directory, 'prepared-references');
    this.now = options.now ?? Date.now;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private identity(input: ReferenceSource | ReferenceIdentity) {
    const sha256 = 'sha256' in input ? input.sha256 : hash(input.bytes);
    return { sha256, id: hash(JSON.stringify([input.scope, sha256, input.mime])) };
  }
  private read(input: ReferenceSource | ReferenceIdentity): ReadyReference | null {
    const { id, sha256 } = this.identity(input);
    try {
      const record = JSON.parse(readFileSync(join(this.directory, id + '.json'), 'utf8'));
      return record.schemaVersion === 2 && typeof record.bindingId === 'string' && /^[a-f0-9-]{36}$/.test(record.bindingId) && record.mime === input.mime && record.sha256 === sha256 && record.scope === input.scope
        && (record.providerExpiresAt === undefined || Number.isFinite(record.providerExpiresAt)) && Number.isFinite(record.freshUntil) && typeof record.url === 'string' && safeReferenceUrl(record.url)
        ? { bindingId: record.bindingId, url: record.url, sha256, scope: input.scope, freshUntil: Math.min(record.freshUntil, record.providerExpiresAt ?? Infinity), ...(record.providerExpiresAt !== undefined ? { providerExpiresAt: record.providerExpiresAt } : {}) } : null;
    } catch { return null; } // Corrupt derived copies can be rebuilt from the source.
  }
  ready(input: ReferenceSource | ReferenceIdentity): ReadyReference | null {
    const record = this.read(input);
    return record && record.freshUntil > this.now() ? record : null;
  }
  /** Resolve only the exact persisted content/account identity. Acquisition performs no network work. */
  acquire(bindingId: string, input: ReferenceIdentity): ReadyReference | null {
    const ready = this.ready(input);
    return ready && ready.bindingId === bindingId && ready.freshUntil > this.now() + 30_000 ? ready : null;
  }
  status(input: ReferenceIdentity): ReferencePreparationStatus {
    const { id } = this.identity(input);
    const progress = this.progress.get(id);
    const ready = this.ready(input);
    if (ready) return { state: 'ready', freshUntil: ready.freshUntil, ...(progress ? { refreshState: progress.state === 'failed' ? 'failed' as const : 'preparing' as const, retryAt: progress.retryAt, message: progress.message } : {}) };
    if (progress) return { ...progress };
    return { state: 'queued' };
  }
  prepare(input: ReferenceSource, provider: ReferenceStorage): Promise<ReadyReference> {
    const ready = this.ready(input);
    if (ready && ready.freshUntil > this.now() + 5 * 60_000) return Promise.resolve(ready);
    const { id, sha256 } = this.identity(input);
    const existing = this.pending.get(id);
    if (existing) return existing;
    if (this.pending.size >= 2) return Promise.reject(new Error('Reference preparation busy'));
    if ((this.retryAfter.get(id) ?? 0) > this.now()) return Promise.reject(new Error('Reference preparation cooling down'));
    const onStage = (stage: ReferencePreparationStage) => {
      this.progress.set(id, { state: 'preparing', stage, updatedAt: this.now() });
    };
    onStage('credentials');
    const task = (async () => {
      const previous = this.read(input);
      // A transport failure throws; only a definite missing/denied object is reuploaded.
      if (previous) onStage('availability');
      const reusable = previous && (previous.providerExpiresAt ?? Infinity) > this.now() && await provider.check(previous.url);
      if (previous && !reusable && this.read(input)?.bindingId === previous.bindingId) rmSync(join(this.directory, id + '.json'), { force: true });
      const uploaded = reusable ? previous : await provider.upload(input.bytes, sha256, input.mime, onStage);
      const url = typeof uploaded === 'string' ? uploaded : uploaded.url;
      const providerExpiresAt = typeof uploaded === 'string' ? undefined : uploaded.providerExpiresAt;
      if (!safeReferenceUrl(url)) throw new ReferencePreparationError('check', 'malformed');
      const freshUntil = Math.min(this.now() + 60 * 60_000, providerExpiresAt ?? Infinity);
      if (!Number.isFinite(freshUntil) || freshUntil <= this.now()) throw new ReferencePreparationError('check', 'malformed');
      // A worker from an older process/source generation cannot replace a newer persisted replica.
      const concurrent = this.read(input);
      if (concurrent && concurrent.bindingId !== previous?.bindingId) {
        const current = this.ready(input);
        if (current) return current;
        throw new ReferencePreparationError('availability', 'status');
      }
      const bindingId = reusable && previous.freshUntil > this.now() ? previous.bindingId : randomUUID();
      const record = { schemaVersion: 2, bindingId, url, sha256, mime: input.mime, scope: input.scope, freshUntil, ...(providerExpiresAt !== undefined ? { providerExpiresAt } : {}) };
      const target = join(this.directory, id + '.json');
      const temporary = target + '.' + randomUUID() + '.tmp';
      try { writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); renameSync(temporary, target); }
      finally { rmSync(temporary, { force: true }); }
      this.retryAfter.delete(id);
      this.progress.delete(id);
      return { bindingId, url, sha256, scope: input.scope, freshUntil: record.freshUntil, ...(providerExpiresAt !== undefined ? { providerExpiresAt } : {}) };
    })().catch(error => {
      const retryAt = this.now() + 60_000;
      this.retryAfter.set(id, retryAt);
      this.progress.set(id, { state: 'failed', message: preparationFailureMessage(error), retryAt, updatedAt: this.now(),
        ...(error instanceof ReferencePreparationError ? { stage: error.stage } : {}) });
      while (this.retryAfter.size > 2_000) this.retryAfter.delete(this.retryAfter.keys().next().value!);
      for (const [key, value] of this.progress) {
        if (this.progress.size <= 2_000) break;
        if (value.state !== 'preparing') this.progress.delete(key);
      }
      throw error;
    }).finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }
}
