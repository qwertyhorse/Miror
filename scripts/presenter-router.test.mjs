import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresenterRouter, validatePresenterConfig } from './presenter-router.mjs';

const config = { apiBaseUrl: 'http://xuminghong.local:10601/v1.1/api/exhibition', bindings: [
  { id: 'pen-1', mirrorId: 'default', vendorId: 529, productId: 1, locationId: 17825792 },
  { id: 'pen-2', mirrorId: 'mirror-second', vendorId: 529, productId: 1, locationId: 17825793 },
] };
const clock = 1_000_000;
const look = (id, mode = 'clothx') => ({ id, mode });
const standby = (mirrorId = 'default', extra = {}) => ({
  mirrorId, revision: 10, phase: 'idle', providerMode: 'xmax', experienceMode: 'clothx',
  selectedLookId: 'a', generationNumber: 4, sessionNumber: 2, live: null,
  lifecycle: { state: 'ended', connection: 'idle' },
  // Array order deliberately differs from the enabled-ID set and draft catalog.
  catalog: { looks: [look('a'), look('disabled'), look('b'), look('foreign', 'charx'), look('c')],
    availableLookIds: ['c', 'foreign', 'a', 'b'] },
  looks: [look('draft-only'), look('a'), look('b'), look('c')], enabledLookIds: ['draft-only', 'a', 'b', 'c'],
  ...extra,
});
const running = (extra = {}) => standby('default', {
  phase: 'showcase', lifecycle: { state: 'active', connection: 'running' },
  live: { sessionId: 'existing-session', status: 'running', generationNumber: 4, lookId: 'a', heartbeatAt: clock },
  ...extra,
});
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture({ states = {}, fetchOverride, routerConfig = config, ...options } = {}) {
  const mirrors = { default: standby(), 'mirror-second': standby('mirror-second'), ...states };
  const calls = []; const events = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const mirrorId = path.split('/')[5];
    const call = { url, path, mirrorId, method: init.method ?? 'GET', init,
      body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (fetchOverride) {
      const result = await fetchOverride(call, mirrors);
      if (result !== undefined) return result;
    }
    if (!mirrors[mirrorId]) return json({}, 404);
    if (call.method === 'GET') return json(mirrors[mirrorId]);
    const previous = mirrors[mirrorId];
    assert.equal(call.body.expectedRevision, previous.revision);
    mirrors[mirrorId] = { ...previous, revision: previous.revision + 1, selectedLookId: call.body.lookId,
      phase: call.body.action === 'select' ? 'select' : 'generating' };
    return json(mirrors[mirrorId]);
  };
  let sequence = 0;
  const router = createPresenterRouter(routerConfig, { fetchImpl, now: () => clock,
    randomUUID: () => `command-${++sequence}`, onEvent: event => events.push(event), ...options });
  const key = (bindingId, usage, value = 1) => router.handle({ type: 'key', bindingId, usage, value });
  const tap = async (bindingId = 'pen-1', usage = 78) => { const result = await key(bindingId, usage); await key(bindingId, usage, 0); return result; };
  return { router, key, tap, calls, events, mirrors, commands: () => calls.filter(call => call.method === 'POST') };
}

test('two identical presenters route to their own mirrors with revision and origin headers', async () => {
  const f = fixture();
  await Promise.all([f.tap('pen-1'), f.tap('pen-2', 75)]);
  const commands = f.commands();
  assert.equal(commands.length, 2);
  assert.deepEqual(commands.map(call => [call.mirrorId, call.body.action, call.body.lookId]), [
    ['default', 'select', 'b'], ['mirror-second', 'select', 'c'],
  ]);
  assert.equal(new Set(commands.map(call => call.body.commandId)).size, 2);
  for (const call of commands) {
    assert.equal(call.init.headers.Origin, 'http://xuminghong.local:10601');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.equal(call.body.expectedRevision, 10);
    assert.equal(call.init.redirect, 'error');
  }
});

