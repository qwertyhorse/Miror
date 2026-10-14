import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDecart } from '../src/exhibition/decartRealtime';
import type { CreatedSession, SessionData } from '../src/api';
const mock = vi.hoisted(() => ({ connect: vi.fn(), create: vi.fn(), session: { sessionId: 'session-fixture', set: vi.fn(), on: vi.fn(), disconnect: vi.fn(), getConnectionState: vi.fn(() => 'disconnected') } }));
vi.mock('@decartai/sdk', () => ({ createDecartClient: mock.create, models: { realtime: (name: string) => ({ name }) }, noopLogger: {} }));
const local: CreatedSession & { exhibition: { prompt: string } } = { id: 'local', sourceKind: 'camera', status: 'active', refImageUrl: 'file_first', referenceVersion: 1, token: '', model: 'lucy-vton-3.6', providerId: 'decart', expiresAt: new Date().toISOString(), exhibition: { prompt: 'red jacket' } };
const source = {} as MediaStream;
const callbacks = () => ({ onRemoteStream: vi.fn(), onError: vi.fn(), onDisconnect: vi.fn() });
beforeEach(() => { vi.clearAllMocks(); mock.create.mockReturnValue({ realtime: { connect: mock.connect } }); mock.connect.mockResolvedValue(mock.session); mock.session.getConnectionState.mockReturnValue('disconnected'); });
describe('Decart realtime adapter', () => {
  it('uses a just-in-time credential and a complete atomic initial/update condition', async () => {
    const dial = vi.fn(async () => ({ token: 'ephemeral-fixture' })); const release = vi.fn(async () => ({ status: 'stopped' } as SessionData));
    const adapter = await connectDecart(source, local, callbacks(), dial, release);
    const options = mock.create.mock.calls[0][0]; expect(options.apiKey).toBeUndefined(); expect(options.telemetry).toBe(false);
    expect(dial).not.toHaveBeenCalled(); expect(await options.apiKeyProvider()).toBe('ephemeral-fixture'); await expect(options.apiKeyProvider()).rejects.toThrow();
    expect(mock.connect.mock.calls[0][1]).toMatchObject({ retries: 0, capacityRetryBudgetMs: 0, initialState: { image: 'file_first', prompt: { text: 'red jacket', enhance: false } } });
    await adapter.set({ prompt: 'blue jacket', refImageUrl: 'file_second' });
    expect(mock.session.set).toHaveBeenCalledWith({ prompt: 'blue jacket', image: 'file_second', enhance: false });
    await adapter.disconnect(); expect(release).toHaveBeenCalledOnce(); expect(mock.session.disconnect).toHaveBeenCalledOnce();
    await expect(adapter.set({ prompt: 'late' })).rejects.toThrow();
  });
  it('does not overlap SDK reconnection with application recovery', async () => {
    const cb = callbacks(); const adapter = await connectDecart(source, local, cb, async () => ({ token: 'fixture' }), async () => ({} as SessionData));
    mock.connect.mock.calls[0][1].onConnectionChange('reconnecting'); expect(cb.onDisconnect).toHaveBeenCalledOnce(); expect(mock.session.disconnect).toHaveBeenCalled();
    await expect(mock.create.mock.calls[0][0].apiKeyProvider()).rejects.toThrow(); await adapter.disconnect();
  });
  it('releases a failed partial connect, and never reports close before transport termination', async () => {
    const release = vi.fn(async () => ({} as SessionData)); mock.connect.mockRejectedValueOnce(Error('transport failed'));
    await expect(connectDecart(source, local, callbacks(), async () => ({ token: 'fixture' }), release)).rejects.toThrow('transport failed'); expect(release).toHaveBeenCalledOnce();
    release.mockClear(); const adapter = await connectDecart(source, local, callbacks(), async () => ({ token: 'fixture' }), release);
    mock.session.getConnectionState.mockReturnValue('connected'); await expect(adapter.disconnect()).rejects.toThrow(); expect(release).not.toHaveBeenCalled();
  });
});

it('does not classify provider terminal refusals as renewable credential expiry', async () => {
  const cb = callbacks(); await connectDecart(source, local, cb, async () => ({ token: 'fixture' }), async () => ({} as SessionData));
  const ended = mock.session.on.mock.calls.find(([event]) => event === 'sessionEnded')![1];
  ended({ reason: 'session_limit' }); expect(cb.onError).toHaveBeenLastCalledWith(expect.any(String), { code: 'PROVIDER_REQUEST_REJECTED' });
  ended({ reason: 'insufficient_credits' }); expect(cb.onError).toHaveBeenLastCalledWith(expect.any(String), { code: 'PROVIDER_QUOTA_EXHAUSTED' });
  expect(cb.onDisconnect).not.toHaveBeenCalled();
});
