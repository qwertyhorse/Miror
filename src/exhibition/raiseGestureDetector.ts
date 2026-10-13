export interface ExhibitionGesturePoseLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
  presence?: number;
}

export interface ExhibitionGesturePose {
  landmarks: readonly ExhibitionGesturePoseLandmark[];
}

export type ExhibitionOperatorStatus = 'searching' | 'locked' | 'ambiguous';

// Initial exhibition-camera tuning values, not model guarantees. Calibrate these
// with the real camera, mounting height, lighting and standing distance.
const MIN_VISIBILITY = 0.65;
const MIN_PRESENCE = 0.65;
const MAX_FRAME_GAP_MS = 350;
const OPERATOR_SETTLE_MS = 400;
const LOWER_CONFIRM_MS = 350;
const RAISE_CONFIRM_MS = 250;
const CENTRAL_MIN_X = 0.25;
const CENTRAL_MAX_X = 0.75;
const CENTRAL_MIN_Y = 0.12; // Shoulder midpoint, rather than the shoulder/hip midpoint.
const CENTRAL_MAX_Y = 0.92;
const MIN_TORSO_HEIGHT = 0.12;
const MAX_TORSO_HEIGHT = 0.60;
const MIN_SHOULDER_WIDTH = 0.07;
const MAX_SHOULDER_WIDTH = 0.92;
const MAX_CENTER_X_STEP = 0.45; // Fractions of the previous shoulder width.
const MAX_CENTER_Y_STEP = 0.65; // Fractions of shoulder width measured in y-image units.
const MAX_SCALE_RATIO = 1.35;
const FALLBACK_TORSO_TO_SHOULDER_RATIO = 1.25;
const MIN_HEAD_HEIGHT_RATIO = 0.10;
const MAX_HEAD_HEIGHT_RATIO = 1.20;
const MAX_HEAD_X_OFFSET = 0.60;
const MAX_SHOULDER_TILT_RATIO = 0.85;
const MIN_HEAD_PAIR_WIDTH_RATIO = 0.08;
const MAX_HEAD_PAIR_WIDTH_RATIO = 1.10;
const RAISED_SHOULDER_MARGIN = 0.18; // Fractions of torso height, with hysteresis.
const LOWERED_SHOULDER_MARGIN = 0.45;
const UPPER_BODY_LOWERED_VISIBLE_FRACTION = 0.60;
const MIN_UPPER_BODY_LOWERED_DISTANCE = 0.025;

type ArmIndex = 0 | 1;
type ArmPosition = 'raised' | 'lowered' | 'between' | 'unknown';
interface ArmState { armed: boolean; lowerSince: number | null; raiseSince: number | null; }
interface Torso {
  pose: ExhibitionGesturePose;
  x: number;
  y: number;
  height: number;
  width: number;
  shoulderScale: number;
  upperBody: boolean;
}
const ARM_LANDMARKS = [[11, 13, 15], [12, 14, 16]] as const;
const newArm = (): ArmState => ({ armed: false, lowerSince: null, raiseSince: null });

function visible(point: ExhibitionGesturePoseLandmark | undefined): point is ExhibitionGesturePoseLandmark {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    // Pose's Web output supplies visibility; missing confidence cannot authorize a gesture.
    && Number.isFinite(point.visibility) && point.visibility! >= MIN_VISIBILITY
    && (point.presence === undefined || (Number.isFinite(point.presence) && point.presence >= MIN_PRESENCE));
}

function headSupportsShoulders(points: ExhibitionGesturePose['landmarks'], x: number, y: number,
  width: number, shoulderScale: number): boolean {
  const nose = points[0];
  if (!visible(nose) || Math.abs(nose.x - x) > width * MAX_HEAD_X_OFFSET) return false;
  const headHeight = y - nose.y;
  if (headHeight < shoulderScale * MIN_HEAD_HEIGHT_RATIO || headHeight > shoulderScale * MAX_HEAD_HEIGHT_RATIO) return false;
  // A nose plus a credible eye/ear pair supports an upper-body candidate. An
  // extrapolated hip or an isolated confident shoulder cannot authorize one.
  return ([[2, 5], [7, 8]] as const).some(([left, right]) => {
    const a = points[left]; const b = points[right];
    if (!visible(a) || !visible(b) || a.y >= y || b.y >= y) return false;
    const span = Math.abs(a.x - b.x);
    return span >= width * MIN_HEAD_PAIR_WIDTH_RATIO && span <= width * MAX_HEAD_PAIR_WIDTH_RATIO
      && Math.abs((a.x + b.x) / 2 - x) <= width * MAX_HEAD_X_OFFSET;
  });
}

