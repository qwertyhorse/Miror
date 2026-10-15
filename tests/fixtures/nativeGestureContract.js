// Runs unchanged in Node and the actual Chromium 74 executable. No inference or network mocks are needed.
export function runNativeGestureContract(createRuntime) {
  const checks = [];
  const palm = [[0, 0], [-.04, -.05], [-.09, -.09], [-.12, -.14], [-.16, -.17],
    [-.06, -.17], [-.065, -.29], [-.07, -.37], [-.075, -.44],
    [0, -.19], [0, -.32], [0, -.41], [0, -.49],
    [.06, -.17], [.065, -.29], [.07, -.37], [.075, -.44],
    [.115, -.13], [.13, -.23], [.14, -.3], [.15, -.36]];
  const hand = (x = .30) => ({ handedness: 'Left', landmarks: palm.map(point => ({ x: x + point[0] * .5, y: .42 + point[1] * .5 })) });
  const frame = (runtime, timestamp, hands = [hand()]) => runtime.push({ timestamp, hands, poses: [], aspectRatio: 1 });
  const run = (runtime, start, end, hands = () => [hand()]) => {
    const events = [];
    for (let at = start; at <= end; at += 100) {
      const result = frame(runtime, at, hands(at));
      if (result.event) events.push({ at, event: result.event });
    }
    return events;
  };
  const equal = (actual, expected, message) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + ': ' + JSON.stringify(actual));
  };
  const test = (name, check) => { check(); checks.push(name); };

  test('first lock and confirmation in the default 0 → 310 ms sampling frame', () => {
    const runtime = createRuntime();
    equal(frame(runtime, 0).event, null, 'initial palm');
    const confirmed = frame(runtime, 310);
    equal([confirmed.operatorStatus, confirmed.event], ['locked', 'open_palm'], 'same-frame confirmation');
    equal(run(runtime, 410, 4010), [], 'held palm must fire once');
  });
  test('brief busy palm is consumed until release, never replayed', () => {
    const runtime = createRuntime(); runtime.configure({ gestures: ['open_palm'] });
    runtime.setBlocked(true);
    equal(run(runtime, 0, 100), [], 'busy palm');
    runtime.setBlocked(false);
    equal(run(runtime, 200, 1200), [], 'old palm after completion');
    run(runtime, 1300, 1900, () => []);
    equal(run(runtime, 2000, 2700), [{ at: 2300, event: 'open_palm' }], 'fresh palm');
  });
  test('busy release counts, but busy re-raise cannot accumulate confirmation', () => {
    const runtime = createRuntime(); runtime.configure({ gestures: ['open_palm'] });
    frame(runtime, 0); frame(runtime, 310); runtime.setBlocked(true);
    run(runtime, 410, 1110, () => []);
    runtime.setBlocked(false);
    equal(run(runtime, 1210, 1910), [{ at: 1510, event: 'open_palm' }], 'release during busy');
    runtime.setBlocked(true); run(runtime, 2010, 2710, () => []);
    run(runtime, 2810, 2910); runtime.setBlocked(false);
    equal(run(runtime, 3010, 4010), [], 'busy re-raise must be discarded');
  });
  test('a second hand appearing while busy cannot rearm an unresolved hand', () => {
    const runtime = createRuntime(); runtime.configure({ gestures: ['open_palm'] });
    frame(runtime, 0); frame(runtime, 310); runtime.setBlocked(true);
    equal(run(runtime, 410, 1010, () => [hand(), hand(.7)]), [], 'two busy hands');
    runtime.setBlocked(false);
    equal(run(runtime, 1110, 2110), [], 'resolved busy hand');
    run(runtime, 2210, 2910, () => []);
    equal(run(runtime, 3010, 3710), [{ at: 3310, event: 'open_palm' }], 'second-hand recovery');
  });
  test('busy wave history is discarded and a fresh wave works after rest', () => {
    const runtime = createRuntime(); runtime.configure({ gestures: ['wave'] });
    const waving = time => [hand(.30 + Math.sin(time / 1000 * Math.PI * 4) * .10)];
    runtime.setBlocked(true);
    equal(run(runtime, 0, 1000, waving), [], 'busy waves');
    runtime.setBlocked(false);
    equal(run(runtime, 1100, 3000, waving), [], 'continued busy wave');
    run(runtime, 3100, 4200);
    equal(run(runtime, 4300, 6000, waving).map(event => event.event), ['wave'], 'fresh wave');
  });
  test('stop, retry, reconfigure and late frames preserve held-palm consumption', () => {
    const runtime = createRuntime();
    frame(runtime, 0); frame(runtime, 310);
    equal(frame(runtime, 310).event, null, 'duplicate frame');
    equal(frame(runtime, 200).timestamp, 310, 'late frame timestamp');
    runtime.reset(); runtime.configure({ gestures: ['open_palm'] });
    equal(run(runtime, 410, 1410), [], 'held palm across retry');
    run(runtime, 1510, 2210, () => []);
    equal(run(runtime, 2310, 3010), [{ at: 2610, event: 'open_palm' }], 'release after retry');
  });
  return checks;
}