test('all six HID direction usages match the existing presenter controls', async () => {
  for (const [usage, target] of [[75, 'c'], [78, 'b'], [79, 'b'], [80, 'c'], [81, 'b'], [82, 'c']]) {
    const f = fixture();
    assert.equal((await f.tap('pen-1', usage)).status, 'accepted');
    assert.equal(f.commands()[0].body.lookId, target);
  }
});

test('uses provider catalog order, skips disabled/other-mode/draft looks and wraps', async () => {
  const f = fixture();
  await f.tap(); await f.tap(); await f.tap(); await f.tap('pen-1', 75);
  assert.deepEqual(f.commands().map(call => call.body.lookId), ['b', 'c', 'a', 'c']);
  assert.ok(f.commands().every(call => call.body.action === 'select'));
});

test('demo mode uses its ordered look catalog rather than XMAX availability', async () => {
  const f = fixture({ states: { default: standby('default', { providerMode: 'demo',
    looks: [look('a'), look('disabled'), look('b'), look('other', 'charx'), look('c')], enabledLookIds: ['c', 'other', 'a', 'b'] }) } });
  await f.tap();
  assert.equal(f.commands()[0].body.lookId, 'b');
});

test('missing current material selects first forward or last backward; fewer than two does nothing', async () => {
  for (const [usage, target] of [[78, 'a'], [75, 'c']]) {
    const f = fixture({ states: { default: standby('default', { selectedLookId: null }) } });
    await f.tap('pen-1', usage);
    assert.equal(f.commands()[0].body.lookId, target);
  }
  for (const availableLookIds of [[], ['a']]) {
    const f = fixture({ states: { default: standby('default', { catalog: { looks: [look('a')], availableLookIds } }) } });
    assert.equal((await f.tap()).reason, 'no_adjacent_material');
    assert.equal(f.commands().length, 0);
  }
});

test('healthy live and demo rounds switch without starting or allocating a session', async () => {
  for (const phase of ['generating', 'showcase']) {
    for (const state of [running({ phase }), standby('default', { phase, providerMode: 'demo', lifecycle: { state: 'active', connection: 'idle' } })]) {
      const f = fixture({ states: { default: state } });
      assert.equal((await f.tap()).status, 'accepted');
      assert.equal(f.commands()[0].body.action, 'switch');
      assert.equal(f.calls.length, 2);
      assert.ok(f.calls.every(call => /^\/v1\.1\/api\/exhibition\/mirrors\/default(?:\/command)?$/.test(call.path)));
    }
  }
});

test('a held button triggers once until a matching release, independently per pen', async () => {
  const f = fixture();
  await f.key('pen-1', 78);
  assert.equal((await f.key('pen-1', 78)).reason, 'held');
  await f.key('pen-1', 75, 0);
  assert.equal((await f.key('pen-1', 78)).reason, 'held');
  await f.tap('pen-2');
  await f.key('pen-1', 78, 0); await f.key('pen-1', 78);
  assert.deepEqual(f.commands().map(call => call.mirrorId), ['default', 'mirror-second', 'default']);
});

test('a pending pen drops new presses while the other pen remains independent', async () => {
  const gate = deferred(); let reads = 0;
  const f = fixture({ fetchOverride: async call => {
    if (call.method === 'GET' && call.mirrorId === 'default' && ++reads === 1) await gate.promise;
  } });
  const first = f.key('pen-1', 78);
  await f.key('pen-1', 78, 0);
  assert.equal((await f.key('pen-1', 75)).reason, 'busy');
  await f.key('pen-1', 75, 0);
  await f.tap('pen-2');
  assert.equal(f.commands().length, 1);
  gate.resolve(); await first;
  assert.equal(f.commands().length, 2);
  assert.equal(f.calls.filter(call => call.method === 'GET' && call.mirrorId === 'default').length, 1);
  await f.tap('pen-1');
  assert.equal(f.commands().length, 3);
});

