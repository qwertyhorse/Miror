import { randomUUID } from 'node:crypto';
import { ExhibitionMirrorGestureDetector } from '../src/exhibition/mirrorGestureDetector.ts';
import { resolveExhibitionGestureSettings, type ExhibitionGestureSettings } from '../shared/exhibitionGestures.ts';
import { REMOTE_GESTURE_MAX_FRAME_BYTES, REMOTE_GESTURE_SESSION_TTL_MS, remoteGestureI420ByteLength,
  type RemoteGestureControl, type RemoteGestureFrameMetadata, type RemoteGestureSnapshot,
  type RemoteGestureI420Metadata, type RemoteGestureOpenSnapshot } from '../shared/remoteGestures.ts';
import type { GestureInference } from './gestureInference.ts';

const RELEASE_MS = 500;
// Startup release is an absence check, not a gesture trajectory. Slow devices may safely prove it
// with sparse fresh empty frames; actual action confirmation keeps the shared detector's 350 ms gap.
const RELEASE_MAX_FRAME_GAP_MS = 800;

export class RemoteGestureError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface RemoteGestureOwner { terminalId: string; mirrorId: string; }
export interface RemoteGestureOpen extends RemoteGestureOwner { epoch?: number; blocked?: boolean; }
export interface RemoteGestureCoordinatorOptions {
  createInference: () => Promise<GestureInference>;
  maxSessions?: number;
  ttlMs?: number;
  maxFrameAgeMs?: number;
  now?: () => number;
}

