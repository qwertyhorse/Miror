import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OutputInfo } from 'sharp';
import { EXHIBITION_AUTO_SWITCH_DEFAULT_SECONDS, EXHIBITION_AUTO_SWITCH_MAX_SECONDS, EXHIBITION_AUTO_SWITCH_MIN_SECONDS, EXHIBITION_EXPERIENCE_MODES, EXHIBITION_FREE_PROMPT_MAX_LENGTH, EXHIBITION_LOOK_IDS, EXHIBITION_UI_SKIN_PRESETS, exhibitionPromptForLook, type ExhibitionExperienceMode, type ExhibitionLook, type ExhibitionPhase, type ExhibitionState, type ExhibitionUploadLimits, type ExhibitionLiveStatus, type ExhibitionUiSkin, type ExhibitionUiSkinPreset } from '../shared/exhibition.ts';
import { ApiError } from './types.ts';
import type { TryOnService } from './service.ts';
import { ExhibitionSkinStore } from './exhibitionSkin.ts';

const GENERATION_DELAY_MS = 2_200;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const MAX_LOGS = 40;
const MAX_LOOKS = 100;
const MAX_INPUT_PIXELS = 32_000_000;
const MIB = 1_048_576;
const UPLOAD_ID = /^upload-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PHASES: ExhibitionPhase[] = ['select', 'positioning', 'generating', 'showcase', 'paused', 'idle'];
const DEFAULT_LIMITS: ExhibitionUploadLimits = { maxFileSizeMB: 10, minWidth: 512, maxWidth: 4096, minHeight: 512, maxHeight: 4096 };
const SAMPLE_LOOKS: ExhibitionLook[] = [
  { id: 'commute', name: '轻盈通勤', description: '自然有型，从容出发', image: '/assets/exhibition/commute-cutout.png', palette: '奶油白 · 燕麦色', mode: 'clothx', category: '通勤', tags: ['简约'], source: 'sample' },
  { id: 'city', name: '都市休闲', description: '日常灵感，时髦百搭', image: '/assets/exhibition/city-cutout.png', palette: '可可棕 · 牛仔蓝', mode: 'clothx', category: '休闲', tags: ['日常'], source: 'sample' },
  { id: 'evening', name: '优雅礼服', description: '气场加持，重要时刻', image: '/assets/exhibition/evening-cutout.png', palette: '经典黑 · 象牙白', mode: 'clothx', category: '礼服', tags: ['优雅'], source: 'sample' },
];

interface StoredExhibition {
  schemaVersion: 3;
  state: ExhibitionState;
  lastCommandAt: number;
  pausedPhase: 'showcase' | 'generating' | null;
  pausedRemainingMs: number;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function isAutoReturn(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && (value === 0 || (value >= 15 && value <= 600)); }
function isAutoSwitchSeconds(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= EXHIBITION_AUTO_SWITCH_MIN_SECONDS && value <= EXHIBITION_AUTO_SWITCH_MAX_SECONDS; }
function isSwitchMode(value: unknown): value is 'manual' | 'auto' { return value === 'manual' || value === 'auto'; }
function isUiSkinPreset(value: unknown): value is ExhibitionUiSkinPreset { return EXHIBITION_UI_SKIN_PRESETS.includes(value as ExhibitionUiSkinPreset); }
function isUiSkin(value: unknown): value is ExhibitionUiSkin | null { return value === null || (isRecord(value) && typeof value.image === 'string' && value.image.startsWith('/api/exhibition/') && isNonnegativeInteger(value.width) && value.width > 0 && isNonnegativeInteger(value.height) && value.height > 0 && isNonnegativeInteger(value.bytes) && value.bytes > 0); }
function isNonnegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isTimestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function isMode(value: unknown): value is ExhibitionExperienceMode { return EXHIBITION_EXPERIENCE_MODES.includes(value as ExhibitionExperienceMode); }
function activeLookIds(state: ExhibitionState): string[] { return state.enabledLookIds.filter(id => state.looks.some(look => look.id === id && look.mode === state.experienceMode)); }
function reconcileSelection(state: ExhibitionState) {
  const ids = activeLookIds(state);
  if (state.selectedLookId === null || !ids.includes(state.selectedLookId)) state.selectedLookId = ids[0] ?? null;
  if (state.selectedLookId === null) { state.phase = 'idle'; state.displayedLookId = null; state.generationReadyAt = null; }
}
function freePrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > EXHIBITION_FREE_PROMPT_MAX_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new ApiError('EXHIBITION_INVALID_PROMPT', `Free 模式需要 1–${EXHIBITION_FREE_PROMPT_MAX_LENGTH} 字提示词。`);
  return value.trim().normalize('NFC');
}
function validLimits(value: unknown): value is ExhibitionUploadLimits {
  if (!isRecord(value) || !Number.isInteger(value.maxFileSizeMB) || (value.maxFileSizeMB as number) < 1 || (value.maxFileSizeMB as number) > 20) return false;
  for (const field of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight']) {
    if (!Number.isInteger(value[field]) || (value[field] as number) < 64 || (value[field] as number) > 8192) return false;
  }
  return (value.minWidth as number) <= (value.maxWidth as number) && (value.minHeight as number) <= (value.maxHeight as number)
    && (value.minWidth as number) * (value.minHeight as number) <= MAX_INPUT_PIXELS;
}
function shortText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new ApiError('EXHIBITION_INVALID_METADATA', `请填写有效的${label}。`);
  const result = value.trim().normalize('NFC');
  if ((!allowEmpty && !result) || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) throw new ApiError('EXHIBITION_INVALID_METADATA', `${label}${allowEmpty ? `最多 ${maximum}` : `需为 1–${maximum}`} 字，不能包含控制字符。`);
  return result;
}
function nameList(value: unknown, label: string, maximum: number, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) throw new ApiError('EXHIBITION_INVALID_TAXONOMY', `${label}数量无效，最多 ${maximum} 个。`);
  const names = value.map(name => shortText(name, label, 20));
  if (new Set(names.map(name => name.toLocaleLowerCase())).size !== names.length) throw new ApiError('EXHIBITION_INVALID_TAXONOMY', `${label}不能重复。`);
  return names;
}
function normalizeStored(value: unknown, assetBasePath: string): StoredExhibition | null {
  if (!isRecord(value) || !isRecord(value.state) || ![1, 2, 3].includes(value.schemaVersion as number)) return null;
  const migrated = structuredClone(value);
  if (migrated.schemaVersion === 1) {
    const state = migrated.state as Record<string, unknown>;
    state.looks = structuredClone(SAMPLE_LOOKS);
    state.categories = ['通勤', '休闲', '礼服']; state.tags = ['简约', '日常', '优雅'];
    state.settings = { ...(isRecord(state.settings) ? state.settings : {}), uploadLimits: { ...DEFAULT_LIMITS } };
    migrated.schemaVersion = 2;
  }
  const state = migrated.state as Record<string, unknown>;
  if (migrated.schemaVersion === 2) {
    state.experienceMode = 'clothx';
    if (Array.isArray(state.looks)) for (const look of state.looks) if (isRecord(look)) look.mode = 'clothx';
    migrated.schemaVersion = 3;
  }
  if (Array.isArray(state.looks)) {
    for (const look of state.looks) {
      if (isRecord(look) && look.source === 'upload' && look.image === `/api/exhibition/assets/${look.id}`) look.image = `${assetBasePath}/${look.id}`;
    }
  }
  if (state.generationNumber === undefined) state.generationNumber = 0;
  if (state.live === undefined) state.live = null;
  if (state.autoSwitchAt === undefined) state.autoSwitchAt = null;
  if (isRecord(state.settings)) {
    if (state.settings.switchMode === undefined) state.settings.switchMode = 'manual';
    if (state.settings.autoSwitchSeconds === undefined) state.settings.autoSwitchSeconds = EXHIBITION_AUTO_SWITCH_DEFAULT_SECONDS;
    if (state.settings.uiSkinPreset === undefined) state.settings.uiSkinPreset = 'crystal';
    if (state.settings.uiSkin === undefined) state.settings.uiSkin = null;
  }
  if (isRecord(state.live) && state.live.generationNumber === undefined) state.live.generationNumber = state.generationNumber;
  try {
    const categories = nameList(state.categories, '分类', 40, false);
    const tags = nameList(state.tags, '标签', 80, true);
    if (!Array.isArray(state.looks) || state.looks.length > MAX_LOOKS || !isMode(state.experienceMode)) return null;
    const ids = new Set<string>();
    for (const look of state.looks) {
      if (!isRecord(look) || typeof look.id !== 'string' || ids.has(look.id)) return null;
      if (look.source === 'sample') {
        if (!SAMPLE_LOOKS.some(sample => sample.id === look.id && sample.image === look.image)) return null;
      } else if (look.source === 'upload') {
        if (!UPLOAD_ID.test(look.id) || look.image !== `${assetBasePath}/${look.id}` || look.mime !== 'image/webp'
          || !isNonnegativeInteger(look.width) || !isNonnegativeInteger(look.height) || !isNonnegativeInteger(look.bytes)) return null;
      } else return null;
      shortText(look.name, '服装名称', 40); shortText(look.description, '描述', 120, true);
      if (!isMode(look.mode)) return null;
      if (look.referenceKind !== undefined && look.referenceKind !== 'image' && look.referenceKind !== 'none') return null;
      if (look.referenceKind === 'none' && look.mode !== 'free') return null;
      if (look.mode === 'free') freePrompt(look.prompt);
      if (typeof look.palette !== 'string' || typeof look.category !== 'string' || !categories.includes(look.category)
        || nameList(look.tags, '服装标签', 8, true).some(tag => !tags.includes(tag))) return null;
      ids.add(look.id);
    }
    const isLook = (id: unknown) => typeof id === 'string' && ids.has(id);
    if (!(isNonnegativeInteger(state.revision) && isNonnegativeInteger(state.sessionNumber) && isNonnegativeInteger(state.generationNumber)
      && PHASES.includes(state.phase as ExhibitionPhase) && (state.selectedLookId === null || isLook(state.selectedLookId))
      && (state.displayedLookId === null || isLook(state.displayedLookId))
      && Array.isArray(state.enabledLookIds) && state.enabledLookIds.every(isLook)
      && new Set(state.enabledLookIds).size === state.enabledLookIds.length
      && (state.selectedLookId === null ? !state.looks.some(look => isRecord(look) && look.mode === state.experienceMode && (state.enabledLookIds as unknown[]).includes(look.id)) && ['select', 'idle'].includes(state.phase as string) : state.enabledLookIds.includes(state.selectedLookId) && state.looks.some(look => isRecord(look) && look.id === state.selectedLookId && look.mode === state.experienceMode))
      && isTimestamp(state.updatedAt) && (state.generationReadyAt === null || isTimestamp(state.generationReadyAt))
      && (state.autoSwitchAt === null || isTimestamp(state.autoSwitchAt))
      && isRecord(state.settings) && isAutoReturn(state.settings.autoReturnSeconds) && validLimits(state.settings.uploadLimits) && isSwitchMode(state.settings.switchMode) && isAutoSwitchSeconds(state.settings.autoSwitchSeconds) && isUiSkinPreset(state.settings.uiSkinPreset) && isUiSkin(state.settings.uiSkin) && ['demo', 'xmax'].includes(state.providerMode as string)
      && (state.live === null || (isRecord(state.live) && isNonnegativeInteger(state.live.generationNumber) && typeof state.live.deviceId === 'string' && typeof state.live.lookId === 'string' && (state.live.sessionId === null || typeof state.live.sessionId === 'string') && (state.live.localEnded === undefined || typeof state.live.localEnded === 'boolean') && isTimestamp(state.live.heartbeatAt) && isTimestamp(state.live.updatedAt)))
      && Array.isArray(state.logs) && state.logs.every(log => isRecord(log) && typeof log.id === 'string' && isTimestamp(log.time) && typeof log.message === 'string')
      && isTimestamp(migrated.lastCommandAt) && (migrated.pausedPhase === null || migrated.pausedPhase === 'showcase' || migrated.pausedPhase === 'generating')
      && isTimestamp(migrated.pausedRemainingMs))) return null;
  } catch { return null; }
  return migrated as unknown as StoredExhibition;
}