test('pending command responses also prevent queued or repeated material changes', async () => {
  const entered = deferred(); const gate = deferred();
  const f = fixture({ fetchOverride: async call => {
    if (call.method === 'POST' && call.mirrorId === 'default') { entered.resolve(); await gate.promise; }
  } });
  const first = f.key('pen-1', 78); await entered.promise;
  await f.key('pen-1', 78, 0);
  assert.equal((await f.key('pen-1', 78)).reason, 'busy');
  gate.resolve(); await first;
  assert.equal((await f.key('pen-1', 78)).reason, 'held');
  assert.equal(f.commands().length, 1);
});

test('paused, positioning, stopping, connection errors, renewal, and stale live frames are blocked', async () => {
  const base = running();
  const cases = [
    { phase: 'paused' }, { phase: 'positioning' },
    ...['preparing', 'connecting', 'stopping', 'error'].map(status => ({ live: { ...base.live, status } })),
    { live: null }, { live: { ...base.live, renewal: { id: 'renewal' } } },
    { live: { ...base.live, localEnded: true } }, { live: { ...base.live, sessionId: null } },
    { live: { ...base.live, generationNumber: 3 } }, { live: { ...base.live, lookId: 'b' } },
    { live: { ...base.live, heartbeatAt: clock - 20_000 } }, { live: { ...base.live, heartbeatAt: undefined } },
    ...['connecting', 'recovering', 'cleaning', 'needs_assistance'].map(connection => ({ lifecycle: { state: 'active', connection } })),
    { lifecycle: { state: 'paused', connection: 'running' } },
  ];
  for (const extra of cases) {
    const f = fixture({ states: { default: running(extra) } });
    assert.equal((await f.tap()).status, 'blocked', JSON.stringify(extra));
    assert.equal(f.commands().length, 0);
  }
  const f = fixture({ states: { default: standby('default', { live: base.live }) } });
  assert.equal((await f.tap()).reason, 'live_pending');
});

test('unavailable, malformed and wrong-mirror state cannot mutate any device', async () => {
  for (const response of [json({}, 503), json({}), json(standby('wrong-mirror')), json(standby('default', { revision: -1 })),
    json(standby('default', { catalog: null })), json(standby('default', { catalog: { looks: [look('a'), look('a')], availableLookIds: ['a'] } }))]) {
    const f = fixture({ fetchOverride: call => call.method === 'GET' ? response : undefined });
    assert.ok(['blocked', 'error'].includes((await f.tap()).status));
    assert.equal(f.commands().length, 0);
  }
});

test('network failure and HTTP conflict do not retry; a later fresh press can recover', async () => {
  for (const method of ['GET', 'POST']) {
    let fail = true;
    const f = fixture({ fetchOverride: call => {
      if (fail && call.method === method) {
        fail = false;
        if (method === 'GET') throw new Error('private response data must not reach logs');
        return json({ message: 'private response data must not reach logs' }, 409);
      }
    } });
    assert.equal((await f.tap()).status, 'error');
    assert.equal(f.calls.filter(call => call.method === method).length, 1);
    assert.equal((await f.tap()).status, 'accepted');
    assert.ok(!JSON.stringify(f.events).includes('private response'));
  }
});

test('slow reads expire the original press without posting or replaying it', async () => {
  let time = clock;
  const f = fixture({ now: () => time, fetchOverride: call => { if (call.method === 'GET') time += 1_501; } });
  assert.equal((await f.tap()).reason, 'expired_press');
  assert.equal(f.commands().length, 0);
});

