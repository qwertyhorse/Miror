export type ExhibitionGesture = 'wave' | 'swipe_left' | 'swipe_right' | 'raise_hand' | 'open_palm';
export type ExhibitionGestureMode = 'wave' | 'swipe' | 'both' | 'raise' | 'palm_wave';

export interface ExhibitionGestureLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface ExhibitionGestureHand {
  landmarks: readonly ExhibitionGestureLandmark[];
  handedness?: string;
}

interface Sample {
  x: number;
  y: number;
  waveX: number;
  waveY: number;
  time: number;
  palmSize: number;
  handedness?: string;
}

const HISTORY_MS = 1_800;
const MAX_FRAME_GAP_MS = 320;
const COOLDOWN_MS = 1_000;
const RELEASE_MS = 450;
const REARM_STILL_MS = 300;
const REARM_RADIUS = 0.018;
const TURN_DISTANCE = 0.055;
const RAISE_HISTORY_MS = 900;
const RAISE_MIN_MS = 120;

function distance(a: ExhibitionGestureLandmark, b: ExhibitionGestureLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function motionDistance(a: Sample, b: Sample): number {
  return Math.max(distance(a, b), Math.hypot(a.waveX - b.waveX, a.waveY - b.waveY));
}

function openPalmSample(hand: ExhibitionGestureHand, time: number): Sample | null {
  const points = hand.landmarks;
  if (points.length !== 21 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const wrist = points[0];
  const palmSize = distance(wrist, points[9]);
  if (palmSize < 0.018) return null;

  let extendedFingers = 0;
  for (const start of [5, 9, 13, 17]) {
    const [base, pip, dip, tip] = points.slice(start, start + 4);
    const fingerLength = distance(base, pip) + distance(pip, dip) + distance(dip, tip);
    if (distance(base, tip) >= fingerLength * 0.8
      && distance(base, tip) >= palmSize * 0.65
      && distance(wrist, tip) >= distance(wrist, pip) * 1.13) extendedFingers += 1;
  }
  if (extendedFingers < 3) return null;
  // The fingers and palm move during a natural wrist-pivot wave even when landmark 0 stays still.
  const tips = [points[8], points[12], points[16]];
  const waveX = (wrist.x + tips.reduce((sum, tip) => sum + tip.x, 0) / tips.length) / 2;
  const waveY = (wrist.y + tips.reduce((sum, tip) => sum + tip.y, 0) / tips.length) / 2;
  return { x: wrist.x, y: wrist.y, waveX, waveY, time, palmSize, handedness: hand.handedness };
}

/** Coordinates follow the supplied landmarks. Mirror x before update when the preview is mirrored. */
export class ExhibitionGestureDetector {
  constructor(private readonly options: { waveReversals?: 1 | 2 } = {}) {}
  private samples: Sample[] = [];
  private raiseSamples: Sample[] = [];
  private raisedAt: Sample | null = null;
  private previous: Sample | null = null;
  private previousTime: number | null = null;
  private mode: ExhibitionGestureMode | null = null;
  private cooldownUntil = 0;
  private latched = false;
  private releaseSince: number | null = null;
  private stillAnchor: Sample | null = null;

  /** Preparation only: a raised hand never emits a gesture or consumes its cooldown. */
  get handRaised(): boolean { return this.raisedAt !== null; }

  reset(): void {
    this.clearMotion();
    this.clearRaise();
    this.previousTime = null;
    this.mode = null;
    this.cooldownUntil = 0;
    this.latched = false;
    this.releaseSince = null;
    this.stillAnchor = null;
  }

  update(hand: ExhibitionGestureHand | null, timestampMs: number, mode: ExhibitionGestureMode = 'both'): ExhibitionGesture | null {
    // Body-relative raises use ExhibitionRaiseGestureDetector, never the palm trajectory rules.
    if (mode === 'raise' || mode === 'palm_wave') { this.reset(); return null; }
    if (!Number.isFinite(timestampMs)) return null;
    if (this.previousTime !== null && timestampMs <= this.previousTime) {
      if (timestampMs < this.previousTime) this.reset();
      else return null;
    }
    this.previousTime = timestampMs;
    if (this.mode !== mode) {
      this.clearMotion();
      this.clearRaise();
      this.mode = mode;
    }

    const sample = hand ? openPalmSample(hand, timestampMs) : null;
    if (!sample) {
      this.clearMotion();
      this.raiseSamples = [];
      this.stillAnchor = null;
      this.releaseSince ??= timestampMs;
      if (timestampMs - this.releaseSince >= RELEASE_MS) {
        this.latched = false;
        this.clearRaise();
      }
      return null;
    }
    if (this.releaseSince !== null && timestampMs - this.releaseSince >= RELEASE_MS) {
      this.latched = false;
      this.clearRaise();
    }
    this.releaseSince = null;

    if (this.raisedAt?.handedness && sample.handedness && this.raisedAt.handedness !== sample.handedness) this.clearRaise();
    if (this.previous) {
      const gap = sample.time - this.previous.time;
      const trackingChanged = !!(sample.handedness && this.previous.handedness && sample.handedness !== this.previous.handedness)
        || motionDistance(sample, this.previous) > Math.max(0.22, gap * 0.0015)
        || sample.palmSize / this.previous.palmSize > 1.8
        || this.previous.palmSize / sample.palmSize > 1.8;
      if (gap > MAX_FRAME_GAP_MS || trackingChanged) {
        this.clearMotion();
        this.raiseSamples = [];
        // A brief capture gap breaks trajectories, but not a confirmed raised hand.
        if (gap > RAISE_HISTORY_MS || trackingChanged) this.clearRaise();
        this.stillAnchor = null;
      }
    }
    this.previous = sample;
    this.observeRaise(sample);

    // A long, uninterrupted wave is one action even after its cooldown expires.
    if (this.latched) {
      if (!this.stillAnchor || motionDistance(sample, this.stillAnchor) > REARM_RADIUS) this.stillAnchor = sample;
      else if (timestampMs - this.stillAnchor.time >= REARM_STILL_MS) {
        this.latched = false;
        this.stillAnchor = null;
      }
      this.samples = [];
      return null;
    }
    if (timestampMs < this.cooldownUntil) {
      this.samples = [];
      return null;
    }

    this.samples.push(sample);
    this.samples = this.samples.filter(point => timestampMs - point.time <= HISTORY_MS);
    const gesture = this.detect(mode);
    if (gesture) {
      this.samples = [];
      this.latched = true;
      this.stillAnchor = sample;
      this.cooldownUntil = timestampMs + COOLDOWN_MS;
    }
    return gesture;
  }

  private clearMotion(): void {
    this.samples = [];
    this.previous = null;
  }

  private clearRaise(): void {
    this.raiseSamples = [];
    this.raisedAt = null;
  }

  private observeRaise(sample: Sample): void {
    const distance = Math.max(0.04, sample.palmSize * 0.8);
    if (this.raisedAt && sample.y - this.raisedAt.y >= distance) this.clearRaise();
    else if (this.raisedAt && sample.y < this.raisedAt.y) this.raisedAt = sample;
    this.raiseSamples.push(sample);
    this.raiseSamples = this.raiseSamples.filter(point => sample.time - point.time <= RAISE_HISTORY_MS);
    const anchor = this.raiseSamples.reduce((lowest, point) => point.y > lowest.y ? point : lowest, sample);
    if (sample.time - anchor.time < RAISE_MIN_MS || anchor.y - sample.y < distance
      || Math.abs(sample.x - anchor.x) > Math.max(0.06, sample.palmSize)) return;
    this.raisedAt = sample;
    this.raiseSamples = [sample];
    // Discard the upward segment so it cannot delay the next horizontal wave.
    // Keep the existing latch and cooldown: another lift is still the same action.
    this.samples = [];
  }

  private detect(mode: ExhibitionGestureMode): ExhibitionGesture | null {
    const points = this.samples;
    const first = points[0];
    const last = points.at(-1);
    if (!first || !last || last.time - first.time < 300) return null;
    const wave = mode !== 'swipe';
    const positionX = (point: Sample) => wave ? point.waveX : point.x;
    const positionY = (point: Sample) => wave ? point.waveY : point.y;
    const xs = points.map(positionX);
    const ys = points.map(positionY);
    const xRange = Math.max(...xs) - Math.min(...xs);
    const yRange = Math.max(...ys) - Math.min(...ys);
    if (yRange > 0.1 || yRange > xRange * 0.7 + 0.015) return null;

    // Direction changes require a real excursion, rather than a per-frame sign change.
    const palmSizes = points.map(point => point.palmSize).sort((a, b) => a - b);
    const palmSize = palmSizes[Math.floor(palmSizes.length / 2)];
    const turnDistance = wave ? Math.max(0.018, palmSize * 0.42) : TURN_DISTANCE;
    let direction = 0;
    let pivot = positionX(first);
    let extreme = pivot;
    let reversals = 0;
    let completedDistance = 0;
    for (const point of points) {
      const x = positionX(point);
      if (!direction) {
        if (Math.abs(x - pivot) >= turnDistance) {
          direction = Math.sign(x - pivot);
          extreme = x;
        }
      } else if ((x - extreme) * direction > 0) extreme = x;
      else if ((extreme - x) * direction >= turnDistance) {
        completedDistance += Math.abs(extreme - pivot);
        pivot = extreme;
        extreme = x;
        direction *= -1;
        reversals += 1;
      }
    }
    const travelled = completedDistance + Math.abs(extreme - pivot);
    const requiredReversals = this.options.waveReversals ?? 2;
    if (wave && reversals >= requiredReversals && xRange >= Math.max(0.045, palmSize * 0.9)
      && travelled >= Math.max(0.11, palmSize * (requiredReversals === 1 ? 1.7 : 2.25))) return 'wave';

    // The live screen uses a single mode. A longer pause is required if both are enabled.
    const stillMs = mode === 'both' ? 650 : 300;
    const tail = points.filter(point => last.time - point.time <= stillMs);
    const net = last.x - first.x;
    if (mode !== 'wave' && reversals === 0 && Math.abs(net) >= 0.14
      && tail.length >= 2 && last.time - tail[0].time >= stillMs - 60
      && Math.max(...tail.map(point => point.x)) - Math.min(...tail.map(point => point.x)) <= 0.018
      && Math.max(...tail.map(point => point.y)) - Math.min(...tail.map(point => point.y)) <= 0.018) {
      return net > 0 ? 'swipe_right' : 'swipe_left';
    }
    return null;
  }
}
