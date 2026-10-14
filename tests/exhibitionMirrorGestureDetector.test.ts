import { describe, expect, it } from 'vitest';
import { ExhibitionMirrorGestureDetector } from '../src/exhibition/mirrorGestureDetector';
import type { ExhibitionGestureHand } from '../src/exhibition/gestureDetector';
import type { ExhibitionGesturePose } from '../src/exhibition/raiseGestureDetector';

// The same frontal open-palm proportions used by exhibitionGestureDetector.test.ts.
const palm = [
  [0, 0], [-0.04, -0.05], [-0.09, -0.09], [-0.12, -0.14], [-0.16, -0.17],
  [-0.06, -0.17], [-0.065, -0.29], [-0.07, -0.37], [-0.075, -0.44],
  [0, -0.19], [0, -0.32], [0, -0.41], [0, -0.49],
  [0.06, -0.17], [0.065, -0.29], [0.07, -0.37], [0.075, -0.44],
  [0.115, -0.13], [0.13, -0.23], [0.14, -0.3], [0.15, -0.36],
];

type Point = { x: number; y: number };
type Frame = { poses: readonly ExhibitionGesturePose[]; hands: readonly ExhibitionGestureHand[] };
type Event = { gesture: 'raise_hand' | 'wave' | 'open_palm'; time: number };

function hand(x: number, y = 0.42, angle = 0, shape: 'open' | 'fist' | 'phone' = 'open', handedness = 'Left'): ExhibitionGestureHand {
  const points = palm.map(([px, py]) => ({ x: px, y: py }));
  // A phone grip leaves at most two extended fingers; the fist leaves none.
  const folded = shape === 'fist' ? [5, 9, 13, 17] : shape === 'phone' ? [13, 17] : [];
  for (const start of folded) {
    points[start + 2] = { x: points[start].x + 0.02, y: points[start].y - 0.07 };
    points[start + 3] = { x: points[start].x + 0.02, y: points[start].y + 0.03 };
  }
  return { handedness, landmarks: points.map(point => ({
    x: x + (point.x * Math.cos(angle) - point.y * Math.sin(angle)) * 0.5,
    y: y + (point.x * Math.sin(angle) + point.y * Math.cos(angle)) * 0.5,
  })) };
}

function pose({ left = { x: 0.30, y: 0.42 }, right = { x: 0.70, y: 0.42 }, hidden = [], centerX = 0.5,
  upperBody = false }: { left?: Point; right?: Point; hidden?: readonly number[]; centerX?: number; upperBody?: boolean } = {}): ExhibitionGesturePose {
  const offset = centerX - 0.5;
  const landmarks = Array.from({ length: 33 }, () => ({ x: centerX, y: 0.5, visibility: 0.99 }));
  const set = (index: number, x: number, y: number) => {
    landmarks[index] = { x: x + offset, y, visibility: hidden.includes(index) ? 0.1 : 0.99 };
  };
  set(0, 0.5, 0.36); set(2, 0.46, 0.34); set(5, 0.54, 0.34); set(7, 0.42, 0.36); set(8, 0.58, 0.36);
  set(11, 0.35, 0.55); set(12, 0.65, 0.55);
  set(13, 0.30, 0.61); set(14, 0.70, 0.61);
  set(15, left.x, left.y); set(16, right.x, right.y);
  set(23, 0.38, 0.85); set(24, 0.62, 0.85);
  if (upperBody) landmarks[23].visibility = landmarks[24].visibility = 0.1;
  return { landmarks };
}

function scene(left: ExhibitionGestureHand, right?: ExhibitionGestureHand,
  options: { hidden?: readonly number[]; upperBody?: boolean; reverse?: boolean } = {}): Frame {
  const hands = right ? [left, right] : [left];
  return {
    poses: [pose({ left: left.landmarks[0], right: right?.landmarks[0], hidden: options.hidden, upperBody: options.upperBody })],
    hands: options.reverse ? hands.reverse() : hands,
  };
}

const oscillation = (time: number) => Math.sin(time / 1_000 * Math.PI * 4);
const wave = (time: number, x = 0.30, handedness = 'Left') => hand(x + oscillation(time) * 0.10, 0.42, 0, 'open', handedness);
const pivotWave = (time: number) => hand(0.30, 0.42, oscillation(time) * Math.PI / 5);

function run(detector: ExhibitionMirrorGestureDetector, from: number, to: number, frameAt: (time: number) => Frame,
  fps = 10, aspect = 1): Event[] {
  const events: Event[] = [];
  for (let frame = 0; from + frame * 1_000 / fps <= to + 0.01; frame++) {
    const time = from + frame * 1_000 / fps;
    const frameData = frameAt(time);
    const gesture = detector.update(frameData.poses, frameData.hands, time, aspect);
    if (gesture) events.push({ gesture, time });
  }
  return events;
}

// Consume the first palm presentation, then keep it visible long enough to permit
// a deliberate wave without allowing the same static palm to fire again.
function presentPalm(detector: ExhibitionMirrorGestureDetector, fps = 10, hidden: readonly number[] = []) {
  expect(run(detector, 0, 1_600, () => scene(hand(0.30), undefined, { hidden }), fps)
    .map(event => event.gesture)).toEqual(['open_palm']);
}

