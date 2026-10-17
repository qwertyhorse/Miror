import type { RealtimeConnectOptions, RealtimeSessionState } from '../../src/exhibition/xmaxSdkContract';

/** Every connect owns a fresh SDK session while tests retain the underlying method spies. */
export function xmaxSessionFixture<T extends { disconnect(): Promise<void> }>(
  methods: T, callbacks: Pick<RealtimeConnectOptions, 'onStateChange'>,
) {
  const session = { ...methods, state: 'idle' as RealtimeSessionState, disconnect: async () => {
    await methods.disconnect();
    session.state = 'disconnected'; callbacks.onStateChange?.('disconnected');
  } };
  return session;
}
