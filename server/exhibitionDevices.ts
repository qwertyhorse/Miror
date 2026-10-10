import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExhibitionDeviceBinding, ExhibitionDeviceConnection, ExhibitionDeviceCredentials } from '../shared/exhibition.ts';
import { ApiError } from './types.ts';

const TERMINAL_ID = /^terminal-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MIRROR_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const CODE = /^[0-9]{6}$/;
const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const ONLINE_LIFETIME_MS = 30 * 1000;
interface StoredTerminal {
  terminalId: string;
  tokenHash: string;
  label: string;
  platform: 'android' | 'browser';
  mirrorId: string | null;
  boundAt: number | null;
  pairing: { code: string; expiresAt: number } | null;
}
interface StoredDevices { schemaVersion: 1; terminals: StoredTerminal[]; retiredCodeHashes: string[]; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function terminalLabel(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError('EXHIBITION_INVALID_TERMINAL', '镜端名称无效。');
  const label = value.trim().normalize('NFC');
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) throw new ApiError('EXHIBITION_INVALID_TERMINAL', '镜端名称需为 1–80 字。');
  return label;
}
function tokenHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(value)) throw new ApiError('EXHIBITION_INVALID_TERMINAL', '镜端凭据无效，请重新开启镜端设备。');
  return digest(value);
}

/** A physical terminal registers independently of mirror URLs, then pairs using a one-use code. */
export class ExhibitionDevices {
  private readonly filename: string;
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private stored: StoredDevices = { schemaVersion: 1, terminals: [], retiredCodeHashes: [] };
  // Heartbeats intentionally do not rewrite disk. A restarted server requires a fresh authenticated heartbeat.
  private readonly lastSeen = new Map<string, number>();
  private pairingFailures: number[] = [];

