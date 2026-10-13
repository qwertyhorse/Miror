import { describe, expect, it } from 'vitest';
import { ExhibitionGestureDetector, type ExhibitionGestureHand } from '../src/exhibition/gestureDetector';

const palm = [
  [0, 0], [-0.04, -0.05], [-0.09, -0.09], [-0.12, -0.14], [-0.16, -0.17],
  [-0.06, -0.17], [-0.065, -0.29], [-0.07, -0.37], [-0.075, -0.44],
  [0, -0.19], [0, -0.32], [0, -0.41], [0, -0.49],
  [0.06, -0.17], [0.065, -0.29], [0.07, -0.37], [0.075, -0.44],
  [0.115, -0.13], [0.13, -0.23], [0.14, -0.3], [0.15, -0.36],
];
function hand(x: number, y: number, handedness = 'Right'): ExhibitionGestureHand {
  return { handedness, landmarks: palm.map(([px, py]) => ({ x: x + px * 0.5, y: y + py * 0.5 })) };
}
function feed(detector: ExhibitionGestureDetector, from: number, until: number, fps: number,
  sample: (time: number) => ExhibitionGestureHand | null) {
  const gestures = [];
  for (let frame = 0; from + frame * 1_000 / fps <= until + 0.01; frame++) {
    const time = from + frame * 1_000 / fps;
    const gesture = detector.update(sample(time), time, 'wave');
    if (gesture) gestures.push(gesture);
  }
  return gestures;
}
function raise(detector: ExhibitionGestureDetector, fps: number) {
  return feed(detector, 0, 600, fps, time => hand(0.5, 0.85 - Math.min(time / 600, 1) * 0.3));
}
function wave(time: number, from = 0): ExhibitionGestureHand {
  return hand(0.5 + Math.sin((time - from) / 1_000 * Math.PI * 4) * 0.13, 0.55);
}

