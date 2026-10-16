import { ExhibitionGestureDetector, type ExhibitionGestureHand, type ExhibitionGestureLandmark } from './gestureDetector.ts';
import { ExhibitionRaiseGestureDetector, type ExhibitionGesturePose, type ExhibitionGesturePoseLandmark } from './raiseGestureDetector.ts';

// Initial camera tuning, to validate against real seated and standing recordings.
const MIN_VISIBILITY = 0.65;
const MAX_FRAME_GAP_MS = 350;
const WRIST_MATCH_SCALE = 0.25;
const MIN_WRIST_MATCH_DISTANCE = 0.035;
const MAX_WRIST_MATCH_DISTANCE = 0.12;
const RELEASE_STILL_MS = 600;
const RELEASE_LOWER_MS = 350;
const LOWER_WRIST_RADIUS = 0.035;
const LOWER_TRACK_GRACE_MS = 500;
const STILL_RADIUS = 0.018;
const PALM_CONFIRM_MS = 300;
const PALM_WITHDRAW_MS = 500;
const PALM_LOWER_MS = 350;
const MIN_FULL_PALM_SIZE = 0.028;
// Presentation tolerates one naturally short or gently bent finger; these
// initial limits do not require finger separation or an abducted thumb.
const GENTLE_FINGER_STRAIGHTNESS = 0.65;
const GENTLE_FINGER_REACH = 0.30;
const GENTLE_FINGER_RADIAL = 1.03;
const CLOSED_FINGER_STRAIGHTNESS = 0.65;
const CLOSED_FINGER_RADIAL = 0.95;
const HAND_SETTLE_MS = 200;
const WRISTS = [15, 16] as const;
const SHOULDERS = [11, 12] as const;
type Arm = 0 | 1;
interface BodyAnchor { x: number; y: number; width: number; scale: number; }
interface PalmPosition { wrist: ExhibitionGestureLandmark; tips: ExhibitionGestureLandmark; }
interface PalmLowering {
  body: BodyAnchor;
  /** Triggering wrist height relative to the same body's shoulder scale. */
  wristY: number;
  since: number | null;
  wristX?: number;
  tipX?: number;
  lastAt?: number;
  trackingLost?: boolean;
  waitingForRaise: boolean;
}
interface PalmDisplay { consumed: boolean; since: number | null; absentSince: number | null; lowering: PalmLowering | null; }
export type ExhibitionGestureConfirmationState = 'no_hand' | 'unmatched_hand' | 'settling' | 'ambiguous'
  | 'incomplete' | 'too_small' | 'fingers_folded' | 'holding' | 'already_triggered' | 'release_required'
  | 'lowering' | 'raise_required';
interface Latch {
  arm: Arm;
  body: BodyAnchor;
  wristY: number;
  lowerSince: number | null;
  stillSince: number | null;
  stillAnchor: PalmPosition | null;
}
interface BlockedWave {
  stillAnchor: PalmPosition | null;
  stillSince: number | null;
  absentSince: number | null;
  released: boolean;
}

function trusted(point: ExhibitionGesturePoseLandmark | undefined): point is ExhibitionGesturePoseLandmark {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    && Number.isFinite(point.visibility) && point.visibility! >= MIN_VISIBILITY
    && (point.presence === undefined || (Number.isFinite(point.presence) && point.presence >= MIN_VISIBILITY));
}

function anchor(pose: ExhibitionGesturePose, aspect: number): BodyAnchor {
  const [left, right] = SHOULDERS.map(index => pose.landmarks[index]);
  const width = Math.abs(right.x - left.x);
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2,
    width, scale: Math.hypot(width * aspect, right.y - left.y) };
}

function sameBody(previous: BodyAnchor, next: BodyAnchor): boolean {
  const comparable = (a: number, b: number) => Math.max(a, b) / Math.min(a, b) <= 1.35;
  return Math.abs(previous.x - next.x) <= previous.width * 0.45
    && Math.abs(previous.y - next.y) <= previous.scale * 0.65
    && comparable(previous.width, next.width) && comparable(previous.scale, next.scale);
}

function distance(a: ExhibitionGestureLandmark, b: ExhibitionGestureLandmark, aspect: number) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

function usableHand(hand: ExhibitionGestureHand, aspect: number) {
  return hand.landmarks.length === 21 && hand.landmarks.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    && hand.landmarks[0].x >= 0 && hand.landmarks[0].x <= 1 && hand.landmarks[0].y >= 0 && hand.landmarks[0].y <= 1
    && distance(hand.landmarks[0], hand.landmarks[9], aspect) >= 0.018;
}

function sameHand(previous: ExhibitionGestureHand, next: ExhibitionGestureHand, aspect: number) {
  const a = distance(previous.landmarks[0], previous.landmarks[9], aspect);
  const b = distance(next.landmarks[0], next.landmarks[9], aspect);
  return Math.max(a, b) / Math.min(a, b) <= 1.8
    && distance(previous.landmarks[0], next.landmarks[0], aspect) <= Math.max(0.12, Math.min(0.30, Math.max(a, b) * 3));
}

