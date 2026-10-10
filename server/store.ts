import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApiError, type SessionRecord } from './types.ts';

export class SecretBox {
  constructor(private readonly key: Buffer) { if (key.length !== 32) throw new Error('Invalid encryption key'); }
  static forDirectory(directory: string): SecretBox {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    const filename = `${directory}/secret.key`;
    if (!existsSync(filename)) writeFileSync(filename, randomBytes(32), { mode: 0o600, flag: 'wx' });
    chmodSync(filename, 0o600);
    return new SecretBox(readFileSync(filename));
  }
  encrypt(text: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  }
  decrypt(value: string): string {
    const bytes = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
}
export function apiKeyBudgetScope(apiKey: string): string { return createHash('sha256').update(apiKey.trim()).digest('hex'); }

export class SessionStore {
  readonly db: DatabaseSync;
  private budgetScope = 'legacy';
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, allocation INTEGER NOT NULL CHECK(allocation > 0), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY, session_id TEXT, code TEXT NOT NULL, created_at TEXT NOT NULL);`);
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'budget_scope')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN budget_scope TEXT NOT NULL DEFAULT 'legacy'");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS sessions_budget_scope ON sessions(budget_scope)');
  }
  /** Persist credential identity for safe recovery; the scope imposes no spending limit. */
  activateApiKeyBudget(apiKey: string): void {
    this.budgetScope = apiKeyBudgetScope(apiKey);
  }
  currentBudgetScope(): string { return this.budgetScope; }
  sessionBudgetScope(id: string): string {
    const row = this.db.prepare('SELECT budget_scope FROM sessions WHERE id=?').get(id) as { budget_scope: string } | undefined;
    if (!row) throw new ApiError('SESSION_NOT_FOUND', '未找到本地试穿会话。', 404);
    return row.budget_scope;
  }
  allocated(scope = this.budgetScope): number { return Number((this.db.prepare('SELECT COALESCE(SUM(allocation),0) AS n FROM sessions WHERE budget_scope=?').get(scope) as { n: number }).n); }
  reserve(record: SessionRecord, _unusedTotalLimit: number | undefined = undefined, scope = this.budgetScope): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO sessions(id, allocation, record, budget_scope) VALUES(?,?,?,?)').run(record.id, record.pointsLimit, JSON.stringify(record), scope);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): SessionRecord {
    const row = this.db.prepare('SELECT record FROM sessions WHERE id=?').get(id) as { record: string } | undefined;
    if (!row) throw new ApiError('SESSION_NOT_FOUND', '未找到本地试穿会话。', 404);
    return JSON.parse(row.record) as SessionRecord;
  }
  update(id: string, patch: Partial<SessionRecord>): SessionRecord {
    const value = { ...this.get(id), ...patch, id, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE sessions SET record=? WHERE id=?').run(JSON.stringify(value), id); return value;
  }
  list(): SessionRecord[] { return (this.db.prepare('SELECT record FROM sessions ORDER BY rowid').all() as { record: string }[]).map(row => JSON.parse(row.record)); }
  error(id: string | undefined, code: string): void {
    this.db.prepare('INSERT INTO errors(session_id,code,created_at) VALUES(?,?,?)').run(id ?? null, code, new Date().toISOString());
  }
  close(): void { this.db.close(); }
}
