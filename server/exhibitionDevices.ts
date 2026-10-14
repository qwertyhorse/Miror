import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExhibitionDeviceBinding, ExhibitionDeviceConnection, ExhibitionDeviceCredentials } from '../shared/exhibition.ts';
import { EXHIBITION_CAMERA_REQUEST_TTL_MS, EXHIBITION_CAMERA_VERSION, type ExhibitionCameraReport, type ExhibitionCameraRequest, type ExhibitionCameraStatus } from '../shared/exhibitionCamera.ts';
import { ApiError } from './types.ts';

const TERMINAL_ID = /^terminal-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MIRROR_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const CODE = /^[0-9]{4}$/;
const LEGACY_CODE = /^[0-9]{6}$/;
const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const ONLINE_LIFETIME_MS = 30 * 1000;
const CAMERA_COMPLETED = new Set(['closed', 'error', 'busy']);
interface CameraRuntime {
  mirrorId: string;
  bindingId: string;
  report?: ExhibitionCameraReport;
  updatedAt?: number;
  request?: ExhibitionCameraRequest;
  requestState?: ExhibitionCameraStatus['state'];
}
interface StoredTerminal {
  terminalId: string;
  tokenHash: string;
  label: string;
  platform: 'android' | 'browser';
  mirrorId: string | null;
  boundAt: number | null;
  pairing: { code: string; expiresAt: number } | null;
}
interface StoredDevices { schemaVersion: 2; terminals: StoredTerminal[]; retiredCodes: { hash: string; expiresAt: number }[]; }
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
function cameraText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}
function cameraReport(value: unknown): ExhibitionCameraReport | undefined {
  if (value === undefined) return undefined;
  const id = (input: unknown) => input === null || cameraText(input, 512);
  if (!record(value) || !cameraText(value.mirrorId, 64) || !cameraText(value.bindingId, 64) || !id(value.requestId)
    || !['ready', 'scanning', 'preview', 'error', 'permission-required', 'busy', 'closed'].includes(String(value.status))
    || !Array.isArray(value.devices) || value.devices.length > 24 || !id(value.selectedDeviceId) || !id(value.activeDeviceId)
    || (value.error !== undefined && !cameraText(value.error, 240))) throw new ApiError('EXHIBITION_INVALID_CAMERA_REPORT', '摄像头状态无效。');
  const ids = new Set<string>();
  const devices = value.devices.map(device => {
    if (!record(device) || !cameraText(device.id, 512) || ids.has(device.id) || !cameraText(device.label, 120)
      || !['external', 'back', 'front', 'unknown'].includes(String(device.kind))) throw new ApiError('EXHIBITION_INVALID_CAMERA_REPORT', '摄像头列表无效。');
    ids.add(device.id);
    return { id: device.id, label: device.label, kind: device.kind as ExhibitionCameraReport['devices'][number]['kind'] };
  });
  // Construct the allowlist explicitly: never retain arbitrary frame/image payloads.
  return { mirrorId: value.mirrorId, bindingId: value.bindingId, requestId: value.requestId as string | null,
    status: value.status as ExhibitionCameraReport['status'], devices,
    selectedDeviceId: value.selectedDeviceId as string | null, activeDeviceId: value.activeDeviceId as string | null,
    ...(value.error === undefined ? {} : { error: value.error as string }) };
}

/** A physical terminal registers independently of mirror URLs, then pairs using a one-use code. */
export class ExhibitionDevices {
  private readonly filename: string;
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private stored: StoredDevices = { schemaVersion: 2, terminals: [], retiredCodes: [] };
  // Heartbeats intentionally do not rewrite disk. A restarted server requires a fresh authenticated heartbeat.
  private readonly lastSeen = new Map<string, number>();
  // Commands and camera metadata are intentionally ephemeral: restart must never reopen a panel.
  private readonly cameraCapabilities = new Set<string>();
  private readonly cameras = new Map<string, CameraRuntime>();
  private pairingFailures: number[] = [];