describe('raised hand prepares the existing wave without becoming a command', () => {
  it.each([5, 10, 15, 30, 60])('prepares on an upward motion and accepts the immediately following wave at %i FPS', fps => {
    const detector = new ExhibitionGestureDetector();
    expect(raise(detector, fps)).toEqual([]);
    expect(detector.handRaised).toBe(true);
    const from = 600 + 1_000 / fps;
    expect(feed(detector, from, from + 2_000, fps, time => wave(time, from))).toEqual(['wave']);
  });

  it('does not consume the existing wave latch when the same hand rises again', () => {
    const detector = new ExhibitionGestureDetector();
    expect(raise(detector, 10)).toEqual([]);
    expect(feed(detector, 700, 2_700, 10, time => wave(time, 700))).toEqual(['wave']);
    expect(feed(detector, 2_800, 3_300, 10,
      time => hand(0.5 + Math.sin(time / 250 * Math.PI) * 0.13, 0.55 - (time - 2_800) / 500 * 0.15))).toEqual([]);
    expect(feed(detector, 3_400, 5_400, 10,
      time => hand(0.5 + Math.sin(time / 250 * Math.PI) * 0.13, 0.4))).toEqual([]);
  });

  it.each([5, 15, 30])('still accepts a hand first seen already raised at %i FPS', fps => {
    expect(feed(new ExhibitionGestureDetector(), 0, 2_000, fps, time => wave(time))).toEqual(['wave']);
  });

  it.each([500, 900])('retains confirmed preparation across a %i ms capture gap and accepts the next wave', gap => {
    const detector = new ExhibitionGestureDetector();
    raise(detector, 15);
    expect(detector.handRaised).toBe(true);
    const resumedAt = 600 + gap;
    expect(detector.update(hand(0.5, 0.55), resumedAt, 'wave')).toBeNull();
    expect(detector.handRaised).toBe(true);
    const from = resumedAt + 100;
    expect(feed(detector, from, from + 2_000, 15, time => wave(time, from))).toEqual(['wave']);
  });

  it('clears confirmed preparation after a gap longer than the raise history', () => {
    const detector = new ExhibitionGestureDetector();
    raise(detector, 15);
    expect(detector.handRaised).toBe(true);
    expect(detector.update(hand(0.5, 0.55), 1_501, 'wave')).toBeNull();
    expect(detector.handRaised).toBe(false);
  });

  it('tracks a continued lift across a capture gap so lowering the hand clears preparation', () => {
    const detector = new ExhibitionGestureDetector();
    raise(detector, 15);
    expect(detector.update(hand(0.5, 0.42), 1_100, 'wave')).toBeNull();
    expect(detector.handRaised).toBe(true);
    expect(detector.update(hand(0.5, 0.52), 1_200, 'wave')).toBeNull();
    expect(detector.handRaised).toBe(false);
  });

  it('does not join an unfinished raise across a 500 ms capture gap', () => {
    const detector = new ExhibitionGestureDetector();
    detector.update(hand(0.5, 0.85), 0, 'wave');
    detector.update(hand(0.5, 0.82), 100, 'wave');
    expect(detector.handRaised).toBe(false);
    expect(detector.update(hand(0.5, 0.55), 600, 'wave')).toBeNull();
    expect(detector.handRaised).toBe(false);
    expect(feed(detector, 700, 1_500, 15, () => hand(0.5, 0.55))).toEqual([]);
    expect(detector.handRaised).toBe(false);
  });

  it.each(['other-hand', 'position-jump', 'size-change'])('clears preparation when a short capture gap ends with %s', interruption => {
    const detector = new ExhibitionGestureDetector();
    raise(detector, 15);
    const sample = hand(interruption === 'position-jump' ? 1.3 : 0.5, 0.55,
      interruption === 'other-hand' ? 'Left' : 'Right');
    if (interruption === 'size-change') sample.landmarks = sample.landmarks.map(point => ({
      x: 0.5 + (point.x - 0.5) * 2,
      y: 0.55 + (point.y - 0.55) * 2,
    }));
    expect(detector.update(sample, 1_100, 'wave')).toBeNull();
    expect(detector.handRaised).toBe(false);
  });

  it('keeps an ordinary horizontal pass and finger jitter from preparing or switching', () => {
    const detector = new ExhibitionGestureDetector();
    expect(feed(detector, 0, 600, 15, time => hand(0.35 + time / 600 * 0.3, 0.65))).toEqual([]);
    expect(detector.handRaised).toBe(false);
    expect(feed(detector, 700, 1_700, 15, time => hand(0.65, 0.65 + Math.sin(time / 100) * 0.005))).toEqual([]);
    expect(detector.handRaised).toBe(false);
  });

  it('clears preparation after lowering the hand, changing hands or resetting the experience', () => {
    const detector = new ExhibitionGestureDetector();
    raise(detector, 15);
    expect(detector.handRaised).toBe(true);
    feed(detector, 700, 1_200, 15, time => hand(0.5, 0.55 + (time - 700) / 500 * 0.25));
    expect(detector.handRaised).toBe(false);
    detector.reset(); raise(detector, 15);
    detector.update(hand(0.5, 0.55, 'Left'), 700, 'wave');
    expect(detector.handRaised).toBe(false);
    detector.reset(); raise(detector, 15); detector.reset();
    expect(detector.handRaised).toBe(false);
  });

  it('ignores a closed fist moving upwards', () => {
    const detector = new ExhibitionGestureDetector();
    expect(feed(detector, 0, 600, 15, time => {
      const sample = hand(0.5, 0.85 - time / 600 * 0.3);
      for (const start of [5, 9, 13, 17]) {
        sample.landmarks[start + 2] = { x: sample.landmarks[start].x, y: sample.landmarks[start].y + 0.01 };
        sample.landmarks[start + 3] = { x: sample.landmarks[start].x, y: sample.landmarks[start].y + 0.02 };
      }
      return sample;
    })).toEqual([]);
    expect(detector.handRaised).toBe(false);
  });

  it.each([5, 15])('does not split a continuous wave after one missing frame at %i FPS', fps => {
    const detector = new ExhibitionGestureDetector();
    expect(feed(detector, 0, 2_000, fps, time => wave(time))).toEqual(['wave']);
    const missingAt = 2_000 + 1_000 / fps;
    expect(detector.update(null, missingAt, 'wave')).toBeNull();
    expect(feed(detector, missingAt + 1_000 / fps, 4_500, fps, time => wave(time))).toEqual([]);
    feed(detector, 4_600, 5_400, fps, () => null);
    expect(detector.handRaised).toBe(false);
    expect(feed(detector, 5_500, 7_500, fps, time => wave(time, 5_500))).toEqual(['wave']);
  });
});