test('request timeout releases pending and a fresh press works after recovery', async () => {
  let fail = true;
  const f = fixture({ requestTimeoutMs: 5, fetchOverride: call => {
    if (!fail) return;
    fail = false;
    return new Promise((_, reject) => call.init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  assert.equal((await f.tap()).reason, 'timeout');
  assert.equal(f.commands().length, 0);
  assert.equal((await f.tap()).status, 'accepted');
});

test('disconnect fences an unfinished read even if fetch ignores its aborted signal', async () => {
  const gate = deferred(); let firstRead = true;
  const f = fixture({ fetchOverride: async call => {
    if (call.method === 'GET' && firstRead) { firstRead = false; await gate.promise; }
  } });
  const pending = f.key('pen-1', 78);
  await f.router.handle({ type: 'disconnected', bindingId: 'pen-1' });
  gate.resolve();
  assert.equal((await pending).reason, 'cancelled');
  assert.equal(f.commands().length, 0);
  assert.equal((await f.tap()).status, 'accepted');
});

test('disconnect/reconnect cannot let an old completion clear a newer pending request', async () => {
  const gates = [deferred(), deferred()]; let count = 0;
  const f = fixture({ fetchOverride: async call => {
    if (call.method === 'GET') { const gate = gates[count++]; if (gate) await gate.promise; }
  } });
  const old = f.key('pen-1', 78);
  f.router.release('pen-1');
  const fresh = f.key('pen-1', 78);
  gates[0].resolve(); await old;
  assert.equal((await f.key('pen-1', 75)).reason, 'busy');
  gates[1].resolve(); await fresh;
  assert.equal(f.commands().length, 1);
});

test('releaseAll clears held keys and ignores unknown bindings and unsupported input', async () => {
  const f = fixture();
  for (const event of [null, {}, { type: 'key', bindingId: 'unknown', usage: 78, value: 1 },
    { type: 'key', bindingId: 'pen-1', usage: 78, value: 2 },
    { type: 'key', bindingId: 'pen-1', usage: 78, value: 1, usagePage: 12 },
    { type: 'key', bindingId: 'pen-1', usage: 40, value: 1 }]) await f.router.handle(event);
  assert.equal(f.calls.length, 0);
  await f.key('pen-1', 78); await f.key('pen-2', 78);
  f.router.releaseAll();
  await f.key('pen-1', 78); await f.key('pen-2', 78);
  assert.equal(f.commands().length, 4);
});

test('unconfirmed command responses are reported without sending another command', async () => {
  const f = fixture({ fetchOverride: call => call.method === 'POST' ? json(standby()) : undefined });
  assert.equal((await f.tap()).reason, 'unconfirmed_command');
  assert.equal(f.commands().length, 1);
});

test('invalid or ambiguous physical bindings fail before accepting input', () => {
  for (const bad of [null, {}, { ...config, apiBaseUrl: 'https://example.com' },
    { ...config, apiBaseUrl: config.apiBaseUrl + '?secret=value' },
    { ...config, bindings: [config.bindings[0], config.bindings[0]] },
    { ...config, bindings: [config.bindings[0], { ...config.bindings[1], locationId: config.bindings[0].locationId }] },
    { ...config, bindings: [config.bindings[0], { ...config.bindings[1], mirrorId: 'default' }] },
    { ...config, bindings: [{ ...config.bindings[0], locationId: 0 }] },
    { ...config, bindings: [{ ...config.bindings[0], id: 1 }] },
    { ...config, bindings: [{ ...config.bindings[0], locationId: undefined }] },
    { ...config, bindings: [{ ...config.bindings[0], locationId: undefined, serialNumber: '  ' }] },
    { ...config, bindings: [{ ...config.bindings[0], mirrorId: '../other' }] }]) {
    assert.throws(() => createPresenterRouter(bad));
  }
  assert.deepEqual(validatePresenterConfig(config), config);
});

test('serial-only and combined selectors preserve native matching and reject overlapping receivers', () => {
  const serialConfig = { ...config, bindings: config.bindings.map((binding, index) => {
    const { locationId: _location, ...rest } = binding;
    return { ...rest, productId: 0, serialNumber: `receiver-${index}` };
  }) };
  assert.deepEqual(validatePresenterConfig(serialConfig), serialConfig);
  const first = serialConfig.bindings[0];
  assert.throws(() => validatePresenterConfig({ ...config, bindings: [first,
    { ...serialConfig.bindings[1], serialNumber: first.serialNumber }] }));
  // One selector has only a location, the other only a serial: they could be the same receiver.
  assert.throws(() => validatePresenterConfig({ ...config, bindings: [config.bindings[0],
    { ...serialConfig.bindings[1], productId: config.bindings[0].productId }] }));
  const both = { ...config.bindings[0], serialNumber: 'receiver-1' };
  assert.deepEqual(validatePresenterConfig({ ...config, bindings: [both] }).bindings[0], both);
  // Different locations OR different serials prove the two matching predicates cannot overlap.
  assert.doesNotThrow(() => validatePresenterConfig({ ...config, bindings: [both,
    { ...config.bindings[1], locationId: both.locationId, serialNumber: 'receiver-2' }] }));
  assert.doesNotThrow(() => validatePresenterConfig({ ...config, bindings: [both,
    { ...config.bindings[1], serialNumber: both.serialNumber }] }));
});

const linuxConfig = { apiBaseUrl: 'http://xuxin.local:10101/v1.1/api/exhibition', bindings: config.bindings.map((binding, index) => ({
  id: binding.id, mirrorId: binding.mirrorId, vendorId: binding.vendorId, productId: binding.productId,
  linuxDevicePath: `/dev/input/by-path/pci-0000:00:14.0-usb-0:${index + 1}:1.0-event-kbd`,
  phys: `usb-0000:00:14.0-${index + 1}/input0`,
})) };

test('Linux receivers preserve stable identity and route independently to the Ubuntu mirrors', async () => {
  assert.deepEqual(validatePresenterConfig(linuxConfig), linuxConfig);
  const f = fixture({ routerConfig: linuxConfig });
  await Promise.all([f.tap('pen-1', 82), f.tap('pen-2', 81)]);
  assert.deepEqual(f.commands().map(call => [call.mirrorId, call.body.lookId]), [['default', 'c'], ['mirror-second', 'b']]);
  assert.ok(f.commands().every(call => call.init.headers.Origin === 'http://xuxin.local:10101'));
  const alias = { ...linuxConfig.bindings[0], byPath: linuxConfig.bindings[0].linuxDevicePath };
  delete alias.linuxDevicePath;
  assert.deepEqual(validatePresenterConfig({ ...linuxConfig, bindings: [alias] }).bindings[0], linuxConfig.bindings[0]);
});

test('Linux ambiguous selectors and unstable event numbers without physical identity are rejected', () => {
  const [first, second] = linuxConfig.bindings;
  for (const bindings of [
    [first, { ...second, linuxDevicePath: first.linuxDevicePath }],
    [first, { ...second, phys: first.phys }],
    [{ ...first, uniq: 'same' }, { ...second, uniq: 'same' }],
    [{ ...first, linuxDevicePath: '/dev/input/event8', phys: undefined }],
    [{ ...first, linuxDevicePath: '/dev/input/by-path/..' }],
    [{ ...first, linuxDevicePath: '/dev/input/by-path/../event8' }],
    [{ ...first, linuxDevicePath: '/dev/input/by-id/x\0' }],
    [{ ...first, phys: '' }], [{ ...first, uniq: 5 }],
    [{ ...first, byPath: '/dev/input/by-path/different' }],
    [{ ...first, locationId: 123 }], [first, config.bindings[1]],
  ]) assert.throws(() => validatePresenterConfig({ ...linuxConfig, bindings }));
  assert.doesNotThrow(() => validatePresenterConfig({ ...linuxConfig,
    bindings: [{ ...first, linuxDevicePath: '/dev/input/event8' }] }));
});
