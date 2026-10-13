import { describe, expect, it } from 'vitest';
import { ExhibitionRaiseGestureDetector, type ExhibitionGesturePose } from '../src/exhibition/raiseGestureDetector';

type PoseOptions = {
  x?: number;
  scale?: number;
  left?: number;
  right?: number;
  hidden?: number[];
  presence?: number;
};

// y=0.65 is a relaxed wrist; y=0.25 is clearly above the shoulder at y=0.35.
function pose({ x = 0.5, scale = 1, left = 0.65, right = 0.65, hidden = [], presence }: PoseOptions = {}): ExhibitionGesturePose {
  const landmarks = Array.from({ length: 33 }, () => ({ x, y: 0.5, visibility: 0.99, presence }));
  const set = (index: number, px: number, py: number) => {
    landmarks[index] = { x: x + (px - 0.5) * scale, y: 0.5 + (py - 0.5) * scale, visibility: hidden.includes(index) ? 0.2 : 0.99, presence };
  };
  set(11, 0.42, 0.35); set(12, 0.58, 0.35);
  set(23, 0.44, 0.65); set(24, 0.56, 0.65);
  set(13, 0.38, left < 0.35 ? 0.39 : 0.5); set(14, 0.62, right < 0.35 ? 0.39 : 0.5);
  set(15, 0.36, left); set(16, 0.64, right);
  return { landmarks };
}

function run(detector: ExhibitionRaiseGestureDetector, from: number, to: number,
  frames: (time: number) => readonly ExhibitionGesturePose[], fps = 10, frameAspectRatio = 1): number[] {
  const events: number[] = [];
  for (let frame = 0; from + frame * 1_000 / fps <= to + 0.01; frame++) {
    const time = from + frame * 1_000 / fps;
    if (detector.update(frames(time), time, frameAspectRatio)) events.push(time);
  }
  return events;
}

function upperBody({ x = 0.5, width = 0.42, aspect = 1, raised = false, phone = false, hips = 'hidden' }: {
  x?: number; width?: number; aspect?: number; raised?: boolean; phone?: boolean; hips?: 'hidden' | 'outside' | 'visible';
} = {}): ExhibitionGesturePose {
  const landmarks = pose().landmarks.map(point => ({ ...point }));
  const shoulderY = 0.4;
  const height = Math.max(0.12, Math.min(0.6, width * aspect * 1.25));
  const noseY = shoulderY - Math.min(0.18, width * aspect * 0.35);
  const set = (index: number, px: number, py: number) => { landmarks[index] = { x: px, y: py, visibility: 0.99 }; };
  set(11, x - width / 2, shoulderY); set(12, x + width / 2, shoulderY);
  set(0, x, noseY);
  set(2, x - width * 0.12, noseY - 0.02); set(5, x + width * 0.12, noseY - 0.02);
  set(7, x - width * 0.25, noseY); set(8, x + width * 0.25, noseY);
  set(13, x - width / 2, shoulderY + 0.05); set(14, x + width / 2, shoulderY + 0.05);
  set(15, x - width / 2 - 0.02, shoulderY + height * (raised ? -0.25 : 0.5));
  set(16, x + width / 2 + 0.02, shoulderY + height * (phone ? -0.25 : 0.5));
  set(23, x - width / 3, hips === 'outside' ? 1.1 : 0.7); set(24, x + width / 3, hips === 'outside' ? 1.1 : 0.7);
  if (hips === 'hidden') { landmarks[23].visibility = 0.2; landmarks[24].visibility = 0.2; }
  return { landmarks };
}