/** Shared LAN exhibition state; garments are local assets and never invoke XMAX or a camera. */
export class ExhibitionService {
  readonly mirrorId: string;
  private readonly filename: string;
  private readonly assetsDirectory: string;
  private readonly copyBackupsDirectory: string;
  private readonly assetBasePath: string;
  private readonly uploadConcurrency: { inProgress: number; limit: number };
  private readonly now: () => number;
  private stored: StoredExhibition;
  private uploadsInProgress = 0;
  private liveService?: TryOnService;
  private reconcilingLive?: Promise<void>;
  private readonly skinStore: ExhibitionSkinStore;

  constructor(dataDirectory: string, options: { now?: () => number; mirrorId?: string; assetBasePath?: string; uploadConcurrency?: { inProgress: number; limit: number }; strictStorage?: boolean } = {}) {
    this.mirrorId = options.mirrorId ?? 'default';
    this.assetBasePath = options.assetBasePath ?? '/api/exhibition/assets';
    this.skinStore = new ExhibitionSkinStore(dataDirectory, this.assetBasePath.replace(/\/assets$/u, '/skin'));
    this.uploadConcurrency = options.uploadConcurrency ?? { inProgress: 0, limit: 2 };
    this.filename = join(dataDirectory, 'exhibition.json'); this.assetsDirectory = join(dataDirectory, 'exhibition-assets');
    this.copyBackupsDirectory = join(dataDirectory, 'exhibition-copy-backups');
    this.now = options.now ?? Date.now;
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const time = this.now();
    this.stored = {
      schemaVersion: 3,
      state: {
        mirrorId: this.mirrorId,
        revision: 0, phase: 'select', experienceMode: 'clothx', selectedLookId: 'commute', displayedLookId: null,
        enabledLookIds: [...EXHIBITION_LOOK_IDS], looks: structuredClone(SAMPLE_LOOKS), categories: ['通勤', '休闲', '礼服'], tags: ['简约', '日常', '优雅'],
        sessionNumber: 0, generationNumber: 0, updatedAt: time, generationReadyAt: null, autoSwitchAt: null,
        settings: { autoReturnSeconds: 90, uploadLimits: { ...DEFAULT_LIMITS }, switchMode: 'manual', autoSwitchSeconds: EXHIBITION_AUTO_SWITCH_DEFAULT_SECONDS, uiSkinPreset: 'crystal', uiSkin: null }, providerMode: 'demo', live: null, logs: [],
      }, lastCommandAt: time, pausedPhase: null, pausedRemainingMs: 0,
    };
    let loaded: unknown;
    try { loaded = JSON.parse(readFileSync(this.filename, 'utf8')); }
    catch (error) { if ((error instanceof SyntaxError && options.strictStorage) || (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')) throw error; }
    const normalized = normalizeStored(loaded, this.assetBasePath);
    if (options.strictStorage && loaded !== undefined && !normalized) throw new Error(`Invalid exhibition mirror data: ${this.mirrorId}`);
    if (normalized) {
      const needsUpgrade = normalized.state.mirrorId !== this.mirrorId || JSON.stringify(normalized) !== JSON.stringify(loaded);
      if (isRecord(loaded) && loaded.schemaVersion !== 3) {
        const backup = `${this.filename}.before-six-modes.json`;
        if (!existsSync(backup)) copyFileSync(this.filename, backup);
      }
      normalized.state.mirrorId = this.mirrorId;
      this.stored = normalized; this.stored.state.logs = this.stored.state.logs.slice(0, MAX_LOGS);
      if (!['select', 'idle'].includes(normalized.state.phase)) {
        const recovered = structuredClone(this.stored); this.reset(recovered, 'select'); recovered.lastCommandAt = time;
        this.commit(recovered, '本地演示服务已恢复，上一轮体验已结束。', time);
      } else if (needsUpgrade) {
        this.commit(structuredClone(this.stored), '服装库已升级，原有服装选择和展会设置已保留。', time);
      }
    } else this.commit(this.stored, '局域网交互演示已就绪，未连接 XMAX 或摄像头。', time);
  }

  get(): ExhibitionState { this.tick(); return structuredClone(this.stored.state); }

  attachLiveService(service: TryOnService) { this.liveService = service; }

  liveStatus(): ExhibitionLiveStatus {
    const status = this.liveService?.status(this.mirrorId);
    return { configured: status?.configured ?? false, mode: this.stored.state.providerMode, model: status?.model ?? 'x2.0',
      providerRegion: status?.providerRegion ?? 'global', perSessionLimit: status?.perSessionLimit ?? 30, expireSeconds: this.liveService?.expireSeconds ?? 120,
      heartbeatTimeoutSeconds: HEARTBEAT_TIMEOUT_MS / 1000, live: structuredClone(this.stored.state.live) };
  }
  credentialsEditable(): boolean {
    this.tick(); const state = this.stored.state;
    return (['idle', 'select'].includes(state.phase) && (!state.live || (state.live.localEnded === true && state.live.status === 'error')))
      || (state.phase === 'paused' && state.live?.status === 'error');
  }

  async createLiveSession(input: unknown, hooks?: { cancelled?: () => boolean }) {
    if (!isRecord(input)) throw new ApiError('EXHIBITION_INVALID_SESSION', '请提供设备和服装信息。');
    const deviceId = shortText(input.deviceId, '设备 ID', 100);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(deviceId)) throw new ApiError('EXHIBITION_INVALID_DEVICE', '设备 ID 无效。');
    this.tick(); await this.reconcileLive(); this.checkRevision(input.expectedRevision);
    const state = this.stored.state;
    if (state.providerMode !== 'xmax') throw new ApiError('EXHIBITION_LIVE_DISABLED', '请先在后台明确启用 XMAX 实时模式。', 409);
    if (state.phase !== 'generating') throw new ApiError('EXHIBITION_INVALID_PHASE', '请先开始体验，再连接实时换装。', 409);
    if (input.generationNumber !== state.generationNumber) throw new ApiError('EXHIBITION_STALE_GENERATION', '本轮换装已更新，请等待大屏同步。', 409);
    if (state.live) throw new ApiError('EXHIBITION_DEVICE_BUSY', '已有大屏占用本轮体验，请先结束或等待会话停止。', 409);
    const look = state.looks.find(item => item.id === input.lookId);
    if (!look || look.id !== state.selectedLookId || !activeLookIds(state).includes(look.id)) throw new ApiError('EXHIBITION_INVALID_LOOK', '素材与当前模式或体验不一致。');
    if (!this.liveService) throw new ApiError('EXHIBITION_LIVE_UNAVAILABLE', '实时换装服务尚未连接。', 503);
    if (look.source === 'upload') this.asset(look.id);
    const service = this.liveService;
    const live = { deviceId, generationNumber: state.generationNumber, sessionId: null as string | null, lookId: look.id, status: 'preparing' as const, updatedAt: this.now(), heartbeatAt: this.now() };
    const draft = structuredClone(this.stored); draft.state.live = live;
    this.commit(draft, '大屏已占用本轮体验，正在申请受限 XMAX 临时凭证。', this.now());
    let reservedId: string | undefined;
    try {
      const created = await service.createExhibition({ mirrorId: this.mirrorId, lookId: look.id, deviceId, name: look.name, referenceAsset: look.referenceKind === 'none' ? '' : look.image, referenceKind: look.referenceKind, mode: state.experienceMode, prompt: exhibitionPromptForLook(look), sessionNumber: state.sessionNumber, generationNumber: state.generationNumber }, {
        onReserved: id => {
          reservedId = id;
          const reserved = structuredClone(this.stored);
          if (reserved.state.live?.deviceId === deviceId && reserved.state.live.generationNumber === state.generationNumber) { reserved.state.live.sessionId = id; this.commit(reserved, '实时会话记录已创建。', this.now()); }
        },
        cancelled: () => !!hooks?.cancelled?.() || this.stored.state.providerMode !== 'xmax' || this.stored.state.phase !== 'generating'
          || this.stored.state.experienceMode !== state.experienceMode || this.stored.state.selectedLookId !== look.id || this.stored.state.live?.deviceId !== deviceId || this.stored.state.generationNumber !== state.generationNumber || this.stored.state.sessionNumber !== state.sessionNumber,
      });
      const connected = structuredClone(this.stored);
      if (connected.state.live?.sessionId === created.id) {
        connected.state.live.status = 'connecting'; connected.state.live.updatedAt = this.now(); connected.state.live.heartbeatAt = this.now();
        this.commit(connected, '临时凭证已签发，等待摄像头与 XMAX 首帧。', this.now());
      }
      return created;
    } catch (error) {
      const failed = structuredClone(this.stored);
      if (failed.state.live?.deviceId === deviceId && failed.state.live.generationNumber === state.generationNumber) {
        if (!reservedId) failed.state.live = null;
        else { failed.state.live.status = 'error'; failed.state.live.error = error instanceof Error ? error.message : '实时会话连接失败。'; }
        if (failed.state.phase === 'generating' && failed.state.generationNumber === state.generationNumber) { failed.state.phase = 'paused'; failed.pausedPhase = 'generating'; }
        this.commit(failed, '实时连接未完成，请检查错误后手动继续或结束。', this.now());
      }
      await this.reconcileLive(); throw error;
    }
  }

  heartbeat(input: unknown): ExhibitionState {
    if (!isRecord(input) || !this.stored.state.live || input.deviceId !== this.stored.state.live.deviceId || input.sessionId !== this.stored.state.live.sessionId) throw new ApiError('EXHIBITION_OWNER_MISMATCH', '当前大屏并未持有这个实时会话。', 409);
    this.stored.state.live.heartbeatAt = this.now();
    return this.get();
  }

  async reportLiveError(input: unknown): Promise<ExhibitionState> {
    if (!isRecord(input)) throw new ApiError('EXHIBITION_INVALID_SESSION', '错误报告无效。');
    const deviceId = shortText(input.deviceId, '设备 ID', 100);
    const state = this.stored.state;
    if (state.providerMode !== 'xmax' || !['generating', 'showcase'].includes(state.phase) || input.lookId !== state.selectedLookId || input.sessionNumber !== state.sessionNumber || input.generationNumber !== state.generationNumber
      || (input.sessionId && !state.live) || (state.live && (state.live.deviceId !== deviceId || state.live.sessionId !== input.sessionId))) throw new ApiError('EXHIBITION_OWNER_MISMATCH', '错误报告不属于当前体验。', 409);
    const message = shortText(input.message, '错误说明', 300).replace(/(?:tk|uk)-[A-Za-z0-9_-]+/g, '[凭证已隐藏]').replace(/https?:\/\/\S+/g, '[连接地址]');
    const draft = structuredClone(this.stored); draft.state.phase = 'paused'; draft.pausedPhase = 'generating'; draft.state.generationReadyAt = null;
    if (draft.state.live) { draft.state.live.status = 'error'; draft.state.live.error = message; }
    this.commit(draft, `实时体验已暂停：${message}`, this.now());
    await this.reconcileLive();
    if (this.stored.state.sessionNumber === input.sessionNumber && this.stored.state.generationNumber === input.generationNumber) this.commit(structuredClone(this.stored), `请检查后手动继续：${message}`, this.now());
    return this.get();
  }

  async bindLiveReference(id: string, input: unknown) {
    if (!isRecord(input) || !this.liveService || this.stored.state.live?.sessionId !== id || this.stored.state.live.deviceId !== input.deviceId
      || this.stored.state.live.lookId !== input.lookId || this.stored.state.live.generationNumber !== this.stored.state.generationNumber || this.stored.state.providerMode !== 'xmax' || this.stored.state.phase !== 'generating') throw new ApiError('EXHIBITION_OWNER_MISMATCH', '设备、服装或当前体验与会话不匹配。', 409);
    return this.liveService.bindExhibitionReference(id, { mirrorId: this.mirrorId, deviceId: input.deviceId as string, lookId: input.lookId as string, refImageUrl: input.refImageUrl as string });
  }

  liveFirstFrame(id: string, firstFrameMs: number) {
    const live = this.stored.state.live;
    if (!live || !['connecting', 'running'].includes(live.status) || live.generationNumber !== this.stored.state.generationNumber || live.sessionId !== id || this.stored.state.providerMode !== 'xmax' || this.stored.state.phase !== 'generating' || live.lookId !== this.stored.state.selectedLookId) return;
    const draft = structuredClone(this.stored);
    draft.state.phase = 'showcase'; draft.state.displayedLookId = live.lookId;
    draft.state.live!.status = 'running'; draft.state.live!.firstFrameMs = firstFrameMs; draft.state.live!.updatedAt = this.now();
    this.commit(draft, `${this.lookName(live.lookId)}已收到 XMAX 实时首帧。`, this.now());
  }

  async sweepLive() { this.tick(); await this.reconcileLive(); }

  reconcileLive(): Promise<void> {
    if (this.reconcilingLive) return this.reconcilingLive;
    this.reconcilingLive = this.reconcileLiveNow().finally(() => { this.reconcilingLive = undefined; });
    return this.reconcilingLive;
  }

  private async reconcileLiveNow() {
    const live = this.stored.state.live; const service = this.liveService;
    if (!live || !service || !live.sessionId) return;
    const id = live.sessionId;
    let session = await service.get(id, false);
    let state = this.stored.state;
    if (state.live?.sessionId !== id || state.live.generationNumber !== live.generationNumber) return;
    if (session.status === 'issuance_unknown' && service.isUnconfirmedExhibitionSession?.(id, this.mirrorId) === true) {
      const localEnded = state.live.localEnded === true && ['idle', 'select'].includes(state.phase);
      const message = localEnded ? '本地体验已结束，云端凭证状态待确认。' : 'XMAX 凭证签发状态未确认，请联系工作人员。';
      if ((!localEnded && state.phase !== 'paused') || state.live.status !== 'error' || state.live.error !== message || (state.live.localEnded === true && !localEnded)) {
        const draft = structuredClone(this.stored);
        if (!localEnded) { draft.state.phase = 'paused'; draft.pausedPhase = 'generating'; delete draft.state.live!.localEnded; }
        draft.state.generationReadyAt = null;
        draft.state.live!.status = 'error'; draft.state.live!.error = message; draft.state.live!.updatedAt = this.now();
        this.commit(draft, message, this.now());
      }
      return;
    }
    const ownerLost = this.now() - state.live.heartbeatAt >= HEARTBEAT_TIMEOUT_MS;
    const expired = !!session.expiresAt && Date.parse(session.expiresAt) <= this.now();
    const exhausted = session.consumedCredits >= session.pointsLimit;
    // A polling read cannot verify provider lifetime. Advance live results only after
    // checking the current credential here, before releasing it for the next material.
    if (session.status === 'active' && !ownerLost && !expired && !exhausted && this.canAutoSwitch(state, this.now())) {
      this.advanceAutomatic(this.now());
      state = this.stored.state;
    }
    const interrupted = live.generationNumber !== state.generationNumber || state.providerMode !== 'xmax' || !['generating', 'showcase'].includes(state.phase) || state.selectedLookId !== live.lookId;
    if (session.status !== 'stopped' && (interrupted || ownerLost || expired || exhausted || live.status === 'error' || session.status === 'stopping' || session.status === 'issuance_unknown')) {
      if (!['stopping', 'error'].includes(state.live?.status ?? '')) {
        const draft = structuredClone(this.stored);
        if (draft.state.live?.sessionId !== id) return;
        draft.state.live.status = 'stopping'; draft.state.live.updatedAt = this.now();
        this.commit(draft, ownerLost ? '大屏心跳中断，正在停用 XMAX 临时凭证。' : '正在停止上一轮实时会话。', this.now());
      }
      try { session = await service.stop(id); }
      catch (error) {
        const failed = structuredClone(this.stored);
        const message = error instanceof Error ? error.message : '停止尚未确认。';
        if (failed.state.live?.sessionId === id && (failed.state.live.status !== 'error' || failed.state.live.error !== message)) { failed.state.live.status = 'error'; failed.state.live.error = message; this.commit(failed, '实时会话停止尚未确认，禁止再次签发。', this.now()); }
        return;
      }
    }
    if (session.status === 'stopped' && this.stored.state.live?.sessionId === id) {
      const draft = structuredClone(this.stored); draft.state.live = null;
      if (!interrupted && draft.state.generationNumber === live.generationNumber && session.exhibition?.sessionNumber === draft.state.sessionNumber && ['generating', 'showcase'].includes(draft.state.phase)) { draft.state.phase = 'paused'; draft.pausedPhase = 'generating'; draft.state.generationReadyAt = null; }
      this.commit(draft, 'XMAX 临时凭证已停止，设备占用已释放。', this.now());
    }
  }

  /** Limits the JSON envelope before buffering its base64 payload. */
  uploadRequestLimit(): number { return Math.ceil(this.stored.state.settings.uploadLimits.maxFileSizeMB * MIB / 3) * 4 + 16_384; }

  asset(id: string): { data: Buffer; mime: 'image/webp' } {
    if (!UPLOAD_ID.test(id) || !this.stored.state.looks.some(look => look.id === id && look.source === 'upload')) throw new ApiError('EXHIBITION_ASSET_NOT_FOUND', '未找到服装素材。', 404);
    try { return { data: readFileSync(join(this.assetsDirectory, `${id}.webp`)), mime: 'image/webp' }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError('EXHIBITION_ASSET_NOT_FOUND', '未找到服装素材。', 404);
      throw error;
    }
  }

  async upload(input: unknown): Promise<ExhibitionState> {
    if (!isRecord(input)) throw new ApiError('EXHIBITION_INVALID_METADATA', '请提供有效的服装信息。');
    // Append-only uploads do not lock or reset the current visitor; playback revisions may advance while decoding.
    const payload = input;
    if (this.stored.state.looks.length >= MAX_LOOKS) throw new ApiError('EXHIBITION_CATALOG_FULL', `服装库最多保存 ${MAX_LOOKS} 套服装。`);
    if (this.uploadConcurrency.inProgress >= this.uploadConcurrency.limit) throw new ApiError('EXHIBITION_UPLOAD_BUSY', '已有素材正在处理，请稍后再试。', 429);
    const details = this.lookMetadata(payload);
    const limits = this.stored.state.settings.uploadLimits;
    if (typeof payload.imageBase64 !== 'string') throw new ApiError('EXHIBITION_INVALID_IMAGE', '请选择 PNG、JPEG 或 WebP 图片。');
    let encoded = payload.imageBase64;
    if (encoded.startsWith('data:')) {
      const prefix = /^data:image\/(png|jpeg|webp);base64,/.exec(encoded);
      if (!prefix) throw new ApiError('EXHIBITION_INVALID_IMAGE', '仅支持 PNG、JPEG 或 WebP 图片。');
      encoded = encoded.slice(prefix[0].length);
    }
    if (encoded.length > Math.ceil(limits.maxFileSizeMB * MIB / 3) * 4) throw new ApiError('EXHIBITION_IMAGE_TOO_LARGE', `图片不能超过 ${limits.maxFileSizeMB} MB。`, 413);
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new ApiError('EXHIBITION_INVALID_IMAGE', '图片编码无效。');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new ApiError('EXHIBITION_INVALID_IMAGE', '图片编码无效。');
    if (!bytes.length || bytes.length > limits.maxFileSizeMB * MIB) throw new ApiError('EXHIBITION_IMAGE_TOO_LARGE', `图片不能超过 ${limits.maxFileSizeMB} MB。`, 413);
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const supportedSignature = bytes.subarray(0, 8).equals(pngSignature)
      || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      || (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
    if (!supportedSignature) throw new ApiError('EXHIBITION_INVALID_IMAGE', '仅支持 PNG、JPEG 或 WebP 图片。');
    // libpng can read an APNG as its first frame, so reject the animation chunk explicitly.
    if (bytes.subarray(0, 8).equals(pngSignature)) {
      for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        if (bytes.subarray(offset + 4, offset + 8).toString('ascii') === 'acTL') throw new ApiError('EXHIBITION_INVALID_IMAGE', '仅支持静态图片，请先导出单张图片。');
        offset += length + 12;
      }
    }
    this.uploadConcurrency.inProgress += 1;
    this.uploadsInProgress += 1;
    try {
      let normalized: { data: Buffer; info: OutputInfo };
      try {
        const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS });
        const metadata = await decoder.metadata();
        if (!metadata.format || !['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw new ApiError('EXHIBITION_INVALID_IMAGE', '仅支持静态 PNG、JPEG 或 WebP 图片。');
        const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
        const width = (rotated ? metadata.height : metadata.width) ?? 0;
        const height = (rotated ? metadata.width : metadata.height) ?? 0;
        if (width < limits.minWidth || width > limits.maxWidth || height < limits.minHeight || height > limits.maxHeight || width * height > MAX_INPUT_PIXELS) {
          throw new ApiError('EXHIBITION_INVALID_DIMENSIONS', `图片宽度需为 ${limits.minWidth}–${limits.maxWidth} px，高度需为 ${limits.minHeight}–${limits.maxHeight} px，且总像素不超过 3200 万。`);
        }
        // Re-encoding forces a complete decode, normalizes orientation, strips metadata and any appended payload.
        normalized = await decoder.rotate().webp({ quality: 95, effort: 3 }).toBuffer({ resolveWithObject: true });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('EXHIBITION_INVALID_IMAGE', '图片无法完整解码，可能已损坏、格式不支持或总像素过大。');
      }
      // Merge onto the latest state after decoding. Only upload rules, taxonomy and catalog capacity
      // constrain this append; live ownership, playback state and idle deadlines are left intact.
      const latestLimits = this.stored.state.settings.uploadLimits;
      if (bytes.length > latestLimits.maxFileSizeMB * MIB) throw new ApiError('EXHIBITION_UPLOAD_RULES_CHANGED', `上传限制已更新，图片不能超过 ${latestLimits.maxFileSizeMB} MB。请重新选择图片。`, 409);
      const { width, height } = normalized.info;
      if (width < latestLimits.minWidth || width > latestLimits.maxWidth || height < latestLimits.minHeight || height > latestLimits.maxHeight || width * height > MAX_INPUT_PIXELS) {
        throw new ApiError('EXHIBITION_UPLOAD_RULES_CHANGED', `上传限制已更新：宽 ${latestLimits.minWidth}–${latestLimits.maxWidth} px，高 ${latestLimits.minHeight}–${latestLimits.maxHeight} px。请重新选择图片。`, 409);
      }
      if (!this.stored.state.categories.includes(details.category) || details.tags.some(tag => !this.stored.state.tags.includes(tag))) {
        throw new ApiError('EXHIBITION_UPLOAD_TAXONOMY_CHANGED', '所选分类或标签在上传期间已被移除，请重新选择后上传。', 409);
      }
      if (this.stored.state.looks.length >= MAX_LOOKS) throw new ApiError('EXHIBITION_CATALOG_FULL', `服装库最多保存 ${MAX_LOOKS} 套服装。`, 409);
      const id = `upload-${randomUUID()}`;
      const draft = structuredClone(this.stored);
      draft.state.looks.push({ id, ...details, image: `${this.assetBasePath}/${id}`, palette: '', source: 'upload',
        width: normalized.info.width, height: normalized.info.height, bytes: normalized.data.length, mime: 'image/webp' });
      const filename = join(this.assetsDirectory, `${id}.webp`);
      mkdirSync(this.assetsDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(filename, normalized.data, { mode: 0o600, flag: 'wx' });
      try { this.commit(draft, `服装「${details.name}」已上传，启用后会出现在大屏。`, this.now()); }
      catch (error) { rmSync(filename, { force: true }); throw error; }
      return structuredClone(this.stored.state);
    } finally { this.uploadConcurrency.inProgress -= 1; this.uploadsInProgress -= 1; }
  }

  /** Copies a configuration snapshot; live ownership and history always belong to the target. */
  copyFrom(source: ExhibitionService, input: { expectedRevision: number; copyLooks: boolean; copySettings: boolean }): ExhibitionState {
    this.editableInput(input);
    if (this.stored.state.live || this.uploadsInProgress > 0) throw new ApiError('EXHIBITION_MIRROR_BUSY', '请等待此设备的会话或素材上传结束，再复制数据。', 409);
    const sourceState = source.get();
    if (input.copySettings && sourceState.providerMode === 'xmax' && !this.liveService?.status(this.mirrorId).configured) throw new ApiError('MISSING_API_KEY', '请先配置 XMAX 服务端凭证。', 503);
    // A replace operation may delete every prior uploaded file. Publish a complete
    // restorable snapshot before writing any replacement asset or state.
    this.backupBeforeCopy(source.mirrorId, input);
    const draft = structuredClone(this.stored);
    const previousUploads = input.copyLooks ? draft.state.looks.filter(look => look.source === 'upload').map(look => look.id) : [];
    const copiedFiles: string[] = [];
    try {
      if (input.copyLooks) {
        const remapped = new Map<string, string>();
        draft.state.looks = sourceState.looks.map(look => {
          if (look.source === 'sample') { remapped.set(look.id, look.id); return structuredClone(look); }
          const asset = source.asset(look.id);
          const id = `upload-${randomUUID()}`;
          const filename = join(this.assetsDirectory, `${id}.webp`);
          mkdirSync(this.assetsDirectory, { recursive: true, mode: 0o700 });
          copiedFiles.push(filename);
          writeFileSync(filename, asset.data, { flag: 'wx', mode: 0o600 });
          remapped.set(look.id, id);
          return { ...structuredClone(look), id, image: `${this.assetBasePath}/${id}` };
        });
        draft.state.categories = [...sourceState.categories];
        draft.state.tags = [...sourceState.tags];
        draft.state.enabledLookIds = sourceState.enabledLookIds.map(id => remapped.get(id)!);
        draft.state.selectedLookId = null;
      }
      if (input.copySettings) {
        draft.state.settings = structuredClone(sourceState.settings);
        if (sourceState.settings.uiSkin) draft.state.settings.uiSkin = this.skinStore.copyFrom(source.skinStore, sourceState.settings.uiSkin);
        draft.state.providerMode = sourceState.providerMode;
        draft.state.experienceMode = sourceState.experienceMode;
      }
      this.reset(draft, 'idle');
      reconcileSelection(draft.state);
      draft.lastCommandAt = this.now();
      this.checkRevision(input.expectedRevision);
      this.commit(draft, '设备数据已复制，复制前数据已备份。', this.now());
    } catch (error) {
      for (const filename of copiedFiles) { try { rmSync(filename, { force: true }); } catch { /* Unreferenced files are never served. */ } }
      throw error;
    }
    for (const id of previousUploads) { try { rmSync(join(this.assetsDirectory, `${id}.webp`), { force: true }); } catch { /* State was committed; stale files are not served. */ } }
    return structuredClone(this.stored.state);
  }

  private backupBeforeCopy(sourceMirrorId: string, input: { copyLooks: boolean; copySettings: boolean }): void {
    const name = `before-copy-${this.now()}-${randomUUID()}`;
    const staging = join(this.copyBackupsDirectory, `.pending-${randomUUID()}`);
    try {
      mkdirSync(this.copyBackupsDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, 'exhibition.json'), JSON.stringify(this.stored), { flag: 'wx', mode: 0o600 });
      const uploads = this.stored.state.looks.filter(look => look.source === 'upload');
      if (uploads.length) {
        const assets = join(staging, 'exhibition-assets'); mkdirSync(assets, { mode: 0o700 });
        for (const look of uploads) writeFileSync(join(assets, `${look.id}.webp`), this.asset(look.id).data, { flag: 'wx', mode: 0o600 });
      }
      const skin = this.stored.state.settings.uiSkin;
      if (skin) {
        const id = skin.image.split('/').at(-1)!;
        const skins = join(staging, 'exhibition-skins'); mkdirSync(skins, { mode: 0o700 });
        writeFileSync(join(skins, `${id}.webp`), this.skinStore.asset(id).data, { flag: 'wx', mode: 0o600 });
      }
      writeFileSync(join(staging, 'backup.json'), JSON.stringify({ schemaVersion: 1, reason: 'before-copy', createdAt: this.now(),
        targetMirrorId: this.mirrorId, sourceMirrorId, revision: this.stored.state.revision, copyLooks: input.copyLooks, copySettings: input.copySettings }), { flag: 'wx', mode: 0o600 });
      // A final directory always denotes a complete snapshot. Interrupted or
      // failed writes stay hidden in staging and never authorize replacement.
      renameSync(staging, join(this.copyBackupsDirectory, name));
    } catch {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* Never serve or treat partial staging directories as recoverable backups. */ }
      throw new ApiError('EXHIBITION_COPY_BACKUP_FAILED', '复制前备份未完成，原有素材与设置已保留。请检查存储空间后重试。', 500);
    }
  }

  updateLook(id: string, input: unknown): ExhibitionState {
    const payload = this.editableInput(input);
    const index = this.stored.state.looks.findIndex(look => look.id === id);
    if (index < 0) throw new ApiError('EXHIBITION_INVALID_LOOK', '未找到这套服装。', 404);
    const existing = this.stored.state.looks[index];
    const details = this.lookMetadata({ ...existing, ...payload });
    const draft = structuredClone(this.stored); draft.state.looks[index] = { ...existing, ...details };
    reconcileSelection(draft.state);
    this.commit(draft, `服装「${details.name}」的信息已保存。`, this.now()); return structuredClone(this.stored.state);
  }

  removeLook(id: string, input: unknown): ExhibitionState {
    this.editableInput(input);
    const state = this.stored.state;
    const existing = state.looks.find(look => look.id === id);
    if (!existing) throw new ApiError('EXHIBITION_INVALID_LOOK', '未找到这套服装。', 404);
    const remainingEnabled = state.enabledLookIds.filter(lookId => lookId !== id);
    const draft = structuredClone(this.stored);
    draft.state.looks = draft.state.looks.filter(look => look.id !== id);
    draft.state.enabledLookIds = remainingEnabled;
    reconcileSelection(draft.state);
    if (draft.state.displayedLookId === id) draft.state.displayedLookId = null;
    this.commit(draft, `服装「${existing.name}」已删除。`, this.now());
    if (existing.source === 'upload') {
      // Commit first so a failed state write keeps the image intact. A cleanup failure
      // leaves an inaccessible orphan instead of reporting a committed deletion as failed.
      try { rmSync(join(this.assetsDirectory, `${id}.webp`), { force: true }); } catch { /* Catalog membership gates all asset reads. */ }
    }
    return structuredClone(this.stored.state);
  }

  taxonomy(input: unknown): ExhibitionState {
    const payload = this.editableInput(input);
    const categories = nameList(payload.categories, '分类', 40, false);
    const tags = nameList(payload.tags, '标签', 80, true);
    if (this.stored.state.looks.some(look => !categories.includes(look.category) || look.tags.some(tag => !tags.includes(tag)))) throw new ApiError('EXHIBITION_TAXONOMY_IN_USE', '部分分类或标签仍被服装使用，请先修改对应服装。', 409);
    const draft = structuredClone(this.stored); draft.state.categories = categories; draft.state.tags = tags;
    this.commit(draft, '单级分类与标签已保存。', this.now()); return structuredClone(this.stored.state);
  }

  updateUiSkin(skin: ExhibitionUiSkin | null, expectedRevision?: number): ExhibitionState {
    this.editableInput({ expectedRevision });
    if (this.stored.state.live) throw new ApiError('EXHIBITION_MIRROR_BUSY', '请等待实时会话停止后再更换界面皮肤。', 409);
    if (!isUiSkin(skin)) throw new ApiError('EXHIBITION_INVALID_SKIN', '界面皮肤信息无效。');
    const draft = structuredClone(this.stored); draft.state.settings.uiSkin = skin === null ? null : { ...skin };
    if (skin === null) draft.state.settings.uiSkinPreset = 'crystal';
    this.commit(draft, skin ? '镜端界面皮肤已更新。' : '镜端界面皮肤已恢复默认。', this.now());
    return structuredClone(this.stored.state);
  }

  async uploadUiSkin(input: unknown): Promise<ExhibitionState> {
    const payload = this.editableInput(input);
    if (this.stored.state.live) throw new ApiError('EXHIBITION_MIRROR_BUSY', '请等待实时会话停止后再更换界面皮肤。', 409);
    const prepared = await this.skinStore.prepare(payload.imageBase64);
    this.editableInput(payload);
    if (this.stored.state.live) throw new ApiError('EXHIBITION_MIRROR_BUSY', '请等待实时会话停止后再更换界面皮肤。', 409);
    const skin = this.skinStore.install(prepared);
    return this.updateUiSkin(skin, payload.expectedRevision as number | undefined);
  }

  removeUiSkin(input: unknown): ExhibitionState {
    const payload = this.editableInput(input);
    return this.updateUiSkin(null, payload.expectedRevision as number | undefined);
  }

  uiSkinAsset(id: string): { data: Buffer; mime: 'image/webp' } {
    const skin = this.stored.state.settings.uiSkin;
    if (!skin || skin.image !== `${this.assetBasePath.replace(/\/assets$/u, '/skin')}/${id}`) throw new ApiError('EXHIBITION_SKIN_NOT_FOUND', '未找到界面皮肤。', 404);
    return this.skinStore.asset(id);
  }

  /** Synchronous validation and atomic rename serialize all state mutations after any image decoding. */
  command(input: unknown): ExhibitionState {
    if (!isRecord(input) || typeof input.action !== 'string') throw new ApiError('EXHIBITION_INVALID_COMMAND', '请选择有效的展会操作。');
    this.tick(); this.checkRevision(input.expectedRevision);
    const draft = structuredClone(this.stored); const state = draft.state; const time = this.now(); let message: string;
    const isLookId = (id: unknown): id is string => typeof id === 'string' && state.looks.some(look => look.id === id);
    const currentModeIds = activeLookIds(state);
    const requireSelection = () => { if (state.selectedLookId === null || !currentModeIds.includes(state.selectedLookId)) throw new ApiError('EXHIBITION_NO_ENABLED_LOOKS', '当前模式暂无启用素材，请先上传并启用素材。', 409); };
    const requirePhase = (...phases: ExhibitionPhase[]) => { if (!phases.includes(state.phase)) throw new ApiError('EXHIBITION_INVALID_PHASE', '当前体验阶段无法执行此操作。', 409); };
    switch (input.action) {
      case 'select':
        requirePhase('select', 'idle');
        if (!isLookId(input.lookId) || !currentModeIds.includes(input.lookId)) throw new ApiError('EXHIBITION_INVALID_LOOK', '这份素材不属于当前模式或尚未启用。');
        state.selectedLookId = input.lookId; state.phase = 'select'; message = `已选择${this.lookName(state.selectedLookId)}。`; break;
      case 'begin':
        requirePhase('select', 'idle');
        if (state.live) throw new ApiError('EXHIBITION_LIVE_STOP_PENDING', '上一轮停止尚未确认，请重试停止后再开始。', 409);
        requireSelection(); state.phase = 'generating'; state.sessionNumber += 1; state.generationNumber += 1; state.displayedLookId = null;
        state.generationReadyAt = state.providerMode === 'demo' ? time + GENERATION_DELAY_MS : null;
        message = state.providerMode === 'demo' ? `第 ${state.sessionNumber} 轮演示已开始，正在准备换装画面。` : `第 ${state.sessionNumber} 轮体验已开始，等待大屏连接实时换装。`; break;
      case 'confirm':
        // Only older clients can retain a positioning round; new rounds start generating atomically.
        requirePhase('positioning'); requireSelection(); state.phase = 'generating'; state.generationNumber += 1; state.generationReadyAt = state.providerMode === 'demo' ? time + GENERATION_DELAY_MS : null;
        message = state.providerMode === 'demo' ? '站位已手动确认，正在演示换装流程。' : '站位已确认，等待拥有摄像头的大屏连接 XMAX。'; break;
      case 'switch':
        requirePhase('showcase');
        if (!isLookId(input.lookId) || !currentModeIds.includes(input.lookId)) throw new ApiError('EXHIBITION_INVALID_LOOK', '这份素材不属于当前模式或尚未启用。');
        // Tapping the current outfit must not restart or allocate another live session.
        if (input.lookId === state.selectedLookId) return structuredClone(this.stored.state);
        state.selectedLookId = input.lookId; state.phase = 'generating'; state.generationNumber += 1;
        state.generationReadyAt = state.providerMode === 'demo' ? time + GENERATION_DELAY_MS : null;
        message = `正在切换至${this.lookName(state.selectedLookId)}${state.providerMode === 'demo' ? '演示图' : '实时造型'}。`; break;
      case 'next':
      case 'previous': {
        requirePhase('showcase'); requireSelection(); const current = currentModeIds.indexOf(state.selectedLookId!); const direction = input.action === 'next' ? 1 : -1;
        if (currentModeIds.length === 1) return structuredClone(this.stored.state);
        state.selectedLookId = currentModeIds[(current + direction + currentModeIds.length) % currentModeIds.length];
        state.phase = 'generating'; state.generationNumber += 1; state.generationReadyAt = state.providerMode === 'demo' ? time + GENERATION_DELAY_MS : null;
        message = `正在切换至${this.lookName(state.selectedLookId)}演示图。`; break;
      }
      case 'pause':
        requirePhase('generating', 'showcase'); draft.pausedPhase = state.phase as 'generating' | 'showcase';
        draft.pausedRemainingMs = state.generationReadyAt === null ? 0 : Math.max(0, state.generationReadyAt - time);
        state.phase = 'paused'; state.generationReadyAt = null; message = '工作人员已暂停本轮演示。'; break;
      case 'resume':
        requirePhase('paused');
        if (state.live) throw new ApiError('EXHIBITION_LIVE_STOP_PENDING', '上一轮停止尚未确认，请重试停止后再继续。', 409);
        requireSelection(); if (!draft.pausedPhase) throw new ApiError('EXHIBITION_INVALID_PHASE', '没有可以继续的演示，请重新开始。', 409);
        state.phase = state.providerMode === 'xmax' ? 'generating' : draft.pausedPhase; if (state.phase === 'generating') state.generationNumber += 1; state.generationReadyAt = state.providerMode === 'demo' && state.phase === 'generating' ? time + draft.pausedRemainingMs : null;
        draft.pausedPhase = null; draft.pausedRemainingMs = 0; message = '本轮演示已继续。'; break;
      case 'end':
      case 'idle': {
        const phase = input.action === 'end' ? 'select' : 'idle';
        const unknown = state.live?.sessionId && this.liveService?.isUnconfirmedExhibitionSession?.(state.live.sessionId, this.mirrorId) === true;
        if (unknown && state.phase === phase && state.live?.localEnded === true && state.live.status === 'error') return structuredClone(this.stored.state);
        this.reset(draft, phase);
        if (unknown && state.live) {
          state.live.localEnded = true; state.live.status = 'error'; state.live.updatedAt = time;
          state.live.error = '本地体验已结束，云端凭证状态待确认。'; message = state.live.error;
        } else message = input.action === 'end' ? state.live ? '正在停止体验。' : '体验已结束，已返回选衣页。' : state.live ? '正在停止体验并返回待机。' : '大屏已返回待机展示。';
        break;
      }
      case 'recover': {
        requirePhase('select', 'idle');
        if (!state.live) return structuredClone(this.stored.state);
        if (state.live.localEnded !== true || state.live.status !== 'error' || !state.live.sessionId
          || this.liveService?.isUnconfirmedExhibitionSession(state.live.sessionId, this.mirrorId) !== true) {
          throw new ApiError('EXHIBITION_RECOVERY_UNAVAILABLE', '请先结束体验并确认旧会话状态后再恢复。', 409);
        }
        // A lost issuance response has no token to revoke. Detach only its ended
        // local lease; its unknown cloud record, signing key and allocation stay intact.
        this.reset(draft, state.phase === 'idle' ? 'idle' : 'select');
        state.live = null; state.generationNumber += 1;
        message = '镜端已恢复，旧会话记录保留。'; break;
      }
      case 'reorder': {
        requirePhase('select', 'idle');
        if (state.live) throw new ApiError('EXHIBITION_MIRROR_BUSY', '请等待实时会话停止后再调整素材顺序。', 409);
        if (!isMode(input.experienceMode)) throw new ApiError('EXHIBITION_INVALID_MODE', '请选择要排序的素材模式。');
        const mode = input.experienceMode;
        const looks = state.looks.filter(look => look.mode === mode);
        if (!Array.isArray(input.lookIds) || input.lookIds.length !== looks.length || new Set(input.lookIds).size !== looks.length
          || !input.lookIds.every(id => typeof id === 'string' && looks.some(look => look.id === id))) throw new ApiError('EXHIBITION_INVALID_LOOK_ORDER', '请提交该模式全部素材的顺序，素材不能重复、遗漏或跨模式。');
        const lookIds = input.lookIds as string[];
        if (lookIds.every((id, index) => id === looks[index].id)) return structuredClone(this.stored.state);
        const ordered = new Map(looks.map(look => [look.id, look]));
        let catalogIndex = 0;
        state.looks = state.looks.map(look => look.mode === mode ? ordered.get(lookIds[catalogIndex++])! : look);
        const enabled = new Set(state.enabledLookIds);
        const enabledOrder = lookIds.filter(id => enabled.has(id));
        let enabledIndex = 0;
        state.enabledLookIds = state.enabledLookIds.map(id => ordered.has(id) ? enabledOrder[enabledIndex++] : id);
        message = '素材顺序已保存，大屏选择和自动换装按此顺序播放。'; break;
      }
      case 'configure': {
        const otherSettings = input.enabledLookIds !== undefined || input.autoReturnSeconds !== undefined || input.uploadLimits !== undefined || input.providerMode !== undefined || input.experienceMode !== undefined || input.uiSkinPreset !== undefined;
        if (otherSettings) requirePhase('select', 'idle');
        if (!otherSettings && input.switchMode === undefined && input.autoSwitchSeconds === undefined) throw new ApiError('EXHIBITION_INVALID_SETTINGS', '请提供要更新的展会设置。');
        if (input.switchMode !== undefined) {
          if (!isSwitchMode(input.switchMode)) throw new ApiError('EXHIBITION_INVALID_SETTINGS', '请选择手动换装或自动换装。');
          if (state.settings.switchMode !== input.switchMode) state.autoSwitchAt = null;
          state.settings.switchMode = input.switchMode;
        }
        if (input.autoSwitchSeconds !== undefined) {
          if (!isAutoSwitchSeconds(input.autoSwitchSeconds)) throw new ApiError('EXHIBITION_INVALID_SETTINGS', `自动换装间隔需为 ${EXHIBITION_AUTO_SWITCH_MIN_SECONDS}–${EXHIBITION_AUTO_SWITCH_MAX_SECONDS} 秒的整数。`);
          if (state.settings.autoSwitchSeconds !== input.autoSwitchSeconds) state.autoSwitchAt = null;
          state.settings.autoSwitchSeconds = input.autoSwitchSeconds;
        }
        if (input.experienceMode !== undefined) {
          if (!isMode(input.experienceMode)) throw new ApiError('EXHIBITION_INVALID_MODE', '请选择有效的体验模式。');
          if (state.live) throw new ApiError('EXHIBITION_MIRROR_BUSY', '请等待实时会话停止后再切换体验模式。', 409);
          if (state.experienceMode !== input.experienceMode) { state.experienceMode = input.experienceMode; this.reset(draft, 'idle'); }
        }
        if (input.uiSkinPreset !== undefined) {
          if (!isUiSkinPreset(input.uiSkinPreset)) throw new ApiError('EXHIBITION_INVALID_SETTINGS', '请选择有效的界面皮肤。');
          if (state.live) throw new ApiError('EXHIBITION_MIRROR_BUSY', '请等待实时会话停止后再更换界面皮肤。', 409);
          state.settings.uiSkinPreset = input.uiSkinPreset;
          state.settings.uiSkin = null;
        }
        if (input.enabledLookIds !== undefined) {
          if (!Array.isArray(input.enabledLookIds) || !input.enabledLookIds.every(isLookId) || new Set(input.enabledLookIds).size !== input.enabledLookIds.length) throw new ApiError('EXHIBITION_INVALID_LOOKS', '启用素材必须存在，且不能重复。');
          state.enabledLookIds = [...input.enabledLookIds];
        }
        if (input.autoReturnSeconds !== undefined) {
          if (!isAutoReturn(input.autoReturnSeconds)) throw new ApiError('EXHIBITION_INVALID_SETTINGS', '自动返回时间需为 15–600 秒的整数，或设为 0 关闭。');
          state.settings.autoReturnSeconds = input.autoReturnSeconds;
        }
        if (input.uploadLimits !== undefined) {
          if (!validLimits(input.uploadLimits)) throw new ApiError('EXHIBITION_INVALID_SETTINGS', '文件限制需为 1–20 MB 的整数；宽高需为 64–8192 px 的整数，最小值不能超过最大值，最小宽高总像素不能超过 3200 万。');
          state.settings.uploadLimits = { ...input.uploadLimits };
        }
        if (input.providerMode !== undefined) {
          if (input.providerMode !== 'demo' && input.providerMode !== 'xmax') throw new ApiError('EXHIBITION_INVALID_SETTINGS', '请选择演示或 XMAX 实时模式。');
          if (input.providerMode === 'xmax' && !this.liveService?.status(this.mirrorId).configured) throw new ApiError('MISSING_API_KEY', '请先配置 XMAX 服务端凭证。', 503);
          state.providerMode = input.providerMode;
        }
        reconcileSelection(state); message = '展会设置已保存。'; break;
      }
      default: throw new ApiError('EXHIBITION_INVALID_COMMAND', '未知的展会操作。');
    }
    const live = state.live;
    const interruptedSession = live?.sessionId && (live.generationNumber !== state.generationNumber || state.providerMode !== 'xmax'
      || !['generating', 'showcase'].includes(state.phase) || live.lookId !== state.selectedLookId) ? live.sessionId : undefined;
    const locallyEnded = live?.localEnded === true && live.status === 'error' && live.sessionId && this.liveService?.isUnconfirmedExhibitionSession?.(live.sessionId, this.mirrorId) === true;
    if (interruptedSession && live && !locallyEnded) { delete live.localEnded; live.status = 'stopping'; live.updatedAt = time; }
    draft.lastCommandAt = time; this.commit(draft, message, time);
    // Block delayed reference/link/signing completions before awaiting revocation.
    if (interruptedSession) this.liveService?.cancelExhibitionSession(interruptedSession, this.mirrorId);
    return structuredClone(this.stored.state);
  }

  private checkRevision(revision: unknown) {
    if (revision === undefined) return;
    if (!isNonnegativeInteger(revision)) throw new ApiError('EXHIBITION_INVALID_REVISION', '状态版本无效，请刷新后重试。');
    if (revision !== this.stored.state.revision) throw new ApiError('EXHIBITION_STALE_REVISION', '屏幕状态已更新，请刷新后重试。', 409);
  }
  private editableInput(input: unknown): Record<string, unknown> {
    if (!isRecord(input)) throw new ApiError('EXHIBITION_INVALID_METADATA', '请提供有效的服装库信息。');
    this.tick(); this.checkRevision(input.expectedRevision);
    if (!['idle', 'select'].includes(this.stored.state.phase)) throw new ApiError('EXHIBITION_INVALID_PHASE', '请先结束当前体验，再编辑服装库。', 409);
    return input;
  }
  private lookMetadata(input: Record<string, unknown>): Pick<ExhibitionLook, 'name' | 'description' | 'category' | 'tags' | 'mode' | 'prompt' | 'referenceKind'> {
    const name = shortText(input.name, '服装名称', 40); const description = shortText(input.description ?? '', '服装描述', 120, true);
    const mode = input.mode ?? 'clothx';
    if (!isMode(mode)) throw new ApiError('EXHIBITION_INVALID_MODE', '请选择有效的体验模式。');
    const referenceKind = input.referenceKind;
    if ((referenceKind !== undefined && referenceKind !== 'image' && referenceKind !== 'none') || (referenceKind === 'none' && mode !== 'free')) throw new ApiError('EXHIBITION_INVALID_REFERENCE', '仅 Free 模式可以不使用参考图。');
    const prompt = mode === 'free' ? freePrompt(input.prompt) : undefined;
    const category = shortText(input.category ?? this.stored.state.categories[0], '分类', 20); const tags = nameList(input.tags ?? [], '服装标签', 8, true);
    if (!this.stored.state.categories.includes(category) || tags.some(tag => !this.stored.state.tags.includes(tag))) throw new ApiError('EXHIBITION_UNKNOWN_TAXONOMY', '请先在分类标签管理中添加分类或标签。');
    return { name, description, category, tags, mode, prompt, ...(referenceKind === undefined ? {} : { referenceKind }) };
  }
  private lookName(id: string | null): string { return this.stored.state.looks.find(look => look.id === id)?.name ?? '素材'; }
  private reset(draft: StoredExhibition, phase: 'idle' | 'select') {
    draft.state.phase = phase; draft.state.displayedLookId = null; draft.state.generationReadyAt = null; draft.state.autoSwitchAt = null; draft.pausedPhase = null; draft.pausedRemainingMs = 0;
    reconcileSelection(draft.state);
  }
  private autoSwitchEligible(state: ExhibitionState, time: number) {
    if (state.settings.switchMode !== 'auto' || state.phase !== 'showcase' || activeLookIds(state).length < 2) return false;
    return state.providerMode === 'demo' || (!!state.live?.sessionId && state.live.status === 'running' && state.live.generationNumber === state.generationNumber
      && state.live.lookId === state.selectedLookId && time - state.live.heartbeatAt < HEARTBEAT_TIMEOUT_MS);
  }
  private canAutoSwitch(state: ExhibitionState, time: number) {
    return this.autoSwitchEligible(state, time) && state.autoSwitchAt != null && time >= state.autoSwitchAt;
  }
  private advanceAutomatic(time: number) {
    const draft = structuredClone(this.stored); const state = draft.state;
    const ids = activeLookIds(state); const current = ids.indexOf(state.selectedLookId!);
    if (current < 0 || ids.length < 2) return;
    state.selectedLookId = ids[(current + 1) % ids.length]; state.phase = 'generating'; state.generationNumber += 1;
    state.generationReadyAt = state.providerMode === 'demo' ? time + GENERATION_DELAY_MS : null;
    draft.lastCommandAt = time;
    this.commit(draft, `自动切换至${this.lookName(state.selectedLookId)}。`, time);
  }
  private tick() {
    const { state, lastCommandAt } = this.stored; const time = this.now();
    const automaticExperience = state.settings.switchMode === 'auto' && ['generating', 'showcase'].includes(state.phase);
    if (!automaticExperience && state.phase !== 'idle' && state.phase !== 'paused' && state.settings.autoReturnSeconds > 0 && time - lastCommandAt >= state.settings.autoReturnSeconds * 1_000) {
      const draft = structuredClone(this.stored); this.reset(draft, 'idle'); this.commit(draft, '长时间未操作，大屏已自动返回待机。', time);
    } else if (state.providerMode === 'demo' && state.phase === 'generating' && state.generationReadyAt !== null && time >= state.generationReadyAt) {
      const draft = structuredClone(this.stored); draft.state.phase = 'showcase'; draft.state.displayedLookId = draft.state.selectedLookId; draft.state.generationReadyAt = null;
      this.commit(draft, `${this.lookName(draft.state.selectedLookId)}演示图已展示。`, time);
    } else if (state.providerMode === 'demo' && this.canAutoSwitch(state, time)) {
      this.advanceAutomatic(time);
    }
  }
  private commit(draft: StoredExhibition, message: string, time: number) {
    if (!this.autoSwitchEligible(draft.state, time)) draft.state.autoSwitchAt = null;
    else if (draft.state.autoSwitchAt == null) draft.state.autoSwitchAt = time + (draft.state.settings.autoSwitchSeconds ?? EXHIBITION_AUTO_SWITCH_DEFAULT_SECONDS) * 1_000;
    draft.state.revision = this.stored.state.revision + 1; draft.state.updatedAt = time;
    draft.state.logs = [{ id: randomUUID(), time, message }, ...draft.state.logs].slice(0, MAX_LOGS);
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(draft), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.filename); this.stored = draft; }
    finally { rmSync(temporary, { force: true }); }
  }
}
