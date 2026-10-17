import type { RealtimeConnectOptions, RealtimeSession, RealtimeSessionState } from './xmaxSdkContract';

type LifecycleSession = Pick<RealtimeSession, 'state' | 'disconnect'>;
export type XmaxLifecycleCallbacks = Pick<RealtimeConnectOptions, 'onError' | 'onStateChange'>;

const RTC_STAGES = new Set(['rtc_prepare', 'rtc_join', 'camera_capture', 'camera_audio', 'camera_ready',
  'publish', 'outbound_ready', 'generation_start', 'wait_first_frame', 'remote_bind', 'rtc', 'streaming', 'context_set']);

function hasRtcResources(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object' || !('details' in cause)) return false;
  const details = cause.details;
  if (!details || typeof details !== 'object') return false;
  return ('connection_state' in details && typeof details.connection_state === 'string' && !!details.connection_state)
    || ('failure_stage' in details && typeof details.failure_stage === 'string' && RTC_STAGES.has(details.failure_stage));
}

export class XmaxTeardownUnconfirmedError extends Error {
  readonly code = 'XMAX_TEARDOWN_UNCONFIRMED';
  constructor() { super('视频连接仍在释放，请稍后重试。'); this.name = 'XmaxTeardownUnconfirmedError'; }
}

/** Require both completed cleanup and a terminal state before releasing the next session. */
export async function connectXmaxWithLifecycle<T extends LifecycleSession>(
  connect: (callbacks: XmaxLifecycleCallbacks) => Promise<T>,
  callbacks: XmaxLifecycleCallbacks = {},
  { teardownTimeoutMs = 8000 }: { teardownTimeoutMs?: number } = {},
): Promise<T> {
  let disconnected = false;
  let rtcResourcesObserved = false;
  const terminalListeners = new Set<() => void>();
  const onStateChange = (state: RealtimeSessionState) => {
    if (state === 'disconnected') {
      disconnected = true;
      for (const listener of [...terminalListeners]) listener();
      terminalListeners.clear();
    }
    callbacks.onStateChange?.(state);
  };
  let session: T;
  try {
    session = await connect({ onStateChange, onError: (message, error) => {
      rtcResourcesObserved ||= hasRtcResources(error);
      callbacks.onError?.(message, error);
    } });
  } catch (cause) {
    // Keep bootstrap pending until RTC is actually gone. The caller bounds its
    // stop wait and keeps the next connection fenced while this promise is pending.
    // Auth/media failures before an RTC engine exists need no teardown barrier.
    if (!disconnected && (rtcResourcesObserved || hasRtcResources(cause))) {
      await new Promise<void>(resolve => terminalListeners.add(resolve));
    }
    throw cause;
  }

  const nativeDisconnect = session.disconnect.bind(session);
  let disconnecting: Promise<void> | undefined;
  let confirmed = false;
  session.disconnect = () => {
    if (confirmed) return Promise.resolve();
    if (disconnecting) return disconnecting;
    disconnecting = new Promise<void>((resolve, reject) => {
      let nativeDone = false;
      const finish = () => {
        if (!nativeDone || (!disconnected && session.state !== 'disconnected')) return;
        confirmed = true; cleanup(); resolve();
      };
      const timer = setTimeout(() => { cleanup(); reject(new XmaxTeardownUnconfirmedError()); }, teardownTimeoutMs);
      const cleanup = () => { clearTimeout(timer); terminalListeners.delete(finish); };
      terminalListeners.add(finish);
      void Promise.resolve().then(nativeDisconnect).then(() => { nativeDone = true; finish(); }, cause => { cleanup(); reject(cause); });
    }).finally(() => { disconnecting = undefined; });
    return disconnecting;
  };
  return session;
}
