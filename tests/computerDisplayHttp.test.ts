import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerDisplayBroker } from '../server/computerDisplay.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { createApiServer } from '../server/http.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { ComputerDisplayHostSession } from '../shared/computerDisplay.ts';

const origin = 'https://xuxin.local:10202';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'computer-display-test-'));
  const store = new SessionStore(':memory:');
  const unavailable = vi.fn(async () => { throw new Error('No supplier/network generation is permitted'); });
  const service = new TryOnService({ store, secrets: new SecretBox(randomBytes(32)), catalog: async () => [],
    provider: { configured: true, issueKey: unavailable, keyStatus: unavailable, deactivate: unavailable, sessionStatus: unavailable } });
  const mirrors = new ExhibitionMirrors(directory);
  const broker = new ComputerDisplayBroker({ binding: id => mirrors.devices.binding(id) });
  const server = createApiServer(service, [origin], undefined, mirrors, undefined, broker);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const postTo = (mirrorId: string, path: string, input: unknown, headers: Record<string, string> = {}, method = 'POST') => fetch(`${base}/api/exhibition/mirrors/${encodeURIComponent(mirrorId)}${path}`, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  const post = (path: string, input: unknown, headers: Record<string, string> = {}, method = 'POST') => postTo('default', path, input, headers, method);
  const terminal = { terminalId: `terminal-${randomUUID()}`, token: randomBytes(32).toString('hex'), label: 'isolated receiver', platform: 'android' as const };
  const pair = mirrors.connectDevice(terminal);
  mirrors.bindDevice('default', { code: pair.code });
  const receiver = { terminalId: terminal.terminalId, terminalToken: terminal.token, receiverId: randomUUID(), after: 0 };
  const devicesBefore = readFileSync(join(directory, 'exhibition-devices.json'), 'utf8');
  const open = async (output?: 'android' | 'browser') => {
    const response = await post('/display/host/open', { deviceId: 'computer-one', ...(output ? { output } : {}) });
    expect(response.status).toBe(200);
    return await response.json() as ComputerDisplayHostSession;
  };
  cleanup.push(async () => {
    expect(unavailable).not.toHaveBeenCalled();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await mirrors.browserTests.destroy(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { directory, devicesBefore, service, mirrors, broker, post, postTo, terminal, receiver, open };
}

describe('computer display HTTP authentication', () => {
  it('permits explicit idle takeover without changing bindings and rejects cross-origin takeover', async () => {
    const f = await fixture(); const old = await f.open();
    const input = { deviceId: 'computer-two', replaceHost: true };
    expect((await f.post('/display/host/open', input, { Origin: 'https://untrusted.invalid' })).status).toBe(403);
    expect((await f.post('/display/host/poll', { ...old, after: 0 })).status).toBe(200);
    const response = await f.post('/display/host/open', input); expect(response.status).toBe(200);
    const next = await response.json();
    expect((await f.post('/display/host/close', old)).status).toBe(403);
    expect((await f.post('/display/host/poll', { ...next, after: 0 })).status).toBe(200);
    expect(readFileSync(join(f.directory, 'exhibition-devices.json'), 'utf8')).toBe(f.devicesBefore);
  });

  it('keeps the old host when takeover is blocked by an active experience or camera', async () => {
    const f = await fixture(); const old = await f.open(); const current = f.mirrors.getMirror();
    const original = current.read(); const read = vi.spyOn(current, 'read');
    for (const patch of [{ phase: 'generating' }, { live: { deviceId: 'computer-one' } },
      { lifecycle: { state: 'paused' } }, { lifecycle: { connection: 'stopping' } }]) {
      read.mockReturnValue({ ...original, ...patch } as typeof original);
      const response = await f.post('/display/host/open', { deviceId: 'computer-two', replaceHost: true });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('DISPLAY_MIRROR_BUSY');
      expect((await f.post('/display/host/poll', { ...old, after: 0 })).status).toBe(200);
    }
    read.mockRestore();
    vi.spyOn(f.mirrors.devices, 'assertCameraClosed').mockImplementation(() => { throw new Error('Camera is active'); });
    expect((await f.post('/display/host/open', { deviceId: 'computer-two', replaceHost: true })).status).not.toBe(200);
    expect((await f.post('/display/host/poll', { ...old, after: 0 })).status).toBe(200);
  });

  it('returns rendered confirmation only for the authorized receiver and current active page batch', async () => {
    const f = await fixture(); const host = await f.open();
    await f.post('/display/receiver/poll', { ...f.receiver, capabilities: ['page'] });
    await f.post('/display/host/signal', { ...host, kind: 'offer', payload: { epoch: 1, type: 'offer', sdp: 'v=0' } });
    const identity = { ...f.receiver, sessionId: host.sessionId };
    await f.post('/display/receiver/signal', { ...identity, kind: 'answer', payload: { epoch: 1, type: 'answer', sdp: 'v=0' } });
    await f.post('/display/host/signal', { ...host, kind: 'presentation', payload: { epoch: 1, source: 'page', active: true, mirrored: false, presentationId: 7 } });
    const confirmation = { ...identity, kind: 'rendered', payload: { epoch: 1, presentationId: 7 } };
    expect((await f.post('/display/receiver/signal', { ...confirmation, terminalToken: 'invalid' })).status).toBe(403);
    expect((await f.post('/display/receiver/signal', confirmation)).status).toBe(200);
    const legacy = await f.post('/display/host/poll', { ...host, after: 0 });
    expect((await legacy.json()).messages.filter((message: { kind: string }) => message.kind === 'rendered')).toEqual([]);
    await f.post('/display/receiver/poll', { ...f.receiver, capabilities: ['page', 'page-rendered'] });
    expect((await f.post('/display/receiver/signal', { ...confirmation, payload: { epoch: 1, presentationId: 6 } })).status).toBe(200);
    expect((await f.post('/display/receiver/signal', confirmation)).status).toBe(200);
    const response = await f.post('/display/host/poll', { ...host, after: 0 });
    expect((await response.json()).messages.filter((message: { kind: string }) => message.kind === 'rendered')).toEqual([
      expect.objectContaining({ kind: 'rendered', payload: { epoch: 1, presentationId: 7 } }),
    ]);
  });

  it('negotiates full-page capability and relays explicit capture stop through existing authenticated endpoints', async () => {
    const f = await fixture(); const host = await f.open();
    const ready = await f.post('/display/receiver/poll', { ...f.receiver, capabilities: ['page'] });
    expect(ready.status).toBe(200);
    const polled = await f.post('/display/host/poll', { ...host, after: 0 });
    expect(await polled.json()).toMatchObject({ receiverOnline: true, receiverCapabilities: ['page'] });
    await f.post('/display/host/signal', { ...host, kind: 'offer', payload: { epoch: 1, type: 'offer', sdp: 'v=0' } });
    for (const active of [true, false]) expect((await f.post('/display/host/signal', {
      ...host, kind: 'presentation', payload: { epoch: 1, source: 'page', mirrored: false, active, presentationId: active ? 1 : 2 },
    })).status).toBe(200);
    const incoming = await f.post('/display/receiver/poll', { ...f.receiver, sessionId: host.sessionId, capabilities: ['page'] });
    expect(await incoming.json()).toMatchObject({ messages: [
      { kind: 'offer' },
      { kind: 'presentation', payload: { source: 'page', mirrored: false, rotation: 0, active: true } },
      { kind: 'presentation', payload: { source: 'page', mirrored: false, rotation: 0, active: false } },
    ] });
    expect(readFileSync(join(f.directory, 'exhibition-devices.json'), 'utf8')).toBe(f.devicesBefore);
  });

  it('exchanges only signaling with the bound receiver and leaves durable device identities unchanged', async () => {
    const f = await fixture(); const host = await f.open();
    const ready = await f.post('/display/receiver/poll', f.receiver);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ session: { id: host.sessionId, deviceId: 'computer-one' }, messages: [] });
    const polled = await f.post('/display/host/poll', { ...host, after: 0 });
    expect(await polled.json()).toMatchObject({ receiverOnline: true, messages: [{ kind: 'ready', payload: { epoch: 0 } }] });
    const sdp = 'v=0\r\ns=private-local-sdp';
    expect((await f.post('/display/host/signal', { ...host, kind: 'offer', payload: { epoch: 1, type: 'offer', sdp } })).status).toBe(200);
    const incoming = await f.post('/display/receiver/poll', { ...f.receiver, sessionId: host.sessionId });
    const content = await incoming.text(); expect(content).toContain('private-local-sdp'); expect(content).not.toContain(host.token); expect(content).not.toContain(f.terminal.token);
    expect(readFileSync(join(f.directory, 'exhibition-devices.json'), 'utf8')).toBe(f.devicesBefore);
    expect((await f.post('/display/host/open', { deviceId: 'computer-two' })).status).toBe(409);
  });

  it('never returns SDP or tokens to missing/wrong terminal credentials, host token, or origin', async () => {
    const f = await fixture(); const host = await f.open();
    await f.post('/display/receiver/poll', f.receiver);
    await f.post('/display/host/signal', { ...host, kind: 'offer', payload: { epoch: 1, type: 'offer', sdp: 'private-sdp' } });
    for (const input of [{ after: 0 }, { ...f.receiver, terminalToken: 'bad' }, { ...f.receiver, terminalId: `terminal-${randomUUID()}` },
      { ...f.receiver, terminalId: host.terminalId, terminalToken: host.token }]) {
      const response = await f.post('/display/receiver/poll', input);
      expect(response.status).toBe(403); expect(await response.text()).not.toContain('private-sdp');
    }
    expect((await f.post('/display/host/poll', { ...host, token: '0'.repeat(64), after: 0 })).status).toBe(403);
    expect((await f.post('/display/host/poll', { ...host, after: 0 }, { Origin: 'https://untrusted.invalid' })).status).toBe(403);
    expect((await f.post('/display/host/signal', { ...host, kind: 'offer', payload: { epoch: 2, type: 'offer', sdp: 'x'.repeat(100_000) } })).status).toBe(413);
  });

  it('relays rotation metadata with a legacy 0° default and rejects invalid JSON angles', async () => {
    const f = await fixture(); const host = await f.open();
    await f.post('/display/receiver/poll', f.receiver);
    await f.post('/display/host/signal', { ...host, kind: 'offer', payload: { epoch: 1, type: 'offer', sdp: 'v=0' } });
    const presentation = { epoch: 1, mirrored: true, source: 'camera' };
    for (const payload of [{ ...presentation, rotation: 270 }, presentation]) {
      expect((await f.post('/display/host/signal', { ...host, kind: 'presentation', payload })).status).toBe(200);
    }
    for (const rotation of [null, '270', 360]) {
      const invalid = await f.post('/display/host/signal', { ...host, kind: 'presentation', payload: { ...presentation, rotation } });
      expect(invalid.status).toBe(400);
    }
    const incoming = await f.post('/display/receiver/poll', { ...f.receiver, sessionId: host.sessionId });
    expect(await incoming.json()).toMatchObject({ messages: [
      { kind: 'offer' },
      { kind: 'presentation', payload: { ...presentation, rotation: 270 } },
      { kind: 'presentation', payload: { ...presentation, rotation: 0 } },
    ] });
  });

  it('invalidates immediately on unbind even when the same physical terminal is rebound in the same clock tick', async () => {
    const f = await fixture(); const host = await f.open();
    expect((await f.post('/binding', { terminalId: f.terminal.terminalId }, {}, 'DELETE')).status).toBe(200);
    expect((await f.post('/display/receiver/poll', f.receiver)).status).toBe(403);
    const pair = f.mirrors.connectDevice(f.terminal); f.mirrors.bindDevice('default', { code: pair.code });
    expect((await f.post('/display/host/poll', { ...host, after: 0 })).status).toBe(403);
    expect((await f.post('/display/receiver/poll', f.receiver)).status).toBe(200);
    const next = await f.open(); expect(next.sessionId).not.toBe(host.sessionId);
  });

  it('refuses computer takeover while a real mirror experience is active', async () => {
    const f = await fixture(); const current = f.mirrors.getMirror();
    const original = current.read();
    vi.spyOn(current, 'read').mockReturnValue({ ...original, phase: 'generating' });
    expect((await f.post('/display/host/open', { deviceId: 'computer-one' })).status).toBe(409);
    expect(f.broker.hasHost('default')).toBe(false);
  });

  it.each(['android', 'browser'] as const)('accepts %s desktop live credentials only for the granted device and revokes late allocations after close', async output => {
    const f = await fixture(); const host = await f.open(output); const current = f.mirrors.getMirror();
    const liveId = randomUUID();
    let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void; const finishPromise = new Promise<void>(resolve => { finish = resolve; });
    let cancelled: (() => boolean) | undefined;
    const create = vi.spyOn(current, 'createLiveSession').mockImplementation(async (_input, hooks) => {
      cancelled = hooks?.cancelled; entered(); await finishPromise;
      return { id: liveId } as Awaited<ReturnType<typeof current.createLiveSession>>;
    });
    const stop = vi.spyOn(f.service, 'stop').mockResolvedValue({} as Awaited<ReturnType<typeof f.service.stop>>);
    vi.spyOn(current, 'reconcileLive').mockResolvedValue(undefined);
    const headers = { 'X-Miror-Material': 'catalog-v2', 'X-Miror-Protocol': '2' };
    const input = { deviceId: 'computer-one', terminalId: host.terminalId, terminalToken: host.token };
    expect((await f.post('/live/session', { ...input, deviceId: 'computer-two' }, headers)).status).toBe(403);
    expect((await f.post('/live/session', { deviceId: 'computer-one', ...f.receiver }, headers)).status).toBe(409);
    expect(create).not.toHaveBeenCalled();
    const pending = f.post('/live/session', input, headers); await enteredPromise;
    expect(cancelled?.()).toBe(false);
    expect((await f.post('/display/host/close', host)).status).toBe(200);
    expect(cancelled?.()).toBe(true); finish();
    const response = await pending; expect(response.status).toBe(403);
    expect(stop).toHaveBeenCalledWith(liveId);
    expect((await f.post('/live/session', input, headers)).status).toBe(403);
  });

  it('opens bound and unbound browser mirrors concurrently without exposing either to Android receivers', async () => {
    const f = await fixture();
    const second = f.mirrors.create({ name: '第二路摄像头' });
    const host = await f.open('browser');
    const opened = await f.postTo(second.id, '/display/host/open', { deviceId: 'computer-two', output: 'browser' });
    expect(opened.status).toBe(200);
    const other = await opened.json() as ComputerDisplayHostSession;
    for (const [id, session] of [['default', host], [second.id, other]] as const) {
      const polled = await f.postTo(id, '/display/host/poll', { ...session, after: 0 });
      expect(polled.status).toBe(200);
      expect(await polled.json()).toEqual({ messages: [], receiverOnline: true, epoch: 0, cursor: 0 });
      expect((await f.postTo(id, '/display/host/open', { deviceId: 'computer-three', output: 'browser' })).status).toBe(409);
    }
    const receiver = await f.post('/display/receiver/poll', f.receiver);
    expect(receiver.status).toBe(200);
    expect(await receiver.json()).toEqual({ session: null, messages: [], epoch: 0, cursor: 0 });
    expect((await f.post('/display/host/signal', { ...host, kind: 'offer', payload: { epoch: 1, type: 'offer', sdp: 'v=0' } })).status).toBe(400);
    expect((await f.post('/display/receiver/signal', { ...f.receiver, sessionId: host.sessionId, kind: 'ready', payload: { epoch: 0 } })).status).toBe(403);
    expect((await f.postTo(second.id, '/display/host/poll', { ...host, after: 0 })).status).toBe(403);
    const headers = { 'X-Miror-Material': 'catalog-v2', 'X-Miror-Protocol': '2' };
    expect((await f.postTo(second.id, '/live/session', { deviceId: 'computer-one', terminalId: host.terminalId, terminalToken: host.token }, headers)).status).toBe(403);
    expect((await f.postTo(second.id, '/live/session', { deviceId: 'computer-three' }, headers)).status).toBe(409);
    const sources = [['default', host, 'computer-one'], [second.id, other, 'computer-two']] as const;
    const create = sources.map(([id]) => {
      const current = f.mirrors.getMirror(id);
      return vi.spyOn(current, 'createLiveSession').mockResolvedValue({ id: randomUUID() } as Awaited<ReturnType<typeof current.createLiveSession>>);
    });
    const started = await Promise.all(sources.map(([id, session, deviceId]) => f.postTo(id, '/live/session', {
      deviceId, terminalId: session.terminalId, terminalToken: session.token,
    }, headers)));
    expect(started.map(response => response.status)).toEqual([201, 201]);
    sources.forEach(([, session, deviceId], index) => expect(create[index]).toHaveBeenCalledExactlyOnceWith({
      deviceId, terminalId: session.terminalId, terminalToken: session.token,
    }, { cancelled: expect.any(Function) }));
    expect(readFileSync(join(f.directory, 'exhibition-devices.json'), 'utf8')).toBe(f.devicesBefore);
  });

  it('validates the output before granting ownership and keeps omitted output bound to Android', async () => {
    const f = await fixture();
    for (const output of [null, '', 'screen', true, {}]) {
      expect((await f.post('/display/host/open', { deviceId: 'computer-one', output })).status).toBe(400);
      expect(f.broker.hasHost('default')).toBe(false);
    }
    const second = f.mirrors.create({ name: '未绑定摄像头' });
    expect((await f.postTo(second.id, '/display/host/open', { deviceId: 'computer-two' })).status).toBe(409);
    expect((await f.postTo(second.id, '/display/host/open', { deviceId: 'computer-two', output: 'browser' })).status).toBe(200);
  });

  it('revokes browser credentials when a bound Android receiver is unbound', async () => {
    const f = await fixture(); const host = await f.open('browser');
    expect((await f.post('/binding', { terminalId: f.terminal.terminalId }, {}, 'DELETE')).status).toBe(200);
    expect((await f.post('/display/host/poll', { ...host, after: 0 })).status).toBe(403);
    const next = await f.open('browser');
    expect(next.sessionId).not.toBe(host.sessionId);
    expect((await f.post('/display/receiver/poll', f.receiver)).status).toBe(403);
  });
});
