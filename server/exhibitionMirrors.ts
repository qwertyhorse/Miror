import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExhibitionDeviceBinding, ExhibitionDeviceConnection, ExhibitionMirrorList, ExhibitionMirrorSummary, ExhibitionState } from '../shared/exhibition.ts';
import { ExhibitionService } from './exhibition.ts';
import { ExhibitionDevices } from './exhibitionDevices.ts';
import type { TryOnService } from './service.ts';
import { ApiError } from './types.ts';

interface MirrorEntry { id: string; name: string; }
interface StoredMirrors { schemaVersion: 1; defaultMirrorId: 'default'; mirrors: MirrorEntry[]; }
const MIRROR_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function mirrorName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError('EXHIBITION_INVALID_MIRROR_NAME', '请填写设备名称。');
  const name = value.trim().normalize('NFC');
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/u.test(name)) throw new ApiError('EXHIBITION_INVALID_MIRROR_NAME', '设备名称需为 1–40 字，不能包含控制字符。');
  return name;
}

/** Durable device registry. Each mirror owns its state and assets; supplier budgets stay shared. */
export class ExhibitionMirrors {
  readonly defaultMirrorId = 'default';
  readonly devices: ExhibitionDevices;
  private readonly filename: string;
  private readonly directory: string;
  private readonly mirrors = new Map<string, ExhibitionService>();
  private entries: MirrorEntry[] = [];
  private readonly uploadConcurrency = { inProgress: 0, limit: 2 };
  private liveService?: TryOnService;

  constructor(private readonly dataDirectory: string, private readonly options: { now?: () => number } = {}) {
    this.devices = new ExhibitionDevices(dataDirectory, { now: options.now });
    this.filename = join(dataDirectory, 'exhibition-mirrors.json');
    this.directory = join(dataDirectory, 'exhibition-mirrors');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (existsSync(this.filename)) {
      const stored: unknown = JSON.parse(readFileSync(this.filename, 'utf8'));
      if (!record(stored) || stored.schemaVersion !== 1 || stored.defaultMirrorId !== this.defaultMirrorId || !Array.isArray(stored.mirrors) || !stored.mirrors.length) throw new Error('Invalid exhibition mirror registry');
      const seen = new Set<string>(); const names = new Set<string>();
      this.entries = stored.mirrors.map(value => {
        if (!record(value) || typeof value.id !== 'string' || !MIRROR_ID.test(value.id) || seen.has(value.id)) throw new Error('Invalid exhibition mirror ID');
        const name = mirrorName(value.name); const key = name.toLocaleLowerCase();
        if (names.has(key)) throw new Error('Duplicate exhibition mirror name');
        seen.add(value.id); names.add(key);
        return { id: value.id, name };
      });
      if (!seen.has(this.defaultMirrorId)) throw new Error('Default exhibition mirror missing');
      for (const entry of this.entries) {
        const path = join(this.directory, entry.id);
        // A missing device is not a new blank device: fail without overwriting registered data.
        if (!existsSync(join(path, 'exhibition.json'))) throw new Error(`Exhibition mirror data missing: ${entry.id}`);
        this.mirrors.set(entry.id, this.service(path, entry.id));
      }
    } else {
      const legacy = existsSync(join(dataDirectory, 'exhibition.json'));
      if (legacy) this.backupLegacy();
      const entry = { id: this.defaultMirrorId, name: '智能镜 1' };
      this.install(entry, legacy);
    }
  }

  list(): ExhibitionMirrorList { return { defaultMirrorId: this.defaultMirrorId, mirrors: this.entries.map(entry => this.summary(entry)) }; }

  getMirror(id = this.defaultMirrorId): ExhibitionService {
    const mirror = this.mirrors.get(id);
    if (!mirror) throw new ApiError('EXHIBITION_MIRROR_NOT_FOUND', '未找到这台智能镜，请重新选择设备。', 404);
    return mirror;
  }

  create(input: unknown): ExhibitionMirrorSummary {
    if (!record(input)) throw new ApiError('EXHIBITION_INVALID_MIRROR_NAME', '请填写设备名称。');
    const name = mirrorName(input.name); this.uniqueName(name);
    const entry = { id: `mirror-${randomUUID()}`, name };
    this.install(entry, false);
    return this.summary(entry);
  }

  rename(id: string, input: unknown): ExhibitionMirrorSummary {
    this.getMirror(id);
    if (!record(input)) throw new ApiError('EXHIBITION_INVALID_MIRROR_NAME', '请填写设备名称。');
    const name = mirrorName(input.name); this.uniqueName(name, id);
    const entries = this.entries.map(entry => entry.id === id ? { ...entry, name } : entry);
    this.persist(entries); this.entries = entries;
    return this.summary(entries.find(entry => entry.id === id)!);
  }

