import { STOP_REASONS } from '../../shared/exhibitionLifecycle';
export const DIAGNOSTIC_EVENT_TYPES = [
  'experience_started', 'credential_started', 'credential_ready', 'rtc_started', 'rtc_ready', 'reference_cache_hit',
  'gesture_threshold', 'gesture_confirmed', 'gesture_ignored', 'command_sent', 'command_accepted', 'command_rejected', 'command_cancelled',
  'reference_started', 'reference_ready', 'upload_started', 'upload_ready', 'bind_started', 'bind_ready',
  'sdk_set_started', 'sdk_set_resolved', 'condition_committed', 'session_first_frame', 'failed', 'stopped', 'manual_visible', 'sample',
] as const;
export type DiagnosticEventType = typeof DIAGNOSTIC_EVENT_TYPES[number];
export const DIAGNOSTIC_REASONS = [
  ...STOP_REASONS,
  'blocked', 'unavailable', 'insufficient_materials', 'rejected', 'provider_error', 'update_error', 'stopped',
  'inactive', 'stale_context', 'busy', 'not_ready', 'invalid_input', 'command_error', 'tracking_lost',
  'multiple_people', 'expired', 'cancelled',
] as const;
export type DiagnosticReason = typeof DIAGNOSTIC_REASONS[number];

export interface DiagnosticContext {
  mirrorId: string;
  sessionNumber: number;
  generationNumber: number;
  lookId: string;
  sessionId?: string;
  referenceVersion?: number;
}
export interface DiagnosticMetrics {
  durationMs?: number;
  inferenceMs?: number;
  recognitionMs?: number;
  fps?: number;
  width?: number;
  height?: number;
  packetLoss?: number;
  rttMs?: number;
  actualKbps?: number;
  targetKbps?: number;
  queuedMs?: number;
  frameId?: number;
  raiseLatencyMs?: number;
  accepted?: boolean;
  armed?: boolean;
  handDetected?: boolean;
  handRaised?: boolean;
  needsRelease?: boolean;
  confirmationState?: 'no_hand' | 'unmatched_hand' | 'settling' | 'ambiguous' | 'incomplete' | 'too_small' | 'fingers_folded' | 'holding' | 'already_triggered' | 'release_required' | 'lowering' | 'raise_required';
  palmHoldMs?: number;
  palmConfirmMs?: number;
  rawHandCount?: number;
  matchedHandCount?: number;
  controlSource?: 'body' | 'hand' | 'none';
  ambiguityReason?: 'people' | 'hands';
  gesture?: 'wave' | 'raise_hand' | 'open_palm';
  operatorStatus?: 'searching' | 'locked' | 'ambiguous';
  captureStatus?: 'waiting' | 'active' | 'disabled' | 'muted' | 'stalled' | 'hidden';
  source?: 'gesture' | 'manual';
}
export interface DiagnosticEventInput {
  type: DiagnosticEventType;
  at?: number;
  context: DiagnosticContext;
  operationId?: string;
  actionId?: string;
  interactionId?: string;
  metrics?: DiagnosticMetrics;
  reason?: DiagnosticReason;
}
export interface DiagnosticEvent {
  readonly type: DiagnosticEventType;
  readonly at: number;
  readonly context: Readonly<DiagnosticContext>;
  readonly operationId?: string;
  readonly actionId?: string;
  readonly interactionId?: string;
  readonly metrics?: Readonly<DiagnosticMetrics>;
  readonly reason?: DiagnosticReason;
}
export interface DiagnosticStats {
  readonly confirmed: number;
  readonly failed: number;
  readonly failedCommands: number;
  readonly failedGenerations: number;
  readonly unconfirmed: number;
}
export interface DiagnosticSnapshot {
  readonly events: readonly DiagnosticEvent[];
  readonly current: Readonly<DiagnosticContext> | null;
  readonly canMarkVisible: boolean;
  readonly latestStage: DiagnosticEventType | null;
  readonly stats: DiagnosticStats;
  readonly droppedCount: number;
  readonly version: number;
}

const NUMERIC_METRICS = ['durationMs', 'inferenceMs', 'recognitionMs', 'fps', 'width', 'height', 'packetLoss', 'rttMs',
  'actualKbps', 'targetKbps', 'queuedMs', 'frameId', 'raiseLatencyMs', 'palmHoldMs', 'palmConfirmMs', 'rawHandCount', 'matchedHandCount'] as const;