describe('configurable mirror gesture selection and timing', () => {
  it('enables only the selected entry point, including a fully disabled selection', () => {
    const palmOnly = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(palmOnly);
    expect(run(palmOnly, 1_700, 5_000, time => scene(wave(time)))).toEqual([]);
    const waveOnly = new ExhibitionMirrorGestureDetector({ gestures: ['wave'] });
    expect(run(waveOnly, 0, 1_600, () => scene(hand(0.30)))).toEqual([]);
    expect(run(waveOnly, 1_700, 5_000, time => scene(wave(time))).map(event => event.gesture)).toEqual(['wave']);
    const disabled = new ExhibitionMirrorGestureDetector({ gestures: [] });
    expect(run(disabled, 0, 1_600, () => scene(hand(0.30)))).toEqual([]);
    expect(run(disabled, 1_700, 5_000, time => scene(wave(time)))).toEqual([]);
    expect(disabled.armed).toBe(false);
  });

  it('does not let a wave bypass the selected palm confirmation duration', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmConfirmMs: 1_000 });
    run(detector, 0, 1_000, () => ({ poses: [pose()], hands: [] }));
    const events = run(detector, 1_100, 4_000, time => scene(wave(time)));
    expect(events).toEqual([{ gesture: 'open_palm', time: 2_100 }]);
  });

  it.each([200, 600, 1_000])('uses the configured %i ms continuous palm confirmation', palmConfirmMs => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmConfirmMs });
    run(detector, 0, 1_000, () => ({ poses: [pose()], hands: [] }));
    expect(run(detector, 1_100, 3_000, () => scene(hand(0.30))))
      .toEqual([{ gesture: 'open_palm', time: 1_100 + palmConfirmMs }]);
  });

  it('uses the configured withdrawal period before allowing the next palm', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmReleaseMs: 1_000 });
    presentPalm(detector);
    expect(run(detector, 1_700, 2_500, () => ({ poses: [pose()], hands: [] }))).toEqual([]);
    expect(run(detector, 2_600, 3_600, () => scene(hand(0.30)))).toEqual([]);
    run(detector, 3_700, 4_800, () => ({ poses: [pose()], hands: [] }));
    expect(run(detector, 4_900, 6_000, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
  });

  it.each(['close', 'withdraw'] as const)('releases at the exact configured 500 ms %s boundary', release => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmReleaseMs: 500 });
    presentPalm(detector);
    run(detector, 1_700, 2_200, () => ({ poses: [pose()], hands: release === 'close' ? [hand(0.30, 0.42, 0, 'fist')] : [] }));
    expect(run(detector, 2_300, 3_000, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
  });

  it.each([150, 750, 1_500])('uses the exact configured %i ms natural lowering duration', palmLowerMs => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmLowerMs });
    presentPalm(detector);
    run(detector, 1_700, 1_700 + palmLowerMs - 50, () => scene(hand(0.30, 0.80)), 20);
    expect(detector.confirmationState).toBe('lowering');
    const low = scene(hand(0.30, 0.80));
    expect(detector.update(low.poses, low.hands, 1_700 + palmLowerMs)).toBeNull();
    expect(detector.confirmationState).toBe('raise_required');
    const rise = 1_800 + palmLowerMs;
    expect(run(detector, rise, rise + 1_000, () => scene(hand(0.30)))).toEqual([{ gesture: 'open_palm', time: rise + 300 }]);
  });

  it.each([100, 300, 1_000])('uses the %i ms tracking grace boundary without releasing on uncertain frames', lowerTrackingGraceMs => {
    for (const overdue of [false, true]) {
      const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmLowerMs: 150,
        palmReleaseMs: 2_000, lowerTrackingGraceMs });
      presentPalm(detector);
      run(detector, 1_700, 1_800, () => scene(hand(0.30, 0.80)), 20);
      const resume = 1_800 + lowerTrackingGraceMs + (overdue ? 50 : 0);
      run(detector, 1_850, resume - 50, () => ({ poses: [pose({ left: { x: 0.30, y: 0.85 }, hidden: [15] })], hands: [] }), 20);
      const low = scene(hand(0.30, 0.80));
      expect(detector.update(low.poses, low.hands, resume)).toBeNull();
      expect(detector.confirmationState).toBe(overdue ? 'lowering' : 'raise_required');
      const events = run(detector, resume + 100, resume + 900, () => scene(hand(0.30)));
      expect(events).toEqual(overdue ? [] : [{ gesture: 'open_palm', time: resume + 400 }]);
    }
  });

  it('does not mistake continuous 8 FPS trustworthy wrists for a loss when the tracking grace is 100 ms', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmLowerMs: 350, lowerTrackingGraceMs: 100 });
    presentPalm(detector, 8);
    run(detector, 1_750, 2_125, () => scene(hand(0.30, 0.80)), 8);
    expect(detector.confirmationState).toBe('raise_required');
    expect(run(detector, 2_250, 3_000, () => scene(hand(0.30)), 8)).toEqual([{ gesture: 'open_palm', time: 2_625 }]);
  });

  it('keeps the legacy allowRaise latch release at 350 ms independently of palmLowerMs', () => {
    const detector = new ExhibitionMirrorGestureDetector({ allowRaise: true, gestures: ['open_palm'], palmLowerMs: 1_500 });
    expect(run(detector, 0, 700, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
    run(detector, 800, 1_100, () => scene(hand(0.30, 0.80)), 20);
    expect(detector.needsRelease).toBe(true);
    const low = scene(hand(0.30, 0.80));
    expect(detector.update(low.poses, low.hands, 1_150)).toBeNull();
    expect(detector.needsRelease).toBe(false);
    expect(detector.confirmationState).toBe('lowering');
  });

  it.each(['reset', 'configure'] as const)('does not turn a partial configurable drop into a fresh palm across %s', boundary => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmLowerMs: 1_500, lowerTrackingGraceMs: 1_000 });
    presentPalm(detector);
    run(detector, 1_700, 1_900, () => scene(hand(0.30, 0.80)));
    if (boundary === 'configure') detector.configure({ gestures: ['open_palm'], palmLowerMs: 150, lowerTrackingGraceMs: 100 });
    else detector.reset(true);
    expect(run(detector, 2_000, 3_000, () => scene(hand(0.30)))).toEqual([]);
    // The new timing still applies to a fresh, complete drop after the boundary.
    run(detector, 3_100, 4_700, () => scene(hand(0.30, 0.80)));
    expect(detector.confirmationState).toBe('raise_required');
    detector.configure({ gestures: ['open_palm'], palmLowerMs: 1_500, lowerTrackingGraceMs: 1_000 });
    expect(run(detector, 4_800, 5_700, () => scene(hand(0.30, 0.80)))).toEqual([]);
    expect(run(detector, 5_800, 6_700, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
  });

  it('reconfiguration and temporarily disabling selection cannot rearm a consumed palm', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector);
    detector.configure({ gestures: ['open_palm'], palmConfirmMs: 150, palmReleaseMs: 300 });
    expect(run(detector, 1_700, 3_000, () => scene(hand(0.30)))).toEqual([]);
    detector.configure({ gestures: [] });
    expect(run(detector, 3_100, 4_000, () => scene(hand(0.30)))).toEqual([]);
    detector.configure({ gestures: ['open_palm'], palmConfirmMs: 150, palmReleaseMs: 300 });
    expect(run(detector, 4_100, 5_000, () => scene(hand(0.30)))).toEqual([]);
    run(detector, 5_100, 5_600, () => ({ poses: [pose()], hands: [] }));
    expect(run(detector, 5_700, 6_500, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
  });
});

