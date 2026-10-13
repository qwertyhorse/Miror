import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type CreatedSession, type SessionData } from '../api';
import { appUrl } from '../versionScope';
import { exhibitionApiPath } from './mirrorApi';
import { cameraCaptureConstraints, readCameraPreference } from './cameraPreference';
import { acquireExhibitionCamera, cameraTrackDeviceId } from './cameraCapture';
import { exhibitionLiveFailure, safeExhibitionErrorMessage } from './liveFailure';
import type { ConnectOptions, SdkSession } from '../sdkTypes';
import { exhibitionPromptForLook, type ExhibitionExperienceMode, type ExhibitionLiveStatus, type ExhibitionState } from '../../shared/exhibition';
import { isXmaxRegion, type XmaxRegion } from '../../shared/xmax';
import type { RealtimePresentationState } from '@xmaxai/sdk-global';
import type { MoXInteraction } from './MoXDragSurface';
import type { DiagnosticEventInput } from './diagnostics';
import { exhibitionSdk, prepareExhibitionEntry } from './sdkPreparation';

export type ExhibitionCameraStatus = 'off' | 'opening' | 'preview' | 'preparing' | 'connecting' | 'running' | 'stopping' | 'error' | 'other-device';
type LiveSession = CreatedSession & { exhibition: { mirrorId?: string; lookId: string; deviceId: string; sessionNumber: number; generationNumber: number; mode?: ExhibitionExperienceMode; prompt?: string } };
interface LiveInput { mirrorId?: string; terminalId?: string; terminalToken?: string; deviceId: string; lookId: string; sessionNumber: number; generationNumber: number; expectedRevision: number; image: string; referenceKind?: 'image' | 'none'; mode?: ExhibitionExperienceMode; prompt?: string; stream?: MediaStream; prefetchImages?: string[]; }
interface ConditionInput { deviceId: string; lookId: string; sessionNumber: number; generationNumber: number; refImageUrl?: string; }
export interface ExhibitionSdkSession extends Omit<SdkSession, 'set'> {
  set(context: { prompt: string; refImageUrl?: string | null }): Promise<void>;
  media?: { streamSetting: { width: number; height: number } };
  beginDrag?: () => void; endDrag?: () => void; sendTracks?: (tracks: Array<[number, number]>) => Promise<void>;
}
interface ExhibitionConnectOptions extends Omit<ConnectOptions, 'onError' | 'onDisconnect'> {
  onError: (message: string, error?: unknown) => void;
  onDisconnect: (reason?: unknown, details?: unknown) => void;
  onPresentationChange?: (state: Readonly<RealtimePresentationState>) => void;
}
interface ConnectionEvents { status: (status: ExhibitionCameraStatus, message?: string) => void; stream: (stream: MediaStream | null) => void; refresh: () => void; updateError?: (message: string) => void; interaction?: (value: MoXInteraction | null) => void; presentation?: (value: Readonly<RealtimePresentationState> | null) => void; diagnostic?: (event: DiagnosticEventInput) => void; }
interface DiagnosticOperation { input: LiveInput; operationId: string; context: DiagnosticEventInput['context']; }
let diagnosticConnectionSequence = 0;
export interface ExhibitionLiveDeps {
  create: (input: LiveInput) => Promise<LiveSession>;
  reference: (input: LiveInput, signal: AbortSignal) => Promise<File>;
  upload: (file: File, token: string, signal: AbortSignal, region?: XmaxRegion) => Promise<string>;
  bind: (id: string, input: { deviceId: string; lookId: string; refImageUrl: string }, signal: AbortSignal) => Promise<SessionData>;
  updateCondition?: (id: string, input: ConditionInput, signal: AbortSignal) => Promise<SessionData>;
  conditionApplied?: (id: string, input: ConditionInput & { referenceVersion: number }, signal: AbortSignal) => Promise<unknown>;
  connect: (source: MediaStream | File, local: LiveSession, callbacks: ExhibitionConnectOptions) => Promise<ExhibitionSdkSession>;
  link: (id: string, providerSessionId: string) => Promise<SessionData>;
  firstFrame: (id: string, firstFrameMs: number) => Promise<SessionData>;
  stop: (id: string) => Promise<SessionData>;
  heartbeat: (id: string, deviceId: string, signal: AbortSignal) => Promise<unknown>;
  reportError: (input: { deviceId: string; sessionId?: string; lookId: string; sessionNumber: number; generationNumber: number; message: string }) => Promise<unknown>;
  clone: (stream: MediaStream) => MediaStream;
  now: () => number;
  prepare: (region?: XmaxRegion) => Promise<unknown>;
}
function liveDefaults(mirrorId: string): ExhibitionLiveDeps {
  const path = (suffix: string) => exhibitionApiPath(suffix, mirrorId);
  const sessionPath = (id: string, action: string) => path(`sessions/${encodeURIComponent(id)}/${action}`);
  const createFilesClient = async (token: string, region: XmaxRegion) => {
    const { createXmaxClient } = await exhibitionSdk(region);
    return createXmaxClient({ apiKey: token, locale: 'zh-CN', telemetry: false }).files;
  };
  // Keep the SDK's upload authorization cache within this connection and credential.
  // The realtime client remains independent of this files-only client.
  let cachedFiles: { token: string; region: XmaxRegion; promise: ReturnType<typeof createFilesClient> } | undefined;
  return {
  create: ({ deviceId, lookId, generationNumber, expectedRevision, terminalId, terminalToken }) => api(path('live/session'), 'POST', { deviceId, lookId, generationNumber, expectedRevision, terminalId, terminalToken }),
  reference: async (input, signal) => {
    const response = await fetch(appUrl(input.image), { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('参考图读取失败，请检查该素材。');
    const blob = await response.blob();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || !blob.size || blob.size > 64 * 1024 * 1024)
      throw new Error('参考图不可用，请重新上传有效图片。');
    return new File([blob], `garment.${blob.type.split('/')[1]}`, { type: blob.type });
  },
  upload: async (file, token, signal, region = 'global') => {
    if (!cachedFiles || cachedFiles.token !== token || cachedFiles.region !== region) {
      const entry = { token, region, promise: createFilesClient(token, region) };
      cachedFiles = entry;
      void entry.promise.catch(() => { if (cachedFiles === entry) cachedFiles = undefined; });
    }
    const files = await cachedFiles.promise;
    return (await files.uploadAndCheckImage(file, { signal })).url;
  },
  bind: (id, input, signal) => api(path(`live/session/${encodeURIComponent(id)}/reference`), 'POST', input, signal),
  updateCondition: (id, input, signal) => api(path(`live/session/${encodeURIComponent(id)}/condition`), 'POST', input, signal),
  conditionApplied: (id, input, signal) => api(path(`live/session/${encodeURIComponent(id)}/condition/applied`), 'POST', input, signal),
  connect: async (source, local, callbacks) => {
    const { createXmaxClient, models } = await exhibitionSdk(local.providerRegion);
    const client = createXmaxClient({ apiKey: local.token, locale: 'zh-CN', telemetry: false });
    const options = {
      model: models.realtime(local.model as 'x2.0'), autoStart: false,
      audio: { publish: false, subscribe: false },
      context: { prompt: local.exhibition.prompt ?? exhibitionPromptForLook({ mode: local.exhibition.mode ?? 'clothx' }), ...(local.refImageUrl ? { refImageUrl: local.refImageUrl } : {}) },
      render: { fit: 'contain' as const, drag: { enabled: false } }, ...callbacks,
    };
    return source instanceof File ? client.realtime.connectMedia(source, options) : client.realtime.connect(source, options);
  },
  link: (id, providerSessionId) => api(sessionPath(id, 'link'), 'POST', { providerSessionId }),
  firstFrame: (id, firstFrameMs) => api(sessionPath(id, 'first-frame'), 'POST', { firstFrameMs }),
  stop: id => api(sessionPath(id, 'stop'), 'POST', {}),
  heartbeat: (sessionId, deviceId, signal) => api(path('live/heartbeat'), 'POST', { sessionId, deviceId }, signal),
  reportError: input => api(path('live/error'), 'POST', input),
  clone: stream => new MediaStream(stream.getVideoTracks().map(track => track.clone())),
  now: () => performance.now(),
  prepare: region => exhibitionSdk(region),
  };
}
function deadline<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('连接超时，请检查网络后重试。')), ms); })]).finally(() => clearTimeout(timer));
}
function liveInputKey(input: LiveInput) { return `${input.mirrorId ?? 'default'}:${input.sessionNumber}:${input.generationNumber}:${input.lookId}`; }
/** One realtime connection and temporary credential per experience; compatible outfits update its conditions. */
export class ExhibitionLiveConnection {
  get key() { return liveInputKey(this.input); }
  private deps: ExhibitionLiveDeps;
  private closed = false;
  private local?: LiveSession;
  private sdk?: ExhibitionSdkSession;
  private inputStream?: MediaStream;
  private remoteStream?: MediaStream;
  private begun = false;
  private failureStage = 'prepare_reference';
  private firstFrameSent = false;
  private firstFrameConfirmed = false;
  private appliedKey = '';
  private updateSequence = 0;
  private attemptedSequence = 0;
  private updating?: Promise<void>;
  private updateController?: AbortController;
  private references = new Map<string, Promise<string>>();
  private warming = false;
  private pendingWarmInput?: LiveInput;
  private startedAt = 0;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private starting?: Promise<void>;
  private stopping?: Promise<boolean>;
  private sdkDisconnected = false;
  private credentialStopped = false;
  private stopAttemptedSdk?: ExhibitionSdkSession;
  private stopAttemptedSession?: string;
  private diagnosticPrefix = `live-${++diagnosticConnectionSequence}`;
  private initialOperation?: DiagnosticOperation;
  private updateOperation?: DiagnosticOperation;
  private activeOperation?: DiagnosticOperation;
  constructor(private input: LiveInput, private events: ConnectionEvents, deps: Partial<ExhibitionLiveDeps> = {}) {
    const mirrorId = input.mirrorId ?? 'default';
    this.input = { ...input, mirrorId };
    this.deps = { ...liveDefaults(mirrorId), ...deps };
  }
  get sessionId() { return this.local?.id ?? null; }
  get stopped() { return this.closed; }
  start() { return this.starting ??= this.closed ? Promise.resolve() : this.run(); }
  private operation(suffix: string, input: LiveInput): DiagnosticOperation {
    return { input: { ...input }, operationId: `${this.diagnosticPrefix}:${suffix}`, context: {
      mirrorId: input.mirrorId ?? 'default', sessionNumber: input.sessionNumber, generationNumber: input.generationNumber,
      lookId: input.lookId, ...(this.local ? { sessionId: this.local.id, referenceVersion: this.local.referenceVersion } : {}),
    } };
  }
  private emitDiagnostic(type: DiagnosticEventInput['type'], operation = this.activeOperation, reason?: DiagnosticEventInput['reason']) {
    const receive = this.events.diagnostic;
    if (!receive || !operation || (this.closed && type !== 'stopped')) return;
    try {
      receive({ type, at: this.deps.now(), operationId: operation.operationId, context: { ...operation.context }, ...(reason ? { reason } : {}) });
    } catch { /* Diagnostics must never affect generation or cleanup. */ }
  }
  private async heartbeat() {
    if (this.closed || !this.local) return;
    try {
      await deadline(this.deps.heartbeat(this.local.id, this.input.deviceId, this.controller.signal), 6000);
      if (!this.closed) this.heartbeatTimer = setTimeout(() => void this.heartbeat(), 5000);
    } catch { if (!this.closed) await this.fail('大屏与后台连接中断，已停止本次换装。'); }
  }
  private async run() {
    const operation = this.operation('start', this.input);
    const input = operation.input;
    this.initialOperation = operation; this.activeOperation = operation;
    this.events.status('preparing');
    this.timer = setTimeout(() => void this.fail('换装连接超时，请检查网络后由工作人员重新开始。', `client_stage=${this.failureStage}`), 45000);
    try {
      const mode = input.mode ?? 'clothx';
      const hasReference = input.referenceKind !== 'none';
      if (!hasReference && mode !== 'free') throw new Error('仅提示词素材只支持 Free 模式，请检查素材设置。');
      if (mode !== 'mox' && !input.stream?.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('摄像头已断开，请重新开启。');
      // A prompt-only cover is for display and must never become a supplier reference.
      if (hasReference) this.emitDiagnostic('reference_started', operation);
      const file = hasReference ? await this.deps.reference(input, this.controller.signal) : undefined;
      if (this.closed) return;
      if (hasReference) this.emitDiagnostic('reference_ready', operation);
      this.failureStage = 'create_session';
      const local = await this.deps.create(input);
      this.local = local;
      operation.context = { ...operation.context, sessionId: local.id, referenceVersion: local.referenceVersion };
      // A request may settle after end/pause/navigation; dispose its late credential.
      if (this.closed) { await this.stop(); if (!this.credentialStopped && this.stopAttemptedSession !== local.id) await this.stop(); return; }
      const meta = local.exhibition;
      const prompt = exhibitionPromptForLook({ mode, prompt: input.prompt });
      const referenceMatches = hasReference ? appUrl(local.referenceAsset ?? '') === appUrl(input.image)
        : !local.referenceAsset && !local.refImageUrl && local.referenceVersion === 0;
      if (local.sourceKind !== (mode === 'mox' ? 'photo' : 'camera') || !meta || (meta.mirrorId ?? 'default') !== input.mirrorId || meta.deviceId !== input.deviceId || meta.lookId !== input.lookId
        || meta.sessionNumber !== input.sessionNumber || meta.generationNumber !== input.generationNumber || !referenceMatches
        || (meta.mode ?? 'clothx') !== mode || (meta.prompt ?? (mode === 'clothx' ? prompt : '')) !== prompt)
        throw new Error('服务返回的服装或设备不匹配，请重新开始。');
      if (local.providerRegion !== undefined && !isXmaxRegion(local.providerRegion))
        throw new Error('服务区域无效，请联系工作人员。');
      const providerRegion = local.providerRegion ?? 'global';
      this.local = { ...local, providerRegion };
      void this.heartbeat();
      const lifetime = Date.parse(local.expiresAt) - Date.now();
      if (!(lifetime > 0)) throw new Error('本次换装凭证已过期，请重新开始。');
      this.expiryTimer = setTimeout(() => void this.fail('本次换装时长已结束，请由工作人员开始下一次体验。'), Math.min(lifetime, 2147483647));
      this.events.refresh();
      this.failureStage = 'prepare_sdk';
      await this.deps.prepare(providerRegion);
      if (this.closed) return;
      let refImageUrl: string | undefined;
      if (hasReference) {
        this.failureStage = 'upload_reference';
        this.emitDiagnostic('upload_started', operation);
        refImageUrl = await this.deps.upload(file!, local.token, this.controller.signal, providerRegion);
        if (this.closed) return;
        this.emitDiagnostic('upload_ready', operation);
        this.references.set(this.referenceKey(input.image), Promise.resolve(refImageUrl));
        this.failureStage = 'bind_reference';
        this.emitDiagnostic('bind_started', operation);
        const bound = await this.deps.bind(local.id, { deviceId: input.deviceId, lookId: input.lookId, refImageUrl }, this.controller.signal);
        if (this.closed) return;
        if (bound.id !== local.id || bound.refImageUrl !== refImageUrl || bound.referenceVersion !== 1) throw new Error('服装参考绑定失败，请重新开始。');
        this.local = { ...local, ...bound, providerRegion };
        operation.context = { ...operation.context, referenceVersion: bound.referenceVersion };
        this.emitDiagnostic('bind_ready', operation);
      }
      this.events.status('connecting');
      this.failureStage = 'connect_sdk';
      if (mode !== 'mox') {
        this.inputStream = this.deps.clone(input.stream!);
        this.inputStream.getVideoTracks().forEach(track => { track.onended = () => { if (!this.closed) void this.fail('摄像头已断开，已停止本次体验。'); }; });
      }
      const sdk = await this.deps.connect(mode === 'mox' ? file! : this.inputStream!, this.local, {
        onRemoteStream: stream => { if (!this.closed) { this.remoteStream = stream; if (this.begun) this.events.stream(stream); } },
        onRemoteVideoFirstFrame: () => this.reportFirstFrame(),
        onPresentationChange: value => { if (!this.closed) this.events.presentation?.(value); },
        onRoomEvent: event => { if (!this.closed && this.begun && mode !== 'mox' && event.event === 'video_completed') void this.fail('本次换装已结束，请由工作人员继续体验。'); },
        onError: (message, error) => {
          if (!this.closed) void this.failSdk(error ?? { code: 'UNKNOWN_ERROR', message }, '换装服务连接失败，请由工作人员重试。');
        },
        onDisconnect: (reason, details) => {
          if (!this.closed) void this.failSdk({ code: 'SESSION_ERROR', details: {
            ...(typeof reason === 'string' ? { reason_code: reason } : {}),
            ...(details && typeof details === 'object' ? details : {}),
          } }, '换装连接已断开，请由工作人员重试。');
        },
      });
      this.sdk = sdk;
      if (this.closed) { await this.stop(); if (!this.sdkDisconnected && this.stopAttemptedSdk !== sdk) await this.stop(); return; }
      const providerSessionId = sdk.getSessionUid();
      if (!providerSessionId) throw new Error('未取得换装会话编号，请重新开始。');
      this.failureStage = 'link_session';
      const linked = await this.deps.link(local.id, providerSessionId);
      if (this.closed) return;
      if (linked.id !== local.id || linked.providerSessionId !== providerSessionId || linked.referenceVersion !== (hasReference ? 1 : 0)
        || (!hasReference && (!!linked.referenceAsset || !!linked.refImageUrl))) throw new Error('换装会话校验失败，请重新开始。');
      this.local = { ...this.local, ...linked };
      this.startedAt = this.deps.now(); this.begun = true;
      if (this.remoteStream) this.events.stream(this.remoteStream);
      // autoStart is off. Exactly this one set() creates the generation after linking.
      this.failureStage = 'start_generation';
      this.emitDiagnostic('sdk_set_started', operation);
      await sdk.set({ prompt, ...(hasReference ? { refImageUrl } : {}) });
      this.emitDiagnostic('sdk_set_resolved', operation);
      this.failureStage = 'wait_first_frame';
      if (!this.closed && mode === 'mox') {
        if (!sdk.beginDrag || !sdk.endDrag || !sdk.sendTracks || !sdk.media?.streamSetting.width || !sdk.media.streamSetting.height) throw new Error('当前 SDK 无法启动动作交互，请更新客户端。');
        this.events.interaction?.({ width: sdk.media.streamSetting.width, height: sdk.media.streamSetting.height,
          beginDrag: () => { if (!this.closed) sdk.beginDrag!(); }, endDrag: () => { if (!this.closed) sdk.endDrag!(); },
          sendTracks: points => this.closed ? Promise.resolve() : sdk.sendTracks!(points),
        });
      }
    } catch (cause) {
      if (!this.closed) await this.failSdk(cause, cause instanceof Error ? safeExhibitionErrorMessage(cause.message) : '换装连接失败，请重新开始。', operation);
    }
  }
  /** Only call from a decoded remote video frame, never from the local preview. */
  reportRenderedFrame(stream: MediaStream) {
    if (stream === this.remoteStream) this.reportFirstFrame();
  }
  reportFirstFrame = () => {
    if (this.closed || !this.begun || this.firstFrameSent || !this.local) return;
    this.firstFrameSent = true;
    this.emitDiagnostic('session_first_frame', this.initialOperation);
    void deadline(this.deps.firstFrame(this.local.id, Math.max(0, this.deps.now() - this.startedAt))).then(() => {
      if (this.closed) return;
      this.firstFrameConfirmed = true; this.appliedKey = this.key;
      clearTimeout(this.timer); this.events.status('running'); this.events.refresh();
      void this.warmReferences();
    }).catch(() => { if (!this.closed) void this.fail('首帧确认失败，已停止本次换装，请重新开始。'); });
  };
  canReuse(input: LiveInput) {
    return !this.closed && this.firstFrameConfirmed && !!this.sdk && !!this.local && this.local.status === 'active'
      && (input.mirrorId ?? 'default') === this.input.mirrorId && input.deviceId === this.input.deviceId
      && input.sessionNumber === this.input.sessionNumber && (input.mode ?? 'clothx') === (this.input.mode ?? 'clothx')
      && (input.mode ?? 'clothx') !== 'mox' && input.stream === this.input.stream
      && !!input.stream?.getVideoTracks().some(track => track.readyState === 'live');
  }
  /** Latest requested outfit wins. Uploads may overlap, but SDK condition changes never do. */
  async update(input: LiveInput, retry = false): Promise<boolean> {
    if (!this.canReuse(input)) return false;
    const key = liveInputKey(input);
    if (key === this.key && !retry) { await this.updating; return !this.closed && this.appliedKey === key; }
    this.input = { ...input, mirrorId: this.input.mirrorId };
    this.updateSequence++;
    this.updateOperation = this.operation(`update-${this.updateSequence}`, this.input);
    this.events.updateError?.(''); this.events.status('preparing');
    await this.ensureUpdates();
    // A newer request may arrive after a drain resolves but before its finally callback.
    if (!this.closed && this.attemptedSequence < this.updateSequence) await this.ensureUpdates();
    return !this.closed && this.appliedKey === key;
  }
  retryUpdate() { return this.update(this.input, true); }
  private ensureUpdates(): Promise<void> {
    return this.updating ??= this.runUpdates().finally(() => { this.updating = undefined; });
  }
  private referenceKey(image: string) { return `${this.local?.providerRegion ?? 'global'}:${appUrl(image)}`; }
  private uploadReference(input: LiveInput, operation?: DiagnosticOperation) {
    const key = this.referenceKey(input.image);
    let upload = this.references.get(key);
    if (!upload) {
      upload = (async () => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        this.controller.signal.addEventListener('abort', abort, { once: true });
        try {
          if (operation) this.emitDiagnostic('reference_started', operation);
          const file = await deadline(this.deps.reference(input, controller.signal), 15_000);
          if (this.closed || !this.local) throw new Error('本次体验已结束。');
          if (operation) { this.emitDiagnostic('reference_ready', operation); this.emitDiagnostic('upload_started', operation); }
          const uploaded = await deadline(this.deps.upload(file, this.local.token, controller.signal, this.local.providerRegion), 20_000);
          if (operation) this.emitDiagnostic('upload_ready', operation);
          return uploaded;
        } finally { controller.abort(); this.controller.signal.removeEventListener('abort', abort); }
      })();
      this.references.set(key, upload);
      void upload.catch(() => { if (this.references.get(key) === upload) this.references.delete(key); });
      // The cache belongs to one short-lived credential and never crosses mirrors or experiences.
      while (this.references.size > 32) this.references.delete(this.references.keys().next().value!);
    }
    return upload;
  }
  private async warmReferences() {
    if (this.closed || !this.firstFrameConfirmed) return;
    this.pendingWarmInput = { ...this.input, prefetchImages: this.input.prefetchImages?.slice(0, 2) };
    if (this.warming) return;
    this.warming = true;
    const attempted = new Set<string>();
    try {
      while (this.pendingWarmInput && !this.closed) {
        const input = this.pendingWarmInput;
        this.pendingWarmInput = undefined;
        for (const image of input.prefetchImages ?? []) {
          if (this.closed || this.pendingWarmInput) break;
          const key = this.referenceKey(image);
          // A newer selection can replace this batch, but failed URLs get only one
          // attempt per drain. A later foreground selection can explicitly retry.
          if (attempted.has(key)) continue;
          attempted.add(key);
          try { await this.uploadReference({ ...input, image, referenceKind: 'image' }); } catch { /* Prefetch never interrupts the active generation. */ }
        }
      }
    } finally { this.warming = false; }
  }
  private async runUpdates() {
    // A decoded frame can arrive before the initial set() finishes remote binding.
    // Wait for that start so the SDK is running before sending change_condition.
    await this.starting;
    if (this.closed) return;
    while (!this.closed && this.attemptedSequence < this.updateSequence) {
      const sequence = this.updateSequence;
      const operation = this.updateOperation!;
      const input = operation.input;
      this.activeOperation = operation;
      this.attemptedSequence = sequence;
      const controller = new AbortController(); this.updateController = controller;
      const stale = () => this.closed || sequence !== this.updateSequence;
      try {
        const local = this.local!;
        const hasReference = input.referenceKind !== 'none';
        if (!hasReference && input.mode !== 'free') throw new Error('仅提示词素材只支持 Free 模式，请检查素材设置。');
        const refImageUrl = hasReference ? await this.uploadReference(input, operation) : undefined;
        if (stale()) continue;
        const intent: ConditionInput = { deviceId: input.deviceId, lookId: input.lookId, sessionNumber: input.sessionNumber, generationNumber: input.generationNumber,
          ...(hasReference ? { refImageUrl } : {}) };
        this.emitDiagnostic('bind_started', operation);
        const bound = await deadline(this.deps.updateCondition!(local.id, intent, controller.signal), 12_000) as SessionData & { exhibition?: LiveSession['exhibition'] };
        const meta = bound.exhibition;
        const prompt = exhibitionPromptForLook({ mode: input.mode ?? 'clothx', prompt: input.prompt });
        const referenceMatches = hasReference ? appUrl(bound.referenceAsset ?? '') === appUrl(input.image) && bound.refImageUrl === refImageUrl
          : !bound.referenceAsset && !bound.refImageUrl;
        if (bound.id !== local.id || bound.status !== 'active' || bound.providerSessionId !== local.providerSessionId || !referenceMatches
          || !Number.isSafeInteger(bound.referenceVersion) || bound.referenceVersion < local.referenceVersion
          || (bound.referenceVersion === local.referenceVersion && (local.exhibition.lookId !== input.lookId || local.exhibition.generationNumber !== input.generationNumber))
          || !meta || (meta.mirrorId ?? 'default') !== input.mirrorId
          || meta.deviceId !== input.deviceId || meta.lookId !== input.lookId || meta.sessionNumber !== input.sessionNumber
          || meta.generationNumber !== input.generationNumber || (meta.mode ?? 'clothx') !== (input.mode ?? 'clothx') || meta.prompt !== prompt)
          throw new Error('换装条件校验失败，请重新选择素材。');
        // Store the accepted version before set(), so a rejected set can be retried idempotently.
        this.local = { ...local, ...bound, exhibition: meta };
        operation.context = { ...operation.context, sessionId: bound.id, referenceVersion: bound.referenceVersion };
        this.emitDiagnostic('bind_ready', operation);
        if (stale()) continue;
        // null explicitly clears the previous reference; omission would merge and retain it in the SDK.
        // Do not time out and overlap an unresolved set: expiry/stop aborts the whole connection.
        this.emitDiagnostic('sdk_set_started', operation);
        await this.sdk!.set({ prompt, refImageUrl: hasReference ? refImageUrl : null });
        this.emitDiagnostic('sdk_set_resolved', operation);
        if (stale()) continue;
        await deadline(this.deps.conditionApplied!(local.id, { ...intent, referenceVersion: bound.referenceVersion }, controller.signal));
        if (stale()) continue;
        this.emitDiagnostic('condition_committed', operation);
        this.appliedKey = liveInputKey(input);
        this.events.updateError?.(''); this.events.status('running'); this.events.refresh();
        void this.warmReferences();
      } catch (cause) {
        if (stale()) continue;
        this.emitDiagnostic('failed', operation, 'update_error');
        const message = cause instanceof Error ? safeExhibitionErrorMessage(cause.message) : '素材切换失败，请重试。';
        // A failed upload or condition request leaves the existing RTC output and lease intact.
        this.events.updateError?.(message); this.events.status('running'); this.events.refresh();
      } finally { controller.abort(); if (this.updateController === controller) this.updateController = undefined; }
    }
  }
  private failSdk(cause: unknown, fallbackMessage: string, operation = this.activeOperation) {
    const failure = exhibitionLiveFailure(cause, fallbackMessage);
    return this.fail(failure.message, failure.diagnostic ? `client_stage=${this.failureStage}; ${failure.diagnostic}` : '', operation);
  }
  private async fail(message: string, diagnostic = '', operation = this.activeOperation) {
    if (this.closed) return;
    this.emitDiagnostic('failed', operation, 'provider_error');
    const payload = { deviceId: this.input.deviceId, sessionId: this.local?.id, lookId: this.input.lookId, sessionNumber: this.input.sessionNumber, generationNumber: this.input.generationNumber,
      message: safeExhibitionErrorMessage(diagnostic ? `${message} ${diagnostic}` : message) };
    this.events.status('error', message);
    // Both paths start immediately; a hung SDK must never delay credential deactivation.
    const stopping = this.stop();
    await Promise.allSettled([stopping, deadline(this.deps.reportError(payload))]);
    this.events.refresh();
  }
  stop() {
    if (this.stopping) return this.stopping;
    const firstStop = !this.closed;
    this.closed = true;
    if (firstStop) this.emitDiagnostic('stopped', this.activeOperation, 'stopped');
    this.controller.abort();
    this.updateController?.abort(); this.references.clear(); this.pendingWarmInput = undefined;
    clearTimeout(this.timer); clearTimeout(this.heartbeatTimer); clearTimeout(this.expiryTimer);
    this.inputStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.inputStream = undefined; this.events.stream(null); this.events.interaction?.(null); this.events.presentation?.(null);
    this.stopping = (async () => {
      let confirmed = true;
      let attemptedSdk: ExhibitionSdkSession | undefined;
      let attemptedSession: string | undefined;
      do {
        const tasks: Promise<unknown>[] = [];
        const sdk = this.sdk; const local = this.local;
        attemptedSdk = sdk; attemptedSession = local?.id;
        this.stopAttemptedSdk = sdk; this.stopAttemptedSession = local?.id;
        // Start both independently, and drain resources that arrive while an
        // earlier stop is awaiting confirmation. Failed resources retry only
        // after another explicit stop, never in an unbounded loop.
        if (sdk && !this.sdkDisconnected) tasks.push(deadline(Promise.resolve().then(() => sdk.disconnect())).then(() => { this.sdkDisconnected = true; }));
        if (local && !this.credentialStopped) tasks.push(deadline(Promise.resolve().then(() => this.deps.stop(local.id)), 15000).then(result => {
          if (result.status !== 'stopped') throw new Error('stop-unconfirmed');
          this.credentialStopped = true;
        }));
        const results = await Promise.allSettled(tasks);
        confirmed = confirmed && results.every(result => result.status === 'fulfilled');
      } while ((this.sdk && this.sdk !== attemptedSdk && !this.sdkDisconnected)
        || (this.local && this.local.id !== attemptedSession && !this.credentialStopped));
      if (!confirmed) this.events.status('error', '停止状态未确认，请联系工作人员。');
      this.events.refresh();
      return confirmed;
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}

function cameraError(cause: unknown) {
  if (cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError' || cause.name === 'SecurityError') return '摄像头权限未开启。请在浏览器或安卓应用设置中允许摄像头，再重试。';
    if (cause.name === 'NotFoundError' || cause.name === 'OverconstrainedError') return '未找到可用摄像头，请检查设备连接或选择其他摄像头。';
    if (cause.name === 'NotReadableError' || cause.name === 'AbortError') return '摄像头暂时无法读取，可能被其他应用占用，请关闭占用应用后重试。';
  }
  return cause instanceof Error ? cause.message : '摄像头开启失败，请检查设备后重试。';
}
export function useExhibitionLive({ state, active, refresh, mirrorId = 'default', terminal, selectionPending = false, onDiagnostic }: { state: ExhibitionState | null; active: boolean; refresh: () => Promise<unknown> | void; mirrorId?: string; terminal?: { terminalId: string; token: string }; selectionPending?: boolean; onDiagnostic?: (event: DiagnosticEventInput) => void }) {
  const diagnosticCallback = useRef(onDiagnostic);
  diagnosticCallback.current = onDiagnostic;
  // Per mounted page instance: duplicate tabs must not inherit another screen's lease.
  const [deviceId] = useState(() => `screen-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [outputStream, setOutputStream] = useState<MediaStream | null>(null);
  const [interaction, setInteraction] = useState<MoXInteraction | null>(null);
  const [presentation, setPresentation] = useState<Readonly<RealtimePresentationState> | null>(null);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [status, setStatus] = useState<ExhibitionCameraStatus>('off');
  const [error, setError] = useState('');
  const [updateError, setUpdateError] = useState('');
  const [opening, setOpening] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [mirrored, setMirrored] = useState(true);
  const [liveStatus, setLiveStatus] = useState<ExhibitionLiveStatus | null>(null);
  // Identity, rather than a revision or mirror string alone, also distinguishes A → B → A.
  const identity = useMemo(() => ({ mirrorId }), [mirrorId]);
  const current = useRef({ state, active, refresh, identity });
  current.current = { state, active, refresh, identity };
  const camera = useRef<MediaStream | null>(null);
  const connection = useRef<ExhibitionLiveConnection | null>(null);
  const cameraRequest = useRef(0);
  const mounted = useRef(true);
  const failedKey = useRef('');
  const manuallyStoppedKey = useRef('');
  const statusRequests = useRef(new Set<AbortController>());
  const latestStatusRequest = useRef(0);
  const previousMode = useRef(state?.providerMode);
  const previousExperience = useRef(state?.experienceMode);
  const cameraEntryAttempt = useRef('');
  const cameraCaptureRequest = useRef<AbortController | null>(null);
  const secure = typeof window !== 'undefined' && window.isSecureContext;
  const refreshStatus = useCallback(async () => {
    const requestId = ++latestStatusRequest.current;
    const controller = new AbortController();
    statusRequests.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const next = await api<ExhibitionLiveStatus>(exhibitionApiPath('live/status', identity.mirrorId), 'GET', undefined, controller.signal);
      if (mounted.current && current.current.identity === identity && requestId === latestStatusRequest.current) setLiveStatus(next);
    }
    catch { /* Screen state polling owns the visible connectivity warning. */ }
    finally { clearTimeout(timer); statusRequests.current.delete(controller); }
  }, [identity]);
  const stopCamera = useCallback(() => {
    cameraRequest.current++;
    cameraCaptureRequest.current?.abort(); cameraCaptureRequest.current = null;
    if (connection.current) { void connection.current.stop(); connection.current = null; }
    camera.current?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    camera.current = null;
    if (mounted.current) { setCameraStream(null); setOutputStream(null); setInteraction(null); setPresentation(null); setUpdateError(''); setOpening(false); setStatus('off'); }
  }, []);
  const startCamera = useCallback(async (cameraId?: string) => {
    if (!current.current.active || current.current.state?.experienceMode === 'mox') return false;
    if (current.current.state?.live && current.current.state.live.deviceId !== deviceId) return false;
    const owner = current.current.identity;
    if (!secure || !navigator.mediaDevices?.getUserMedia) {
      setError('摄像头连接不可用，请重新打开镜端。'); setStatus('error'); return false;
    }
    stopCamera();
    const request = ++cameraRequest.current;
    const controller = new AbortController();
    cameraCaptureRequest.current = controller;
    setOpening(true); setError(''); setStatus('opening');
    try {
      const preference = readCameraPreference();
      const stream = await acquireExhibitionCamera(cameraCaptureConstraints(cameraId, preference), controller.signal);
      if (!stream) return false;
      if (!mounted.current || current.current.identity !== owner || !current.current.active || request !== cameraRequest.current
        || (current.current.state?.live && current.current.state.live.deviceId !== deviceId)) { stream.getTracks().forEach(track => track.stop()); return false; }
      if (!stream.getVideoTracks().some(track => track.readyState === 'live')) { stream.getTracks().forEach(track => track.stop()); throw new Error('摄像头没有返回有效画面，请重新开启。'); }
      camera.current = stream; setCameraStream(stream); setStatus('preview');
      setSelectedCameraId(cameraTrackDeviceId(stream.getVideoTracks()[0]) || cameraId || preference?.deviceId || '');
      stream.getVideoTracks().forEach(track => { track.onended = () => {
        if (camera.current !== stream) return;
        stopCamera(); setStatus('error'); setError('摄像头已断开，请检查设备后重新开启。');
      }; });
      const devices = await (navigator.mediaDevices.enumerateDevices?.() ?? Promise.resolve([])).catch(() => []);
      if (mounted.current && current.current.identity === owner && request === cameraRequest.current) setCameras(devices.filter(device => device.kind === 'videoinput'));
      return mounted.current && current.current.identity === owner && request === cameraRequest.current && camera.current === stream;
    } catch (cause) { if (mounted.current && current.current.identity === owner && request === cameraRequest.current) { setError(cameraError(cause)); setStatus('error'); } return false; }
    finally {
      if (cameraCaptureRequest.current === controller) cameraCaptureRequest.current = null;
      if (mounted.current && current.current.identity === owner && request === cameraRequest.current) setOpening(false);
    }
  }, [secure, stopCamera, deviceId]);
  useEffect(() => {
    mounted.current = true;
    failedKey.current = '';
    cameraEntryAttempt.current = '';
    setLiveStatus(null); setError(''); setUpdateError(''); setStatus('off'); setOpening(false);
    setCameraStream(null); setOutputStream(null); setCameras([]); setSelectedCameraId('');
    const leave = () => stopCamera();
    window.addEventListener('pagehide', leave);
    return () => {
      mounted.current = false; stopCamera();
      statusRequests.current.forEach(request => request.abort());
      window.removeEventListener('pagehide', leave);
    };
  }, [identity, stopCamera]);
  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 10000);
    return () => clearInterval(timer);
  }, [refreshStatus]);
  useEffect(() => {
    if (!active || !secure || state?.providerMode !== 'xmax' || !liveStatus?.configured
      || !isXmaxRegion(liveStatus.providerRegion)) return;
    return prepareExhibitionEntry(liveStatus.providerRegion);
  }, [identity, active, secure, state?.providerMode, liveStatus?.configured, liveStatus?.providerRegion]);
  useEffect(() => {
    if (!active || (previousMode.current === 'xmax' && state?.providerMode !== 'xmax') || previousExperience.current !== state?.experienceMode) stopCamera();
    previousMode.current = state?.providerMode; previousExperience.current = state?.experienceMode;
  }, [active, state?.providerMode, state?.experienceMode, stopCamera]);
  useEffect(() => {
    if (!active || state?.providerMode !== 'xmax' || state.experienceMode === 'mox') {
      cameraEntryAttempt.current = '';
      return;
    }
    if (!secure || (state.live && state.live.deviceId !== deviceId)) return;
    const entryKey = `${identity.mirrorId}:${state.providerMode}:${state.experienceMode}`;
    if (cameraEntryAttempt.current === entryKey) return;
    let cancelled = false;
    // Wait past StrictMode's setup/cleanup probe before requesting permission.
    void Promise.resolve().then(() => {
      if (cancelled || cameraEntryAttempt.current === entryKey) return;
      cameraEntryAttempt.current = entryKey;
      // Local preview is independent of XMAX credits. A denied grant is retried
      // only by an explicit gesture, never by a status poll or a stopped capture.
      if (!camera.current) void startCamera();
    });
    return () => { cancelled = true; };
  }, [identity, active, secure, state?.providerMode, state?.experienceMode, state?.live?.deviceId, deviceId, startCamera]);
  useEffect(() => {
    const currentState = current.current.state;
    if (!currentState) return;
    const desiredKey = `${identity.mirrorId}:${currentState.sessionNumber}:${currentState.generationNumber}:${currentState.selectedLookId}`;
    const mox = currentState.experienceMode === 'mox';
    const wantsLive = active && !!currentState.selectedLookId && currentState.providerMode === 'xmax' && (currentState.phase === 'generating' || currentState.phase === 'showcase');
    const occupied = !!currentState.live && currentState.live.deviceId !== deviceId;
    const existing = connection.current;
    const look = currentState.looks.find(item => item.id === currentState.selectedLookId);
    const modeLooks = currentState.enabledLookIds.flatMap(id => {
      const item = currentState.looks.find(candidate => candidate.id === id);
      return item && (item.mode ?? 'clothx') === (look?.mode ?? 'clothx') ? [item] : [];
    });
    const selectedIndex = modeLooks.findIndex(item => item.id === look?.id);
    const neighbours = [...modeLooks.slice(selectedIndex + 1), ...modeLooks.slice(0, Math.max(selectedIndex, 0))]
      .filter(item => item.referenceKind !== 'none' && item.id !== look?.id).slice(0, 2);
    const input: LiveInput | null = look ? { mirrorId: identity.mirrorId, terminalId: terminal?.terminalId, terminalToken: terminal?.token, deviceId, lookId: look.id,
      sessionNumber: currentState.sessionNumber, generationNumber: currentState.generationNumber, expectedRevision: currentState.revision,
      image: look.image, referenceKind: look.referenceKind, mode: look.mode ?? 'clothx', prompt: look.prompt, stream: cameraStream ?? undefined,
      prefetchImages: neighbours.map(item => item.image),
    } : null;
    const reusable = !!input && !!existing?.canReuse(input);
    if (existing && (!wantsLive || occupied || (existing.key !== desiredKey && !reusable) || (!mox && !cameraStream))) {
      connection.current = null; void existing.stop(); setOutputStream(null); setInteraction(null); setPresentation(null);
      setUpdateError('');
      if (mounted.current) setStatus(cameraStream ? 'preview' : 'off');
    }
    if (!wantsLive) {
      failedKey.current = '';
      setStatus(previous => previous === 'other-device' ? cameraStream ? 'preview' : 'off' : previous);
      return;
    }
    if (occupied) { setStatus('other-device'); return; }
    setStatus(previous => previous === 'other-device' ? cameraStream ? 'preview' : 'off' : previous);
    if (existing && reusable && existing.key !== desiredKey) {
      if (!selectionPending && currentState.phase === 'generating' && currentState.live?.sessionId === existing.sessionId) void existing.update(input!);
      return;
    }
    if (selectionPending || currentState.phase !== 'generating' || (!mox && (!cameraStream || cameraStream !== camera.current)) || connection.current || failedKey.current === desiredKey || manuallyStoppedKey.current === desiredKey) return;
    // Polling can see the new outfit while the command is still releasing the
    // old lease. Wait for that release instead of allocating against its revision.
    if (currentState.live && (currentState.live.generationNumber !== currentState.generationNumber
      || currentState.live.lookId !== currentState.selectedLookId)) return;
    if (!input) return;
    setError(''); setUpdateError('');
    const next = new ExhibitionLiveConnection(input, {
      status: (nextStatus, message) => {
        if (!mounted.current || current.current.identity !== identity || connection.current !== next) return;
        setStatus(nextStatus);
        if (message) setError(message);
        if (nextStatus === 'error') failedKey.current = desiredKey;
      },
      stream: stream => { if (mounted.current && current.current.identity === identity && connection.current === next) setOutputStream(stream); },
      updateError: message => { if (mounted.current && current.current.identity === identity && connection.current === next) setUpdateError(message); },
      interaction: value => { if (mounted.current && current.current.identity === identity && connection.current === next) setInteraction(value); },
      presentation: value => { if (mounted.current && current.current.identity === identity && connection.current === next) setPresentation(value); },
      refresh: () => { if (mounted.current && current.current.identity === identity) { void current.current.refresh(); void refreshStatus(); } },
      get diagnostic() { return diagnosticCallback.current ? (event: DiagnosticEventInput) => diagnosticCallback.current?.(event) : undefined; },
    });
    connection.current = next; void next.start();
  }, [identity, active, selectionPending, state?.phase, state?.providerMode, state?.experienceMode, state?.selectedLookId, state?.sessionNumber, state?.generationNumber, state?.live?.deviceId, state?.live?.sessionId, cameraStream, deviceId, refreshStatus, retryEpoch, terminal?.terminalId, terminal?.token]);
  const retryUpdate = useCallback(async () => {
    const round = current.current.state;
    const existing = connection.current;
    if (!mounted.current || !current.current.active || !round || !existing || existing.stopped || existing.key !== liveInputKey({ mirrorId: current.current.identity.mirrorId,
      deviceId, lookId: round.selectedLookId ?? '', sessionNumber: round.sessionNumber, generationNumber: round.generationNumber, expectedRevision: round.revision, image: '' })) return false;
    return existing.retryUpdate();
  }, [deviceId]);
  const retry = useCallback(async () => {
    if (!mounted.current || !current.current.active) return false;
    const owner = current.current.identity;
    const previous = connection.current;
    const round = current.current.state;
    if (camera.current?.getVideoTracks().some(track => track.readyState === 'live')) {
      // A cloud connection failure does not invalidate the local camera grant.
      cameraRequest.current++;
      cameraCaptureRequest.current?.abort(); cameraCaptureRequest.current = null;
      connection.current = null;
      setOutputStream(null); setInteraction(null); setPresentation(null);
    } else stopCamera();
    const request = cameraRequest.current;
    failedKey.current = '';
    setOpening(true); setError(''); setStatus('opening');
    // A user retry must release the previous credential before opening a new capture.
    if (previous && !(await previous.stop())) { if (mounted.current && current.current.identity === owner) { setOpening(false); setStatus('error'); setError('停止状态未确认，请联系工作人员。'); } return false; }
    await current.current.refresh();
    const latest = current.current.state;
    const leftRound = round && !['idle', 'select'].includes(round.phase)
      && (!latest || latest.sessionNumber !== round.sessionNumber || ['idle', 'select'].includes(latest.phase));
    if (!mounted.current || current.current.identity !== owner || !current.current.active || request !== cameraRequest.current || leftRound) {
      if (mounted.current && current.current.identity === owner && request === cameraRequest.current) { setOpening(false); setStatus(camera.current?.getVideoTracks().some(track => track.readyState === 'live') ? 'preview' : 'off'); }
      return false;
    }
    if (latest?.experienceMode === 'mox') { setOpening(false); setStatus('off'); setRetryEpoch(value => value + 1); return true; }
    if (camera.current?.getVideoTracks().some(track => track.readyState === 'live')) {
      setOpening(false); setStatus('preview'); setRetryEpoch(value => value + 1);
      return true;
    }
    const restarting = startCamera(selectedCameraId || undefined);
    const restartRequest = cameraRequest.current;
    await restarting;
    if (!mounted.current || current.current.identity !== owner || !current.current.active || restartRequest !== cameraRequest.current) return false;
    // startCamera can fail before getUserMedia (for example on an insecure page).
    setOpening(false);
    return !!camera.current?.getVideoTracks().some(track => track.readyState === 'live');
  }, [selectedCameraId, startCamera, stopCamera]);
  const stopGeneration = useCallback(async () => {
    const owner = current.current.identity;
    const round = current.current.state;
    const stoppedKey = round ? `${owner.mirrorId}:${round.sessionNumber}:${round.generationNumber}:${round.selectedLookId}` : '';
    manuallyStoppedKey.current = stoppedKey;
    const previous = connection.current;
    setOutputStream(null); setInteraction(null); setPresentation(null); setError(''); setUpdateError(''); setStatus('stopping');
    const confirmed = previous ? await previous.stop() : true;
    const latest = current.current.state;
    const latestKey = latest ? `${owner.mirrorId}:${latest.sessionNumber}:${latest.generationNumber}:${latest.selectedLookId}` : '';
    if (mounted.current && current.current.identity === owner && latestKey === stoppedKey) {
      if (confirmed) setStatus(camera.current ? 'preview' : 'off');
      else { setStatus('error'); setError('停止状态未确认，请联系工作人员。'); }
    }
    return confirmed;
  }, []);
  const reportFirstFrame = useCallback((stream: MediaStream) => connection.current?.reportRenderedFrame(stream), []);
  return { cameraStream, outputStream, interaction, presentation, status, error, updateError, opening, deviceId, cameras, selectedCameraId, mirrored, setMirrored, startCamera, stopCamera, stopGeneration, retry, retryUpdate, reportFirstFrame, secure, liveStatus, refreshStatus };
}
export type ExhibitionLiveController = ReturnType<typeof useExhibitionLive>;
