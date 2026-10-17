import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeSessionState, XmaxSdkError } from '../src/exhibition/xmaxSdkContract';
import { connectXmaxWithLifecycle, XmaxTeardownUnconfirmedError, type XmaxLifecycleCallbacks } from '../src/exhibition/xmaxRealtimeLifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function fixture(initialState: RealtimeSessionState = 'running') {
  let handlers!: XmaxLifecycleCallbacks;
  const onError = vi.fn(); const onStateChange = vi.fn();
  const nativeDisconnect = vi.fn(async () => {});
  const session = { state: initialState, disconnect: nativeDisconnect, marker: 'preserved' };
  const result = await connectXmaxWithLifecycle(async callbacks => { handlers = callbacks; return session; }, { onError, onStateChange });
  return { session, result, nativeDisconnect, handlers, onError, onStateChange,
    terminal() { session.state = 'disconnected'; handlers.onStateChange?.('disconnected'); } };
}

describe('XMAX realtime teardown barrier', () => {
  it('keeps the public session and waits when native disconnect returns before teardown completes', async () => {
    const f = await fixture(); expect(f.result).toBe(f.session); expect(f.result.marker).toBe('preserved');
    let finished = false;
    const pending = f.result.disconnect().then(() => { finished = true; }); await flush();
    expect(f.nativeDisconnect).toHaveBeenCalledOnce(); expect(finished).toBe(false);
    f.terminal(); await pending; expect(finished).toBe(true);
    expect(f.onStateChange).toHaveBeenCalledExactlyOnceWith('disconnected');
  });

  it('waits for native disconnect too when the terminal event arrives first', async () => {
    const f = await fixture(); const native = deferred<void>(); f.nativeDisconnect.mockImplementation(() => native.promise);
    let finished = false;
    const pending = f.result.disconnect().then(() => { finished = true; }); await flush();
    f.terminal(); await flush(); expect(finished).toBe(false);
    native.resolve(); await pending; expect(finished).toBe(true);
  });

  it('shares concurrent calls and does not repeat a confirmed disconnect', async () => {
    const f = await fixture();
    const first = f.result.disconnect(); const second = f.result.disconnect(); expect(second).toBe(first);
    await flush(); f.terminal(); await first; await f.result.disconnect();
    expect(f.nativeDisconnect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts an already terminal session without waiting for a second event', async () => {
    const f = await fixture('disconnected'); await f.result.disconnect();
    expect(f.nativeDisconnect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('retains terminal notification received before connect returns', async () => {
    const session = { state: 'idle' as RealtimeSessionState, disconnect: vi.fn(async () => {}) };
    const wrapped = await connectXmaxWithLifecycle(async callbacks => { callbacks.onStateChange?.('disconnected'); return session; });
    await wrapped.disconnect(); expect(session.disconnect).not.toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an unconfirmed disconnect and permits a later attempt after real cleanup', async () => {
    const f = await fixture(); const pending = f.result.disconnect();
    const rejection = expect(pending).rejects.toBeInstanceOf(XmaxTeardownUnconfirmedError);
    await vi.advanceTimersByTimeAsync(8000); await rejection;
    expect(vi.getTimerCount()).toBe(0);
    f.terminal(); await f.result.disconnect(); expect(f.nativeDisconnect).toHaveBeenCalledTimes(2);
  });

  it('preserves native disconnect errors without marking cleanup confirmed', async () => {
    const f = await fixture(); const error = new Error('leave failed'); f.nativeDisconnect.mockRejectedValueOnce(error);
    await expect(f.result.disconnect()).rejects.toBe(error); expect(vi.getTimerCount()).toBe(0);
    const pending = f.result.disconnect(); await flush(); f.terminal(); await pending;
    expect(f.nativeDisconnect).toHaveBeenCalledTimes(2);
  });

  it('notifies an RTC bootstrap error immediately but defers rejection until teardown completes', async () => {
    let handlers!: XmaxLifecycleCallbacks;
    const onError = vi.fn(); const onStateChange = vi.fn();
    const error = Object.assign(new Error('publish failed'), { code: 'WEB_RTC_ERROR', details: { failure_stage: 'publish' } }) as XmaxSdkError;
    let finished = false;
    const pending = connectXmaxWithLifecycle(async callbacks => {
      handlers = callbacks; callbacks.onError?.('publish failed', error); throw error;
    }, { onError, onStateChange }).catch(cause => { finished = true; return cause; });
    await flush(); expect(onError).toHaveBeenCalledExactlyOnceWith('publish failed', error); expect(finished).toBe(false);
    // No arbitrary grace period may release the next connection while cleanup remains pending.
    await vi.advanceTimersByTimeAsync(30000); expect(finished).toBe(false);
    handlers.onStateChange?.('disconnected'); expect(await pending).toBe(error);
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith('disconnected');
  });

  it('uses earlier RTC error evidence even if connect ultimately rejects a different error', async () => {
    let handlers!: XmaxLifecycleCallbacks;
    const original = Object.assign(new Error('rtc failed'), { code: 'WEB_RTC_ERROR', details: { connection_state: 'CONNECTION_STATE_CONNECTED' } }) as XmaxSdkError;
    const finalError = new Error('bootstrap cancelled'); let finished = false;
    const pending = connectXmaxWithLifecycle(async callbacks => {
      handlers = callbacks; callbacks.onError?.(original.message, original); throw finalError;
    }).catch(cause => { finished = true; return cause; });
    await flush(); expect(finished).toBe(false);
    handlers.onStateChange?.('disconnected'); expect(await pending).toBe(finalError);
  });

  it.each(['session_api', 'media_prepare'])('does not delay a %s rejection before RTC exists', async failure_stage => {
    const error = Object.assign(new Error('rejected'), { details: { failure_stage } });
    await expect(connectXmaxWithLifecycle(async () => { throw error; })).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait again when failed bootstrap already announced completed teardown', async () => {
    const error = Object.assign(new Error('publish failed'), { details: { failure_stage: 'publish' } });
    await expect(connectXmaxWithLifecycle(async handlers => { handlers.onStateChange?.('disconnected'); throw error; })).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
