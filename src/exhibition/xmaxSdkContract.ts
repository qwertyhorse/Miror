/** App-owned connection contract, independent of the vendor's package/API versions. */
export type RealtimeSessionState = 'idle' | 'running' | 'disconnected';
export interface XmaxSdkError extends Error {
  code: string;
  details?: Record<string, unknown>;
}
export interface RealtimeSession {
  readonly state: RealtimeSessionState;
  disconnect(): Promise<void>;
}
export interface RealtimePresentationState {
  instant: boolean;
  inputImageUrl: string | null;
  showInputImage: boolean;
  suppressLoading: boolean;
}
export type RealtimeRoomEventPayload = { event?: string; [key: string]: unknown };
export interface RealtimeConnectOptions {
  model: { name: string };
  autoStart?: boolean;
  context?: { prompt: string; refImageUrl?: string | null };
  audio?: { publish?: boolean; subscribe?: boolean };
  render?: { fit?: 'contain' | 'cover'; drag?: { enabled?: boolean } };
  onRemoteStream?: (stream: MediaStream) => void;
  onRemoteVideoFirstFrame?: () => void;
  onRoomEvent?: (event: RealtimeRoomEventPayload) => void;
  onPresentationChange?: (state: Readonly<RealtimePresentationState>) => void;
  onStateChange?: (state: RealtimeSessionState) => void;
  onError?: (message: string, error?: unknown) => void;
  onDisconnect?: (reason?: unknown, details?: unknown) => void;
}
