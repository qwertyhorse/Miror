/** Metadata only. Camera capture and saved selection remain on the bound terminal. */
export const EXHIBITION_CAMERA_VERSION = 1;
export const EXHIBITION_CAMERA_REQUEST_TTL_MS = 120_000;
export interface ExhibitionCameraDevice {
  id: string;
  label: string;
  kind: 'external' | 'back' | 'front' | 'unknown';
}
export type ExhibitionCameraReportState = 'ready' | 'scanning' | 'preview' | 'error' | 'permission-required' | 'busy' | 'closed';
export interface ExhibitionCameraOpenInput {
  action: 'open';
  terminalId: string;
  /** Required by the local terminal entry; staff controls may omit it. */
  bindingId?: string;
}
export interface ExhibitionCameraRequest {
  id: string;
  action: 'open';
  mirrorId: string;
  terminalId: string;
  bindingId: string;
  createdAt: number;
  expiresAt: number;
}
export interface ExhibitionCameraReport {
  mirrorId: string;
  bindingId: string;
  requestId: string | null;
  status: ExhibitionCameraReportState;
  devices: ExhibitionCameraDevice[];
  /** null means automatic selection; IDs are opaque values from that terminal. */
  selectedDeviceId: string | null;
  activeDeviceId: string | null;
  error?: string;
}
export interface ExhibitionCameraStatus {
  supported: boolean;
  terminalId: string | null;
  online: boolean;
  state: ExhibitionCameraReportState | 'unbound' | 'offline' | 'unsupported' | 'idle' | 'requested' | 'expired';
  devices: ExhibitionCameraDevice[];
  selectedDeviceId: string | null;
  activeDeviceId: string | null;
  updatedAt: number | null;
  request: ExhibitionCameraRequest | null;
  error?: string;
}
