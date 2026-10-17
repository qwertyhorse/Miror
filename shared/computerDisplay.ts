/** Display ownership and signaling; video stays local or travels directly over WebRTC. */
export const COMPUTER_DISPLAY_TTL_MS = 20_000;
export const COMPUTER_DISPLAY_MAX_SDP_BYTES = 65_536;
export const COMPUTER_DISPLAY_MAX_REQUEST_BYTES = 73_728;
export type ComputerDisplayOutput = 'android' | 'browser';
export type ComputerDisplayCapability = 'page' | 'page-rendered';
export type ComputerDisplaySource = 'camera' | 'output' | 'image' | 'page';
export type ComputerDisplaySignal =
  | { kind: 'offer'; payload: { epoch: number; type: 'offer'; sdp: string } }
  | { kind: 'answer'; payload: { epoch: number; type: 'answer'; sdp: string } }
  | { kind: 'candidate'; payload: { epoch: number; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null } }
  | { kind: 'reset' | 'ready'; payload: { epoch: number } }
  | { kind: 'rendered'; payload: { epoch: number; presentationId: number } }
  | { kind: 'presentation'; payload: { epoch: number; mirrored: boolean; source: ComputerDisplaySource; rotation?: 0 | 90 | 180 | 270; active?: boolean; presentationId?: number } };
export type ComputerDisplayMessage = ComputerDisplaySignal & { sequence: number };
export interface ComputerDisplayHostSession { sessionId: string; token: string; terminalId: string; }
export interface ComputerDisplayHostPoll {
  messages: ComputerDisplayMessage[]; receiverOnline: boolean; epoch: number; cursor: number;
  receiverCapabilities?: ComputerDisplayCapability[];
}
export interface ComputerDisplayReceiverPoll {
  session: { id: string; deviceId: string } | null;
  messages: ComputerDisplayMessage[]; epoch: number; cursor: number;
}
