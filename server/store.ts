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
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_live_mirror ON sessions(coalesce(json_extract(record,'$.exhibition.mirrorId'),'default')) WHERE json_extract(record,'$.status') != 'stopped'");
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_unclosed ON sessions(json_extract(record,'$.status')) WHERE json_extract(record,'$.status') != 'stopped'");
    this.db.exec(`CREATE TABLE IF NOT EXISTS mirror_states (mirror_id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mirror_commands (mirror_id TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY(mirror_id, command_id));
      CREATE TABLE IF NOT EXISTS mirror_events (id INTEGER PRIMARY KEY, mirror_id TEXT NOT NULL, record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mirror_events_owner ON mirror_events(mirror_id,id);`);
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
  unclosed(): SessionRecord[] {
    return (this.db.prepare("SELECT record FROM sessions WHERE json_extract(record,'$.status') != 'stopped'").all() as { record: string }[]).map(row => JSON.parse(row.record));
  }
  unreleasedMirror(mirrorId: string): SessionRecord[] {
    return (this.db.prepare("SELECT record FROM sessions WHERE json_extract(record,'$.status') != 'stopped' AND json_extract(record,'$.exhibition') IS NOT NULL AND coalesce(json_extract(record,'$.exhibition.mirrorId'),'default')=?").all(mirrorId) as { record: string }[]).map(row => JSON.parse(row.record));
  }
  error(id: string | undefined, code: string): void {
    this.db.prepare('INSERT INTO errors(session_id,code,created_at) VALUES(?,?,?)').run(id ?? null, code, new Date().toISOString());
  }
  close(): void { this.db.close(); }

  mirrorState(mirrorId: string): unknown {
    const row = this.db.prepare('SELECT record FROM mirror_states WHERE mirror_id=?').get(mirrorId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : undefined;
  }
  commandFingerprint(mirrorId: string, commandId: string): string | undefined {
    return (this.db.prepare('SELECT fingerprint FROM mirror_commands WHERE mirror_id=? AND command_id=?').get(mirrorId, commandId) as { fingerprint: string } | undefined)?.fingerprint;
  }
  /** State, command deduplication and diagnostics commit together, before external work. */
  saveMirrorState(mirrorId: string, value: unknown, event: unknown, command?: { id: string; fingerprint: string }): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO mirror_states VALUES(?,?) ON CONFLICT(mirror_id) DO UPDATE SET record=excluded.record').run(mirrorId, JSON.stringify(value));
      if (command) this.db.prepare('INSERT OR IGNORE INTO mirror_commands VALUES(?,?,?)').run(mirrorId, command.id, command.fingerprint);
      this.db.prepare('INSERT INTO mirror_events(mirror_id,record) VALUES(?,?)').run(mirrorId, JSON.stringify(event));
      this.db.prepare('DELETE FROM mirror_events WHERE mirror_id=? AND id NOT IN (SELECT id FROM mirror_events WHERE mirror_id=? ORDER BY id DESC LIMIT 2000)').run(mirrorId, mirrorId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  mirrorEvents(mirrorId: string): unknown[] {
    return (this.db.prepare('SELECT record FROM mirror_events WHERE mirror_id=? ORDER BY id DESC LIMIT 2000').all(mirrorId) as { record: string }[]).map(row => JSON.parse(row.record));
  }
}