  constructor(directory: string, options: { now?: () => number; generateCode?: () => string } = {}) {
    this.filename = join(directory, 'exhibition-devices.json');
    this.now = options.now ?? Date.now;
    this.generateCode = options.generateCode ?? (() => randomInt(1_000_000).toString().padStart(6, '0'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let loaded: unknown;
    try { loaded = JSON.parse(readFileSync(this.filename, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (loaded !== undefined) this.stored = this.validate(loaded);
  }

  connect(input: unknown): ExhibitionDeviceConnection {
    if (!record(input) || typeof input.terminalId !== 'string' || !TERMINAL_ID.test(input.terminalId) || !['android', 'browser'].includes(input.platform as string)) throw new ApiError('EXHIBITION_INVALID_TERMINAL', '镜端设备信息无效。');
    const hash = tokenHash(input.token); const label = terminalLabel(input.label); const platform = input.platform as StoredTerminal['platform'];
    const current = this.stored.terminals.find(item => item.terminalId === input.terminalId);
    if (current && !this.matches(current.tokenHash, hash)) throw new ApiError('EXHIBITION_DEVICE_UNAUTHORIZED', '镜端凭据不匹配，请使用已登记的设备连接。', 403);
    const time = this.now();
    let connected = current;
    if (!current || current.label !== label || current.platform !== platform || (!current.mirrorId && (!current.pairing || current.pairing.expiresAt <= time))) {
      const draft = structuredClone(this.stored);
      connected = current ? draft.terminals.find(item => item.terminalId === current.terminalId)! : { terminalId: input.terminalId, tokenHash: hash, label, platform, mirrorId: null, boundAt: null, pairing: null };
      if (!current) draft.terminals.push(connected);
      connected.label = label; connected.platform = platform;
      if (!connected.mirrorId && (!connected.pairing || connected.pairing.expiresAt <= time)) {
        if (connected.pairing) draft.retiredCodeHashes.push(digest(connected.pairing.code));
        connected.pairing = { code: this.newCode(draft), expiresAt: time + PAIRING_LIFETIME_MS };
      }
      this.commit(draft);
    }
    this.lastSeen.set(connected!.terminalId, time);
    return { terminalId: connected!.terminalId, mirrorId: connected!.mirrorId,
      ...(!connected!.mirrorId && connected!.pairing ? { code: connected!.pairing.code, expiresAt: connected!.pairing.expiresAt } : {}) };
  }

  bind(mirrorId: string, input: unknown): ExhibitionDeviceBinding {
    if (!MIRROR_ID.test(mirrorId)) throw new ApiError('EXHIBITION_INVALID_TERMINAL', '设备编号无效。');
    this.pairingFailures = this.pairingFailures.filter(time => this.now() - time < 60_000);
    if (this.pairingFailures.length >= 30) throw new ApiError('EXHIBITION_PAIRING_RATE_LIMITED', '配对码尝试过多，请等待一分钟后再试。', 429);
    if (!record(input) || typeof input.code !== 'string' || !CODE.test(input.code)) throw this.pairingError('EXHIBITION_PAIRING_CODE_INVALID', '请输入镜端显示的 6 位配对码。', 400);
    if (this.stored.terminals.some(item => item.mirrorId === mirrorId)) throw new ApiError('EXHIBITION_MIRROR_ALREADY_BOUND', '此设备已有绑定镜端，请先解除当前绑定。', 409);
    const current = this.stored.terminals.find(item => item.pairing?.code === input.code);
    if (!current) throw this.pairingError('EXHIBITION_PAIRING_CODE_INVALID', '配对码无效或已使用，请查看镜端的最新配对码。', 409);
    if (current.pairing!.expiresAt <= this.now()) throw this.pairingError('EXHIBITION_PAIRING_CODE_EXPIRED', '配对码已过期，请查看镜端的最新配对码。', 410);
    if (current.mirrorId) throw new ApiError('EXHIBITION_TERMINAL_ALREADY_BOUND', '该镜端已绑定其他设备，请先解除原绑定。', 409);
    const draft = structuredClone(this.stored); const terminal = draft.terminals.find(item => item.terminalId === current.terminalId)!;
    terminal.mirrorId = mirrorId; terminal.boundAt = this.now();
    draft.retiredCodeHashes.push(digest(terminal.pairing!.code)); terminal.pairing = null;
    this.commit(draft);
    return this.binding(mirrorId)!;
  }

  unbind(mirrorId: string, input: unknown): void {
    const current = this.stored.terminals.find(item => item.mirrorId === mirrorId);
    if (!record(input) || typeof input.terminalId !== 'string' || !current || input.terminalId !== current.terminalId) throw new ApiError('EXHIBITION_DEVICE_BINDING_CHANGED', '镜端绑定已变化，请刷新后重新确认。', 409);
    const draft = structuredClone(this.stored); const terminal = draft.terminals.find(item => item.terminalId === current.terminalId)!;
    terminal.mirrorId = null; terminal.boundAt = null; terminal.pairing = null;
    this.commit(draft);
  }

  binding(mirrorId: string): ExhibitionDeviceBinding | null {
    const terminal = this.stored.terminals.find(item => item.mirrorId === mirrorId);
    if (!terminal) return null;
    const lastSeenAt = this.lastSeen.get(terminal.terminalId);
    return { terminalId: terminal.terminalId, label: terminal.label, platform: terminal.platform, boundAt: terminal.boundAt!, lastSeenAt: lastSeenAt ?? 0,
      online: lastSeenAt !== undefined && this.now() >= lastSeenAt && this.now() - lastSeenAt < ONLINE_LIFETIME_MS };
  }

  assertOwner(mirrorId: string, credentials: ExhibitionDeviceCredentials): void {
    const terminal = this.stored.terminals.find(item => item.mirrorId === mirrorId);
    const supplied = credentials.terminalId !== undefined || credentials.terminalToken !== undefined;
    if (!terminal && !supplied) return;
    if (!terminal) throw new ApiError('EXHIBITION_DEVICE_UNAUTHORIZED', '镜端绑定已解除或已变更，请重新配对后开启实时换装。', 403);
    let hash: string;
    try { hash = tokenHash(credentials.terminalToken); } catch { throw new ApiError('EXHIBITION_DEVICE_UNAUTHORIZED', '此智能镜已绑定镜端，请从已绑定的设备开启实时换装。', 403); }
    if (credentials.terminalId !== terminal.terminalId || !this.matches(terminal.tokenHash, hash)) throw new ApiError('EXHIBITION_DEVICE_UNAUTHORIZED', '此智能镜已绑定镜端，请从已绑定的设备开启实时换装。', 403);
  }

  private matches(a: string, b: string): boolean { return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  private pairingError(code: string, message: string, status: number): ApiError { this.pairingFailures.push(this.now()); return new ApiError(code, message, status); }

  private newCode(draft: StoredDevices): string {
    const used = new Set(draft.retiredCodeHashes);
    for (const terminal of draft.terminals) if (terminal.pairing) used.add(digest(terminal.pairing.code));
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = this.generateCode();
      if (CODE.test(code) && !used.has(digest(code))) return code;
    }
    throw new ApiError('EXHIBITION_PAIRING_CODE_BUSY', '暂时无法生成配对码，请稍后重试。', 503);
  }

  private validate(value: unknown): StoredDevices {
    if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.terminals) || !Array.isArray(value.retiredCodeHashes)
      || value.retiredCodeHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))) throw new Error('Invalid exhibition terminal registry');
    const terminals = new Set<string>(); const mirrors = new Set<string>(); const codes = new Set<string>(value.retiredCodeHashes);
    if (codes.size !== value.retiredCodeHashes.length) throw new Error('Duplicate retired exhibition pairing code');
    for (const terminal of value.terminals) {
      if (!record(terminal) || typeof terminal.terminalId !== 'string' || !TERMINAL_ID.test(terminal.terminalId) || terminals.has(terminal.terminalId)
        || typeof terminal.tokenHash !== 'string' || !HASH.test(terminal.tokenHash) || !['android', 'browser'].includes(terminal.platform as string)
        || (terminal.mirrorId !== null && (typeof terminal.mirrorId !== 'string' || !MIRROR_ID.test(terminal.mirrorId) || mirrors.has(terminal.mirrorId)))
        || (terminal.mirrorId === null ? terminal.boundAt !== null : !timestamp(terminal.boundAt))) throw new Error('Invalid exhibition terminal record');
      terminalLabel(terminal.label); terminals.add(terminal.terminalId);
      if (typeof terminal.mirrorId === 'string') mirrors.add(terminal.mirrorId);
      if (terminal.pairing !== null) {
        if (terminal.mirrorId !== null || !record(terminal.pairing) || typeof terminal.pairing.code !== 'string' || !CODE.test(terminal.pairing.code)
          || !timestamp(terminal.pairing.expiresAt) || codes.has(digest(terminal.pairing.code))) throw new Error('Invalid exhibition pairing code');
        codes.add(digest(terminal.pairing.code));
      }
    }
    return value as unknown as StoredDevices;
  }

  private commit(draft: StoredDevices): void {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(draft), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.filename); this.stored = draft; }
    finally { rmSync(temporary, { force: true }); }
  }
}