function torsoFor(pose: ExhibitionGesturePose, frameAspectRatio: number): Torso | null {
  const points = pose.landmarks;
  if (points.length !== 33) return null;
  const [leftShoulder, rightShoulder, leftHip, rightHip] = [points[11], points[12], points[23], points[24]];
  if (!visible(leftShoulder) || !visible(rightShoulder)) return null;
  const x = (leftShoulder.x + rightShoulder.x) / 2;
  const y = (leftShoulder.y + rightShoulder.y) / 2;
  const width = Math.abs(rightShoulder.x - leftShoulder.x);
  if (width < MIN_SHOULDER_WIDTH || width > MAX_SHOULDER_WIDTH
    || x < CENTRAL_MIN_X || x > CENTRAL_MAX_X || y < CENTRAL_MIN_Y || y > CENTRAL_MAX_Y) return null;
  // x and y are normalized against different dimensions. Convert the shoulder
  // span to height-image units before estimating a missing torso measurement.
  const shoulderScale = Math.hypot(width * frameAspectRatio, rightShoulder.y - leftShoulder.y);
  const measuredHeight = visible(leftHip) && visible(rightHip) ? (leftHip.y + rightHip.y) / 2 - y : NaN;
  let height = measuredHeight;
  const upperBody = !(height >= MIN_TORSO_HEIGHT && height <= MAX_TORSO_HEIGHT);
  if (upperBody) {
    if (Math.abs(rightShoulder.y - leftShoulder.y) > width * frameAspectRatio * MAX_SHOULDER_TILT_RATIO
      || !headSupportsShoulders(points, x, y, width, shoulderScale)) return null;
    // Close framing can imply a torso taller than the frame. Cap only its gesture
    // scale; the operator is always associated by the same visible shoulders.
    height = Math.max(MIN_TORSO_HEIGHT, Math.min(MAX_TORSO_HEIGHT, shoulderScale * FALLBACK_TORSO_TO_SHOULDER_RATIO));
  }
  return { pose, x, y, height, width, shoulderScale, upperBody };
}

function sameOperator(previous: Torso, next: Torso): boolean {
  const comparable = (a: number, b: number) => Math.max(a, b) / Math.min(a, b) <= MAX_SCALE_RATIO;
  // Normalize each axis by its own body measurement: x/y image coordinates have
  // different scales on a portrait feed. No array index or handedness is an ID.
  return Math.abs(next.x - previous.x) <= previous.width * MAX_CENTER_X_STEP
    && Math.abs(next.y - previous.y) <= previous.shoulderScale * MAX_CENTER_Y_STEP
    && comparable(previous.shoulderScale, next.shoulderScale) && comparable(previous.width, next.width);
}

function armPosition(torso: Torso, index: ArmIndex): ArmPosition {
  const [shoulderIndex, elbowIndex, wristIndex] = ARM_LANDMARKS[index];
  const [shoulder, elbow, wrist] = [shoulderIndex, elbowIndex, wristIndex].map(i => torso.pose.landmarks[i]);
  if (!visible(shoulder) || !visible(elbow) || !visible(wrist)) return 'unknown';
  if (wrist.y <= shoulder.y - torso.height * RAISED_SHOULDER_MARGIN) return 'raised';
  const fullLowerDistance = torso.height * LOWERED_SHOULDER_MARGIN;
  // A seated upper-body view may have only a small visible area below a shoulder.
  // Require a distinctly lower, visible wrist there; never count an out-of-frame
  // wrist as lowered. Reliable full-torso measurements retain their old margin.
  const lowerDistance = torso.upperBody ? Math.max(MIN_UPPER_BODY_LOWERED_DISTANCE,
    Math.min(fullLowerDistance, (1 - shoulder.y) * UPPER_BODY_LOWERED_VISIBLE_FRACTION)) : fullLowerDistance;
  if (wrist.y >= shoulder.y + lowerDistance) return 'lowered';
  return 'between';
}

/** A positional operator association, never a persistent identity recognizer. */
export class ExhibitionRaiseGestureDetector {
  private previousTime: number | null = null;
  private operator: Torso | null = null;
  private candidate: Torso | null = null;
  private candidateSince: number | null = null;
  private arms: [ArmState, ArmState] = [newArm(), newArm()];
  private triggeredArm: ArmIndex | null = null;
  private currentStatus: ExhibitionOperatorStatus = 'searching';
  private currentHandDetected = false;
  private currentHandRaised = false;
  private currentRaiseStartedAt: number | null = null;

  get operatorStatus(): ExhibitionOperatorStatus { return this.currentStatus; }
  /** The current associated body only; unavailable while acquiring or ambiguous. */
  get operatorPose(): ExhibitionGesturePose | null { return this.currentStatus === 'locked' ? this.operator?.pose ?? null : null; }
  get handDetected(): boolean { return this.currentHandDetected; }
  get handRaised(): boolean { return this.currentHandRaised; }
  /** First sampled above-shoulder frame of the event emitted by the latest update.
   * Uses the caller's frame timestamp, not wall time or the local trigger time. */
  get lastRaiseStartedAt(): number | null { return this.currentRaiseStartedAt; }
  /** The successful event's pose-side arm, with the same lifetime as its timing. */
  get lastTriggeredArm(): ArmIndex | null { return this.currentRaiseStartedAt === null ? null : this.triggeredArm; }
  get armed(): boolean {
    return this.currentStatus === 'locked' && this.triggeredArm === null && this.arms.some(arm => arm.armed);
  }

