import { describe, expect, it } from 'vitest';
import { ExhibitionMirrorGestureDetector } from '../src/exhibition/mirrorGestureDetector';
import type { ExhibitionGestureHand } from '../src/exhibition/gestureDetector';
import type { ExhibitionGesturePose } from '../src/exhibition/raiseGestureDetector';

const palm = [[0, 0], [-.04, -.05], [-.09, -.09], [-.12, -.14], [-.16, -.17],
  [-.06, -.17], [-.065, -.29], [-.07, -.37], [-.075, -.44],
  [0, -.19], [0, -.32], [0, -.41], [0, -.49],
  [.06, -.17], [.065, -.29], [.07, -.37], [.075, -.44],
  [.115, -.13], [.13, -.23], [.14, -.3], [.15, -.36]];
function hand(x: number, fist = false, handedness = 'Left'): ExhibitionGestureHand {
  const points = palm.map(point => [...point]);
  if (fist) for (const start of [5, 9, 13, 17]) {
    points[start + 2] = [points[start][0] + .02, points[start][1] - .07];
    points[start + 3] = [points[start][0] + .02, points[start][1] + .03];
  }
  return { handedness, landmarks: points.map(([xOffset, yOffset]) => ({ x: x + xOffset * .5, y: .42 + yOffset * .5 })) };
}

function pose(centerX = .5): ExhibitionGesturePose {
  const landmarks = Array.from({ length: 33 }, () => ({ x: centerX, y: .5, visibility: .99 }));
  for (const [index, x, y] of [[0, .5, .36], [2, .46, .34], [5, .54, .34], [7, .42, .36], [8, .58, .36],
    [11, .35, .55], [12, .65, .55], [13, .3, .61], [14, .7, .61], [15, .3, .42], [16, .7, .42],
    [23, .38, .85], [24, .62, .85]]) landmarks[index] = { x: x + centerX - .5, y, visibility: .99 };
  return { landmarks };
}

describe('independent hand tracks keep consumed gestures through identity uncertainty', () => {
  it.each(['fist', 'palm'] as const)('does not replay a held palm while crossing the other %s and swapping model labels', other => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    const events: number[] = [];
    for (let timestamp = 0; timestamp <= 15_000; timestamp += 100) {
      const x = timestamp <= 1800 ? .3 : .5 + Math.sin((timestamp - 1800) / 1000 * Math.PI) * .25;
      const label = timestamp % 200 ? 'Left' : 'Right';
      const hands = [hand(x, false, label), hand(other === 'palm' ? 1 - x : .5, other === 'fist', label)];
      if (timestamp % 200) hands.reverse();
      if (detector.update([], hands, timestamp, 1)) events.push(timestamp);
    }
    expect(events).toEqual([300]);
  });

  it.each(['cropped', 'incomplete', 'small'] as const)('a %s second hand does not veto a complete first hand', issue => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    const events: number[] = [];
    for (let timestamp = 0; timestamp <= 2_000; timestamp += 100) {
      const other = hand(.7);
      if (issue === 'cropped') other.landmarks[8].x = 1.1;
      if (issue === 'incomplete') other.landmarks.pop();
      if (issue === 'small') other.landmarks = other.landmarks.map(point => ({
        x: .7 + (point.x - .7) * .05, y: .42 + (point.y - .42) * .05,
      }));
      const hands = [hand(.3), other];
      if (timestamp % 200) hands.reverse();
      if (detector.update([], hands, timestamp, 1)) events.push(timestamp);
    }
    expect(events).toEqual([300]);
  });

  it.each([false, true])('releases after 500 ms without hands when a different body locks at the boundary (busy=%s)', busy => {
    const detector = new ExhibitionMirrorGestureDetector({ gestures: ['open_palm'] });
    const events: number[] = [];
    const frame = (time: number, visible: boolean, centerX = .5) => {
      if (detector.update([pose(centerX)], visible ? [hand(centerX - .2)] : [], time)) events.push(time);
    };
    for (let time = 0; time <= 700; time += 100) frame(time, true);
    expect(events).toEqual([300]);
    detector.setBlocked(busy);
    // The new body starts settling 100 ms into the absence and locks exactly
    // at its 500 ms release boundary; pose identity cannot restart that clock.
    for (let time = 800; time <= 1_200; time += 100) frame(time, false, time < 900 ? .5 : .68);
    expect(detector.needsRelease).toBe(true);
    frame(1_300, false, .68);
    expect(detector.needsRelease).toBe(false);
    for (let time = 1_400; time <= 1_800; time += 100) frame(time, true, .68);
    if (!busy) {
      expect(events).toEqual([300, 1_700]);
      return;
    }
    detector.setBlocked(false);
    for (let time = 1_900; time <= 2_300; time += 100) frame(time, true, .68);
    expect(events).toEqual([300]);
    for (let time = 2_400; time <= 2_900; time += 100) frame(time, false, .68);
    for (let time = 3_000; time <= 3_300; time += 100) frame(time, true, .68);
    expect(events).toEqual([300, 3_300]);
  });
});