const BOOLEAN_METRICS = ['accepted', 'armed', 'handDetected', 'handRaised', 'needsRelease'] as const;
const ENUM_METRICS = {
  operatorStatus: ['searching', 'locked', 'ambiguous'], captureStatus: ['waiting', 'active', 'disabled', 'muted', 'stalled', 'hidden'],
  source: ['gesture', 'manual'],
  gesture: ['wave', 'raise_hand', 'open_palm'],
  controlSource: ['body', 'hand', 'none'],
  ambiguityReason: ['people', 'hands'],
  confirmationState: ['no_hand', 'unmatched_hand', 'settling', 'ambiguous', 'incomplete', 'too_small', 'fingers_folded', 'holding', 'already_triggered', 'release_required', 'lowering', 'raise_required'],
} as const;
const OPERATION_TYPES = new Set<DiagnosticEventType>(['experience_started', 'credential_started', 'credential_ready', 'rtc_started', 'rtc_ready', 'reference_cache_hit', 'reference_started', 'reference_ready', 'upload_started', 'upload_ready',
  'bind_started', 'bind_ready', 'sdk_set_started', 'sdk_set_resolved', 'condition_committed', 'session_first_frame', 'failed', 'stopped']);
const COMMAND_TYPES = new Set<DiagnosticEventType>(['command_sent', 'command_accepted', 'command_rejected', 'command_cancelled']);
const STAGE_ORDER: Partial<Record<DiagnosticEventType, number>> = {
  reference_started: 0, reference_ready: 1, upload_started: 2, upload_ready: 3, bind_started: 4, bind_ready: 5,
  sdk_set_started: 6, sdk_set_resolved: 7, condition_committed: 8,
};
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);
// IDs are opaque local identifiers. URLs, credential prefixes and free text are never diagnostic fields.
function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    && !/^(?:https?:|data:|blob:|file:|uk-|tk-|sk-)/i.test(value);
}
function contextFor(value: unknown): Readonly<DiagnosticContext> | null {
  if (!isRecord(value) || !safeId(value.mirrorId) || !safeId(value.lookId)
    || !integer(value.sessionNumber) || !integer(value.generationNumber)
    || (value.sessionId !== undefined && !safeId(value.sessionId))
    || (value.referenceVersion !== undefined && !integer(value.referenceVersion))) return null;
  return Object.freeze({ mirrorId: value.mirrorId, sessionNumber: value.sessionNumber, generationNumber: value.generationNumber,
    lookId: value.lookId, ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
    ...(value.referenceVersion !== undefined ? { referenceVersion: value.referenceVersion } : {}) });
}
function metricsFor(value: unknown): Readonly<DiagnosticMetrics> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, number | boolean | string> = {};
  for (const key of NUMERIC_METRICS) if (nonnegative(value[key])) result[key] = value[key];
  for (const key of BOOLEAN_METRICS) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of Object.keys(ENUM_METRICS) as (keyof typeof ENUM_METRICS)[]) {
    if ((ENUM_METRICS[key] as readonly unknown[]).includes(value[key])) result[key] = value[key] as string;
  }
  return Object.keys(result).length ? Object.freeze(result) : undefined;
}
function roundKey(context: Readonly<DiagnosticContext>): string {
  return JSON.stringify([context.mirrorId, context.sessionNumber, context.generationNumber, context.lookId]);
}
function compatible(a: Readonly<DiagnosticContext>, b: Readonly<DiagnosticContext>): boolean {
  return roundKey(a) === roundKey(b) && (a.sessionId === undefined || b.sessionId === undefined || a.sessionId === b.sessionId)
    && (a.referenceVersion === undefined || b.referenceVersion === undefined || a.referenceVersion === b.referenceVersion);
}
interface Operation {
  context: Readonly<DiagnosticContext>;
  firstAt: number;
  lastAt: number;
  stage: number;
  epoch: number;
  resolved: Readonly<DiagnosticContext> | null;
  committed: boolean;
  firstFrame: boolean;
  terminal: boolean;
  stopped: boolean;
  confirmed: boolean;
  failed: boolean;
}
interface Action {
  context: Readonly<DiagnosticContext>; lastAt: number; accepted: boolean; failed: boolean; cancelled: boolean;
  interactionId?: string;
}
interface Round { epoch: number; invalidAfter: number; operationId: string | null; }

