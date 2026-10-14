import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalBindingClient, type TerminalDependencies, type TerminalIdentity } from '../src/exhibition/useTerminalBinding';
import { TerminalPairingScreen } from '../src/exhibition/TerminalPairingScreen';
import type { ExhibitionCameraReport, ExhibitionCameraStatus } from '../shared/exhibitionCamera';

const identity: TerminalIdentity = { terminalId: 'terminal-12345678-1234-4234-8234-123456789abc', token: 'private-device-token-that-must-not-be-rendered', label: '展台镜端', platform: 'android' };
const paired = { terminalId: identity.terminalId, mirrorId: 'mirror-one', mirrorName: '智能镜 1' };
const waiting = { terminalId: identity.terminalId, mirrorId: null, code: '4567', expiresAt: Date.now() + 600000 };
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
    expect(client.getSnapshot()).toMatchObject({ connected: true, connection: { mirrorId: null, code: '4567' } });
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
    expect(html).toContain('4567');
    expect(html).not.toContain(identity.token);
    expect(html).not.toContain(identity.terminalId);
  });

  it('advertises browser camera support and keeps reports scoped to the current binding', async () => {
    const browser = { ...identity, platform: 'browser' as const };
    const connect = vi.fn(async () => ({ ...paired, cameraBindingId: 'binding-a' }));
    const { client } = setup({ identity: vi.fn(async () => browser), connect }); client.start(); await flush();
    expect(connect).toHaveBeenCalledWith({ ...browser, cameraCapabilities: { version: 1 } }, expect.any(AbortSignal));
    const report: ExhibitionCameraReport = { mirrorId: paired.mirrorId, bindingId: 'binding-a', requestId: null, status: 'ready', devices: [], selectedDeviceId: null, activeDeviceId: null };
    client.reportCamera({ ...report, mirrorId: 'another-mirror' }); client.reportCamera({ ...report, bindingId: 'expired-binding' });
    expect(connect).toHaveBeenCalledOnce();
    client.reportCamera(report); await flush();
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ cameraReport: report }), expect.any(AbortSignal));
    client.stop(); client.reportCamera(report); expect(connect).toHaveBeenCalledTimes(2);
  });

  it('delivers queued completion before ordinary metadata while a heartbeat is in flight', async () => {
    vi.useFakeTimers();
    const browser = { ...identity, platform: 'browser' as const };
    const heartbeat = deferred<any>(); const closing = deferred<any>();
    const bound = { ...paired, cameraBindingId: 'binding-a' };
    const connect = vi.fn().mockResolvedValueOnce(bound).mockReturnValueOnce(heartbeat.promise).mockReturnValueOnce(closing.promise).mockResolvedValue(bound);
    const { client } = setup({ identity: vi.fn(async () => browser), connect }); client.start(); await flush();
    const report: ExhibitionCameraReport = { mirrorId: paired.mirrorId, bindingId: 'binding-a', requestId: 'request-a', status: 'preview', devices: [], selectedDeviceId: 'usb', activeDeviceId: 'usb' };
    client.reportCamera(report); client.reportCamera({ ...report, status: 'closed' });
    client.reportCamera({ ...report, requestId: null, status: 'ready', activeDeviceId: null });
    heartbeat.resolve({ ...bound, cameraReportAccepted: true }); await flush(); await vi.advanceTimersByTimeAsync(1);
    expect(connect.mock.calls[2][0].cameraReport).toMatchObject({ requestId: 'request-a', status: 'closed' });
    closing.resolve({ ...bound, cameraReportAccepted: true }); await flush(); await vi.advanceTimersByTimeAsync(1);
    expect(connect.mock.calls[3][0].cameraReport).toMatchObject({ requestId: null, status: 'ready' });
  });

  it('opens only the authenticated browser assignment with its current binding epoch', async () => {
    const browser = { ...identity, platform: 'browser' as const };
    const cameraRequest = { id: 'local-entry-request', action: 'open' as const, mirrorId: paired.mirrorId, terminalId: identity.terminalId,
      bindingId: 'binding-a', createdAt: Date.now(), expiresAt: Date.now() + 120000 };
    const openCamera = vi.fn(async () => ({ request: cameraRequest } as ExhibitionCameraStatus));
    const { client } = setup({ identity: vi.fn(async () => browser), connect: vi.fn(async () => ({ ...paired, cameraBindingId: 'binding-a' })), openCamera });
    client.start(); await flush();
    await expect(client.openCamera('other-mirror')).rejects.toThrow('已绑定'); expect(openCamera).not.toHaveBeenCalled();
    await expect(client.openCamera(paired.mirrorId)).resolves.toEqual(cameraRequest);
    expect(openCamera).toHaveBeenCalledExactlyOnceWith(paired.mirrorId, identity.terminalId, 'binding-a', expect.any(AbortSignal));
    expect(client.getSnapshot().connection?.cameraBindingId).toBe('binding-a');
    openCamera.mockResolvedValueOnce({ request: { ...cameraRequest, bindingId: 'untrusted-response-binding' } } as ExhibitionCameraStatus);
    await expect(client.openCamera(paired.mirrorId)).rejects.toThrow('请求已失效');
    expect(client.getSnapshot().connection?.cameraBindingId).toBe('binding-a');
  });

  it('rejects an in-flight open after the same terminal is rebound to the same mirror', async () => {
    const browser = { ...identity, platform: 'browser' as const };
    const pending = deferred<ExhibitionCameraStatus>();
    const connect = vi.fn().mockResolvedValueOnce({ ...paired, cameraBindingId: 'binding-a' }).mockResolvedValueOnce({ ...paired, cameraBindingId: 'binding-b' });
    const { client } = setup({ identity: vi.fn(async () => browser), connect, openCamera: vi.fn(() => pending.promise) });
    client.start(); await flush(); const opening = client.openCamera(paired.mirrorId);
    await client.retry();
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve({ request: { id: 'old-request', action: 'open', mirrorId: paired.mirrorId, terminalId: identity.terminalId,
      bindingId: 'binding-a', createdAt: Date.now(), expiresAt: Date.now() + 120000 } } as ExhibitionCameraStatus);
    await rejected;
    expect(client.getSnapshot().connection).toMatchObject({ cameraBindingId: 'binding-b' });
  });

  it.each(['cancel', 'restart'] as const)('aborts and ignores a camera request after %s', async kind => {
    const browser = { ...identity, platform: 'browser' as const };
    const pending = deferred<ExhibitionCameraStatus>(); const openCamera = vi.fn(() => pending.promise);
    const { client } = setup({ identity: vi.fn(async () => browser), connect: vi.fn(async () => ({ ...paired, cameraBindingId: 'binding-a' })), openCamera });
    client.start(); await flush();
    const abort = new AbortController(); const opening = client.openCamera(paired.mirrorId, abort.signal);
    const signal = (openCamera.mock.calls[0] as unknown as [string, string, string, AbortSignal])[3];
    if (kind === 'cancel') abort.abort(); else { client.stop(); client.start(); await flush(); }
    expect(signal.aborted).toBe(true);
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve({ request: { id: 'old-request', action: 'open', mirrorId: paired.mirrorId, terminalId: identity.terminalId,
      bindingId: 'binding-a', createdAt: Date.now(), expiresAt: Date.now() + 120000 } } as ExhibitionCameraStatus);
    await rejected;
    expect(client.getSnapshot().connection?.cameraRequest).toBeUndefined();
  });
});