function matchedHands(pose: ExhibitionGesturePose, hands: readonly ExhibitionGestureHand[], body: BodyAnchor, aspect: number) {
  const matches: [ExhibitionGestureHand[], ExhibitionGestureHand[]] = [[], []];
  const tolerance = Math.min(MAX_WRIST_MATCH_DISTANCE, Math.max(MIN_WRIST_MATCH_DISTANCE, body.scale * WRIST_MATCH_SCALE));
  for (const hand of hands) {
    if (hand.landmarks.length !== 21 || hand.landmarks.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue;
    const wrist = hand.landmarks[0];
    if (wrist.x < 0 || wrist.x > 1 || wrist.y < 0 || wrist.y > 1) continue;
    const owners = ([0, 1] as const).filter(arm => {
      const point = pose.landmarks[WRISTS[arm]];
      return trusted(point) && distance(wrist, point, aspect) <= tolerance;
    });
    // Crossing wrists or duplicate hand candidates cannot establish ownership.
    if (owners.length === 1) matches[owners[0]].push(hand);
  }
  return matches.map(items => items.length === 1 ? items[0] : null) as [ExhibitionGestureHand | null, ExhibitionGestureHand | null];
}

function palmPosition(hand: ExhibitionGestureHand, body: BodyAnchor): PalmPosition {
  const relative = (point: ExhibitionGestureLandmark) => ({ x: point.x - body.x, y: point.y - body.y });
  const tips = [8, 12, 16].map(index => hand.landmarks[index]);
  return { wrist: relative(hand.landmarks[0]), tips: relative({
    x: tips.reduce((sum, point) => sum + point.x, 0) / tips.length,
    y: tips.reduce((sum, point) => sum + point.y, 0) / tips.length,
  }) };
}

function fingerShapes(hand: ExhibitionGestureHand, aspect: number) {
  const points = hand.landmarks;
  const palmSize = distance(points[0], points[9], aspect);
  return [5, 9, 13, 17].map(start => {
    const [base, pip, dip, tip] = points.slice(start, start + 4);
    const length = distance(base, pip, aspect) + distance(pip, dip, aspect) + distance(dip, tip, aspect);
    const pipRadius = distance(points[0], pip, aspect);
    const straightness = length > 0 ? distance(base, tip, aspect) / length : 0;
    const reach = distance(base, tip, aspect) / palmSize;
    const radial = pipRadius > 0 ? distance(points[0], tip, aspect) / pipRadius : 0;
    return { straightness, reach, radial,
      strict: straightness >= 0.8 && reach >= 0.65 && radial >= 1.13,
      // Collapsed landmark chains are uncertainty, not evidence of a fist.
      measurable: length >= palmSize * 0.3 && pipRadius >= palmSize * 0.3 };
  });
}

function palmGeometryIssue(hand: ExhibitionGestureHand | null, aspect: number): ExhibitionGestureConfirmationState | null {
  if (!hand) return 'no_hand';
  if (hand.landmarks.length !== 21 || !hand.landmarks.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) return 'incomplete';
  if (distance(hand.landmarks[0], hand.landmarks[9], aspect) < MIN_FULL_PALM_SIZE) return 'too_small';
  return null;
}

function palmIssue(hand: ExhibitionGestureHand | null, aspect: number): ExhibitionGestureConfirmationState | null {
  const geometryIssue = palmGeometryIssue(hand, aspect);
  if (geometryIssue || !hand) return geometryIssue;
  const fingers = fingerShapes(hand, aspect);
  return fingers.filter(finger => finger.strict).length >= 3 && fingers.every(finger =>
    finger.straightness >= GENTLE_FINGER_STRAIGHTNESS && finger.reach >= GENTLE_FINGER_REACH
    && finger.radial >= GENTLE_FINGER_RADIAL) ? null : 'fingers_folded';
}

function clearlyClosedPalm(hand: ExhibitionGestureHand, aspect: number): boolean {
  if (palmGeometryIssue(hand, aspect)) return false;
  return fingerShapes(hand, aspect).filter(finger => finger.measurable
    && finger.straightness < CLOSED_FINGER_STRAIGHTNESS && finger.radial < CLOSED_FINGER_RADIAL).length >= 2;
}

function palmMoved(a: PalmPosition, b: PalmPosition, aspect: number) {
  return Math.max(distance(a.wrist, b.wrist, aspect), distance(a.tips, b.tips, aspect)) > STILL_RADIUS;
}

const newDisplay = (): PalmDisplay => ({ consumed: false, since: null, absentSince: null, lowering: null });
interface MirrorGestureOptions {
  allowRaise?: boolean;
  gestures?: readonly ('open_palm' | 'wave')[];
  palmConfirmMs?: number;
  palmReleaseMs?: number;
  palmLowerMs?: number;
  lowerTrackingGraceMs?: number;
}

/** Each visible hand can act; body association only assists tracking and natural lowering. */
export class ExhibitionMirrorGestureDetector {
  constructor(private options: MirrorGestureOptions = {}) {
    this.options = { ...options, ...(options.gestures ? { gestures: [...new Set(options.gestures)] } : {}) };
  }
  /** Reconfigure the same camera's detector without rearming a consumed palm. */
  configure(options: MirrorGestureOptions): void {
    this.options = { ...options, ...(options.gestures ? { gestures: [...new Set(options.gestures)] } : {}) };
    this.reset(true);
  }
  private get palmEnabled() { return this.options.gestures?.includes('open_palm') ?? true; }
  private get waveEnabled() { return this.options.gestures?.includes('wave') ?? true; }
  private get palmConfirmMs() { return this.options.palmConfirmMs ?? PALM_CONFIRM_MS; }
  private get palmReleaseMs() { return this.options.palmReleaseMs ?? PALM_WITHDRAW_MS; }
  private get palmLowerMs() { return this.options.palmLowerMs ?? PALM_LOWER_MS; }
  private get lowerTrackingGraceMs() { return this.options.lowerTrackingGraceMs ?? LOWER_TRACK_GRACE_MS; }
  private raise = new ExhibitionRaiseGestureDetector();
  private waves = [new ExhibitionGestureDetector({ waveReversals: 1 }), new ExhibitionGestureDetector({ waveReversals: 1 })];
  private palms: [PalmDisplay, PalmDisplay] = [newDisplay(), newDisplay()];
  private previousTime: number | null = null;
  private noHandsSince: number | null = null;
  private body: BodyAnchor | null = null;
  private latch: Latch | null = null;
  private detected = false;
  private raised = false;
  private matched = false;
  private raiseStartedAt: number | null = null;
  private status: 'searching' | 'locked' | 'ambiguous' = 'searching';
  private source: 'body' | 'hand' | 'none' = 'none';
  private ambiguity: 'people' | 'hands' | null = null;
  private lastHands: [ExhibitionGestureHand | null, ExhibitionGestureHand | null] = [null, null];
  private handSince: [number | null, number | null] = [null, null];
  private handLastAt: [number | null, number | null] = [null, null];
  private associatedBody: BodyAnchor | null = null;
  private poseArms: [Arm | null, Arm | null] = [null, null];
  private rawCount = 0;
  private matchedCount = 0;
  private palmIssues: [ExhibitionGestureConfirmationState | null, ExhibitionGestureConfirmationState | null] = ['no_hand', 'no_hand'];
  private blocked = false;
  private blockedWaves: [BlockedWave | null, BlockedWave | null] = [null, null];

  /** Busy periods still observe release, but never accumulate a future action. */
  setBlocked(blocked: boolean): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    this.clearWaves();
    for (const display of this.palms) display.since = null;
    if (blocked && this.body) {
      for (const arm of [0, 1] as const) {
        if (this.palmIssues[arm] === null) this.consumePalm(arm, null, this.body);
        if (this.waveEnabled && this.palmIssues[arm] !== 'no_hand') this.guardBlockedWave(arm);
      }
    }
    if (!blocked) for (const arm of [0, 1] as const) {
      if (this.blockedWaves[arm]?.released) this.blockedWaves[arm] = null;
    }
  }

  get operatorStatus() { return this.status; }
  get controlSource() { return this.source; }
  get ambiguityReason() { return this.ambiguity; }
  get handDetected() { return this.detected; }
  get handRaised() { return this.raised; }
  get armed() { return !this.blocked && this.operatorStatus === 'locked' && !this.latch && ((this.palmEnabled || this.waveEnabled)
    && this.palms.some((display, arm) => this.palmIssues[arm] !== 'no_hand' && ((this.waveEnabled && !this.blockedWaves[arm])
      || (this.palmEnabled && !display.consumed && !display.lowering?.waitingForRaise))) || (!!this.options.allowRaise && this.raise.armed)); }
  get needsRelease() { return this.latch !== null || this.blockedWaves.some(guard => guard !== null && !guard.released); }
  get lastRaiseStartedAt() { return this.raiseStartedAt; }
  get rawHandCount() { return this.rawCount; }
  get matchedHandCount() { return this.matchedCount; }
  get confirmationState(): ExhibitionGestureConfirmationState {
    if (this.status === 'ambiguous') return 'ambiguous';
    if (!this.rawCount) return 'no_hand';
    if (!this.matchedCount) return 'unmatched_hand';
    if (this.status !== 'locked') return 'settling';
    if (this.palmEnabled && this.palms.some(display => display.lowering?.since != null)) return 'lowering';
    if (this.needsRelease) return 'release_required';
    if (this.palmIssues.some((issue, arm) => issue === null && !this.palms[arm].consumed && !this.palms[arm].lowering?.waitingForRaise)) return 'holding';
    if (this.palmEnabled && this.palms.some(display => display.lowering?.waitingForRaise)) return 'raise_required';
    if (this.palmIssues.some(issue => issue === null)) return 'already_triggered';
    return this.palmIssues.find(issue => issue !== 'no_hand') ?? 'no_hand';
  }
  /** Current uninterrupted, unconsumed full-palm observation; no landmark data leaves the detector. */
  get palmHoldMs(): number {
    if (this.blocked || !this.palmEnabled) return 0;
    return Math.max(0, ...this.palms.map((display, arm) => this.palmIssues[arm] === null && !display.consumed && !display.lowering?.waitingForRaise
      && display.since !== null && this.previousTime !== null ? Math.min(this.palmConfirmMs, this.previousTime - display.since) : 0));
  }

  /** Soft blocking boundaries clear trajectories but cannot turn a held wave into a new action. */
  reset(preserveLatch = false): void {
    this.raise.reset();
    this.clearWaves();
    this.previousTime = null;
    this.noHandsSince = null;
    this.body = null;
    this.associatedBody = null;
    this.handSince = [null, null]; this.handLastAt = [null, null];
    this.rawCount = this.matchedCount = 0;
    this.palmIssues = ['no_hand', 'no_hand'];
    this.status = 'searching'; this.source = 'none'; this.ambiguity = null;
    this.detected = this.raised = this.matched = false;
    this.raiseStartedAt = null;
    if (!preserveLatch) {
      this.latch = null; this.palms = [newDisplay(), newDisplay()];
      this.lastHands = [null, null]; this.poseArms = [null, null];
      this.blockedWaves = [null, null];
    }
    this.clearDisplayProgress();
    this.clearReleaseProgress();
  }

  update(poses: readonly ExhibitionGesturePose[], hands: readonly ExhibitionGestureHand[], timestampMs: number,
    frameAspectRatio = 1): 'raise_hand' | 'wave' | 'open_palm' | null {
    this.raiseStartedAt = null;
    if (!Number.isFinite(timestampMs)) return null;
    if (!Number.isFinite(frameAspectRatio) || frameAspectRatio <= 0) { this.reset(true); return null; }
    if (this.previousTime !== null) {
      if (timestampMs === this.previousTime) return null;
      if (timestampMs < this.previousTime || timestampMs - this.previousTime > MAX_FRAME_GAP_MS) this.reset(true);
    }
    this.previousTime = timestampMs;
    this.noHandsSince = hands.length ? null : this.noHandsSince ?? timestampMs;
    this.rawCount = hands.length; this.matchedCount = 0;
    this.palmIssues = ['no_hand', 'no_hand'];
    const raiseEvent = this.raise.update(poses, timestampMs, frameAspectRatio);
    const lockedPose = this.raise.operatorPose;
    const lockedBody = lockedPose ? anchor(lockedPose, frameAspectRatio) : null;
    const bodyHands = lockedPose && lockedBody ? matchedHands(lockedPose, hands, lockedBody, frameAspectRatio) : null;
    // Stable hand slots are independent of model labels, list ordering and body
    // ownership. An unmatched or second person's hand is still a valid control.
    const matches = this.trackHands(hands, bodyHands, lockedBody, frameAspectRatio);
    const pose = lockedPose ? this.poseForSlots(lockedPose, matches, bodyHands!) : null;
    const bodyAssociated = !!pose && matches.some((hand, arm) => hand && trusted(pose.landmarks[WRISTS[arm]]));
    const nextSource = pose && (bodyAssociated || !matches.some(Boolean)) ? 'body' : matches.some(Boolean) ? 'hand' : 'none';
    // A visible but unrelated body cannot move a hand-only track's coordinate
    // origin: that would make its old latch appear to belong to someone else.
    const body = (nextSource === 'body' ? lockedBody : null)
      ?? this.body ?? this.latch?.body ?? { x: 0, y: 0, width: 1, scale: 1 };
    const sourceChanged = this.source !== nextSource;
    this.source = nextSource;
    this.detected = !!this.options.allowRaise && this.raise.handDetected;
    this.raised = !!this.options.allowRaise && this.raise.handRaised;
    this.matched = false;
    this.ambiguity = null;
    const bodyChanged = !!pose && !!this.associatedBody && !sameBody(this.associatedBody, body);
    if (bodyChanged) {
      this.clearWaves(); this.clearReleaseProgress();
      this.clearDisplayProgress();
      this.handSince = [null, null]; this.handLastAt = [null, null];
    } else if (sourceChanged && this.body && distance(this.body, body, frameAspectRatio) > STILL_RADIUS) {
      // A new coordinate origin invalidates motion, not continuous full-palm visibility.
      this.clearWaves(); this.clearReleaseProgress();
    }
    if (pose) this.associatedBody = body;
    if (sourceChanged && this.latch) this.latch.body = body;
    this.body = body;
    for (const arm of [0, 1] as const) {
      const hand = matches[arm];
      if (!hand) { this.handSince[arm] = this.handLastAt[arm] = null; continue; }
      const continuing = this.handLastAt[arm] !== null && timestampMs - this.handLastAt[arm]! <= MAX_FRAME_GAP_MS
        && this.lastHands[arm] && sameHand(this.lastHands[arm]!, hand, frameAspectRatio);
      if (!continuing) {
        this.handSince[arm] = timestampMs;
        this.palms[arm].since = this.palms[arm].absentSince = null;
        this.waves[arm].reset();
        // A returning Hand result may have changed size while its body wrist
        // kept the same lowering trajectory. Reset hand-based stillness only.
        if (this.latch?.arm === arm) this.clearReleaseProgress(!!pose && !bodyChanged);
      }
      this.handLastAt[arm] = timestampMs;
      this.lastHands[arm] = hand;
    }
    this.status = (pose && (bodyAssociated || !matches.some(Boolean))) || matches.some((hand, arm) => hand && usableHand(hand, frameAspectRatio)
      && this.handSince[arm] !== null && timestampMs - this.handSince[arm]! >= HAND_SETTLE_MS) ? 'locked' : 'searching';
    this.matchedCount = matches.filter(Boolean).length;
    this.matched = matches.some(Boolean);
    this.detected ||= this.matched;
    this.raised ||= !!pose && matches.some((hand, arm) => hand && hand.landmarks[0].y < pose.landmarks[SHOULDERS[arm]].y);

    this.palmIssues = matches.map(hand => palmIssue(hand, frameAspectRatio)) as typeof this.palmIssues;
    const complete = this.palmIssues.map(issue => issue === null);
    const unknownHand = hands.some(hand => !matches.includes(hand));
    this.observeLoweredPalms(pose, matches, unknownHand, body, timestampMs, frameAspectRatio);
    this.observeDisplays(matches, complete, unknownHand, body, timestampMs, frameAspectRatio);
    // Every tracked hand seen during busy is consumed independently. A bad or
    // unrelated second hand cannot veto a qualified hand after a fresh release.
    if (this.blocked) {
      for (const arm of [0, 1] as const) {
        if (complete[arm]) this.consumePalm(arm, pose, body);
        if (this.waveEnabled && matches[arm]) this.guardBlockedWave(arm);
      }
    }
    this.observeBlockedWaves(matches, unknownHand, body, timestampMs, frameAspectRatio);
    // Complete Hand-model absence releases independently of body identity. A
    // newly locked or moving pose must not restart the observed absence clock.
    if (this.noHandsSince !== null && timestampMs - this.noHandsSince >= this.palmReleaseMs) {
      this.latch = null;
      this.palms = [newDisplay(), newDisplay()];
      this.blockedWaves = [null, null];
      this.clearWaves();
    }
    if (this.blocked) {
      this.clearWaves();
      for (const display of this.palms) display.since = null;
      if (this.latch && this.status === 'locked') this.observeRelease(pose, matches, body, timestampMs, frameAspectRatio);
      return null;
    }
    if (this.status !== 'locked') {
      // Track the start of a new hand's wave while ownership settles. The 200 ms
      // settling interval is shorter than wave's 300 ms minimum, so this cannot
      // confirm or consume an action before ownership is locked.
      if (this.waveEnabled && this.source === 'hand' && !this.latch) {
        for (const arm of [0, 1] as const) if (!this.blockedWaves[arm]) this.observeWave(arm, matches[arm], body, timestampMs);
      }
      return null;
    }

    if (this.latch) {
      // An open hand shown during another action is consumed, never queued for
      // the instant the busy boundary or the shared latch clears.
      for (const arm of [0, 1] as const) if (complete[arm]) this.consumePalm(arm, pose, body);
      this.clearWaves();
      this.observeRelease(pose, matches, body, timestampMs, frameAspectRatio);
      return null;
    }
    if (this.options.allowRaise && raiseEvent && this.raise.lastTriggeredArm !== null) {
      this.raiseStartedAt = this.raise.lastRaiseStartedAt;
      const slot = this.poseArms.findIndex(arm => arm === this.raise.lastTriggeredArm);
      this.lock((slot < 0 ? this.raise.lastTriggeredArm : slot) as Arm, pose, body, complete);
      return 'raise_hand';
    }
    for (const arm of [0, 1] as const) {
      const display = this.palms[arm];
      if (this.palmEnabled && complete[arm] && !display.consumed && !display.lowering?.waitingForRaise
        && display.since !== null && timestampMs - display.since >= this.palmConfirmMs) {
        this.lock(arm, pose, body, complete);
        return 'open_palm';
      }
    }
    for (const arm of this.waveEnabled ? [0, 1] as const : []) {
      if (!this.blockedWaves[arm] && this.observeWave(arm, matches[arm], body, timestampMs)) {
        this.lock(arm, pose, body, complete);
        return 'wave';
      }
    }
    return null;
  }

  private guardBlockedWave(arm: Arm) {
    this.blockedWaves[arm] ??= { stillAnchor: null, stillSince: null, absentSince: null, released: false };
  }

  /** Retain neutral observations, never the motion history of an ignored wave. */
  private observeBlockedWaves(matches: readonly (ExhibitionGestureHand | null)[], unknownHand: boolean,
    body: BodyAnchor, timestamp: number, aspect: number) {
    for (const arm of [0, 1] as const) {
      const guard = this.blockedWaves[arm];
      if (!guard) continue;
      const hand = matches[arm];
      if (hand) {
        const position = palmPosition(hand, body);
        if (!guard.stillAnchor || palmMoved(position, guard.stillAnchor, aspect)) {
          guard.stillAnchor = position; guard.stillSince = timestamp; guard.released = false;
        } else if (guard.stillSince !== null && timestamp - guard.stillSince >= RELEASE_STILL_MS) guard.released = true;
      } else { guard.stillAnchor = null; guard.stillSince = null; }
      if (hand ? clearlyClosedPalm(hand, aspect) : !unknownHand) {
        guard.absentSince ??= timestamp;
        if (timestamp - guard.absentSince >= this.palmReleaseMs) guard.released = true;
      } else guard.absentSince = null;
      if (!this.blocked && guard.released) this.blockedWaves[arm] = null;
    }
  }

  private observeWave(arm: Arm, hand: ExhibitionGestureHand | null, body: BodyAnchor, timestampMs: number): boolean {
    // Physical ownership is tracked above; changing model labels or a body/hand
    // slot remapping must not discard the same hand's motion history.
    const owned = hand ? { handedness: 'control-hand', landmarks: hand.landmarks.map(point => ({
      ...point, x: point.x - body.x, y: point.y - body.y,
    })) } : null;
    return this.waves[arm].update(owned, timestampMs, 'wave') === 'wave';
  }

  private lock(arm: Arm, pose: ExhibitionGesturePose | null, body: BodyAnchor, complete: readonly boolean[]) {
    this.latch = { arm, body, wristY: pose ? pose.landmarks[WRISTS[arm]].y - body.y : 0,
      lowerSince: null, stillSince: null, stillAnchor: null };
    for (const index of [0, 1] as const) if (index === arm || complete[index]) this.consumePalm(index, pose, body);
    this.clearWaves();
  }

  private consumePalm(arm: Arm, pose: ExhibitionGesturePose | null, body: BodyAnchor) {
    const display = this.palms[arm];
    // A hand already resting in the lowered zone is not a new presentation.
    if (display.lowering?.waitingForRaise) return;
    if (!display.consumed) display.lowering = null;
    display.consumed = true;
    const wrist = pose?.landmarks[WRISTS[arm]];
    if (!display.lowering && trusted(wrist)) display.lowering = {
      body: { ...body }, wristY: (wrist.y - body.y) / body.scale, since: null, waitingForRaise: false,
    };
  }

  /** A natural drop belongs to a consumed palm, independently of the short-lived action latch. */
  private observeLoweredPalms(pose: ExhibitionGesturePose | null, matches: readonly (ExhibitionGestureHand | null)[],
    unknownHand: boolean, body: BodyAnchor, timestamp: number, aspect: number) {
    // Natural lowering rearms palm presentation only. Wave recognition retains
    // its original rest/release rules and accepts deliberate low-level waves.
    if (!this.palmEnabled) {
      for (const display of this.palms) if (display.lowering) display.lowering.since = null;
      return;
    }
    for (const arm of [0, 1] as const) {
      const display = this.palms[arm];
      if (!display.consumed && !display.lowering?.waitingForRaise) continue;
      const hand = matches[arm];
      const wrist = pose?.landmarks[WRISTS[arm]];
      const shoulder = pose?.landmarks[SHOULDERS[arm]];
      // The body wrist can remain reliable as the lowering hand stops looking
      // like a palm. A visible cropped or unowned hand still cannot prove release.
      const certain = this.status === 'locked' && trusted(wrist) && trusted(shoulder)
        && (hand ? hand.landmarks.every(point => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
          : !unknownHand && wrist.x >= 0.025 && wrist.x <= 0.975 && wrist.y <= 0.975);
      if (!certain) {
        const lower = display.lowering;
        // Losing the small Hand result and wrist confidence together during a
        // demonstrated drop may briefly pause confirmation. Only a subsequent
        // trusted low wrist can finish it; uncertainty itself never releases.
        const lowerDistance = trusted(shoulder) ? Math.max(0.04, Math.min(body.scale * 0.4, (1 - shoulder.y) * 0.6)) : Infinity;
        const continuingDrop = lower?.since != null && lower.lastAt !== undefined && !hand && !unknownHand
          && this.status === 'locked' && !!pose && trusted(shoulder) && sameBody(lower.body, body)
          && !!wrist && Number.isFinite(wrist.x) && Number.isFinite(wrist.y)
          && wrist.x >= 0.025 && wrist.x <= 0.975 && wrist.y <= 0.975
          && wrist.y >= shoulder.y + lowerDistance
          && wrist.y >= body.y + lower.wristY * body.scale + Math.max(0.06, body.scale * 0.25)
          && lower.wristX !== undefined && Math.abs(wrist.x - body.x - lower.wristX) * aspect <= LOWER_WRIST_RADIUS
          && timestamp - lower.lastAt <= this.lowerTrackingGraceMs;
        if (lower) {
          lower.trackingLost = true;
          if (!continuingDrop) lower.since = null;
        }
        continue;
      }
      if (!display.lowering) {
        // A hand-only trigger may acquire trustworthy body ownership later.
        // Establish a baseline then; that first pose cannot itself prove a drop.
        display.lowering = { body: { ...body }, wristY: (wrist!.y - body.y) / body.scale, since: null, waitingForRaise: false };
        continue;
      }
      const lower = display.lowering;
      if (!sameBody(lower.body, body)) { lower.since = null; continue; }
      lower.body = { ...body };
      const lowerDistance = Math.max(0.04, Math.min(body.scale * 0.4, (1 - shoulder!.y) * 0.6));
      const lowerBoundary = shoulder!.y + lowerDistance;
      const triggerHeight = body.y + lower.wristY * body.scale;
      if (lower.waitingForRaise) {
        // Position hysteresis: holding an open hand by the hip must not start a
        // new confirmation, even after a soft reset or body/hand source switch.
        if (wrist!.y <= lowerBoundary - Math.max(0.025, lowerDistance * 0.5)) {
          display.lowering = null;
          display.since = display.absentSince = null;
          this.waves[arm].reset();
        }
        continue;
      }
      const lowered = wrist!.y >= lowerBoundary && wrist!.y >= triggerHeight + Math.max(0.06, body.scale * 0.25);
      if (!lowered) { lower.since = null; continue; }
      const wristX = wrist!.x - body.x;
      const tipX = hand ? [8, 12, 16].reduce((sum, index) => sum + hand.landmarks[index].x, 0) / 3 - hand.landmarks[0].x : undefined;
      // Vertical movement and changing fingers are part of lowering the hand.
      // A sustained horizontal wave or fixed-wrist palm rotation must still not
      // rearm its own presentation; allow small fingertip tracking jitter.
      if (lower.since === null || lower.wristX === undefined || Math.abs(wristX - lower.wristX) * aspect > LOWER_WRIST_RADIUS
        || (lower.trackingLost && lower.lastAt !== undefined && timestamp - lower.lastAt > this.lowerTrackingGraceMs)
        || (tipX !== undefined && lower.tipX !== undefined && Math.abs(tipX - lower.tipX) * aspect > 0.05)) {
        lower.since = timestamp; lower.wristX = wristX; lower.tipX = tipX;
      }
      lower.lastAt = timestamp;
      lower.trackingLost = false;
      if (timestamp - lower.since < this.palmLowerMs) continue;
      display.consumed = false;
      display.since = display.absentSince = null;
      lower.since = null; lower.waitingForRaise = true;
      if (this.latch?.arm === arm) this.latch = null;
      this.blockedWaves[arm] = null;
      this.waves[arm].reset();
    }
  }

  private observeDisplays(matches: readonly (ExhibitionGestureHand | null)[], complete: readonly boolean[], unknownHand: boolean,
    body: BodyAnchor, timestamp: number, aspect: number) {
    const sameOwner = !this.latch || sameBody(this.latch.body, body);
    for (const arm of [0, 1] as const) {
      const display = this.palms[arm];
      const hand = matches[arm];
      if (!sameOwner) { display.since = display.absentSince = null; continue; }
      if (!complete[arm]) {
        display.since = null;
        // Unmatched visible hands are uncertain ownership, not evidence that a
        // hand was intentionally withdrawn. A closed matched hand is a release.
        // A still-open palm partly cropped by the frame is not a closed/withdrawn
        // hand; otherwise a wide continuous wave could unlock itself at an edge.
        if (hand ? clearlyClosedPalm(hand, aspect) : !unknownHand) {
          display.absentSince ??= timestamp;
          if (timestamp - display.absentSince >= this.palmReleaseMs) {
            display.consumed = false;
            display.lowering = null;
            if (this.latch?.arm === arm) { this.latch = null; this.clearWaves(); }
          }
        } else display.absentSince = null;
        continue;
      }
      display.absentSince = null;
      if (display.lowering?.waitingForRaise) { display.since = null; continue; }
      // Presentation is visibility, not a stillness gesture. Motion only matters
      // when releasing an already-triggered wave in observeRelease.
      display.since ??= timestamp;
    }
  }

  private observeRelease(pose: ExhibitionGesturePose | null, matches: readonly (ExhibitionGestureHand | null)[],
    body: BodyAnchor, timestamp: number, aspect: number) {
    const latch = this.latch!;
    if (!sameBody(latch.body, body)) { this.clearReleaseProgress(); return; }
    latch.body = body;
    const wrist = pose?.landmarks[WRISTS[latch.arm]];
    const shoulder = pose?.landmarks[SHOULDERS[latch.arm]];
    const lowerDistance = shoulder ? Math.max(0.025, Math.min(body.scale * 0.4, (1 - shoulder.y) * 0.6)) : Infinity;
    const visiblyLowered = !!shoulder && trusted(wrist) && wrist.y >= shoulder.y + lowerDistance
      && wrist.y - body.y >= latch.wristY + Math.max(0.035, body.scale * 0.12);
    if (visiblyLowered) latch.lowerSince ??= timestamp;
    else latch.lowerSince = null;

    const hand = matches[latch.arm];
    if (!hand) { latch.stillSince = null; latch.stillAnchor = null; }
    else {
      const position = palmPosition(hand, body);
      const moving = !latch.stillAnchor || palmMoved(position, latch.stillAnchor, aspect);
      if (moving) { latch.stillAnchor = position; latch.stillSince = timestamp; }
    }
    if ((this.options.allowRaise && latch.lowerSince !== null && timestamp - latch.lowerSince >= RELEASE_LOWER_MS)
      || (latch.stillSince !== null && timestamp - latch.stillSince >= RELEASE_STILL_MS)) {
      this.latch = null;
      this.clearWaves();
    }
  }

  private clearReleaseProgress(preserveBodyLowering = false) {
    if (this.latch) { this.latch.lowerSince = null; this.latch.stillSince = null; this.latch.stillAnchor = null; }
    for (const guard of this.blockedWaves) if (guard) {
      guard.stillSince = guard.absentSince = null; guard.stillAnchor = null;
    }
    if (!preserveBodyLowering) for (const display of this.palms) if (display.lowering) display.lowering.since = null;
  }

  private clearDisplayProgress() {
    for (const display of this.palms) { display.since = null; display.absentSince = null; }
  }

  /** Choose the lowest-cost one-to-one assignment; handedness is deliberately ignored. */
  private trackHands(hands: readonly ExhibitionGestureHand[], bodyHands: readonly (ExhibitionGestureHand | null)[] | null,
    body: BodyAnchor | null, aspect: number): [ExhibitionGestureHand | null, ExhibitionGestureHand | null] {
    const candidates = hands.filter(hand => hand.landmarks.length === 21
      && hand.landmarks.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
      && hand.landmarks[0].x >= 0 && hand.landmarks[0].x <= 1 && hand.landmarks[0].y >= 0 && hand.landmarks[0].y <= 1)
      .sort((a, b) => a.landmarks[0].x - b.landmarks[0].x || a.landmarks[0].y - b.landmarks[0].y);
    if (!candidates.length) return [null, null];
    const continuingBody = !!body && !!this.associatedBody && sameBody(this.associatedBody, body);
    // An erratic second detection must not steal a clearly continuing first
    // hand merely because swapping both slots has a smaller total distance.
    const certain = this.lastHands.map((previous, arm) => {
      if (!previous) return null;
      const nearest = candidates.map(hand => ({ hand, distance: distance(previous.landmarks[0], hand.landmarks[0], aspect) }))
        .sort((a, b) => a.distance - b.distance);
      const first = nearest[0];
      const other = this.lastHands[1 - arm];
      return first.distance <= 0.06 && (!nearest[1] || nearest[1].distance - first.distance >= 0.025)
        && (!other || distance(other.landmarks[0], first.hand.landmarks[0], aspect) - first.distance >= 0.025)
        ? first.hand : null;
    });
    const cost = (hand: ExhibitionGestureHand, arm: Arm) => {
      const previous = this.lastHands[arm];
      let score = previous ? distance(previous.landmarks[0], hand.landmarks[0], aspect)
        + (sameHand(previous, hand, aspect) ? 0 : 0.12) : 0.6;
      const bodyArm = bodyHands?.indexOf(hand) ?? -1;
      if (bodyArm >= 0 && continuingBody && this.poseArms[arm] === bodyArm) score *= 0.1;
      if (certain[arm] && hand !== certain[arm]) score += 2;
      return score;
    };
    const assignments: { hands: [ExhibitionGestureHand | null, ExhibitionGestureHand | null]; score: number }[] = [];
    if (candidates.length === 1) {
      assignments.push({ hands: [candidates[0], null], score: cost(candidates[0], 0) },
        { hands: [null, candidates[0]], score: cost(candidates[0], 1) });
    } else {
      for (const left of candidates) for (const right of candidates) if (left !== right) {
        assignments.push({ hands: [left, right], score: cost(left, 0) + cost(right, 1) });
      }
    }
    assignments.sort((a, b) => a.score - b.score);
    const best = assignments[0];
    // At a true crossing the two identities may be indistinguishable. Carry
    // consumed state to both possible owners; never turn a held palm into new input.
    if (assignments[1] && assignments[1].score - best.score < 0.015
      && this.lastHands.every(Boolean) && (this.latch || this.palms.some(display => display.consumed))) {
      for (const arm of [0, 1] as const) {
        if (this.palms.some(display => display.consumed)) this.palms[arm].consumed = true;
        if (this.latch && this.waveEnabled) this.guardBlockedWave(arm);
      }
    }
    return best.hands;
  }

  /** Remap body wrists to stable hand slots, without granting body ownership to an unrelated hand. */
  private poseForSlots(pose: ExhibitionGesturePose, matches: readonly (ExhibitionGestureHand | null)[],
    bodyHands: readonly (ExhibitionGestureHand | null)[]): ExhibitionGesturePose {
    const landmarks = [...pose.landmarks];
    const owners = matches.map((hand, slot) => {
      if (hand) {
        const owner = bodyHands.indexOf(hand);
        this.poseArms[slot] = owner >= 0 ? owner as Arm : null;
      }
      return this.poseArms[slot];
    });
    for (const slot of [0, 1] as const) {
      const owner = owners[slot];
      const duplicate = owner !== null && owners[1 - slot] === owner;
      if (owner === null || duplicate) {
        // Keep shoulder geometry but remove wrist authority for natural lowering.
        landmarks[WRISTS[slot]] = { ...pose.landmarks[WRISTS[slot]], visibility: 0, presence: 0 };
      } else {
        landmarks[WRISTS[slot]] = pose.landmarks[WRISTS[owner]];
        landmarks[SHOULDERS[slot]] = pose.landmarks[SHOULDERS[owner]];
      }
    }
    return { ...pose, landmarks };
  }

  private clearWaves() { for (const wave of this.waves) wave.reset(); }
}