/** Page-owned, memory-only evidence. No network, camera, storage or supplier calls. */
export class ExhibitionDiagnostics {
  private readonly now: () => number;
  private readonly limit: number;
  private startTime = new Date().toISOString();
  private events: DiagnosticEvent[] = [];
  private current: Readonly<DiagnosticContext> | null = null;
  private active = false;
  private closed = false;
  private droppedCount = 0;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<string, Operation>();
  private readonly actions = new Map<string, Action>();
  private readonly rounds = new Map<string, Round>();
  private readonly retiredOperations = new Set<string>();
  private readonly retiredActions = new Set<string>();
  private readonly seenOperations = new Map<string, string>();
  private readonly seenActions = new Map<string, string>();
  private readonly firstFrameSessions = new Map<string, string>();
  private readonly latestStages = new Map<string, DiagnosticEvent>();
  private pendingCommandKey: string | null = null;
  private clearAt = -Infinity;
  private snapshot!: DiagnosticSnapshot;

  constructor(options: { now?: () => number; maxEvents?: number } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.limit = integer(options.maxEvents) ? Math.max(1, Math.min(10_000, options.maxEvents)) : 10_000;
    this.publish(false);
  }

  getSnapshot = (): DiagnosticSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  observe = (input: DiagnosticContext | null, { active }: { active: boolean }): void => {
    if (this.closed) return;
    const next = input === null ? null : contextFor(input);
    if (input !== null && !next) return;
    const changedRound = !!this.current && (!next || roundKey(this.current) !== roundKey(next));
    if (changedRound) this.retireRound(roundKey(this.current!));
    else if (this.current && this.active && !active) this.invalidateRound(roundKey(this.current), this.now());
    const nextActive = !!next && active;
    if (JSON.stringify(this.current) === JSON.stringify(next) && this.active === nextActive) return;
    this.current = next;
    this.active = nextActive;
    if (next && this.pendingCommandKey === roundKey(next)) this.pendingCommandKey = null;
    this.publish();
  };