  reset(): void {
    this.previousTime = null;
    this.operator = null;
    this.candidate = null;
    this.candidateSince = null;
    this.currentStatus = 'searching';
    this.clearArms();
  }

  update(poses: readonly ExhibitionGesturePose[], timestampMs: number, frameAspectRatio = 1): 'raise_hand' | null {
    // An unsuccessful update, including a duplicate/invalid frame, cannot expose
    // timing from a preceding gesture to its caller.
    this.currentRaiseStartedAt = null;
    if (!Number.isFinite(timestampMs)) return null;
    if (!Number.isFinite(frameAspectRatio) || frameAspectRatio <= 0) { this.reset(); return null; }
    if (this.previousTime !== null) {
      if (timestampMs === this.previousTime) return null;
      if (timestampMs < this.previousTime || timestampMs - this.previousTime > MAX_FRAME_GAP_MS) this.reset();
    }
    this.previousTime = timestampMs;
    const candidates = poses.map(pose => torsoFor(pose, frameAspectRatio)).filter((torso): torso is Torso => torso !== null);
    // With overlapping eligible people, halt instead of guessing who owns a hand.
    // People outside the fixed standing region do not acquire control.
    if (candidates.length !== 1) {
      this.operator = null;
      this.candidate = null;
      this.candidateSince = null;
      this.currentStatus = candidates.length > 1 ? 'ambiguous' : 'searching';
      this.clearArms();
      return null;
    }
    const torso = candidates[0];
    if (this.operator && sameOperator(this.operator, torso)) {
      // Keep calibration continuous when hips enter/leave the frame. A changed
      // source of scale must not turn a stationary wrist into an upward crossing.
      torso.height = Math.max(MIN_TORSO_HEIGHT, Math.min(MAX_TORSO_HEIGHT,
        this.operator.height * torso.shoulderScale / this.operator.shoulderScale));
    }
    if (!this.operator || !sameOperator(this.operator, torso)) {
      this.operator = null;
      this.currentStatus = 'searching';
      this.clearArms();
      if (!this.candidate || !sameOperator(this.candidate, torso)) this.candidateSince = timestampMs;
      this.candidate = torso;
      if (this.candidateSince === null || timestampMs - this.candidateSince < OPERATOR_SETTLE_MS) return null;
      this.candidate = null;
      this.candidateSince = null;
    }
    this.operator = torso;
    this.currentStatus = 'locked';
    const positions: [ArmPosition, ArmPosition] = [armPosition(torso, 0), armPosition(torso, 1)];
    this.currentHandDetected = positions.some(position => position !== 'unknown');
    this.currentHandRaised = positions.includes('raised');

    for (const index of [0, 1] as const) {
      const arm = this.arms[index];
      const position = positions[index];
      if (position === 'unknown') {
        this.arms[index] = newArm();
      } else if (position === 'lowered') {
        arm.raiseSince = null;
        arm.lowerSince ??= timestampMs;
        if (timestampMs - arm.lowerSince >= LOWER_CONFIRM_MS) arm.armed = true;
      } else {
        arm.lowerSince = null;
        arm.raiseSince = position === 'raised' && arm.armed ? arm.raiseSince ?? timestampMs : null;
      }
    }

    if (this.triggeredArm !== null) {
      // Suppress the other hand for the whole held gesture. Tracking loss cannot
      // stand in for lowering: the triggering wrist must visibly return down.
      const released = this.arms[this.triggeredArm];
      if (positions[this.triggeredArm] === 'lowered' && released.lowerSince !== null
        && timestampMs - released.lowerSince >= LOWER_CONFIRM_MS) {
        this.triggeredArm = null;
        for (const index of [0, 1] as const) {
          const arm = this.arms[index];
          arm.armed = positions[index] === 'lowered' && arm.lowerSince !== null
            && timestampMs - arm.lowerSince >= LOWER_CONFIRM_MS;
          arm.raiseSince = null;
        }
      }
      return null;
    }

    for (const index of [0, 1] as const) {
      const arm = this.arms[index];
      if (arm.armed && arm.raiseSince !== null && timestampMs - arm.raiseSince >= RAISE_CONFIRM_MS) {
        this.triggeredArm = index;
        this.currentRaiseStartedAt = arm.raiseSince;
        // Both hands belong to one action even if their upward crossings differ.
        this.arms = [newArm(), newArm()];
        return 'raise_hand';
      }
    }
    return null;
  }

  private clearArms(): void {
    this.arms = [newArm(), newArm()];
    this.triggeredArm = null;
    this.currentHandDetected = false;
    this.currentHandRaised = false;
    this.currentRaiseStartedAt = null;
  }
}
