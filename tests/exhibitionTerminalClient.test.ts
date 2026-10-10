import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalBindingClient, type TerminalDependencies, type TerminalIdentity } from '../src/exhibition/useTerminalBinding';
import { TerminalPairingScreen } from '../src/exhibition/TerminalPairingScreen';

const identity: TerminalIdentity = { terminalId: 'terminal-12345678-1234-4234-8234-123456789abc', token: 'private-device-token-that-must-not-be-rendered', label: '展台镜端', platform: 'android' };
const paired = { terminalId: identity.terminalId, mirrorId: 'mirror-one', mirrorName: '智能镜 1' };
const waiting = { terminalId: identity.terminalId, mirrorId: null, code: '456789', expiresAt: Date.now() + 600000 };
const clients: TerminalBindingClient[] = [];
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup(overrides: Partial<TerminalDependencies> = {}) {
  const deps = { identity: vi.fn(async () => identity), create: vi.fn(() => identity), connect: vi.fn(async () => paired), ...overrides };
  const client = new TerminalBindingClient(deps); clients.push(client); return { client, deps };
}
afterEach(() => { clients.splice(0).forEach(client => client.stop()); vi.useRealTimers(); });

describe('physical terminal binding client', () => {
  it('keeps ordinary browser previews unregistered until explicitly starting pairing', async () => {
    const { client, deps } = setup({ identity: vi.fn(async () => null), connect: vi.fn(async () => waiting) });
    client.start(); await flush();
    expect(client.getSnapshot()).toMatchObject({ ready: true, identity: null, connection: null });
    expect(deps.connect).not.toHaveBeenCalled();
    client.beginPairing(); await flush();
    expect(deps.create).toHaveBeenCalledOnce();
    expect(client.getSnapshot()).toMatchObject({ identity, connected: true, connection: waiting });
    client.beginPairing(); expect(deps.create).toHaveBeenCalledOnce();
  });
  it('recovers the bound mirror using persisted identity and retains the credential only in transport', async () => {
    const { client, deps } = setup(); client.start(); await flush();
    expect(deps.connect).toHaveBeenCalledWith(identity, expect.any(AbortSignal));
    expect(client.getSnapshot()).toMatchObject({ ready: true, connected: true, connection: paired });
  });
  it('does not adopt a late native identity from a stopped page epoch', async () => {
    const delayed = deferred<TerminalIdentity | null>();
    const identify = vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(null);
    const { client, deps } = setup({ identity: identify });
    client.start(); client.stop(); client.start(); await flush(); delayed.resolve(identity); await flush();
    expect(deps.connect).not.toHaveBeenCalled();
    expect(client.getSnapshot().identity).toBeNull();
  });
  it('aborts and ignores a late binding response after a same-client restart', async () => {
    const old = deferred<typeof paired>();
    const connect = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(waiting);
    const { client } = setup({ connect });
    client.start(); await flush();
    const signal = connect.mock.calls[0][1] as AbortSignal;
    client.stop(); expect(signal.aborted).toBe(true);
    client.start(); await flush(); old.resolve(paired); await flush();
    expect(client.getSnapshot().connection).toEqual(waiting);
  });
  it('receives backend unbinding on its next heartbeat and stops exposing the old assignment', async () => {
    vi.useFakeTimers();
    const connect = vi.fn().mockResolvedValueOnce(paired).mockResolvedValueOnce(waiting);
    const { client } = setup({ connect }); client.start(); await flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.getSnapshot()).toMatchObject({ connected: true, connection: { mirrorId: null, code: '456789' } });
  });
  it('rejects a mismatched terminal response and recovers through explicit retry', async () => {
    const connect = vi.fn().mockResolvedValueOnce({ ...paired, terminalId: 'other-terminal' }).mockResolvedValueOnce(paired);
    const { client } = setup({ connect }); client.start(); await flush();
    expect(client.getSnapshot()).toMatchObject({ connected: false, connection: null, error: expect.stringContaining('身份不匹配') });
    await client.retry(); expect(client.getSnapshot()).toMatchObject({ connected: true, connection: paired, error: '' });
  });
  it('fails closed on a heartbeat error and keeps the existing mirror only as recovery information', async () => {
    vi.useFakeTimers();
    const connect = vi.fn().mockResolvedValueOnce(paired).mockRejectedValueOnce(new Error('后台连接中断'));
    const { client } = setup({ connect }); client.start(); await flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.getSnapshot()).toMatchObject({ connected: false, connection: paired, error: '后台连接中断' });
  });
  it('never displays terminal credentials on the pairing screen', () => {
    const html = renderToStaticMarkup(createElement(TerminalPairingScreen, { terminal: { ready: true, identity, connection: waiting, connected: true, error: '', retry: async () => {}, beginPairing: () => {} } }));
    expect(html).toContain('456 789');
    expect(html).not.toContain(identity.token);
    expect(html).not.toContain(identity.terminalId);
  });
});
