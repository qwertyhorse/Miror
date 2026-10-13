import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ReferenceSource { scope: string; bytes: Buffer; mime: string }
export interface ReadyReference { url: string; sha256: string; scope: string; freshUntil: number }
export interface ReferenceStorage {
  upload(bytes: Buffer, sha256: string, mime: string): Promise<string>;
  check(url: string): Promise<boolean>;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function safeReferenceUrl(value: string): boolean {
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
  private readonly directory: string;
  private readonly now: () => number;
  constructor(directory: string, options: { now?: () => number } = {}) {
    this.directory = join(directory, 'prepared-references');
    this.now = options.now ?? Date.now;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private identity(input: ReferenceSource) {
    const sha256 = hash(input.bytes);
    return { sha256, id: hash(JSON.stringify([input.scope, sha256, input.mime])) };
  }
  private read(input: ReferenceSource): ReadyReference | null {
    const { id, sha256 } = this.identity(input);
    try {
      const record = JSON.parse(readFileSync(join(this.directory, id + '.json'), 'utf8'));
      return record.schemaVersion === 1 && record.sha256 === sha256 && record.scope === input.scope
        && Number.isFinite(record.freshUntil) && typeof record.url === 'string' && safeReferenceUrl(record.url)
        ? { url: record.url, sha256, scope: input.scope, freshUntil: record.freshUntil } : null;
    } catch { return null; } // Corrupt derived copies can be rebuilt from the source.
  }
  ready(input: ReferenceSource): ReadyReference | null {
    const record = this.read(input);
    return record && record.freshUntil > this.now() ? record : null;
  }
  prepare(input: ReferenceSource, provider: ReferenceStorage): Promise<ReadyReference> {
    const ready = this.ready(input);
    if (ready && ready.freshUntil > this.now() + 5 * 60_000) return Promise.resolve(ready);
    const { id, sha256 } = this.identity(input);
    const existing = this.pending.get(id);
    if (existing) return existing;
    if (this.pending.size >= 2) return Promise.reject(new Error('Reference preparation busy'));
    if ((this.retryAfter.get(id) ?? 0) > this.now()) return Promise.reject(new Error('Reference preparation cooling down'));
    const task = (async () => {
      const previous = this.read(input);
      // A transport failure throws; only a definite missing/denied object is reuploaded.
      const reusable = previous && await provider.check(previous.url);
      const url = reusable ? previous.url : await provider.upload(input.bytes, sha256, input.mime);
      if (!safeReferenceUrl(url)) throw new Error('Invalid reference storage response');
      const record = { schemaVersion: 1, url, sha256, scope: input.scope, freshUntil: this.now() + 60 * 60_000 };
      const target = join(this.directory, id + '.json');
      const temporary = target + '.' + randomUUID() + '.tmp';
      try { writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); renameSync(temporary, target); }
      finally { rmSync(temporary, { force: true }); }
      this.retryAfter.delete(id);
      return { url, sha256, scope: input.scope, freshUntil: record.freshUntil };
    })().catch(error => {
      this.retryAfter.set(id, this.now() + 60_000);
      while (this.retryAfter.size > 2_000) this.retryAfter.delete(this.retryAfter.keys().next().value!);
      throw error;
    }).finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }
}