  copy(targetId: string, input: unknown): ExhibitionState {
    const target = this.getMirror(targetId);
    if (!record(input) || typeof input.sourceMirrorId !== 'string' || typeof input.copyLooks !== 'boolean' || typeof input.copySettings !== 'boolean'
      || (!input.copyLooks && !input.copySettings) || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) {
      throw new ApiError('EXHIBITION_INVALID_COPY', '请选择来源设备与复制内容，并刷新目标设备后重试。');
    }
    if (input.sourceMirrorId === targetId) throw new ApiError('EXHIBITION_INVALID_COPY', '请选择另一台设备作为复制来源。');
    return target.copyFrom(this.getMirror(input.sourceMirrorId), { expectedRevision: input.expectedRevision as number, copyLooks: input.copyLooks, copySettings: input.copySettings });
  }

  connectDevice(input: unknown): ExhibitionDeviceConnection {
    const connected = this.devices.connect(input);
    if (!connected.mirrorId) return connected;
    this.getMirror(connected.mirrorId);
    return { ...connected, mirrorName: this.entries.find(entry => entry.id === connected.mirrorId)!.name };
  }

  bindDevice(mirrorId: string, input: unknown): ExhibitionDeviceBinding {
    this.assertBindingEditable(mirrorId);
    return this.devices.bind(mirrorId, input);
  }

  unbindDevice(mirrorId: string, input: unknown): null {
    this.assertBindingEditable(mirrorId);
    this.devices.unbind(mirrorId, input);
    return null;
  }

  attachLiveService(service: TryOnService): void {
    this.liveService = service;
    for (const mirror of this.mirrors.values()) mirror.attachLiveService(service);
  }

  async sweepLive(): Promise<void> {
    await Promise.allSettled([...this.mirrors.values()].map(mirror => mirror.sweepLive()));
  }

  private service(path: string, id: string): ExhibitionService {
    const service = new ExhibitionService(path, { now: this.options.now, mirrorId: id, assetBasePath: `/api/exhibition/mirrors/${id}/assets`, uploadConcurrency: this.uploadConcurrency, strictStorage: true });
    if (this.liveService) service.attachLiveService(this.liveService);
    return service;
  }

  private install(entry: MirrorEntry, legacy: boolean): void {
    const final = join(this.directory, entry.id);
    const staging = join(this.directory, `.pending-${randomUUID()}`);
    if (existsSync(final)) {
      if (existsSync(join(final, '.installing'))) rmSync(final, { recursive: true, force: true });
      else throw new Error(`Unregistered exhibition mirror directory: ${entry.id}`);
    }
    let installed = false;
    try {
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, '.installing'), entry.id, { flag: 'wx', mode: 0o600 });
      if (legacy) {
        cpSync(join(this.dataDirectory, 'exhibition.json'), join(staging, 'exhibition.json'));
        const assets = join(this.dataDirectory, 'exhibition-assets');
        if (existsSync(assets)) cpSync(assets, join(staging, 'exhibition-assets'), { recursive: true });
      }
      const prepared = this.service(staging, entry.id);
      if (!legacy) prepared.command({ action: 'idle' });
      renameSync(staging, final); installed = true;
      const service = this.service(final, entry.id);
      const entries = [...this.entries, entry];
      this.persist(entries);
      this.entries = entries; this.mirrors.set(entry.id, service);
      try { rmSync(join(final, '.installing'), { force: true }); } catch { /* Registered entries are already durable. */ }
    } catch (error) {
      if (installed) rmSync(final, { recursive: true, force: true });
      throw error;
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }

  private backupLegacy(): void {
    const backup = join(this.dataDirectory, `exhibition-before-mirrors-${Date.now()}-${randomUUID()}`);
    mkdirSync(backup, { mode: 0o700 });
    cpSync(join(this.dataDirectory, 'exhibition.json'), join(backup, 'exhibition.json'));
    const assets = join(this.dataDirectory, 'exhibition-assets');
    if (existsSync(assets)) cpSync(assets, join(backup, 'exhibition-assets'), { recursive: true });
  }

  private summary(entry: MirrorEntry): ExhibitionMirrorSummary {
    const { phase, revision, providerMode, updatedAt } = this.getMirror(entry.id).read();
    return { ...entry, phase, revision, providerMode, updatedAt, binding: this.devices.binding(entry.id) };
  }

  private assertBindingEditable(mirrorId: string): void {
    const state = this.getMirror(mirrorId).get();
    if (!['idle', 'select'].includes(state.phase) || state.live) throw new ApiError('EXHIBITION_MIRROR_BUSY', '请先结束体验并等待实时会话停止，再修改镜端绑定。', 409);
  }

  private uniqueName(name: string, exceptId?: string): void {
    if (this.entries.some(entry => entry.id !== exceptId && entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new ApiError('EXHIBITION_DUPLICATE_MIRROR_NAME', '设备名称已存在，请使用其他名称。', 409);
  }

  private persist(entries: MirrorEntry[]): void {
    const data: StoredMirrors = { schemaVersion: 1, defaultMirrorId: this.defaultMirrorId, mirrors: entries };
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.filename); }
    finally { rmSync(temporary, { force: true }); }
  }
}