  constructor(directory: string, options: { now?: () => number; generateCode?: () => string } = {}) {
    this.filename = join(directory, 'exhibition-devices.json');
    this.now = options.now ?? Date.now;
    this.generateCode = options.generateCode ?? (() => randomInt(10_000).toString().padStart(4, '0'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let loaded: unknown;
    try { loaded = JSON.parse(readFileSync(this.filename, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (loaded !== undefined) {
      this.stored = this.validate(loaded);
      if (record(loaded) && loaded.schemaVersion === 1) this.commit(this.stored);
    }
  }

  connect(input: unknown): ExhibitionDeviceConnection {
    if (!record(input) || typeof input.terminalId !== 'string' || !TERMINAL_ID.test(input.terminalId) || !['android', 'browser'].includes(input.platform as string)) throw new ApiError('EXHIBITION_INVALID_TERMINAL', '镜端设备信息无效。');
    const hash = tokenHash(input.token); const label = terminalLabel(input.label); const platform = input.platform as StoredTerminal['platform'];
    const current = this.stored.terminals.find(item => item.terminalId === input.terminalId);
    if (current && !this.matches(current.tokenHash, hash)) throw new ApiError('EXHIBITION_DEVICE_UNAUTHORIZED', '镜端凭据不匹配，请使用已登记的设备连接。', 403);
    const report = cameraReport(input.cameraReport);
    const time = this.now();
    let connected = current;
    if (!current || current.label !== label || current.platform !== platform || (!current.mirrorId && (!current.pairing || current.pairing.expiresAt <= time))) {
      const draft = structuredClone(this.stored);
      connected = current ? draft.terminals.find(item => item.terminalId === current.terminalId)! : { terminalId: input.terminalId, tokenHash: hash, label, platform, mirrorId: null, boundAt: null, pairing: null };
      if (!current) draft.terminals.push(connected);
      connected.label = label; connected.platform = platform;
      if (!connected.mirrorId && (!connected.pairing || connected.pairing.expiresAt <= time)) {
        if (connected.pairing) this.retireCode(draft, connected.pairing.code);
        connected.pairing = null;
        connected.pairing = { code: this.newCode(draft), expiresAt: time + PAIRING_LIFETIME_MS };
      }
      this.commit(draft);
    }
    this.lastSeen.set(connected!.terminalId, time);
    const supported = record(input.cameraCapabilities) && input.cameraCapabilities.version === EXHIBITION_CAMERA_VERSION;
    if (supported) this.cameraCapabilities.add(connected!.terminalId);
    else { this.cameraCapabilities.delete(connected!.terminalId); this.cameras.delete(connected!.terminalId); }
    let camera: Partial<ExhibitionDeviceConnection> = {};
    if (supported && connected!.mirrorId) {
      const runtime = this.cameraRuntime(connected!);
      camera = { cameraBindingId: runtime.bindingId };
      if (report) camera.cameraReportAccepted = this.acceptCameraReport(runtime, report);
      if (this.cameraPending(runtime) && runtime.requestState === 'requested') camera.cameraRequest = structuredClone(runtime.request!);
    } else if (report) camera.cameraReportAccepted = false;
    return { terminalId: connected!.terminalId, mirrorId: connected!.mirrorId,
      ...(!connected!.mirrorId && connected!.pairing ? { code: connected!.pairing.code, expiresAt: connected!.pairing.expiresAt } : {}), ...camera };
  }

  bind(mirrorId: string, input: unknown): ExhibitionDeviceBinding {
    if (!MIRROR_ID.test(mirrorId)) throw new ApiError('EXHIBITION_INVALID_TERMINAL', '设备编号无效。');
    this.pairingFailures = this.pairingFailures.filter(time => this.now() - time < 60_000);
    if (this.pairingFailures.length >= 30) throw new ApiError('EXHIBITION_PAIRING_RATE_LIMITED', '配对码尝试过多，请等待一分钟后再试。', 429);
    if (!record(input) || typeof input.code !== 'string' || !CODE.test(input.code)) throw this.pairingError('EXHIBITION_PAIRING_CODE_INVALID', '请输入镜端显示的 4 位配对码。', 400);
    if (this.stored.terminals.some(item => item.mirrorId === mirrorId)) throw new ApiError('EXHIBITION_MIRROR_ALREADY_BOUND', '此设备已有绑定镜端，请先解除当前绑定。', 409);
    const current = this.stored.terminals.find(item => item.pairing?.code === input.code);
    if (!current) throw this.pairingError('EXHIBITION_PAIRING_CODE_INVALID', '配对码无效或已使用，请查看镜端的最新配对码。', 409);
    if (current.pairing!.expiresAt <= this.now()) throw this.pairingError('EXHIBITION_PAIRING_CODE_EXPIRED', '配对码已过期，请查看镜端的最新配对码。', 410);
    if (current.mirrorId) throw new ApiError('EXHIBITION_TERMINAL_ALREADY_BOUND', '该镜端已绑定其他设备，请先解除原绑定。', 409);
    const draft = structuredClone(this.stored); const terminal = draft.terminals.find(item => item.terminalId === current.terminalId)!;
    terminal.mirrorId = mirrorId; terminal.boundAt = this.now();
    this.retireCode(draft, terminal.pairing!.code); terminal.pairing = null;
    this.commit(draft);
    this.cameras.delete(terminal.terminalId);
    return this.binding(mirrorId)!;
  }

  /** Validate a staff confirmation before ending the currently bound mirror's experience. */
  assertBindingMatches(mirrorId: string, input: unknown): void {
    const current = this.stored.terminals.find(item => item.mirrorId === mirrorId);
    if (!record(input) || typeof input.terminalId !== 'string' || !current || input.terminalId !== current.terminalId) throw new ApiError('EXHIBITION_DEVICE_BINDING_CHANGED', '镜端绑定已变化，请刷新后重新确认。', 409);
  }

  unbind(mirrorId: string, input: unknown): void {
    this.assertBindingMatches(mirrorId, input);
    const current = this.stored.terminals.find(item => item.mirrorId === mirrorId)!;
    const draft = structuredClone(this.stored); const terminal = draft.terminals.find(item => item.terminalId === current.terminalId)!;
    terminal.mirrorId = null; terminal.boundAt = null; terminal.pairing = null;
    this.commit(draft);
    this.cameras.delete(terminal.terminalId);
  }

  binding(mirrorId: string): ExhibitionDeviceBinding | null {
    const terminal = this.stored.terminals.find(item => item.mirrorId === mirrorId);
    if (!terminal) return null;
    const lastSeenAt = this.lastSeen.get(terminal.terminalId);
    return { terminalId: terminal.terminalId, label: terminal.label, platform: terminal.platform, boundAt: terminal.boundAt!, lastSeenAt: lastSeenAt ?? 0,
      online: this.terminalOnline(terminal.terminalId), camera: this.cameraStatus(mirrorId) };
  }

  cameraStatus(mirrorId: string): ExhibitionCameraStatus {
    const terminal = this.stored.terminals.find(item => item.mirrorId === mirrorId);
    const runtime = terminal ? this.cameras.get(terminal.terminalId) : undefined;
    const online = !!terminal && this.terminalOnline(terminal.terminalId);
    const supported = !!terminal && this.cameraCapabilities.has(terminal.terminalId);
    const expired = !!runtime?.request && runtime.request.expiresAt <= this.now() && !CAMERA_COMPLETED.has(runtime.requestState ?? '');
    const state = !terminal ? 'unbound' : !online ? 'offline' : !supported ? 'unsupported'
      : expired ? 'expired' : runtime?.requestState ?? runtime?.report?.status ?? 'idle';
    return { terminalId: terminal?.terminalId ?? null, online, supported, state,
      devices: structuredClone(runtime?.report?.devices ?? []), selectedDeviceId: runtime?.report?.selectedDeviceId ?? null,
      activeDeviceId: runtime?.report?.activeDeviceId ?? null, updatedAt: runtime?.updatedAt ?? null,
      request: runtime?.request && !expired ? structuredClone(runtime.request) : null,
      ...(runtime?.report?.error ? { error: runtime.report.error } : {}) };
  }

  openCamera(mirrorId: string, input: unknown): ExhibitionCameraStatus {
    this.assertBindingMatches(mirrorId, input);
    if (!record(input) || input.action !== 'open') throw new ApiError('EXHIBITION_INVALID_CAMERA_ACTION', '摄像头操作无效。');
    const terminal = this.stored.terminals.find(item => item.mirrorId === mirrorId)!;
    if (!this.terminalOnline(terminal.terminalId)) throw new ApiError('EXHIBITION_CAMERA_OFFLINE', '镜端离线，请连接镜端后重试。', 409);
    if (!this.cameraCapabilities.has(terminal.terminalId)) throw new ApiError('EXHIBITION_CAMERA_UNSUPPORTED', '请更新镜端后检测摄像头。', 409);
    const currentRuntime = this.cameras.get(terminal.terminalId);
    if (input.bindingId !== undefined && (typeof input.bindingId !== 'string' || currentRuntime?.mirrorId !== mirrorId || input.bindingId !== currentRuntime.bindingId)) {
      throw new ApiError('EXHIBITION_DEVICE_BINDING_CHANGED', '镜端绑定已变化，请刷新后重试。', 409);
    }
    const runtime = this.cameraRuntime(terminal);
    if (!this.cameraPending(runtime)) {
      const createdAt = this.now();
      runtime.request = { id: randomUUID(), action: 'open', mirrorId, terminalId: terminal.terminalId, bindingId: runtime.bindingId,
        createdAt, expiresAt: createdAt + EXHIBITION_CAMERA_REQUEST_TTL_MS };
      runtime.requestState = 'requested';
      if (runtime.report) delete runtime.report.error;
    }
    return this.cameraStatus(mirrorId);
  }

  assertCameraClosed(mirrorId: string): void {
    const terminal = this.stored.terminals.find(item => item.mirrorId === mirrorId);
    const runtime = terminal && this.cameras.get(terminal.terminalId);
    if (runtime && this.cameraPending(runtime)) throw new ApiError('EXHIBITION_CAMERA_BUSY', '请先关闭镜端摄像头检测。', 409);
  }

  cancelCamera(mirrorId: string): void {
    const terminal = this.stored.terminals.find(item => item.mirrorId === mirrorId);
    const runtime = terminal && this.cameras.get(terminal.terminalId);
    if (runtime && this.cameraPending(runtime)) runtime.requestState = 'busy';
  }

  private terminalOnline(terminalId: string): boolean {
    const lastSeenAt = this.lastSeen.get(terminalId);
    return lastSeenAt !== undefined && this.now() >= lastSeenAt && this.now() - lastSeenAt < ONLINE_LIFETIME_MS;
  }

  private cameraRuntime(terminal: StoredTerminal): CameraRuntime {
    let runtime = this.cameras.get(terminal.terminalId);
    if (!runtime || runtime.mirrorId !== terminal.mirrorId) {
      runtime = { mirrorId: terminal.mirrorId!, bindingId: randomUUID() };
      this.cameras.set(terminal.terminalId, runtime);
    }
    return runtime;
  }

  private cameraPending(runtime: CameraRuntime): boolean {
    return !!runtime.request && runtime.request.expiresAt > this.now() && !CAMERA_COMPLETED.has(runtime.requestState ?? '');
  }

  private acceptCameraReport(runtime: CameraRuntime, report: ExhibitionCameraReport): boolean {
    if (report.mirrorId !== runtime.mirrorId || report.bindingId !== runtime.bindingId) return false;
    if (report.requestId !== null) {
      if (!runtime.request || report.requestId !== runtime.request.id || runtime.request.expiresAt <= this.now()
        || (CAMERA_COMPLETED.has(runtime.requestState ?? '') && !CAMERA_COMPLETED.has(report.status))) return false;
      runtime.requestState = report.status;
    }
    runtime.report = report; runtime.updatedAt = this.now();
    return true;
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

  private retireCode(draft: StoredDevices, code: string): void {
    const time = this.now();
    draft.retiredCodes = draft.retiredCodes.filter(item => item.expiresAt > time);
    draft.retiredCodes.push({ hash: digest(code), expiresAt: time + PAIRING_LIFETIME_MS });
  }

  private newCode(draft: StoredDevices): string {
    const time = this.now();
    // A short code must be reusable eventually, including after offline terminals expire.
    for (const terminal of draft.terminals) if (terminal.pairing && terminal.pairing.expiresAt <= time) {
      const expiresAt = terminal.pairing.expiresAt + PAIRING_LIFETIME_MS;
      if (expiresAt > time) draft.retiredCodes.push({ hash: digest(terminal.pairing.code), expiresAt });
      terminal.pairing = null;
    }
    draft.retiredCodes = draft.retiredCodes.filter(item => item.expiresAt > time);
    const used = new Set(draft.retiredCodes.map(item => item.hash));
    for (const terminal of draft.terminals) if (terminal.pairing) used.add(digest(terminal.pairing.code));
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = this.generateCode();
      if (CODE.test(code) && !used.has(digest(code))) return code;
    }
    throw new ApiError('EXHIBITION_PAIRING_CODE_BUSY', '暂时无法生成配对码，请稍后重试。', 503);
  }

  private validate(value: unknown): StoredDevices {
    if (!record(value) || ![1, 2].includes(value.schemaVersion as number) || !Array.isArray(value.terminals)) throw new Error('Invalid exhibition terminal registry');
    const legacy = value.schemaVersion === 1;
    if (legacy && (!Array.isArray(value.retiredCodeHashes) || value.retiredCodeHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash)))) throw new Error('Invalid exhibition terminal registry');
    const retiredCodes = legacy ? (value.retiredCodeHashes as string[]).map(hash => ({ hash, expiresAt: this.now() + PAIRING_LIFETIME_MS })) : value.retiredCodes;
    if (!Array.isArray(retiredCodes) || retiredCodes.some(item => !record(item) || typeof item.hash !== 'string' || !HASH.test(item.hash) || !timestamp(item.expiresAt))) throw new Error('Invalid exhibition terminal registry');
    const terminals = new Set<string>(); const mirrors = new Set<string>(); const codes = new Set<string>(retiredCodes.map(item => item.hash));
    if (codes.size !== retiredCodes.length) throw new Error('Duplicate retired exhibition pairing code');
    for (const terminal of value.terminals) {
      if (!record(terminal) || typeof terminal.terminalId !== 'string' || !TERMINAL_ID.test(terminal.terminalId) || terminals.has(terminal.terminalId)
        || typeof terminal.tokenHash !== 'string' || !HASH.test(terminal.tokenHash) || !['android', 'browser'].includes(terminal.platform as string)
        || (terminal.mirrorId !== null && (typeof terminal.mirrorId !== 'string' || !MIRROR_ID.test(terminal.mirrorId) || mirrors.has(terminal.mirrorId)))
        || (terminal.mirrorId === null ? terminal.boundAt !== null : !timestamp(terminal.boundAt))) throw new Error('Invalid exhibition terminal record');
      terminalLabel(terminal.label); terminals.add(terminal.terminalId);
      if (typeof terminal.mirrorId === 'string') mirrors.add(terminal.mirrorId);
      if (terminal.pairing !== null) {
        if (terminal.mirrorId !== null || !record(terminal.pairing) || typeof terminal.pairing.code !== 'string' || !(CODE.test(terminal.pairing.code) || (legacy && LEGACY_CODE.test(terminal.pairing.code)))
          || !timestamp(terminal.pairing.expiresAt) || codes.has(digest(terminal.pairing.code))) throw new Error('Invalid exhibition pairing code');
        codes.add(digest(terminal.pairing.code));
      }
    }
    const stored = { schemaVersion: 2, terminals: structuredClone(value.terminals), retiredCodes } as StoredDevices;
    // Existing assignments and credentials survive the upgrade; old pending codes refresh on reconnect.
    if (legacy) for (const terminal of stored.terminals) if (terminal.pairing && LEGACY_CODE.test(terminal.pairing.code)) terminal.pairing = null;
    return stored;
  }

  private commit(draft: StoredDevices): void {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(draft), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.filename); this.stored = draft; }
    finally { rmSync(temporary, { force: true }); }
  }
}
