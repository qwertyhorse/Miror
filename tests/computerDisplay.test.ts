import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ComputerDisplayBroker } from '../server/computerDisplay.ts';
import { COMPUTER_DISPLAY_TTL_MS, type ComputerDisplayOutput } from '../shared/computerDisplay.ts';

function fixture(maxSessions = 32, output: ComputerDisplayOutput = 'android', bound = true) {
  let now = 1_000;
  const bindings = new Map([['mirror', { terminalId: 'terminal-one', boundAt: 100 }]]);
  const broker = new ComputerDisplayBroker({ binding: id => bindings.get(id) ?? null, now: () => now, maxSessions });
  if (!bound) bindings.clear();
  const host = broker.open('mirror', 'computer-one', output);
  const receiverId = randomUUID();
  const poll = (after = 0, id = receiverId) => broker.receiverPoll('mirror', 'terminal-one', { receiverId: id, sessionId: host.sessionId, after });
  const send = (kind: string, payload: unknown) => broker.hostSignal('mirror', { ...host, kind, payload });
  const answer = (epoch = 1, id = receiverId) => broker.receiverSignal('mirror', 'terminal-one', {
    sessionId: host.sessionId, receiverId: id, kind: 'answer', payload: { epoch, type: 'answer', sdp: 'v=0\r\nanswer' },
  });
  return { broker, bindings, host, receiverId, poll, send, answer, setTime: (time: number) => { now = time; } };
}
const offer = (epoch: number) => ({ epoch, type: 'offer', sdp: 'v=0\r\noffer' });
const candidate = (epoch: number) => ({ epoch, candidate: 'candidate:1 1 UDP 1 192.168.1.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 });

describe('computer display capability and mailboxes', () => {
  it('replaces only on explicit request and fences all old host credentials, including late close', () => {
    const f = fixture(1); f.poll(); f.send('offer', offer(1));
    expect(() => f.broker.open('mirror', 'computer-two')).toThrow('已有电脑连接');
    for (const replace of [null, 'true', 1, {}])
      expect(() => f.broker.open('mirror', 'computer-two', 'android', replace)).toThrow('请求无效');
    expect(() => f.broker.open('mirror', '', 'android', true)).toThrow('请求无效');
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).receiverOnline).toBe(true);
    const next = f.broker.open('mirror', 'computer-two', 'android', true);
    expect(next.sessionId).not.toBe(f.host.sessionId);
    expect(() => f.broker.hostPoll('mirror', { ...f.host, after: 0 })).toThrow('身份无效');
    expect(() => f.send('reset', { epoch: 1 })).toThrow('身份无效');
    expect(() => f.broker.hostClose('mirror', f.host)).toThrow('身份无效');
    expect(() => f.broker.assertDesktopOwner('mirror', { terminalId: f.host.terminalId, terminalToken: f.host.token, deviceId: 'computer-one' })).toThrow('身份无效');
    expect(f.poll(999)).toMatchObject({ session: { id: next.sessionId, deviceId: 'computer-two' }, epoch: 0, messages: [] });
    expect(f.broker.hostPoll('mirror', { ...next, after: 0 })).toMatchObject({ receiverOnline: true, messages: [{ kind: 'ready' }] });
  });

  it('reports page support only for the current online receiver and keeps legacy polls compatible', () => {
    const f = fixture();
    const poll = (capabilities?: unknown, receiverId = f.receiverId) => f.broker.receiverPoll('mirror', 'terminal-one', {
      receiverId, sessionId: f.host.sessionId, after: 0, ...(capabilities === undefined ? {} : { capabilities }),
    });
    poll(); expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).receiverCapabilities).toBeUndefined();
    poll(['page', 'future-feature']);
    const host = f.broker.hostPoll('mirror', { ...f.host, after: 0 }); expect(host.receiverCapabilities).toEqual(['page']);
    host.receiverCapabilities?.pop(); expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).receiverCapabilities).toEqual(['page']);
    poll(['page-rendered', 'page', 'page', 'future-feature']);
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).receiverCapabilities).toEqual(['page', 'page-rendered']);
    for (const capabilities of [null, true, 'page', {}, [false], Array(17).fill('page'), ['x'.repeat(65)]])
      expect(() => poll(capabilities)).toThrow('请求无效');
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).receiverCapabilities).toEqual(['page', 'page-rendered']);
    poll(undefined, randomUUID());
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).receiverCapabilities).toBeUndefined();
    const currentId = randomUUID(); poll(['page'], currentId); f.setTime(20_000);
    f.broker.hostPoll('mirror', { ...f.host, after: 0 }); f.setTime(21_000);
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 })).toMatchObject({ receiverOnline: false });
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).receiverCapabilities).toBeUndefined();
  });

  it('relays page start and stop only to an upgraded receiver and rejects invalid page transforms', () => {
    const f = fixture(); f.poll(); f.send('offer', offer(1));
    const presentation = { epoch: 1, mirrored: false, source: 'page', active: true, presentationId: 1 };
    expect(() => f.send('presentation', presentation)).toThrow('更新安卓 App');
    f.broker.receiverPoll('mirror', 'terminal-one', { receiverId: f.receiverId, sessionId: f.host.sessionId, after: 0, capabilities: ['page'] });
    f.send('presentation', presentation); f.send('presentation', { ...presentation, active: false, presentationId: 2 });
    expect(f.poll().messages.slice(-2)).toMatchObject([
      { kind: 'presentation', payload: { ...presentation, rotation: 0 } },
      { kind: 'presentation', payload: { ...presentation, active: false, rotation: 0, presentationId: 2 } },
    ]);
    for (const invalid of [{ ...presentation, active: undefined }, { ...presentation, active: 'true' },
      { ...presentation, mirrored: true }, { ...presentation, rotation: 90 }, { ...presentation, source: 'camera' }])
      expect(() => f.send('presentation', invalid)).toThrow('请求无效');
  });

  it('authenticates and fences rendered acknowledgements by receiver, epoch and active presentation batch', () => {
    const f = fixture();
    const poll = (capabilities = ['page', 'page-rendered']) => f.broker.receiverPoll('mirror', 'terminal-one', { receiverId: f.receiverId, sessionId: f.host.sessionId, after: 0, capabilities });
    const rendered = (epoch: number, presentationId: unknown, extra: object = {}) => f.broker.receiverSignal('mirror', 'terminal-one', {
      sessionId: f.host.sessionId, receiverId: f.receiverId, kind: 'rendered', payload: { epoch, presentationId }, ...extra,
    });
    poll(['page']); f.send('offer', offer(1)); f.answer();
    f.send('presentation', { epoch: 1, mirrored: false, source: 'page', active: true, presentationId: 0 });
    rendered(1, 0);
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).messages.filter(m => m.kind === 'rendered')).toEqual([]);
    poll();
    rendered(0, 0); rendered(1, 7);
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).messages.filter(m => m.kind === 'rendered')).toEqual([]);
    rendered(1, 0); rendered(1, 0);
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).messages.filter(m => m.kind === 'rendered')).toEqual([
      expect.objectContaining({ kind: 'rendered', payload: { epoch: 1, presentationId: 0 } }),
    ]);
    expect(() => f.send('rendered', { epoch: 1, presentationId: 0 })).toThrow('请求无效');
    expect(() => rendered(1, 0, { receiverId: randomUUID() })).toThrow('身份无效');
    expect(() => rendered(1, 0, { sessionId: randomUUID() })).toThrow('失效');
    for (const presentationId of [undefined, null, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => rendered(1, presentationId)).toThrow('请求无效');
      expect(() => f.send('presentation', { epoch: 1, mirrored: false, source: 'page', active: true, presentationId })).toThrow('请求无效');
    }
    f.send('presentation', { epoch: 1, mirrored: false, source: 'page', active: false, presentationId: 1 });
    rendered(1, 1); rendered(1, 0);
    const before = f.broker.hostPoll('mirror', { ...f.host, after: 0 });
    expect(before.messages.filter(m => m.kind === 'rendered')).toHaveLength(1);
    f.send('offer', offer(2)); f.answer(2); rendered(1, 0);
    expect(f.broker.hostPoll('mirror', { ...f.host, after: before.cursor }).messages.filter(m => m.kind === 'rendered')).toEqual([]);
    f.send('presentation', { epoch: 2, mirrored: false, source: 'page', active: true, presentationId: 2 }); rendered(2, 2);
    expect(f.broker.hostPoll('mirror', { ...f.host, after: before.cursor }).messages.at(-1)).toMatchObject({ kind: 'rendered', payload: { epoch: 2, presentationId: 2 } });
  });

  it('requires a binding and keeps one non-stealable host with bounded global capacity', () => {
    const f = fixture(1);
    expect(f.host.terminalId).toBe(`desktop-${f.host.sessionId}`);
    expect(() => f.broker.open('mirror', 'computer-two')).toThrow('已有电脑');
    f.bindings.set('other', { terminalId: 'terminal-two', boundAt: 100 });
    expect(() => f.broker.open('other', 'computer-two')).toThrow('已满');
    expect(() => f.broker.hostClose('mirror', { ...f.host, token: '0'.repeat(64) })).toThrow('身份无效');
    f.broker.hostClose('mirror', f.host);
    expect(() => f.broker.open('missing', 'computer-two')).toThrow('先绑定');
    expect(f.broker.open('other', 'computer-two').sessionId).not.toBe(f.host.sessionId);
  });

  it('only valid host polls renew the twenty-second lease; receiver traffic cannot keep a lost computer alive', () => {
    const f = fixture();
    f.poll(); f.setTime(20_000);
    f.broker.hostPoll('mirror', { ...f.host, after: 0 });
    f.setTime(39_999); f.poll();
    expect(f.broker.hasHost('mirror')).toBe(true);
    f.setTime(40_000);
    expect(f.poll().session).toBeNull();
    expect(() => f.broker.hostPoll('mirror', { ...f.host, after: 0 })).toThrow('身份无效');
    const next = f.broker.open('mirror', 'computer-two');
    f.setTime(40_000 + COMPUTER_DISPLAY_TTL_MS);
    expect(() => f.broker.hostSignal('mirror', { ...next, kind: 'reset', payload: { epoch: 0 } })).toThrow('身份无效');
  });

  it('sends ready once, preserves message order, permits retry until acknowledgement, and rejects invalid cursors', () => {
    const f = fixture();
    expect(f.poll()).toMatchObject({ session: { id: f.host.sessionId, deviceId: 'computer-one' }, epoch: 0, cursor: 0 });
    f.poll();
    const first = f.broker.hostPoll('mirror', { ...f.host, after: 0 });
    expect(first.messages).toEqual([{ sequence: 1, kind: 'ready', payload: { epoch: 0 } }]);
    f.send('offer', offer(1)); f.send('candidate', candidate(1));
    const received = f.poll();
    expect(received.messages.map(value => value.kind)).toEqual(['offer', 'candidate']);
    expect(received.messages.map(value => value.sequence)).toEqual([1, 2]);
    received.messages[0].payload.epoch = 999;
    expect(f.poll().messages[0].payload.epoch).toBe(1);
    expect(f.poll(2).messages).toEqual([]);
    expect(() => f.poll(1)).toThrow('顺序');
    expect(() => f.poll(3)).toThrow('顺序');
    f.answer();
    expect(f.broker.hostPoll('mirror', { ...f.host, after: first.cursor }).messages[0].kind).toBe('answer');
    expect(() => f.answer()).toThrow('失效');
  });

  it('fences both old receiver requests and delayed negotiation when a new receiver process joins', () => {
    const f = fixture(); f.poll(); f.send('offer', offer(1)); f.poll(1); f.answer();
    const replacementId = randomUUID();
    const next = f.poll(0, replacementId);
    expect(next).toMatchObject({ epoch: 2, messages: [], cursor: 1 });
    expect(() => f.poll()).toThrow('失效');
    expect(() => f.answer(1)).toThrow('身份无效');
    expect(() => f.send('candidate', candidate(1))).toThrow('失效');
    expect(() => f.send('offer', offer(2))).toThrow('失效');
    const received = f.broker.hostPoll('mirror', { ...f.host, after: 0 });
    expect(received.messages).toEqual([{ sequence: 3, kind: 'ready', payload: { epoch: 2 } }]);
    f.poll(0, replacementId);
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 }).messages).toHaveLength(1);
    f.send('offer', offer(3)); f.answer(3, replacementId);
    expect(f.poll(1, replacementId).messages[0].payload.epoch).toBe(3);
  });

  it('validates direction, epoch and SDP/ICE/presentation shape before queuing', () => {
    const f = fixture(); f.poll();
    expect(() => f.send('candidate', candidate(0))).toThrow('失效');
    expect(() => f.send('answer', { epoch: 0, type: 'answer', sdp: 'v=0' })).toThrow('请求无效');
    expect(() => f.send('offer', { ...offer(1), sdp: 'x'.repeat(65_537) })).toThrow('请求无效');
    f.send('offer', offer(1));
    expect(() => f.send('candidate', { ...candidate(1), token: 'secret' })).toThrow('请求无效');
    expect(() => f.send('candidate', { ...candidate(1), sdpMLineIndex: -1 })).toThrow('请求无效');
    expect(() => f.send('candidate', { ...candidate(1), candidate: 'invalid\nICE' })).toThrow('请求无效');
    expect(() => f.send('presentation', { epoch: 1, mirrored: 'true', source: 'camera' })).toThrow('请求无效');
    f.send('presentation', { epoch: 1, mirrored: true, source: 'camera' });
    expect(f.poll().messages.at(-1)).toMatchObject({ kind: 'presentation', payload: { epoch: 1, mirrored: true, source: 'camera' } });
    expect(() => f.broker.receiverSignal('mirror', 'terminal-one', { sessionId: f.host.sessionId, receiverId: f.receiverId,
      kind: 'presentation', payload: { epoch: 1, mirrored: true, source: 'output' } })).toThrow('请求无效');
    f.send('reset', { epoch: 1 });
    expect(f.poll().messages.map(value => value.kind)).toEqual(['reset']);
    expect(() => f.answer()).toThrow('失效');
    f.send('offer', offer(2));
  });

  it('bounds queued message count and bytes without silently dropping unread candidates', () => {
    const f = fixture(); f.poll(); f.send('offer', offer(1));
    for (let i = 0; i < 127; i++) f.send('candidate', candidate(1));
    expect(() => f.send('candidate', candidate(1))).toThrow('繁忙');
    const all = f.poll(); expect(all.messages).toHaveLength(128);
    f.poll(all.cursor); f.send('candidate', candidate(1));
    f.send('offer', offer(2));
    let accepted = 0;
    for (; accepted < 128; accepted++) {
      try { f.send('candidate', { ...candidate(2), candidate: 'x'.repeat(4_096) }); }
      catch { break; }
    }
    expect(accepted).toBeGreaterThan(1); expect(accepted).toBeLessThan(128);
  });

  it('relays camera-to-output mirror changes in order without carrying camera rotation into output', () => {
    const f = fixture(); f.poll(); f.send('offer', offer(1));
    const negotiated = f.poll(); f.answer();
    f.send('presentation', { epoch: 1, mirrored: true, source: 'camera', rotation: 270 });
    f.send('presentation', { epoch: 1, mirrored: true, source: 'output' });
    f.send('presentation', { epoch: 1, mirrored: false, source: 'output' });

    const received = f.poll(negotiated.cursor);
    expect(received.messages).toEqual([
      { sequence: 2, kind: 'presentation', payload: { epoch: 1, mirrored: true, source: 'camera', rotation: 270 } },
      { sequence: 3, kind: 'presentation', payload: { epoch: 1, mirrored: true, source: 'output', rotation: 0 } },
      { sequence: 4, kind: 'presentation', payload: { epoch: 1, mirrored: false, source: 'output', rotation: 0 } },
    ]);
    expect(f.poll(received.cursor).messages).toEqual([]);
  });

  it('normalizes legacy presentation to 0° and carries valid display rotations only within their epoch', () => {
    const f = fixture(); f.poll(); f.send('offer', offer(1));
    for (const rotation of [undefined, 0, 90, 180, 270]) {
      f.send('presentation', { epoch: 1, mirrored: true, source: 'camera', ...(rotation === undefined ? {} : { rotation }) });
      expect(f.poll().messages.at(-1)).toMatchObject({ kind: 'presentation', payload: { epoch: 1, mirrored: true, source: 'camera', rotation: rotation ?? 0 } });
    }
    f.send('offer', offer(2));
    expect(() => f.send('presentation', { epoch: 1, mirrored: false, source: 'camera', rotation: 270 })).toThrow('失效');
    f.send('presentation', { epoch: 2, mirrored: false, source: 'output' });
    expect(f.poll().messages.map(message => message.kind)).toEqual(['offer', 'presentation']);
    expect(f.poll().messages.at(-1)?.payload).toEqual({ epoch: 2, mirrored: false, source: 'output', rotation: 0 });
  });

  it('rejects invalid presentation rotations without queuing or coercing them', () => {
    const f = fixture(); f.poll(); f.send('offer', offer(1));
    for (const rotation of [null, 45, -90, 360, '90', true, NaN, Infinity, {}, []]) {
      expect(() => f.send('presentation', { epoch: 1, mirrored: false, source: 'camera', rotation })).toThrow('请求无效');
    }
    expect(f.poll().messages.map(message => message.kind)).toEqual(['offer']);
  });

  it('scopes desktop capabilities to device and physical binding, with no secret in receiver responses', () => {
    const f = fixture();
    const credentials = { deviceId: 'computer-one', terminalId: f.host.terminalId, terminalToken: f.host.token };
    expect(f.broker.assertDesktopOwner('mirror', credentials)).toBe(true);
    expect(f.broker.assertDesktopOwner('mirror', { terminalId: 'terminal-one' })).toBe(false);
    expect(() => f.broker.assertDesktopOwner('mirror', { ...credentials, deviceId: 'computer-two' })).toThrow('身份无效');
    expect(() => f.broker.assertDesktopOwner('other', credentials)).toThrow('身份无效');
    expect(JSON.stringify(f.poll())).not.toContain(f.host.token);
    f.bindings.set('mirror', { terminalId: 'terminal-two', boundAt: 100 });
    expect(() => f.broker.assertDesktopOwner('mirror', credentials)).toThrow('身份无效');
    f.bindings.set('mirror', { terminalId: 'terminal-one', boundAt: 100 });
    expect(f.broker.hasHost('mirror')).toBe(false);
    const next = f.broker.open('mirror', 'computer-one');
    f.bindings.set('mirror', { terminalId: 'terminal-one', boundAt: 101 });
    expect(() => f.broker.hostPoll('mirror', { ...next, after: 0 })).toThrow('身份无效');
  });

  it('bounds retired receiver identities instead of forgetting an old peer that could reclaim the session', () => {
    const f = fixture(); f.poll();
    for (let i = 0; i < 32; i++) f.poll(0, randomUUID());
    expect(() => f.poll()).toThrow('失效');
    expect(() => f.poll(0, randomUUID())).toThrow('失效');
    expect(f.broker.hasHost('mirror')).toBe(false);
  });
});