describe('natural lowering after a consumed palm', () => {
  it('counts a continuous downward arc despite finger jitter and vertical movement', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector);
    run(detector, 1_750, 2_125, time => {
      const elapsed = time - 1_750;
      const sample = hand(0.30 + Math.sin(elapsed / 125) * 0.025, 0.70 + elapsed / 375 * 0.15);
      for (const index of [8, 12, 16]) sample.landmarks[index].y += Math.sin(elapsed / 125) * 0.04;
      return scene(sample);
    }, 8);
    expect(detector.confirmationState).toBe('raise_required');
    expect(run(detector, 2_250, 3_000, () => scene(hand(0.30)), 8)).toEqual([{ gesture: 'open_palm', time: 2_625 }]);
  });

  it('continues a confirmed body-wrist drop while the Hand model loses a small hand', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmReleaseMs: 1_000 });
    presentPalm(detector);
    run(detector, 1_700, 1_800, () => scene(hand(0.30, 0.72)));
    run(detector, 1_900, 2_100, () => ({ poses: [pose({ left: { x: 0.30, y: 0.83 } })], hands: [] }));
    // 200 ms of no Hand result is not the configured 1,000 ms withdrawal.
    expect(run(detector, 2_200, 2_900, () => scene(hand(0.30)))).toEqual([{ gesture: 'open_palm', time: 2_500 }]);
  });

  it('waits for a trusted low wrist after a brief combined Hand and wrist-confidence dropout', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmReleaseMs: 1_000 });
    expect(run(detector, 0, 700, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
    expect(detector.needsRelease).toBe(true);
    run(detector, 800, 900, () => scene(hand(0.30, 0.73)));
    run(detector, 1_000, 1_300, () => ({ poses: [pose({ left: { x: 0.30, y: 0.85 }, hidden: [15] })], hands: [] }));
    // Uncertain frames preserve an established trajectory but never unlock it.
    expect(detector.needsRelease).toBe(true);
    const small = hand(0.30, 0.83);
    small.landmarks = small.landmarks.map(point => ({ x: 0.30 + (point.x - 0.30) * 0.1, y: 0.83 + (point.y - 0.83) * 0.1 }));
    const frame = scene(small);
    expect(detector.update(frame.poses, frame.hands, 1_400)).toBeNull();
    expect(detector.confirmationState).toBe('raise_required');
    expect(detector.needsRelease).toBe(false);
    expect(run(detector, 1_500, 2_200, () => scene(hand(0.30)))).toEqual([{ gesture: 'open_palm', time: 1_800 }]);
  });

  it.each(['long_loss', 'raised_return', 'cropped', 'unowned'] as const)('cannot complete an interrupted drop with %s', interruption => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmReleaseMs: 2_000 });
    presentPalm(detector);
    run(detector, 1_700, 1_800, () => scene(hand(0.30, 0.73)));
    const end = interruption === 'long_loss' ? 2_500 : 2_100;
    run(detector, 1_900, end, () => {
      if (interruption === 'cropped') return scene(hand(0.02, 0.80));
      if (interruption === 'unowned') return { poses: [pose({ left: { x: 0.30, y: 0.80 } })], hands: [hand(0.60, 0.80)] };
      return { poses: [pose({ left: { x: 0.30, y: 0.85 }, hidden: [15] })], hands: [] };
    });
    if (interruption !== 'raised_return') run(detector, end + 100, end + 200, () => scene(hand(0.30, 0.80)));
    expect(run(detector, end + 300, end + 1_200, () => scene(hand(0.30)))).toEqual([]);
    expect(detector.confirmationState).toBe('already_triggered');
  });

  it('checks the 500 ms wrist-confidence grace again when the trustworthy wrist returns', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'], palmReleaseMs: 2_000 });
    expect(run(detector, 0, 700, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
    run(detector, 800, 900, () => scene(hand(0.30, 0.73)));
    run(detector, 1_000, 1_300, () => ({ poses: [pose({ left: { x: 0.30, y: 0.85 }, hidden: [15] })], hands: [] }));
    const frame = scene(hand(0.30, 0.80));
    // The frame gap is only 200 ms, but the last trustworthy low wrist was 600 ms ago.
    expect(detector.update(frame.poses, frame.hands, 1_500)).toBeNull();
    expect(detector.confirmationState).toBe('lowering');
    expect(run(detector, 1_600, 2_300, () => scene(hand(0.30)))).toEqual([]);
  });

  it('keeps a low fixed-wrist palm rotation consumed while it is still waving', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector);
    expect(run(detector, 1_700, 5_000, time => scene(hand(0.30, 0.80, oscillation(time) * Math.PI / 5)))).toEqual([]);
    expect(run(detector, 5_100, 6_000, () => scene(hand(0.30)))).toEqual([]);
  });

  it('preserves wave-only gestures performed below the shoulder after a low rest', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['wave'] });
    expect(run(detector, 0, 1_600, () => scene(hand(0.30)))).toEqual([]);
    expect(run(detector, 1_700, 2_400, time => scene(wave(time))).map(event => event.gesture)).toEqual(['wave']);
    expect(run(detector, 2_500, 4_000, () => scene(hand(0.30, 0.80)))).toEqual([]);
    expect(detector.confirmationState).not.toBe('raise_required');
    expect(detector.armed).toBe(true);
    expect(run(detector, 4_100, 6_000, time => scene(hand(0.30 + oscillation(time) * 0.10, 0.80)))
      .map(event => event.gesture)).toEqual(['wave']);
  });

  it.each([{ gestures: ['wave'] as const }, { gestures: ['open_palm', 'wave'] as const }])('allows a low wave after palm lowering when configured gestures become $gestures', ({ gestures }) => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector);
    run(detector, 1_700, 2_400, () => scene(hand(0.30, 0.80)));
    expect(detector.confirmationState).toBe('raise_required');
    detector.configure({ gestures });
    expect(run(detector, 2_500, 3_400, () => scene(hand(0.30, 0.80)))).toEqual([]);
    expect(detector.armed).toBe(true);
    expect(run(detector, 3_500, 5_400, time => scene(hand(0.30 + oscillation(time) * 0.10, 0.80)))
      .map(event => event.gesture)).toEqual(['wave']);
    // Re-enabling palm-only cannot turn the still-low hand into another palm.
    detector.configure({ gestures: ['open_palm'] });
    expect(run(detector, 5_500, 6_800, () => scene(hand(0.30, 0.80)))).toEqual([]);
  });

  it.each([5, 8, 15])('accepts another presentation after resting the hand by the body at %i FPS', fps => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector, fps);
    // The short shared latch has already cleared, but this palm remains consumed.
    expect(detector.needsRelease).toBe(false);
    expect(detector.confirmationState).toBe('already_triggered');
    expect(run(detector, 1_800, 3_800, () => scene(hand(0.30, 0.80)), fps)).toEqual([]);
    expect(detector.confirmationState).toBe('raise_required');
    expect(detector.armed).toBe(false);
    expect(detector.palmHoldMs).toBe(0);
    const second = run(detector, 4_000, 5_000, () => scene(hand(0.30)), fps);
    expect(second).toHaveLength(1);
    expect(second[0].gesture).toBe('open_palm');
    expect(second[0].time).toBeGreaterThanOrEqual(4_300);
    expect(run(detector, 5_200, 6_000, () => scene(hand(0.30, 0.80)), fps)).toEqual([]);
    expect(run(detector, 6_200, 7_200, () => scene(hand(0.30)), fps).map(event => event.gesture)).toEqual(['open_palm']);
  });

  it('reports the down-hold and restarts the full confirmation only after the hand rises', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector);
    run(detector, 1_700, 2_000, () => scene(hand(0.30, 0.80)));
    expect(detector.confirmationState).toBe('lowering');
    run(detector, 2_100, 2_400, () => scene(hand(0.30, 0.80)));
    expect(detector.confirmationState).toBe('raise_required');
    expect(run(detector, 2_500, 2_700, () => scene(hand(0.30)))).toEqual([]);
    expect(detector.confirmationState).toBe('holding');
    expect(detector.palmHoldMs).toBe(200);
    expect(run(detector, 2_800, 3_600, () => scene(hand(0.30)))).toEqual([{ gesture: 'open_palm', time: 2_800 }]);
  });

  it('accepts a new palm in the shoulder display zone without requiring its previous exact height', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector);
    run(detector, 1_700, 2_400, () => scene(hand(0.30, 0.80)));
    expect(detector.confirmationState).toBe('raise_required');
    expect(run(detector, 2_500, 4_000, () => scene(hand(0.30, 0.50))))
      .toEqual([{ gesture: 'open_palm', time: 2_800 }]);
  });

  it('does not rearm a brief dip or an open hand still waving below the shoulder', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector);
    expect(run(detector, 1_700, 2_000, () => scene(hand(0.30, 0.80)))).toEqual([]);
    expect(run(detector, 2_100, 3_000, () => scene(hand(0.30)))).toEqual([]);
    expect(run(detector, 3_100, 6_000, time => scene(hand(0.30 + oscillation(time) * 0.10, 0.80)))).toEqual([]);
    expect(run(detector, 6_100, 7_000, () => scene(hand(0.30)))).toEqual([]);
    expect(detector.confirmationState).toBe('already_triggered');
  });

  it('keeps the lower-zone gate through a soft reset and a temporary hand-only source', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector);
    run(detector, 1_700, 2_300, () => scene(hand(0.30, 0.80)));
    expect(detector.confirmationState).toBe('raise_required');
    detector.reset(true);
    expect(run(detector, 2_400, 3_400, () => ({ poses: [], hands: [hand(0.30, 0.80)] }))).toEqual([]);
    expect(detector.confirmationState).toBe('raise_required');
    expect(run(detector, 3_500, 4_300, () => scene(hand(0.30, 0.80)))).toEqual([]);
    expect(run(detector, 4_400, 5_300, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
  });

  it.each(['reset', 'gap', 'ambiguous'] as const)('discards a partial down-hold across %s instead of completing it with old evidence', interruption => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector);
    run(detector, 1_700, 1_900, () => scene(hand(0.30, 0.80)));
    if (interruption === 'reset') detector.reset(true);
    if (interruption === 'ambiguous') detector.update([pose(), pose({ centerX: 0.64 })], [hand(0.30, 0.80)], 2_000);
    const resume = interruption === 'gap' ? 2_500 : 2_100;
    expect(run(detector, resume, resume + 200, () => scene(hand(0.30, 0.80)))).toEqual([]);
    expect(run(detector, resume + 300, resume + 1_800, () => scene(hand(0.30)))).toEqual([]);
    expect(detector.confirmationState).toBe('already_triggered');
  });

  it.each(['cropped', 'untrusted_wrist', 'unowned_hand', 'different_body'] as const)('does not treat a %s as a trustworthy natural drop', uncertainty => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    presentPalm(detector);
    expect(run(detector, 1_700, 3_500, () => {
      const sample = hand(uncertainty === 'cropped' ? 0.02 : uncertainty === 'different_body' ? 0.48 : 0.30, 0.80);
      if (uncertainty === 'unowned_hand') return { poses: [pose()], hands: [sample] };
      if (uncertainty === 'different_body') return { poses: [pose({ centerX: 0.68, left: { x: 0.30, y: 0.80 } })], hands: [sample] };
      return scene(sample, undefined, { hidden: uncertainty === 'untrusted_wrist' ? [15] : [] });
    })).toEqual([]);
    expect(run(detector, 3_600, 5_000, () => scene(hand(0.30)))).toEqual([]);
    expect(detector.confirmationState).toBe('already_triggered');
  });

  it('rearms only the lowered hand when both palms were consumed together', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    const right = hand(0.70, 0.42, 0, 'open', 'Right');
    expect(run(detector, 0, 1_600, () => scene(hand(0.30), right)).map(event => event.gesture)).toEqual(['open_palm']);
    expect(run(detector, 1_700, 3_500, () => scene(hand(0.30, 0.80), right))).toEqual([]);
    // The stationary right palm is still consumed; only the left's new rise acts.
    expect(run(detector, 3_600, 4_500, () => scene(hand(0.30), right)).map(event => event.gesture)).toEqual(['open_palm']);
    expect(run(detector, 4_600, 6_000, () => scene(hand(0.30), right))).toEqual([]);
  });

  it('acquires the correct body wrist for a hand-only right trigger before lowering it', () => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    const rightAt = (y: number): Frame => { const sample = hand(0.70, y, 0, 'open', 'Right'); return { poses: [pose({ right: sample.landmarks[0] })], hands: [sample] }; };
    expect(run(detector, 0, 1_600, () => ({ poses: [], hands: [hand(0.70, 0.42, 0, 'open', 'Right')] })).map(event => event.gesture)).toEqual(['open_palm']);
    detector.reset(true);
    expect(run(detector, 1_700, 2_500, () => rightAt(0.42))).toEqual([]);
    expect(run(detector, 2_600, 3_400, () => rightAt(0.80))).toEqual([]);
    expect(detector.confirmationState).toBe('raise_required');
    expect(run(detector, 3_500, 4_500, () => rightAt(0.42)).map(event => event.gesture)).toEqual(['open_palm']);
  });
});