interface Session extends RemoteGestureOwner {
  id: string;
  epoch: number;
  revision: number;
  reportedBlocked: boolean;
  serverBlocked: boolean;
  releaseRequired: boolean;
  absentSince: number | null;
  lastObservedTime: number | null;
  seq: number;
  acceptedTime: number | null;
  completedTime: number | null;
  inferenceMs: number | null;
  detector: ExhibitionMirrorGestureDetector;
  settingsKey: string;
  lastActivity: number;
  inFlight: boolean;
  closed: boolean;
  ready: Promise<GestureInference>;
  inference: GestureInference | null;
  closing: Promise<void> | null;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Two independent tracking contexts, one outstanding frame each, and no frame queue. */
export class RemoteGestureCoordinator {
  private readonly sessions = new Map<string, Session>();
  // Includes warming and closing workers: replacing a connection cannot bypass the process limit.
  private readonly workers = new Set<Session>();
  private readonly opening = new Map<string, symbol>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly maxFrameAgeMs: number;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly options: RemoteGestureCoordinatorOptions) {
    this.maxSessions = options.maxSessions ?? 2;
    this.ttlMs = options.ttlMs ?? REMOTE_GESTURE_SESSION_TTL_MS;
    this.maxFrameAgeMs = options.maxFrameAgeMs ?? 800;
    this.now = options.now ?? (() => performance.now());
    if (!integer(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 4
      || !Number.isFinite(this.ttlMs) || this.ttlMs <= 0
      || !Number.isFinite(this.maxFrameAgeMs) || this.maxFrameAgeMs <= 0) throw new Error('Invalid remote gesture limits');
    this.timer = setInterval(() => this.sweep(), Math.min(1_000, this.ttlMs));
    this.timer.unref();
  }

  /** Called only after HTTP verifies a bound terminal. Credentials and images are never retained. */
  async open(owner: RemoteGestureOpen, inputSettings?: ExhibitionGestureSettings): Promise<RemoteGestureOpenSnapshot> {
    if (!owner || typeof owner.terminalId !== 'string' || !owner.terminalId
      || typeof owner.mirrorId !== 'string' || !owner.mirrorId
      || (owner.epoch !== undefined && !integer(owner.epoch))
      || (owner.blocked !== undefined && typeof owner.blocked !== 'boolean')) this.badRequest();
    this.ensureOpen();
    this.sweep();
    const ticket = Symbol();
    this.opening.set(owner.terminalId, ticket);
    try {
      // A replacement invalidates all outstanding results immediately, before awaiting worker shutdown.
      await Promise.all([...this.workers].filter(session => session.terminalId === owner.terminalId
        || session.mirrorId === owner.mirrorId).map(session => this.dispose(session)));
      this.ensureOpen();
      if (this.opening.get(owner.terminalId) !== ticket) throw this.stale();
      if (this.workers.size >= this.maxSessions) throw new RemoteGestureError(429, 'GESTURE_CAPACITY', '手势设备已满，请稍后重试。');
      const settings = resolveExhibitionGestureSettings(inputSettings);
      const session: Session = {
        id: randomUUID(), terminalId: owner.terminalId, mirrorId: owner.mirrorId,
        epoch: owner.epoch ?? 0, revision: 0, reportedBlocked: owner.blocked ?? true, serverBlocked: false,
        releaseRequired: true, absentSince: null, lastObservedTime: null,
        seq: -1, acceptedTime: null, completedTime: null, inferenceMs: null,
        detector: new ExhibitionMirrorGestureDetector({ ...settings, allowRaise: false }),
        settingsKey: JSON.stringify(settings), lastActivity: this.now(), inFlight: false, closed: false,
        ready: Promise.resolve().then(() => this.options.createInference()), inference: null, closing: null,
      };
      session.detector.setBlocked(true);
      this.sessions.set(session.id, session);
      this.workers.add(session);
      try {
        const inference = await session.ready;
        session.inference = inference;
        if (session.closed || this.opening.get(owner.terminalId) !== ticket) throw this.stale();
        session.lastActivity = this.now();
        return { ...this.snapshot(session), frameFormat: 'i420-v1' };
      } catch (error) {
        const invalidated = session.closed;
        await this.dispose(session);
        if (invalidated || error instanceof RemoteGestureError) throw this.stale();
        throw new RemoteGestureError(503, 'GESTURE_UNAVAILABLE', '手势识别未能启动，请重试。');
      }
    } finally {
      if (this.opening.get(owner.terminalId) === ticket) this.opening.delete(owner.terminalId);
    }
  }

  /** Identity lookup does not refresh the idle timeout or grant access by itself. */
  session(sessionId: string): RemoteGestureOwner | null {
    this.sweep();
    const session = this.sessions.get(sessionId);
    return session ? { terminalId: session.terminalId, mirrorId: session.mirrorId } : null;
  }

  control(sessionId: string, control: RemoteGestureControl): RemoteGestureSnapshot {
    const session = this.get(sessionId);
    this.validateControl(control);
    if (control.epoch < session.epoch) throw this.stale();
    this.applyControl(session, control);
    session.lastActivity = this.now();
    return this.snapshot(session);
  }

  async frame(sessionId: string, metadata: RemoteGestureFrameMetadata, image: Buffer,
    inputSettings: ExhibitionGestureSettings, serverBlocked: boolean,
    guard: () => boolean = () => true, rawFrame?: RemoteGestureI420Metadata): Promise<RemoteGestureSnapshot> {
    const session = this.get(sessionId);
    this.validateControl(metadata);
    if (!integer(metadata.seq) || !integer(metadata.timestamp)
      || typeof serverBlocked !== 'boolean' || !Buffer.isBuffer(image) || !image.length
      || (rawFrame === undefined ? image.length > REMOTE_GESTURE_MAX_FRAME_BYTES
        : remoteGestureI420ByteLength(rawFrame) !== image.length)) this.badRequest();
    if (metadata.epoch < session.epoch || metadata.seq <= session.seq
      || (session.acceptedTime !== null && metadata.timestamp <= session.acceptedTime)) throw this.stale();
    // New control is applied even if a previous frame is still finishing. That older frame is invalid now.
    this.applyControl(session, metadata);
    if (session.serverBlocked !== serverBlocked) {
      session.serverBlocked = serverBlocked;
      this.invalidate(session, session.inFlight);
    }
    if (session.inFlight) throw new RemoteGestureError(409, 'GESTURE_BUSY', '上一帧仍在识别。');
    if (!session.inference) throw new RemoteGestureError(409, 'GESTURE_WARMING', '手势识别正在启动。');
    const settings = resolveExhibitionGestureSettings(inputSettings);
    const key = JSON.stringify(settings);
    if (key !== session.settingsKey) {
      this.invalidate(session, true);
      session.detector.configure({ ...settings, allowRaise: false });
      session.settingsKey = key;
    }
    session.detector.setBlocked(this.blocked(session));
    session.seq = metadata.seq;
    session.acceptedTime = metadata.timestamp;
    session.lastActivity = this.now();
    const startedAt = this.now();
    const revision = session.revision;
    session.inFlight = true;
    try {
      let result: Awaited<ReturnType<GestureInference['infer']>>;
      try {
        result = await session.inference.infer(image, metadata.timestamp, settings, rawFrame);
      } catch {
        const invalidated = session.closed || session.revision !== revision;
        // The failed tracker may have lost its VIDEO context. Reopening starts behind the release fence.
        void this.dispose(session);
        if (invalidated) throw this.stale();
        throw new RemoteGestureError(503, 'GESTURE_INFERENCE_FAILED', '手势识别失败，请重试。');
      }
      if (session.closed || session.revision !== revision || this.sessions.get(sessionId) !== session) throw this.stale();
      if (this.now() - startedAt >= this.maxFrameAgeMs) {
        this.invalidate(session, true);
        throw new RemoteGestureError(408, 'GESTURE_FRAME_EXPIRED', '识别帧已过期。');
      }
      let current = false;
      try { current = guard(); } catch { /* A changed/removed binding is an invalidation, never a model event. */ }
      if (!current) {
        this.invalidate(session, true);
        throw this.stale();
      }
      if (!Array.isArray(result.hands) || !Array.isArray(result.poses) || !Number.isFinite(result.width) || !Number.isFinite(result.height)
        || result.width <= 0 || result.height <= 0 || !Number.isFinite(result.inferenceMs) || result.inferenceMs < 0) {
        void this.dispose(session);
        throw new RemoteGestureError(503, 'GESTURE_INFERENCE_FAILED', '手势识别失败，请重试。');
      }
      // Match the mirrored browser preview: transform both models' coordinates exactly once
      // so the shared detector can associate both hands with the same person's wrists.
      const hands = result.hands.map(hand => ({ ...hand,
        landmarks: hand.landmarks.map(point => ({ ...point, x: 1 - point.x })) }));
      const poses = result.poses.map(pose => ({ ...pose,
        landmarks: pose.landmarks.map(point => ({ ...point, x: 1 - point.x })) }));
      const fenced = session.releaseRequired;
      session.detector.setBlocked(this.blocked(session));
      const event = session.detector.update(poses, hands, metadata.timestamp, result.width / result.height);
      if (fenced) {
        const continuous = session.lastObservedTime !== null
          && metadata.timestamp - session.lastObservedTime < RELEASE_MAX_FRAME_GAP_MS;
        if (hands.length) session.absentSince = null;
        else {
          if (!continuous || session.absentSince === null) session.absentSince = metadata.timestamp;
          if (metadata.timestamp - session.absentSince >= RELEASE_MS) {
            session.releaseRequired = false;
            // Empty observations already proved release, including any old detector latch.
            session.detector.reset();
            session.detector.setBlocked(this.blocked(session));
            session.absentSince = null;
          }
        }
      }
      session.lastObservedTime = metadata.timestamp;
      session.completedTime = metadata.timestamp;
      session.inferenceMs = result.inferenceMs;
      return this.snapshot(session, !fenced && (event === 'open_palm' || event === 'wave') ? event : null);
    } finally {
      // Invalidating an epoch never releases this slot early; no two model calls can overlap.
      session.inFlight = false;
    }
  }

  close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    return session ? this.dispose(session) : Promise.resolve();
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.opening.clear();
    await Promise.all([...this.workers].map(session => this.dispose(session)));
  }