  record = (input: DiagnosticEventInput): DiagnosticEvent | null => {
    if (this.closed || !isRecord(input) || input.type === 'manual_visible'
      || !(DIAGNOSTIC_EVENT_TYPES as readonly unknown[]).includes(input.type)) return null;
    const context = contextFor(input.context);
    const at = input.at ?? this.now();
    if (!context || !nonnegative(at) || at < this.clearAt
      || (input.operationId !== undefined && !safeId(input.operationId))
      || (input.actionId !== undefined && !safeId(input.actionId))
      || (input.interactionId !== undefined && !safeId(input.interactionId))
      || (input.reason !== undefined && !(DIAGNOSTIC_REASONS as readonly unknown[]).includes(input.reason))) return null;
    const key = roundKey(context);
    if ((input.operationId && this.retiredOperations.has(input.operationId))
      || (input.actionId && this.retiredActions.has(input.actionId))) return null;
    if ((OPERATION_TYPES.has(input.type) && !input.operationId) || (COMMAND_TYPES.has(input.type) && !input.actionId)) return null;
    if (this.current && (context.mirrorId !== this.current.mirrorId || context.sessionNumber < this.current.sessionNumber
      || (context.sessionNumber === this.current.sessionNumber && context.generationNumber < this.current.generationNumber))) return null;
    const round = this.rounds.get(key) ?? { epoch: 0, invalidAfter: -Infinity, operationId: null };
    const terminalEvent = input.type === 'failed' || input.type === 'stopped';
    if (at < round.invalidAfter && !terminalEvent) return null;
    this.rounds.set(key, round);
    if (OPERATION_TYPES.has(input.type)) {
      const operationId = input.operationId!;
      let operation = this.operations.get(operationId);
      if (operation) {
        if (roundKey(operation.context) !== key || at < operation.lastAt || (operation.epoch !== round.epoch && !terminalEvent)
          || (operation.terminal && !(input.type === 'stopped' && !operation.stopped))
          || (operation.context.sessionId !== undefined && context.sessionId !== undefined && operation.context.sessionId !== context.sessionId)) return null;
        if (operation.context.referenceVersion !== undefined && context.referenceVersion !== undefined
          && context.referenceVersion < operation.context.referenceVersion) return null;
        if (operation.resolved && !compatible(operation.resolved, context)) return null;
      } else {
        if (input.type === 'condition_committed') return null;
        operation = { context, firstAt: at, lastAt: at, stage: -1, epoch: round.epoch, resolved: null,
          committed: false, firstFrame: false, terminal: false, stopped: false, confirmed: false, failed: false };
        this.operations.set(operationId, operation);
      }
      const stage = STAGE_ORDER[input.type];
      if (stage !== undefined && stage < operation.stage) return null;
      if (input.type === 'condition_committed' && !operation.resolved) return null;
      operation.context = Object.freeze({ ...operation.context, ...context });
      operation.lastAt = at;
      if (stage !== undefined) operation.stage = stage;
      if (input.type === 'sdk_set_resolved') operation.resolved = operation.context;
      if (input.type === 'condition_committed') operation.committed = true;
      if (input.type === 'session_first_frame') {
        const sessionKey = JSON.stringify([context.mirrorId, context.sessionNumber, context.sessionId ?? '']);
        const initial = this.firstFrameSessions.get(sessionKey);
        if (!initial) this.firstFrameSessions.set(sessionKey, operationId);
        operation.firstFrame = initial === undefined || initial === operationId;
      }
      const selected = round.operationId ? this.operations.get(round.operationId) : undefined;
      if (!selected || operation.firstAt >= selected.firstAt) round.operationId = operationId;
      if (input.type === 'failed' || input.type === 'stopped') {
        operation.terminal = true;
        operation.failed ||= input.type === 'failed';
        operation.stopped ||= input.type === 'stopped';
        // A late teardown can close its own evidence without invalidating a newer attempt.
        if (operation.epoch === round.epoch && round.operationId === operationId) this.invalidateRound(key, at);
      }
    }
    if (COMMAND_TYPES.has(input.type)) {
      const actionId = input.actionId!;
      const previous = this.actions.get(actionId);
      if (previous && (roundKey(previous.context) !== key || at < previous.lastAt || previous.failed || previous.cancelled
        || (previous.interactionId !== undefined && input.interactionId !== undefined && previous.interactionId !== input.interactionId)
        || (previous.accepted && input.type === 'command_sent'))) return null;
      const action = previous ?? { context, lastAt: at, accepted: false, failed: false, cancelled: false };
      action.lastAt = at;
      action.accepted ||= input.type === 'command_accepted';
      action.failed ||= input.type === 'command_rejected';
      action.cancelled ||= input.type === 'command_cancelled';
      if (input.interactionId !== undefined) action.interactionId = input.interactionId;
      this.actions.set(actionId, action);
      if (input.type === 'command_sent') {
        if (this.current) this.invalidateRound(roundKey(this.current), at);
        this.pendingCommandKey = key;
      }
      if (action.failed) this.invalidateRound(key, at);
    }
    const metrics = metricsFor(input.metrics);
    const event: DiagnosticEvent = Object.freeze({ type: input.type, at, context,
      ...(input.operationId ? { operationId: input.operationId } : {}), ...(input.actionId ? { actionId: input.actionId } : {}),
      ...(input.interactionId ? { interactionId: input.interactionId } : {}),
      ...(metrics ? { metrics } : {}), ...(input.reason ? { reason: input.reason } : {}) });
    if (input.operationId) this.seenOperations.set(input.operationId, key);
    if (input.actionId) this.seenActions.set(input.actionId, key);
    this.append(event);
    return event;
  };

  markVisible = (input?: DiagnosticContext): DiagnosticEvent | null => {
    if (this.closed || !this.canMark()) return null;
    const context = input === undefined ? this.current : contextFor(input);
    if (!context || !this.current || !compatible(context, this.current)) return null;
    const round = this.rounds.get(roundKey(this.current))!;
    const operationId = round.operationId!;
    const operation = this.operations.get(operationId)!;
    const at = this.now();
    if (!nonnegative(at) || at < operation.lastAt) return null;
    operation.confirmed = true;
    let actionId: string | undefined;
    let interactionId: string | undefined;
    for (const [id, action] of this.actions) {
      if (roundKey(action.context) === roundKey(this.current) && action.accepted && !action.cancelled && !action.failed) {
        actionId = id;
        interactionId = action.interactionId;
      }
    }
    const event: DiagnosticEvent = Object.freeze({ type: 'manual_visible', at, context: operation.context, operationId,
      ...(actionId ? { actionId } : {}), ...(interactionId ? { interactionId } : {}), metrics: Object.freeze({ source: 'manual' as const }) });
    this.append(event);
    return event;
  };

  clear = (): void => {
    if (this.closed) return;
    for (const id of this.seenOperations.keys()) this.retiredOperations.add(id);
    for (const id of this.seenActions.keys()) this.retiredActions.add(id);
    this.events = [];
    this.operations.clear(); this.actions.clear(); this.rounds.clear();
    this.latestStages.clear();
    this.seenOperations.clear(); this.seenActions.clear();
    this.pendingCommandKey = null;
    this.clearAt = this.now();
    this.startTime = new Date().toISOString();
    this.droppedCount = 0;
    this.publish();
  };