describe('browser display ownership', () => {
  it('keeps two browser mirrors independent with one host per mirror and no receiver negotiation', () => {
    const f = fixture(32, 'browser', false);
    const second = f.broker.open('other', 'computer-one', 'browser');
    for (const [mirrorId, host] of [['mirror', f.host], ['other', second]] as const) {
      expect(f.broker.hostPoll(mirrorId, { ...host, after: 0 })).toEqual({ messages: [], receiverOnline: true, epoch: 0, cursor: 0 });
      expect(f.broker.assertDesktopOwner(mirrorId, { deviceId: 'computer-one', terminalId: host.terminalId, terminalToken: host.token })).toBe(true);
      expect(() => f.broker.open(mirrorId, 'computer-two', 'browser')).toThrow('已有电脑');
    }
    expect(() => f.broker.hostPoll('other', { ...f.host, after: 0 })).toThrow('身份无效');
    expect(() => f.broker.assertDesktopOwner('other', { deviceId: 'computer-one', terminalId: f.host.terminalId, terminalToken: f.host.token })).toThrow('身份无效');
    f.broker.hostClose('mirror', f.host);
    expect(f.broker.hasHost('mirror')).toBe(false);
    expect(f.broker.hasHost('other')).toBe(true);
  });

  it('supports a browser beside an Android display without changing Android signaling', () => {
    const f = fixture();
    const browser = f.broker.open('other', 'computer-two', 'browser');
    expect(f.broker.hostPoll('other', { ...browser, after: 0 })).toMatchObject({ receiverOnline: true, messages: [] });
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 })).toMatchObject({ receiverOnline: false, messages: [] });
    f.poll(); f.send('offer', offer(1));
    expect(f.poll().messages.map(message => message.kind)).toEqual(['offer']);
    expect(f.broker.hostPoll('other', { ...browser, after: 0 })).toMatchObject({ receiverOnline: true, messages: [] });
  });

  it('hides bound browser sessions from Android receivers and rejects every signaling operation', () => {
    const f = fixture(32, 'browser');
    expect(f.poll()).toEqual({ session: null, messages: [], epoch: 0, cursor: 0 });
    for (const [kind, payload] of [
      ['offer', offer(1)], ['candidate', candidate(0)], ['reset', { epoch: 0 }],
      ['presentation', { epoch: 0, mirrored: true, source: 'camera' }],
    ] as const) expect(() => f.send(kind, payload)).toThrow('请求无效');
    expect(() => f.answer(0)).toThrow('身份无效');
    expect(f.broker.hostPoll('mirror', { ...f.host, after: 0 })).toEqual({ messages: [], receiverOnline: true, epoch: 0, cursor: 0 });
    expect(() => f.broker.open('mirror', 'computer-two')).toThrow('已有电脑');
  });

  it('uses the same lease and capacity for browser sessions and never renews an invalid poll', () => {
    const f = fixture(1, 'browser', false);
    expect(() => f.broker.open('other', 'computer-two', 'browser')).toThrow('已满');
    f.setTime(20_000);
    f.broker.hostPoll('mirror', { ...f.host, after: 0 });
    f.setTime(39_999);
    expect(() => f.broker.hostPoll('mirror', { ...f.host, after: 1 })).toThrow('顺序');
    f.setTime(40_000);
    expect(f.broker.hasHost('mirror')).toBe(false);
    expect(() => f.broker.hostPoll('mirror', { ...f.host, after: 0 })).toThrow('身份无效');
    expect(f.broker.open('other', 'computer-two', 'browser').sessionId).not.toBe(f.host.sessionId);
  });

  it.each(['bind', 'unbind', 'replace', 'rebind'] as const)('revokes browser ownership when the captured binding changes: %s', change => {
    const f = fixture(32, 'browser', change !== 'bind');
    if (change === 'unbind') f.bindings.delete('mirror');
    else f.bindings.set('mirror', { terminalId: change === 'replace' ? 'terminal-two' : 'terminal-one', boundAt: change === 'rebind' ? 101 : 100 });
    expect(f.broker.hasHost('mirror')).toBe(false);
    expect(() => f.broker.hostPoll('mirror', { ...f.host, after: 0 })).toThrow('身份无效');
    expect(f.broker.open('mirror', 'computer-two', 'browser').sessionId).not.toBe(f.host.sessionId);
  });

  it('fails closed if an unbound mirror can no longer be resolved', () => {
    let exists = true;
    const broker = new ComputerDisplayBroker({ binding: () => { if (!exists) throw new Error('mirror removed'); return null; } });
    const host = broker.open('mirror', 'computer-one', 'browser');
    exists = false;
    expect(() => broker.hostPoll('mirror', { ...host, after: 0 })).toThrow('身份无效');
    exists = true;
    expect(broker.hasHost('mirror')).toBe(false);
  });

  it.each([null, '', 'Browser', 'screen', true, 1, {}, []].map(output => ({ output })))('rejects unsupported output $output', ({ output }) => {
    const broker = new ComputerDisplayBroker({ binding: () => null });
    expect(() => broker.open('mirror', 'computer-one', output)).toThrow('请求无效');
    expect(broker.hasHost('mirror')).toBe(false);
  });
});