  sweep(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastActivity >= this.ttlMs) void this.dispose(session);
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new RemoteGestureError(503, 'GESTURE_UNAVAILABLE', '手势识别未启动。');
  }

  private get(sessionId: string): Session {
    this.ensureOpen();
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session) throw new RemoteGestureError(404, 'GESTURE_SESSION_EXPIRED', '手势连接已失效，请重试。');
    return session;
  }

  private applyControl(session: Session, control: RemoteGestureControl): void {
    if (control.epoch === session.epoch && control.blocked === session.reportedBlocked && !control.reset) return;
    session.epoch = control.epoch;
    session.reportedBlocked = control.blocked;
    // An in-flight image discarded at a boundary may contain a previously unseen raised hand.
    // Require observed release instead of turning that unknown hand into a fresh action after reconnect.
    this.invalidate(session, control.reset === true || session.inFlight);
  }

  private invalidate(session: Session, requireRelease: boolean): void {
    session.revision++;
    if (requireRelease) {
      // Reset/configuration changes and discarded in-flight images have unknown gesture evidence.
      // Consume the visible palm before clearing ownership, then require observed release.
      session.detector.setBlocked(true);
      session.detector.reset(true);
      session.releaseRequired = true;
      session.absentSince = null;
      session.lastObservedTime = null;
    }
    // Like the browser's busy boundary, preserve the body lock and observed lowering.
    // Reacquiring the person here would discard a valid release while an outfit is changing.
    session.detector.setBlocked(this.blocked(session));
  }

  private blocked(session: Session): boolean {
    return session.reportedBlocked || session.serverBlocked || session.releaseRequired;
  }

  private snapshot(session: Session, event: 'open_palm' | 'wave' | null = null): RemoteGestureSnapshot {
    const detector = session.detector;
    return { sessionId: session.id, epoch: session.epoch, seq: session.seq, timestamp: session.completedTime,
      event, blocked: this.blocked(session), operatorStatus: detector.operatorStatus,
      controlSource: detector.controlSource, ambiguityReason: detector.ambiguityReason,
      handDetected: detector.handDetected, handRaised: detector.handRaised, armed: detector.armed,
      needsRelease: session.releaseRequired || detector.needsRelease,
      confirmationState: session.releaseRequired ? 'release_required' : detector.confirmationState,
      palmHoldMs: detector.palmHoldMs, rawHandCount: detector.rawHandCount,
      matchedHandCount: detector.matchedHandCount, inferenceMs: session.inferenceMs };
  }

  private dispose(session: Session): Promise<void> {
    if (session.closing) return session.closing;
    session.closed = true;
    session.revision++;
    this.sessions.delete(session.id);
    session.closing = (async () => {
      try { await (await session.ready).close(); } catch { /* The model may already have exited. */ }
      finally { this.workers.delete(session); }
    })();
    return session.closing;
  }

  private validateControl(control: RemoteGestureControl): void {
    if (!control || !integer(control.epoch) || typeof control.blocked !== 'boolean'
      || (control.reset !== undefined && typeof control.reset !== 'boolean')) this.badRequest();
  }

  private stale(): RemoteGestureError { return new RemoteGestureError(409, 'GESTURE_STALE', '手势帧已失效。'); }
  private badRequest(): never { throw new RemoteGestureError(400, 'GESTURE_INVALID', '手势请求无效。'); }
}