describe('exhibition raise-hand detector', () => {
  it('exposes the first above-shoulder sample only alongside its successful raise event', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [pose()]);
    expect(detector.lastRaiseStartedAt).toBeNull();
    expect(detector.update([pose({ left: 0.25 })], 1_100)).toBeNull();
    expect(detector.lastRaiseStartedAt).toBeNull();
    expect(detector.update([pose({ left: 0.25 })], 1_300)).toBeNull();
    expect(detector.update([pose({ left: 0.25 })], 1_400)).toBe('raise_hand');
    expect(detector.lastRaiseStartedAt).toBe(1_100);
    // An ignored/duplicate update does not retain the previous event's timing.
    expect(detector.update([pose({ left: 0.25 })], 1_400)).toBeNull();
    expect(detector.lastRaiseStartedAt).toBeNull();
    expect(detector.update([pose({ left: 0.25 })], 1_500)).toBeNull();
    expect(detector.lastRaiseStartedAt).toBeNull();
  });

  it.each(['reset', 'occlusion', 'lowered'] as const)('does not reuse the start of a raise interrupted by %s', interruption => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [pose()]);
    expect(detector.update([pose({ left: 0.25 })], 1_100)).toBeNull();
    if (interruption === 'reset') detector.reset();
    else detector.update([pose(interruption === 'occlusion' ? { hidden: [15] } : {})], 1_200);
    expect(detector.lastRaiseStartedAt).toBeNull();
    run(detector, 1_300, 2_300, () => [pose()]);
    expect(detector.update([pose({ left: 0.25 })], 2_400)).toBeNull();
    expect(detector.update([pose({ left: 0.25 })], 2_600)).toBeNull();
    expect(detector.update([pose({ left: 0.25 })], 2_700)).toBe('raise_hand');
    expect(detector.lastRaiseStartedAt).toBe(2_400);
    detector.reset();
    expect(detector.lastRaiseStartedAt).toBeNull();
  });

  it('does not expose timing for a failed detection after a successful event', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [pose()]);
    detector.update([pose({ left: 0.25 })], 1_100);
    expect(detector.update([pose({ left: 0.25 })], 1_400)).toBe('raise_hand');
    expect(detector.lastRaiseStartedAt).toBe(1_100);
    expect(detector.update([], NaN)).toBeNull();
    expect(detector.lastRaiseStartedAt).toBeNull();
  });

  it.each([5, 10, 15])('recognizes one action per deliberate raise at %i FPS', fps => {
    const detector = new ExhibitionRaiseGestureDetector();
    const events = run(detector, 0, 3_600, time => [pose({ left: time < 1_000 || (time >= 1_800 && time < 2_600) ? 0.65 : 0.25 })], fps);
    expect(events).toHaveLength(2);
    expect(events[0]).toBeGreaterThanOrEqual(1_250);
    expect(events[1]).toBeGreaterThanOrEqual(2_850);
  });

  it.each([5, 10, 15])('does not repeat while a hand remains raised at %i FPS', fps => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 8_000, time => [pose({ left: time < 1_000 ? 0.65 : 0.25 })], fps)).toHaveLength(1);
    expect(detector.handRaised).toBe(true);
    expect(detector.armed).toBe(false);
  });

  it('requires an initial visible lower position and never treats an already raised phone hand as a new action', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 2_000, () => [pose({ right: 0.25 })])).toEqual([]);
    expect(detector.handRaised).toBe(true);
    // The other, deliberately lowered hand still works while a phone is held up.
    expect(run(detector, 2_100, 3_000, () => [pose({ left: 0.25, right: 0.25 })])).toHaveLength(1);
  });

  it('only arms a raised hand after it has visibly been lowered', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 1_000, () => [pose({ left: 0.25, right: 0.25 })])).toEqual([]);
    expect(detector.armed).toBe(false);
    run(detector, 1_100, 1_700, () => [pose()]);
    expect(detector.armed).toBe(true);
    expect(run(detector, 1_800, 2_300, () => [pose({ right: 0.25 })])).toHaveLength(1);
  });

  it('collapses simultaneous and staggered two-hand raises into one held action', () => {
    for (const stagger of [0, 200, 800]) {
      const detector = new ExhibitionRaiseGestureDetector();
      expect(run(detector, 0, 3_000, time => [pose({
        left: time < 1_000 ? 0.65 : 0.25,
        right: time < 1_000 + stagger ? 0.65 : 0.25,
      })])).toHaveLength(1);
      expect(detector.armed).toBe(false);
    }
  });

  it('does not activate the second raised hand when the first hand is lowered', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 1_600, time => [pose({ left: time < 1_000 ? 0.65 : 0.25 })])).toHaveLength(1);
    expect(run(detector, 1_700, 2_600, () => [pose({ right: 0.25 })])).toEqual([]);
    expect(run(detector, 2_700, 3_300, () => [pose({ right: 0.25 })])).toEqual([]);
    run(detector, 3_400, 4_000, () => [pose()]);
    expect(run(detector, 4_100, 4_700, () => [pose({ right: 0.25 })])).toHaveLength(1);
  });

  it('requires sustained lowering, so a brief dip does not rearm', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 3_000, time => [pose({ left: time < 1_000 || (time >= 1_800 && time <= 2_000) ? 0.65 : 0.25 })])).toHaveLength(1);
    run(detector, 3_100, 3_600, () => [pose()]);
    expect(run(detector, 3_700, 4_300, () => [pose({ left: 0.25 })])).toHaveLength(1);
  });

  it('rejects a brief upward crossing and shoulder-level jitter', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 2_000, time => [pose({ left: time < 1_000 ? 0.65 : time < 1_200 ? 0.25 : 0.35 })])).toEqual([]);
    expect(run(detector, 2_100, 3_000, time => [pose({ left: 0.35 + Math.sin(time) * 0.015 })])).toEqual([]);
  });

  it.each([11, 12, 23, 24])('rejects a torso with an untrusted landmark %i', hidden => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 2_000, time => [pose({ hidden: [hidden], left: time < 1_000 ? 0.65 : 0.25 })])).toEqual([]);
    expect(detector.operatorStatus).toBe('searching');
    expect(detector.handDetected).toBe(false);
    expect(detector.armed).toBe(false);
  });

  it.each([13, 15])('does not authorize a raise from an untrusted arm landmark %i', hidden => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 2_000, time => [pose({ hidden: [hidden], left: time < 1_000 ? 0.65 : 0.25 })])).toEqual([]);
    expect(detector.operatorStatus).toBe('locked');
    expect(detector.handRaised).toBe(false);
  });

  it('clears that arm after even a short occlusion instead of inferring that it was lowered', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [pose()]);
    detector.update([pose({ hidden: [15] })], 1_100);
    expect(run(detector, 1_200, 2_000, () => [pose({ left: 0.25 })])).toEqual([]);
    run(detector, 2_100, 2_600, () => [pose()]);
    expect(run(detector, 2_700, 3_300, () => [pose({ left: 0.25 })])).toHaveLength(1);
    detector.update([pose({ hidden: [15] })], 3_400);
    expect(run(detector, 3_500, 4_100, () => [pose({ left: 0.25 })])).toEqual([]);
  });

  it('does not report a detected hand when only the torso is visible', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [pose({ hidden: [13, 14, 15, 16] })]);
    expect(detector.operatorStatus).toBe('locked');
    expect(detector.handDetected).toBe(false);
    expect(detector.handRaised).toBe(false);
    expect(detector.armed).toBe(false);
  });

  it('rejects missing visibility, low presence, non-finite coordinates and incomplete poses', () => {
    const invalids: ExhibitionGesturePose[] = [
      { landmarks: pose().landmarks.map(({ visibility: _visibility, ...point }) => point) },
      pose({ presence: 0.2 }),
      { landmarks: pose().landmarks.map((point, index) => index === 11 ? { ...point, x: NaN } : point) },
      { landmarks: pose().landmarks.slice(0, 21) },
    ];
    for (const invalid of invalids) {
      const detector = new ExhibitionRaiseGestureDetector();
      run(detector, 0, 2_000, () => [invalid]);
      expect(detector.operatorStatus).toBe('searching');
      expect(detector.armed).toBe(false);
    }
  });

  it('tracks the same central operator when returned pose order changes', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 2_000, time => {
      const owner = pose({ left: time < 1_000 ? 0.65 : 0.25 });
      const passerby = pose({ x: 0.86, left: 0.25 });
      return Math.round(time / 100) % 2 ? [owner, passerby] : [passerby, owner];
    })).toHaveLength(1);
    expect(detector.operatorStatus).toBe('locked');
  });

  it('pauses with two central candidates and requires a fresh lower position after a takeover', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [pose()]);
    expect(detector.armed).toBe(true);
    expect(run(detector, 1_100, 1_600, time => {
      const people = [pose({ left: 0.25 }), pose({ x: 0.64, right: 0.25 })];
      return Math.round(time / 100) % 2 ? people : people.reverse();
    })).toEqual([]);
    expect(detector.operatorStatus).toBe('ambiguous');
    expect(detector.armed).toBe(false);
    expect(run(detector, 1_700, 2_800, () => [pose({ x: 0.64, left: 0.25, right: 0.25 })])).toEqual([]);
    run(detector, 2_900, 3_500, () => [pose({ x: 0.64 })]);
    expect(run(detector, 3_600, 4_100, () => [pose({ x: 0.64, right: 0.25 })])).toHaveLength(1);
  });

  it.each([{ x: 0.64 }, { scale: 1.5 }])('does not transfer an armed state to a suddenly different torso %j', changed => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [pose()]);
    expect(run(detector, 1_100, 2_000, () => [pose({ ...changed, left: 0.25, right: 0.25 })])).toEqual([]);
    expect(detector.armed).toBe(false);
  });

  it('ignores gestures outside the fixed standing region and undersized distant bodies', () => {
    for (const options of [{ x: 0.15 }, { x: 0.85 }, { scale: 0.3 }]) {
      const detector = new ExhibitionRaiseGestureDetector();
      expect(run(detector, 0, 2_000, time => [pose({ ...options, left: time < 1_000 ? 0.65 : 0.25 })])).toEqual([]);
      expect(detector.operatorStatus).toBe('searching');
    }
  });

  it('discards stale arming after missing frames, an empty detection or a backwards clock', () => {
    for (const interruption of ['gap', 'missing', 'backwards'] as const) {
      const detector = new ExhibitionRaiseGestureDetector();
      run(detector, 0, 1_000, () => [pose()]);
      expect(detector.armed).toBe(true);
      const start = interruption === 'gap' ? 1_800 : interruption === 'backwards' ? 100 : 1_200;
      if (interruption === 'missing') detector.update([], 1_100);
      expect(run(detector, start, start + 1_500, () => [pose({ left: 0.25, right: 0.25 })])).toEqual([]);
      expect(detector.armed).toBe(false);
    }
  });

  it('does not accumulate duplicate or invalid timestamps and reset clears every exposed state', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [pose()]);
    detector.update([pose({ left: 0.25 })], 1_100);
    for (let i = 0; i < 100; i++) expect(detector.update([pose({ left: 0.25 })], 1_100)).toBeNull();
    expect(detector.update([pose({ left: 0.25 })], NaN)).toBeNull();
    detector.reset();
    expect(detector.operatorStatus).toBe('searching');
    expect(detector.handDetected).toBe(false);
    expect(detector.handRaised).toBe(false);
    expect(detector.armed).toBe(false);
  });

  it.each([5, 10, 15])('accepts a supported upper-body view at %i FPS with low-confidence or out-of-frame hips', fps => {
    for (const hips of ['hidden', 'outside'] as const) {
      const detector = new ExhibitionRaiseGestureDetector();
      expect(run(detector, 0, 3_000, time => [upperBody({ hips, raised: time >= 1_200 })], fps)).toHaveLength(1);
      expect(detector.operatorStatus).toBe('locked');
    }
  });

  it.each([9 / 16, 1, 16 / 9])('uses pixel-proportional shoulder scale at frame aspect ratio %f', aspect => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 3_000, time => [upperBody({ aspect, raised: time >= 1_200 })], 10, aspect)).toHaveLength(1);
    expect(detector.lastRaiseStartedAt).toBeNull();
    expect(detector.operatorStatus).toBe('locked');
  });

  it('accepts visible shoulders wider than the former full-body framing limit', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 3_000, time => [upperBody({ width: 0.82, aspect: 16 / 9, raised: time >= 1_200 })], 10, 16 / 9)).toHaveLength(1);
  });

  it.each([0.84, 0.9])('accepts a supported seated upper body with shoulders at y=%f and visible lowered wrists', shoulderY => {
    const detector = new ExhibitionRaiseGestureDetector();
    const aspect = 0.589;
    expect(run(detector, 0, 3_000, time => {
      const points = upperBody({ width: 0.5, aspect }).landmarks.map(point => ({ ...point, y: point.y + shoulderY - 0.4 }));
      points[15].y = 1.1; // One hand remains out of the frame throughout.
      points[16].y = time < 1_200 ? 0.98 : shoulderY - 0.12;
      return [{ landmarks: points }];
    }, 10, aspect)).toHaveLength(1);
    expect(detector.operatorStatus).toBe('locked');
  });

  it.each([0.84, 0.9])('does not arm shoulder-level or out-of-frame wrists in the seated y=%f view', shoulderY => {
    for (const wristY of [shoulderY, shoulderY + 0.02, 1.01]) {
      const detector = new ExhibitionRaiseGestureDetector();
      expect(run(detector, 0, 2_000, () => {
        const points = upperBody({ width: 0.5, aspect: 0.589 }).landmarks.map(point => ({ ...point, y: point.y + shoulderY - 0.4 }));
        points[15].y = wristY; points[16].y = wristY;
        return [{ landmarks: points }];
      }, 10, 0.589)).toEqual([]);
      expect(detector.operatorStatus).toBe('locked');
      expect(detector.armed).toBe(false);
    }
  });

  it('keeps the original lower margin when the complete torso is reliable', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 2_000, () => {
      const points = pose().landmarks.map(point => ({ ...point }));
      points[11].y = points[12].y = 0.65;
      points[23].y = points[24].y = 0.95;
      points[15].y = points[16].y = 0.76; // Below the shoulder, but short of the full-torso 0.785 threshold.
      return [{ landmarks: points }];
    });
    expect(detector.operatorStatus).toBe('locked');
    expect(detector.armed).toBe(false);
  });

  it.each(['nose-hidden', 'head-hidden', 'head-below', 'head-sideways', 'head-too-far', 'shoulder-hidden', 'shoulder-tilted'] as const)(
    'does not authorize an upper-body candidate with %s', invalid => {
      const detector = new ExhibitionRaiseGestureDetector();
      const body = upperBody();
      const points = body.landmarks.map(point => ({ ...point }));
      if (invalid === 'nose-hidden') points[0].visibility = 0.2;
      if (invalid === 'head-hidden') for (const index of [2, 5, 7, 8]) points[index].visibility = 0.2;
      if (invalid === 'head-below') points[0].y = 0.5;
      if (invalid === 'head-sideways') points[0].x = 0.98;
      if (invalid === 'head-too-far') points[0].y = 0;
      if (invalid === 'shoulder-hidden') points[11].visibility = 0.2;
      if (invalid === 'shoulder-tilted') points[11].y = 0.01;
      expect(run(detector, 0, 2_000, () => [{ landmarks: points }], 10, invalid === 'head-too-far' ? 0.5 : 1)).toEqual([]);
      expect(detector.operatorStatus).toBe('searching');
    });

  it('keeps the shoulder association and gesture calibration while hips enter and leave view', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [upperBody({ hips: 'visible' })]);
    expect(detector.armed).toBe(true);
    for (let time = 1_100; time <= 1_700; time += 100) {
      const body = upperBody({ hips: time % 200 ? 'hidden' : 'visible' });
      const points = body.landmarks.map(point => ({ ...point }));
      points[15].y = 0.35; // Below the original raised threshold; no motion crossing.
      expect(detector.update([{ landmarks: points }], time)).toBeNull();
      expect(detector.operatorStatus).toBe('locked');
      expect(detector.armed).toBe(true);
    }
    expect(run(detector, 1_800, 2_500, time => [upperBody({ hips: time % 200 ? 'hidden' : 'visible', raised: true })])).toHaveLength(1);
  });

  it('does not infer a raise when recovered hips would produce a smaller gesture scale', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [upperBody()]);
    expect(detector.armed).toBe(true);
    expect(run(detector, 1_100, 2_000, () => {
      const points = upperBody({ hips: 'visible' }).landmarks.map(point => ({ ...point }));
      points[15].y = 0.32; // Raised under recovered hip scale, between under acquired shoulder scale.
      return [{ landmarks: points }];
    })).toEqual([]);
    expect(detector.handRaised).toBe(false);
    expect(detector.armed).toBe(true);
    expect(run(detector, 2_100, 2_600, () => [upperBody({ hips: 'visible', raised: true })])).toHaveLength(1);
  });

  it('requires a fresh lowered hand in an upper-body view and never activates a held phone', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    expect(run(detector, 0, 2_000, () => [upperBody({ raised: true, phone: true })])).toEqual([]);
    expect(detector.armed).toBe(false);
    run(detector, 2_100, 2_700, () => [upperBody({ phone: true })]);
    expect(run(detector, 2_800, 4_000, () => [upperBody({ raised: true, phone: true })])).toHaveLength(1);
    expect(run(detector, 4_100, 5_000, () => [upperBody({ raised: true, phone: true })])).toEqual([]);
  });

  it('pauses for competing upper-body candidates regardless of pose order', () => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [upperBody()]);
    expect(run(detector, 1_100, 2_000, time => {
      const people = [upperBody({ raised: true }), upperBody({ x: 0.64, width: 0.3, raised: true })];
      return time % 200 ? people : people.reverse();
    })).toEqual([]);
    expect(detector.operatorStatus).toBe('ambiguous');
    expect(detector.armed).toBe(false);
    expect(run(detector, 2_100, 3_100, () => [upperBody({ x: 0.64, width: 0.3, raised: true, phone: true })])).toEqual([]);
  });

  it('does not preserve upper-body arming across long gaps or a different shoulder anchor', () => {
    for (const boundary of ['gap', 'person'] as const) {
      const detector = new ExhibitionRaiseGestureDetector();
      run(detector, 0, 1_000, () => [upperBody({ width: 0.3 })]);
      expect(detector.armed).toBe(true);
      const start = boundary === 'gap' ? 1_500 : 1_100;
      expect(run(detector, start, start + 1_500, () => [upperBody({ x: boundary === 'person' ? 0.7 : 0.5,
        width: 0.3, raised: true, phone: true })])).toEqual([]);
      expect(detector.armed).toBe(false);
    }
  });

  it.each([0, -1, Infinity, NaN])('rejects invalid frame aspect ratio %f without retaining arming', aspect => {
    const detector = new ExhibitionRaiseGestureDetector();
    run(detector, 0, 1_000, () => [upperBody()]);
    expect(detector.armed).toBe(true);
    expect(detector.update([upperBody({ raised: true })], 1_100, aspect)).toBeNull();
    expect(detector.operatorStatus).toBe('searching');
    expect(detector.armed).toBe(false);
  });
});