describe('exhibition mirror gestures', () => {
  it.each([5, 10, 15])('accepts a seated upper-body gesture with an initially high hand only once at %i FPS', fps => {
    const detector = new ExhibitionMirrorGestureDetector();
    const events = run(detector, 0, 6_000, time => scene(wave(time), undefined, { upperBody: true }), fps);
    expect(events).toHaveLength(1);
    expect(['wave', 'open_palm']).toContain(events[0].gesture);
    expect(events[0].time).toBeGreaterThanOrEqual(200);
    expect(detector.operatorStatus).toBe('locked');
    expect(detector.handDetected).toBe(true);
  });

  it.each([5, 10, 15])('emits one open-palm event for a continuously visible static palm at %i FPS', fps => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 8_000, () => scene(hand(0.30)), fps)
      .map(event => event.gesture)).toEqual(['open_palm']);
  });

  it('requires a full 300 ms presentation rather than a brief flash of an open palm', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 1_000, () => scene(hand(0.30, 0.42, 0, 'fist')))).toEqual([]);
    expect(run(detector, 1_100, 1_300, () => scene(hand(0.30)))).toEqual([]);
    const frame = scene(hand(0.30));
    expect(detector.update(frame.poses, frame.hands, 1_400)).toBe('open_palm');
  });

  it.each([5, 10, 15])('recognizes a fresh deliberate horizontal wave after the initial palm event at %i FPS', fps => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector, fps);
    expect(run(detector, 1_800, 6_000, time => scene(wave(time)), fps)
      .map(event => event.gesture)).toEqual(['wave']);
  });

  it.each([5, 10, 15])('recognizes fixed-wrist palm rotation after the initial presentation at %i FPS', fps => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector, fps);
    expect(run(detector, 1_800, 6_000, time => scene(pivotWave(time)), fps)
      .map(event => event.gesture)).toEqual(['wave']);
  });

  it.each([5, 10, 15])('accepts one left-right round trip with only one direction reversal at %i FPS', fps => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector, fps);
    const events = run(detector, 1_800, 2_700, time => {
      const elapsed = time - 1_800;
      const x = elapsed <= 300 ? 0.30 + elapsed / 300 * 0.20
        : elapsed <= 600 ? 0.50 - (elapsed - 300) / 300 * 0.20 : 0.30;
      return scene(hand(x));
    }, fps);
    expect(events.map(event => event.gesture)).toEqual(['wave']);
  });

  it.each([
    { source: 'body', fps: 10 }, { source: 'hand', fps: 10 },
    { source: 'body', fps: 15 }, { source: 'hand', fps: 15 },
  ])('accepts an initial 300 ms wave with $source control at $fps FPS and keeps continuous waving latched', ({ source, fps }) => {
    const detector = new ExhibitionMirrorGestureDetector();
    if (source === 'body') run(detector, 0, 1_000, () => ({ poses: [pose()], hands: [] }));
    const frameAt = (time: number): Frame => {
      const elapsed = (time - 1_100) % 300;
      const x = elapsed <= 150 ? 0.30 + elapsed / 150 * 0.20 : 0.50 - (elapsed - 150) / 150 * 0.20;
      // The middle fingertip is outside the frame, so this cannot pass through
      // the separate full-palm presentation path at the same 300 ms boundary.
      const sample = hand(x, 0.235);
      return source === 'body' ? scene(sample) : { poses: [], hands: [sample] };
    };
    const events = run(detector, 1_100, 1_450, frameAt, fps);
    expect(events.map(event => event.gesture)).toEqual(['wave']);
    // Confirmation occurs on the first sampled frame at or after 300 ms.
    expect(events[0].time).toBeCloseTo(fps === 10 ? 1_400 : 1_100 + 5 * 1_000 / 15);
    expect(detector.needsRelease).toBe(true);
    expect(run(detector, 1_500, 2_000, frameAt, fps)).toEqual([]);
    detector.reset(true);
    expect(run(detector, 2_100, 3_500, frameAt, fps)).toEqual([]);
    expect(detector.needsRelease).toBe(true);
  });

  it('keeps a visible wrist and palm usable when the elbow has low confidence', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector, 10, [13]);
    expect(run(detector, 1_800, 4_500, time => scene(wave(time), undefined, { hidden: [13] }))
      .map(event => event.gesture)).toEqual(['wave']);
    expect(detector.operatorStatus).toBe('locked');
    expect(detector.handDetected).toBe(true);
  });

  it.each(['fist', 'phone'] as const)('does not authorize either action from a %s grip', shape => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 4_000, time => scene(hand(0.30 + oscillation(time) * 0.10, 0.42, 0, shape)))).toEqual([]);
  });

  it('does not treat low-to-high arm movement with a closed hand as an action by default', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 4_000, time => scene(hand(0.30, time < 1_100 ? 0.80 : 0.42, 0, 'fist')))).toEqual([]);
  });

  it.each(['outside-frame', 'too-small', 'three-fingers'] as const)('does not authorize a stationary %s palm presentation', invalid => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 4_000, () => {
      const sample = hand(0.30, invalid === 'outside-frame' ? 0.10 : 0.42);
      if (invalid === 'too-small') {
        const wrist = sample.landmarks[0];
        return scene({ ...sample, landmarks: sample.landmarks.map(point => ({
          x: wrist.x + (point.x - wrist.x) * 0.10,
          y: wrist.y + (point.y - wrist.y) * 0.10,
        })) });
      }
      if (invalid === 'three-fingers') {
        const landmarks = sample.landmarks.map(point => ({ ...point }));
        landmarks[19] = { x: landmarks[17].x + 0.01, y: landmarks[17].y - 0.035 };
        landmarks[20] = { x: landmarks[17].x + 0.01, y: landmarks[17].y + 0.015 };
        return scene({ ...sample, landmarks });
      }
      return scene(sample);
    })).toEqual([]);
  });

  it('emits only once for two hands moving continuously even when their array order changes', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 8_000, time => scene(wave(time), wave(time, 0.70, 'Right'),
      { reverse: Math.round(time / 100) % 2 === 0 }))).toHaveLength(1);
  });

  it('associates by the trusted body wrist rather than changing hand-list positions or labels', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    expect(run(detector, 1_800, 5_000, time => {
      const owner = wave(time);
      const unrelated = hand(0.86, 0.85, 0, 'open', 'Left');
      owner.handedness = Math.round(time / 100) % 2 === 0 ? 'Left' : 'Right';
      return { poses: [pose({ left: owner.landmarks[0] })],
        hands: Math.round(time / 100) % 2 === 0 ? [owner, unrelated] : [unrelated, owner] };
    }).map(event => event.gesture)).toEqual(['wave']);
  });

  it('rejects a waving or open hand that matches neither wrist of the locked operator', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 1_000, () => ({ poses: [pose()], hands: [] }))).toEqual([]);
    expect(run(detector, 1_100, 5_000, time => ({ poses: [pose()],
      hands: [hand(0.50 + oscillation(time) * 0.10, 0.90)] }))).toEqual([]);
    expect(detector.operatorStatus).toBe('locked');
  });

  it('pauses for multiple central people regardless of pose or hand-list order', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 4_000, time => {
      const owner = wave(time);
      const other = wave(time, 0.70, 'Right');
      const poses = [pose({ left: owner.landmarks[0] }), pose({ centerX: 0.64 })];
      return { poses: Math.round(time / 100) % 2 === 0 ? poses : poses.reverse(), hands: [owner, other] };
    })).toEqual([]);
    expect(detector.operatorStatus).toBe('ambiguous');
    expect(detector.armed).toBe(false);
  });

  it('preserves the shared latch through a soft reset and a continued gesture', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 3_000, time => scene(wave(time)))).toHaveLength(1);
    detector.reset(true);
    expect(run(detector, 3_100, 7_000, time => scene(wave(time)))).toEqual([]);
  });

  it('clears the latch on an explicit hard reset so a new experience can show its palm again', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    detector.reset();
    expect(detector.operatorStatus).toBe('searching');
    expect(detector.handDetected).toBe(false);
    expect(detector.lastRaiseStartedAt).toBeNull();
    expect(run(detector, 1_800, 5_000, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
  });

  it('does not immediately count a wave after the first palm presentation as a second action', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 700, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
    expect(run(detector, 800, 4_000, time => scene(wave(time)))).toEqual([]);
  });

  it('keeps a continuous wave latched when an extended fingertip stays cropped for more than 500 ms', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 700, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
    expect(run(detector, 800, 4_000, time => {
      // The middle fingertip is just above y=0; the wrist and other fingers stay
      // visible, matched and extended throughout the horizontal motion.
      const sample = hand(0.30 + oscillation(time) * 0.10, 0.235);
      expect(sample.landmarks.filter(point => point.y < 0)).toHaveLength(1);
      return scene(sample);
    })).toEqual([]);
    expect(run(detector, 4_100, 7_000, time => scene(wave(time)))).toEqual([]);
  });

  it('keeps a continuous wave latched when the same wrist moves below the shoulder and back up', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 700, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
    expect(run(detector, 800, 1_700, time => scene(wave(time)))).toEqual([]);
    expect(run(detector, 1_800, 5_000, time => scene(hand(0.30 + oscillation(time) * 0.10, 0.80)))).toEqual([]);
    expect(detector.needsRelease).toBe(true);
    expect(run(detector, 5_100, 8_000, time => scene(wave(time)))).toEqual([]);
    expect(detector.needsRelease).toBe(true);
  });

  it.each([5, 10, 15])('releases a wave after the same palm visibly rests but never repeats its consumed presentation at %i FPS', fps => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector, fps);
    expect(run(detector, 1_800, 4_000, time => scene(pivotWave(time)), fps).map(event => event.gesture)).toEqual(['wave']);
    expect(run(detector, 4_200, 5_200, () => scene(hand(0.30)), fps)).toEqual([]);
    expect(run(detector, 5_400, 8_000, time => scene(pivotWave(time)), fps)
      .map(event => event.gesture)).toEqual(['wave']);
  });

  it('does not release a wave after less than 600 ms of stillness', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    expect(run(detector, 1_800, 4_000, time => scene(pivotWave(time))).map(event => event.gesture)).toEqual(['wave']);
    expect(run(detector, 4_100, 4_600, () => scene(hand(0.30, 0.42, 0.35)))).toEqual([]);
    // Resume away from the resting angle; a near-identical first sample would
    // legitimately count as the sixth 100 ms interval of stillness.
    expect(run(detector, 4_700, 7_000, time => scene(pivotWave(time + 250)))).toEqual([]);
  });

  it('never uses the other stationary hand to release the triggering moving hand', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    expect(run(detector, 1_800, 4_000, time => scene(wave(time))).map(event => event.gesture)).toEqual(['wave']);
    expect(run(detector, 4_100, 8_000, time => scene(wave(time), hand(0.70, 0.80, 0, 'open', 'Right')))).toEqual([]);
  });

  it.each(['close', 'withdraw'] as const)('allows another full palm presentation after a clear %s longer than 500 ms', release => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    expect(run(detector, 1_700, 2_400, () => ({ poses: [pose()],
      hands: release === 'close' ? [hand(0.30, 0.42, 0, 'fist')] : [] }))).toEqual([]);
    expect(run(detector, 2_500, 5_000, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
  });

  it.each(['close', 'withdraw'] as const)('does not rearm a palm during a brief 300 ms %s', release => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    expect(run(detector, 1_700, 2_000, () => ({ poses: [pose()],
      hands: release === 'close' ? [hand(0.30, 0.42, 0, 'fist')] : [] }))).toEqual([]);
    expect(run(detector, 2_100, 5_000, () => scene(hand(0.30)))).toEqual([]);
  });

  it.each(['pose', 'wrist'] as const)('does not treat missing trusted %s data as withdrawing and presenting again', missing => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    expect(run(detector, 1_700, 2_600, () => ({
      poses: missing === 'pose' ? [] : [pose({ hidden: [15] })], hands: [hand(0.30)],
    }))).toEqual([]);
    expect(detector.operatorStatus).toBe('locked');
    expect(detector.controlSource).toBe('hand');
    expect(run(detector, 2_700, 5_000, () => scene(hand(0.30)))).toEqual([]);
  });

  it('accepts reentry after the hand and wrist leave the frame while the same shoulders stay locked', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    expect(run(detector, 1_700, 2_500, () => ({
      poses: [pose({ left: { x: 0.30, y: 1.20 }, hidden: [15] })], hands: [],
    }))).toEqual([]);
    expect(detector.operatorStatus).toBe('locked');
    expect(run(detector, 2_600, 5_000, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
  });

  it('preserves a moving gesture across a capture gap or temporarily ambiguous operator', () => {
    for (const interruption of ['gap', 'ambiguous'] as const) {
      const detector = new ExhibitionMirrorGestureDetector();
      expect(run(detector, 0, 3_000, time => scene(wave(time)))).toHaveLength(1);
      if (interruption === 'ambiguous') expect(run(detector, 3_100, 3_800, time => ({
        poses: [pose({ left: wave(time).landmarks[0] }), pose({ centerX: 0.64 })], hands: [wave(time)],
      }))).toEqual([]);
      expect(run(detector, 4_000, 7_000, time => scene(wave(time)))).toEqual([]);
    }
  });

  it('locks a unique hand in 200 ms while its 300 ms palm confirmation runs in parallel', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    const sample = hand(0.30);
    expect(run(detector, 0, 200, () => ({ poses: [], hands: [sample] }))).toEqual([]);
    expect(detector.operatorStatus).toBe('locked');
    expect(detector.controlSource).toBe('hand');
    expect(detector.ambiguityReason).toBeNull();
    expect(detector.update([], [sample], 299)).toBeNull();
    expect(detector.update([], [sample], 300)).toBe('open_palm');
    expect(run(detector, 400, 3_000, () => ({ poses: [], hands: [sample] }))).toEqual([]);
  });

  it.each([5, 10, 15])('accepts an initial open-hand wave without a face or shoulders at %i FPS', fps => {
    const detector = new ExhibitionMirrorGestureDetector();
    const events = run(detector, 0, 5_000, time => ({ poses: [], hands: [wave(time)] }), fps);
    expect(events).toHaveLength(1);
    expect(['wave', 'open_palm']).toContain(events[0].gesture);
    expect(detector.operatorStatus).toBe('locked');
    expect(detector.controlSource).toBe('hand');
  });

  it('tracks a unique closed hand without authorizing a gesture', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 3_000, time => ({ poses: [],
      hands: [hand(0.30 + oscillation(time) * 0.10, 0.42, 0, 'fist')] }))).toEqual([]);
    expect(detector.operatorStatus).toBe('locked');
    expect(detector.controlSource).toBe('hand');
    expect(detector.handDetected).toBe(true);
  });

  it('pauses hand-only control while two distinct hands are visible', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 4_000, time => ({ poses: [],
      hands: [wave(time), wave(time, 0.70, 'Right')] }))).toEqual([]);
    expect(detector.operatorStatus).toBe('ambiguous');
    expect(detector.ambiguityReason).toBe('hands');
    expect(detector.armed).toBe(false);
  });

  it('prioritizes ambiguous people over an otherwise unique hand fallback', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 4_000, time => ({
      poses: [pose(), pose({ centerX: 0.64 })], hands: [wave(time)],
    }))).toEqual([]);
    expect(detector.operatorStatus).toBe('ambiguous');
    expect(detector.ambiguityReason).toBe('people');
    expect(detector.armed).toBe(false);
  });

  it('preserves a consumed static palm across body-to-hand-to-body control transitions', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    expect(detector.controlSource).toBe('body');
    expect(run(detector, 1_700, 3_300, () => ({ poses: [], hands: [hand(0.30)] }))).toEqual([]);
    expect(detector.controlSource).toBe('hand');
    expect(detector.operatorStatus).toBe('locked');
    expect(run(detector, 3_400, 5_500, () => scene(hand(0.30)))).toEqual([]);
    expect(detector.controlSource).toBe('body');
  });

  it('keeps a continuous wave latched through body-to-hand-to-body control transitions', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 700, () => scene(hand(0.30))).map(event => event.gesture)).toEqual(['open_palm']);
    expect(run(detector, 800, 1_500, time => scene(wave(time)))).toEqual([]);
    expect(run(detector, 1_600, 4_000, time => ({ poses: [], hands: [wave(time)] }))).toEqual([]);
    expect(detector.controlSource).toBe('hand');
    expect(detector.needsRelease).toBe(true);
    expect(run(detector, 4_100, 7_000, time => scene(wave(time)))).toEqual([]);
    expect(detector.controlSource).toBe('body');
    expect(detector.needsRelease).toBe(true);
  });

  it('accepts a new wave from the same visible hand when the body becomes untrackable', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    expect(run(detector, 1_800, 5_000, time => ({ poses: [], hands: [wave(time)] }))
      .map(event => event.gesture)).toEqual(['wave']);
    expect(detector.operatorStatus).toBe('locked');
    expect(detector.controlSource).toBe('hand');
  });

  it.each(['close', 'withdraw'] as const)('permits a fresh hand-only palm after a clear %s', release => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 1_600, () => ({ poses: [], hands: [hand(0.30)] }))
      .map(event => event.gesture)).toEqual(['open_palm']);
    expect(run(detector, 1_700, 2_400, () => ({ poses: [],
      hands: release === 'close' ? [hand(0.30, 0.42, 0, 'fist')] : [] }))).toEqual([]);
    expect(run(detector, 2_500, 5_000, () => ({ poses: [], hands: [hand(0.30)] }))
      .map(event => event.gesture)).toEqual(['open_palm']);
  });

  it('preserves a hand-only gesture through soft reset and short tracking loss', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 3_000, time => ({ poses: [], hands: [wave(time)] }))).toHaveLength(1);
    detector.reset(true);
    expect(run(detector, 3_100, 4_000, time => ({ poses: [], hands: [wave(time)] }))).toEqual([]);
    expect(run(detector, 4_100, 4_300, () => ({ poses: [], hands: [] }))).toEqual([]);
    expect(run(detector, 4_400, 7_000, time => ({ poses: [], hands: [wave(time)] }))).toEqual([]);
  });

  it('permits another hand-only wave after the same palm rests without repeating open-palm events', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 1_600, () => ({ poses: [], hands: [hand(0.30)] }))
      .map(event => event.gesture)).toEqual(['open_palm']);
    expect(run(detector, 1_800, 4_000, time => ({ poses: [], hands: [pivotWave(time)] }))
      .map(event => event.gesture)).toEqual(['wave']);
    expect(run(detector, 4_200, 5_200, () => ({ poses: [], hands: [hand(0.30)] }))).toEqual([]);
    expect(run(detector, 5_400, 8_000, time => ({ poses: [], hands: [pivotWave(time)] }))
      .map(event => event.gesture)).toEqual(['wave']);
  });

  it('does not concatenate unfinished motion when the unique hand jumps to a different location', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 1_500, () => ({ poses: [], hands: [hand(0.30)] }))
      .map(event => event.gesture)).toEqual(['open_palm']);
    expect(run(detector, 1_600, 1_800, time => ({ poses: [],
      hands: [hand(0.30 + (time - 1_600) / 200 * 0.13)] }))).toEqual([]);
    // A spatially separate hand moving once in the opposite direction is not
    // the return stroke of the previous hand's unfinished wave.
    expect(run(detector, 1_900, 2_400, time => ({ poses: [],
      hands: [hand(0.85 - (time - 1_900) / 500 * 0.20)] }))).toEqual([]);
  });

  it.each(['static', 'wave'] as const)('maps an initially hand-only right %s into pose wrist 16 and back without repeating', motion => {
    const detector = new ExhibitionMirrorGestureDetector();
    const sampleAt = (time: number) => motion === 'static' ? hand(0.70, 0.42, 0, 'open', 'Right') : wave(time, 0.70, 'Right');
    const events = run(detector, 0, 2_500, time => ({ poses: [], hands: [sampleAt(time)] }));
    expect(events).toHaveLength(1);
    expect(motion === 'static' ? ['open_palm'] : ['wave', 'open_palm']).toContain(events[0].gesture);
    expect(run(detector, 2_600, 5_000, time => {
      const sample = sampleAt(time);
      return { poses: [pose({ right: sample.landmarks[0] })], hands: [sample] };
    })).toEqual([]);
    expect(detector.controlSource).toBe('body');
    expect(run(detector, 5_100, 8_000, time => ({ poses: [], hands: [sampleAt(time)] }))).toEqual([]);
    expect(detector.controlSource).toBe('hand');
    if (motion === 'wave') expect(detector.needsRelease).toBe(true);
  });

  it.each(['static', 'wave'] as const)('retains right-hand %s ownership through soft resets on both sides of a source switch', motion => {
    const detector = new ExhibitionMirrorGestureDetector();
    const sampleAt = (time: number) => motion === 'static' ? hand(0.70, 0.42, 0, 'open', 'Right') : wave(time, 0.70, 'Right');
    expect(run(detector, 0, 2_500, time => ({ poses: [], hands: [sampleAt(time)] }))).toHaveLength(1);
    detector.reset(true);
    expect(run(detector, 2_600, 5_000, time => {
      const sample = sampleAt(time);
      return { poses: [pose({ right: sample.landmarks[0] })], hands: [sample] };
    })).toEqual([]);
    expect(detector.controlSource).toBe('body');
    detector.reset(true);
    expect(run(detector, 5_100, 8_000, time => ({ poses: [], hands: [sampleAt(time)] }))).toEqual([]);
    expect(detector.controlSource).toBe('hand');
  });

  it.each(['none', 'hands', 'people'] as const)('keeps right-hand consumption and its moving latch through a short %s interruption', interruption => {
    for (const motion of ['static', 'wave'] as const) {
      const detector = new ExhibitionMirrorGestureDetector();
      const sampleAt = (time: number) => motion === 'static' ? hand(0.70, 0.42, 0, 'open', 'Right') : wave(time, 0.70, 'Right');
      expect(run(detector, 0, 2_500, time => ({ poses: [], hands: [sampleAt(time)] }))).toHaveLength(1);
      expect(run(detector, 2_600, 2_800, time => ({
        poses: interruption === 'people' ? [pose(), pose({ centerX: 0.64 })] : [],
        hands: interruption === 'none' ? [] : interruption === 'hands' ? [hand(0.30), sampleAt(time)] : [sampleAt(time)],
      }))).toEqual([]);
      expect(detector.controlSource).toBe('none');
      if (interruption !== 'none') expect(detector.ambiguityReason).toBe(interruption);
      expect(run(detector, 2_900, 5_500, time => {
        const sample = sampleAt(time);
        return { poses: [pose({ right: sample.landmarks[0] })], hands: [sample] };
      })).toEqual([]);
      expect(detector.controlSource).toBe('body');
      if (motion === 'wave') expect(detector.needsRelease).toBe(true);
    }
  });

  it('keeps the same right palm consumed when a nearby closed left hand appears with the body', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    const right = hand(0.65, 0.42, 0, 'open', 'Right');
    const left = hand(0.45, 0.42, 0, 'fist', 'Left');
    expect(run(detector, 0, 1_600, () => ({ poses: [], hands: [right] }))
      .map(event => event.gesture)).toEqual(['open_palm']);
    expect(run(detector, 1_700, 4_000, () => ({
      poses: [pose({ left: left.landmarks[0], right: right.landmarks[0] })], hands: [left, right],
    }))).toEqual([]);
    expect(detector.controlSource).toBe('body');
  });

  it.each([{ hidden: [15] }, { hidden: [15, 16] }])('uses the unique hand when the locked body has untrusted wrists $hidden', ({ hidden }) => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 1_000, () => ({ poses: [pose({ hidden })], hands: [] }))).toEqual([]);
    expect(detector.operatorStatus).toBe('locked');
    expect(run(detector, 1_100, 2_600, () => ({ poses: [pose({ hidden })], hands: [hand(0.30)] }))
      .map(event => event.gesture)).toEqual(['open_palm']);
    expect(detector.controlSource).toBe('hand');
    expect(detector.handDetected).toBe(true);
    expect(run(detector, 2_700, 5_000, time => ({ poses: [pose({ hidden })], hands: [wave(time)] }))
      .map(event => event.gesture)).toEqual(['wave']);
    expect(detector.controlSource).toBe('hand');
  });

  it.each([{ hidden: [15] }, { hidden: [15, 16] }])('pauses two-hand fallback when the locked body has untrusted wrists $hidden', ({ hidden }) => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(run(detector, 0, 1_000, () => ({ poses: [pose({ hidden })], hands: [] }))).toEqual([]);
    expect(run(detector, 1_100, 4_000, time => ({ poses: [pose({ hidden })],
      hands: [wave(time), wave(time, 0.70, 'Right')] }))).toEqual([]);
    expect(detector.operatorStatus).toBe('ambiguous');
    expect(detector.ambiguityReason).toBe('hands');
    expect(detector.armed).toBe(false);
  });

  it('confirms a continuously shown palm despite alternating trusted and fallback wrist confidence', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    run(detector, 0, 1_000, () => ({ poses: [pose()], hands: [] }));
    const events = run(detector, 1_100, 4_000, time => {
      const body = pose();
      body.landmarks[15].visibility = Math.round((time - 1_100) / 100) % 2 ? 0.99 : 0.64;
      return { poses: [body], hands: [hand(0.30)] };
    });
    expect(events.map(event => event.gesture)).toEqual(['open_palm']);
    expect(events[0].time).toBeLessThanOrEqual(1_500);
  });

  it('retains a wave trajectory across per-frame body and hand control changes', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    run(detector, 0, 1_000, () => ({ poses: [pose()], hands: [] }));
    const events = run(detector, 1_100, 5_000, time => {
      // One cropped fingertip disables full-palm confirmation, isolating wave
      // recognition while retaining an extended palm and its matched wrist.
      const sample = hand(0.30 + oscillation(time) * 0.10, 0.235);
      const body = pose({ left: sample.landmarks[0] });
      body.landmarks[15].visibility = Math.round((time - 1_100) / 100) % 2 ? 0.99 : 0.64;
      return { poses: [body], hands: [sample] };
    });
    expect(events.map(event => event.gesture)).toEqual(['wave']);
  });

  it('confirms a complete open palm while it moves vertically instead of requiring stillness', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    const frameAt = (time: number): Frame => ({ poses: [],
      hands: [hand(0.30, Math.min(0.75, 0.42 + time * 0.00015))] });
    const events = run(detector, 0, 1_500, frameAt);
    expect(events.map(event => event.gesture)).toEqual(['open_palm']);
    expect(events[0].time).toBe(300);
    expect(run(detector, 1_600, 4_000, frameAt)).toEqual([]);
  });

  it('reports actual palm confirmation progress and distinguishes a consumed palm from a ready wave', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    expect(detector.update([], [hand(0.30)], 0)).toBeNull();
    expect(detector.confirmationState).toBe('settling');
    expect(detector.update([], [hand(0.30, 0.435)], 100)).toBeNull();
    expect(detector.update([], [hand(0.30, 0.45)], 200)).toBeNull();
    expect(detector.confirmationState).toBe('holding');
    expect(detector.palmHoldMs).toBe(200);
    expect(detector.rawHandCount).toBe(1);
    expect(detector.matchedHandCount).toBe(1);
    expect(detector.update([], [hand(0.30, 0.465)], 300)).toBe('open_palm');
    expect(detector.confirmationState).toBe('release_required');
    expect(detector.palmHoldMs).toBe(0);
    expect(run(detector, 400, 1_100, () => ({ poses: [], hands: [hand(0.30, 0.465)] }))).toEqual([]);
    expect(detector.needsRelease).toBe(false);
    expect(detector.armed).toBe(true);
    expect(detector.confirmationState).toBe('already_triggered');
    expect(detector.palmHoldMs).toBe(0);
  });

  it.each(['incomplete', 'too_small', 'fingers_folded'] as const)('reports the specific %s palm constraint while tracking the hand', reason => {
    const detector = new ExhibitionMirrorGestureDetector();
    const full = hand(0.30, reason === 'incomplete' ? 0.235 : 0.42, 0, reason === 'fingers_folded' ? 'fist' : 'open');
    const sample = reason === 'too_small' ? { ...full, landmarks: full.landmarks.map(point => ({
      x: full.landmarks[0].x + (point.x - full.landmarks[0].x) * 0.25,
      y: full.landmarks[0].y + (point.y - full.landmarks[0].y) * 0.25,
    })) } : full;
    expect(run(detector, 0, 1_000, () => ({ poses: [], hands: [sample] }))).toEqual([]);
    expect(detector.handDetected).toBe(true);
    expect(detector.confirmationState).toBe(reason);
    expect(detector.palmHoldMs).toBe(0);
    expect(detector.rawHandCount).toBe(1);
    expect(detector.matchedHandCount).toBe(1);
  });

  it('distinguishes an absent hand, a visible unmatched hand, and multiple unowned hands', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    run(detector, 0, 1_000, () => ({ poses: [pose()], hands: [] }));
    expect(detector.confirmationState).toBe('no_hand');
    expect(detector.rawHandCount).toBe(0);
    expect(detector.matchedHandCount).toBe(0);
    detector.update([pose()], [hand(0.50, 0.90)], 1_100);
    expect(detector.confirmationState).toBe('unmatched_hand');
    expect(detector.rawHandCount).toBe(1);
    expect(detector.matchedHandCount).toBe(0);
    detector.update([], [hand(0.30), hand(0.70)], 1_200);
    expect(detector.confirmationState).toBe('ambiguous');
    expect(detector.rawHandCount).toBe(2);
    expect(detector.matchedHandCount).toBe(0);
  });

  it('accepts a naturally short little finger while the other three fingers remain extended', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    const full = hand(0.30);
    const landmarks = full.landmarks.map(point => ({ ...point }));
    for (const index of [18, 19, 20]) {
      landmarks[index] = {
        x: landmarks[17].x + (landmarks[index].x - landmarks[17].x) * 0.5,
        y: landmarks[17].y + (landmarks[index].y - landmarks[17].y) * 0.5,
      };
    }
    expect(run(detector, 0, 3_000, () => scene({ ...full, landmarks }))
      .map(event => event.gesture)).toEqual(['open_palm']);
  });

  it('accepts fingers held together and a thumb resting close to the palm', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    const full = hand(0.30);
    const landmarks = full.landmarks.map(point => ({ ...point }));
    for (const [finger, start] of [5, 9, 13, 17].entries()) {
      for (let index = start; index < start + 4; index++) landmarks[index].x = 0.30 + (finger - 1.5) * 0.008;
    }
    for (const index of [1, 2, 3, 4]) landmarks[index] = { x: 0.28 + index * 0.003, y: 0.42 - index * 0.025 };
    expect(run(detector, 0, 3_000, () => scene({ ...full, landmarks }))
      .map(event => event.gesture)).toEqual(['open_palm']);
  });

  it('accepts one gently curved little finger without requiring four rigidly straight fingers', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    const full = hand(0.30);
    const landmarks = full.landmarks.map(point => ({ ...point }));
    // The little finger remains outward, with approximately 0.73 straightness.
    landmarks[20] = { x: 0.405, y: 0.28 };
    expect(run(detector, 0, 3_000, () => scene({ ...full, landmarks }))
      .map(event => event.gesture)).toEqual(['open_palm']);
  });

  it('does not rearm when two short-looking fingers fail presentation checks without folding inward', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    const full = hand(0.30);
    const landmarks = full.landmarks.map(point => ({ ...point }));
    for (const start of [13, 17]) {
      for (let index = start + 1; index < start + 4; index++) landmarks[index] = {
        x: landmarks[start].x + (landmarks[index].x - landmarks[start].x) * 0.4,
        y: landmarks[start].y + (landmarks[index].y - landmarks[start].y) * 0.4,
      };
    }
    // Both fingers are straight and outward: this is an uncertain presentation,
    // not evidence that the user deliberately closed the hand to release it.
    expect(run(detector, 1_700, 2_600, () => scene({ ...full, landmarks }))).toEqual([]);
    expect(run(detector, 2_700, 5_000, () => scene(hand(0.30)))).toEqual([]);
  });

  it('does not mistake two extended fingers in a V sign for a complete open palm', () => {
    const detector = new ExhibitionMirrorGestureDetector();
    const twoFingers = hand(0.30, 0.42, 0, 'phone');
    expect(run(detector, 0, 3_000, () => scene(twoFingers))).toEqual([]);
    expect(detector.confirmationState).toBe('fingers_folded');
  });

  it.each(['incomplete', 'too_small'] as const)('does not interpret an %s fist-shaped result as a confirmed release', geometry => {
    const detector = new ExhibitionMirrorGestureDetector();
    presentPalm(detector);
    const fist = hand(0.30, geometry === 'incomplete' ? 0.12 : 0.42, 0, 'fist');
    const sample = geometry === 'too_small' ? { ...fist, landmarks: fist.landmarks.map(point => ({
      x: fist.landmarks[0].x + (point.x - fist.landmarks[0].x) * 0.25,
      y: fist.landmarks[0].y + (point.y - fist.landmarks[0].y) * 0.25,
    })) } : fist;
    expect(run(detector, 1_700, 2_600, () => scene(sample))).toEqual([]);
    expect(detector.confirmationState).toBe(geometry);
    expect(run(detector, 2_700, 5_000, () => scene(hand(0.30)))).toEqual([]);
    expect(detector.confirmationState).toBe('already_triggered');
  });
});
