import type { RealtimeRoomEventPayload } from './exhibition/xmaxSdkContract';

export interface SdkSession {
  getSessionUid(): string | null;
  set(context: { prompt: string; refImageUrl: string }): Promise<void>;
  stopGeneration(): Promise<void>;
  stopLocalStream(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ConnectOptions {
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteVideoFirstFrame: () => void;
  onRoomEvent: (event: RealtimeRoomEventPayload) => void;
  onError: (message: string) => void;
  onDisconnect: () => void;
}