  close = (): void => {
    if (this.closed) return;
    this.clear();
    this.closed = true;
    this.active = false;
    this.current = null;
    this.retiredOperations.clear(); this.retiredActions.clear(); this.firstFrameSessions.clear();
    this.publish();
    this.listeners.clear();
  };

  exportJSON = (): string => JSON.stringify({
    schemaVersion: 1, startTime: this.startTime, exportTime: new Date().toISOString(), timeOrigin: performance.timeOrigin,
    clock: 'event.at is milliseconds from timeOrigin; startTime is diagnostic activation/clear time, not performance zero',
    observationLabel: '人工观察：服装已可见；不是供应商完成回执，也不是自动视觉识别',
    unverifiedFields: ['现场手势识别率', '服装生成准确率', '自动识别服装已变化', '端到端延迟验收', '多人身份识别'],
    statisticsScope: 'since_clear', current: this.snapshot.current, events: this.snapshot.events,
    stats: this.snapshot.stats, droppedCount: this.snapshot.droppedCount,
  }, null, 2);

  private canMark(): boolean {
    if (!this.active || !this.current || (this.pendingCommandKey !== null && this.pendingCommandKey !== roundKey(this.current))) return false;
    const round = this.rounds.get(roundKey(this.current));
    const operation = round?.operationId ? this.operations.get(round.operationId) : undefined;
    return !!round && !!operation && operation.epoch === round.epoch && !operation.terminal && !operation.confirmed
      && compatible(operation.context, this.current) && (operation.firstFrame || (!!operation.resolved && operation.committed));
  }
  private invalidateRound(key: string, at: number): void {
    const round = this.rounds.get(key) ?? { epoch: 0, invalidAfter: -Infinity, operationId: null };
    round.epoch++;
    round.invalidAfter = Math.max(round.invalidAfter, at);
    round.operationId = null;
    this.rounds.set(key, round);
  }
  private retireRound(key: string): void {
    this.invalidateRound(key, this.now());
    for (const [id, seenKey] of this.seenOperations) if (seenKey === key) this.retiredOperations.add(id);
    for (const [id, seenKey] of this.seenActions) if (seenKey === key) this.retiredActions.add(id);
  }
  private append(event: DiagnosticEvent): void {
    this.events.push(event);
    if (this.events.length > this.limit) { this.events.shift(); this.droppedCount++; }
    const key = roundKey(event.context);
    const selected = this.rounds.get(key)?.operationId;
    if (event.type !== 'sample' && (!OPERATION_TYPES.has(event.type) || selected === event.operationId || !selected)) {
      this.latestStages.set(key, event);
    }
    this.publish();
  }
  private publish(notify = true): void {
    let confirmed = 0; let failedGenerations = 0; let failedCommands = 0; let unconfirmed = 0;
    const operationRounds = new Set<string>();
    for (const operation of this.operations.values()) {
      operationRounds.add(roundKey(operation.context));
      if (operation.failed) failedGenerations++;
      else if (operation.confirmed) confirmed++;
      else if (!operation.terminal) unconfirmed++;
    }
    for (const action of this.actions.values()) {
      if (action.failed) failedCommands++;
      else if (action.accepted && !action.cancelled && !operationRounds.has(roundKey(action.context))) unconfirmed++;
    }
    const stats = Object.freeze({ confirmed, failed: failedGenerations + failedCommands, failedCommands, failedGenerations, unconfirmed });
    const key = this.current ? roundKey(this.current) : null;
    const stageEvent = key ? this.latestStages.get(key) : undefined;
    const validSince = key ? this.rounds.get(key)?.invalidAfter ?? -Infinity : Infinity;
    const latestStage = stageEvent && stageEvent.at >= validSince ? stageEvent.type : null;
    this.snapshot = Object.freeze({ events: Object.freeze([...this.events]), current: this.current, canMarkVisible: this.canMark(),
      latestStage, stats, droppedCount: this.droppedCount, version: this.version++ });
    if (notify) for (const listener of this.listeners) { try { listener(); } catch { /* Evidence must never interrupt the experience. */ } }
  }
}

export function createExhibitionDiagnostics(options?: { now?: () => number; maxEvents?: number }): ExhibitionDiagnostics {
  return new ExhibitionDiagnostics(options);
}
