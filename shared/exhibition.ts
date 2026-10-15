import type { XmaxRegion } from './xmax.ts';
import type { ExhibitionGestureSettings } from './exhibitionGestures.ts';
import type { ExhibitionSessionLimits } from './sessionLimits.ts';
import type { ExhibitionCameraReport, ExhibitionCameraRequest, ExhibitionCameraStatus } from './exhibitionCamera.ts';

export const EXHIBITION_LOOK_IDS = ['commute', 'city', 'evening'] as const;
export const EXHIBITION_EXPERIENCE_MODES = ['free', 'charx', 'clothx', 'vibex', 'dimx', 'mox'] as const;
export type ExhibitionExperienceMode = typeof EXHIBITION_EXPERIENCE_MODES[number];
export type ExhibitionReferenceKind = 'image' | 'none';
export const EXHIBITION_MODE_LABELS: Record<ExhibitionExperienceMode, string> = { free: 'Free', charx: 'CharX', clothx: 'ClothX', vibex: 'VibeX', dimx: 'DimX', mox: 'MoX' };
export const EXHIBITION_FREE_PROMPT_MAX_LENGTH = 1000;
export const EXHIBITION_AUTO_SWITCH_MIN_SECONDS = 5;
export const EXHIBITION_AUTO_SWITCH_MAX_SECONDS = 600;
export const EXHIBITION_AUTO_SWITCH_DEFAULT_SECONDS = 30;
export type ExhibitionSwitchMode = 'manual' | 'auto';
export const EXHIBITION_UI_SKIN_PRESETS = ['crystal', 'brand'] as const;
export type ExhibitionUiSkinPreset = typeof EXHIBITION_UI_SKIN_PRESETS[number];
export interface ExhibitionUiSkin { image: string; width: number; height: number; bytes: number; }
const MODE_PROMPTS: Record<Exclude<ExhibitionExperienceMode, 'free'>, string> = {
  charx: '视频中角色替换成参考图中角色', clothx: '视频中人物衣服替换成参考图中衣服',
  vibex: '视频风格变为参考图指定的风格', dimx: '指定角色在场景中互动', mox: '视频中角色跟随拖拽轨迹运动',
};
export function exhibitionPromptForLook(look: { mode: ExhibitionExperienceMode; prompt?: string }): string {
  return look.mode === 'free' ? (look.prompt ?? '').trim() : MODE_PROMPTS[look.mode];
}

/** Uploaded garments receive an opaque server-generated ID. */
export type ExhibitionLookId = string;
export type ExhibitionPhase = 'select' | 'positioning' | 'generating' | 'showcase' | 'paused' | 'idle';
export type ExhibitionCommandAction = 'keepalive' | 'select' | 'begin' | 'confirm' | 'switch' | 'next' | 'previous' | 'pause' | 'resume' | 'end' | 'idle' | 'recover' | 'configure' | 'reorder';

export interface ExhibitionUploadLimits {
  /** 1–20 MiB, applied to the original image bytes. */
  maxFileSizeMB: number;
  /** Integer pixel dimensions, 64–8192 inclusive; maximum area is 32 megapixels. */
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}
export const EXHIBITION_DEFAULT_UPLOAD_LIMITS: Readonly<ExhibitionUploadLimits> = {
  maxFileSizeMB: 10, minWidth: 256, maxWidth: 8192, minHeight: 256, maxHeight: 8192,
};
export interface ExhibitionLook {
  id: ExhibitionLookId;
  /** Exact business identity supplied by an import manifest. */
  sku?: string;
  name: string;
  description: string;
  /** Version-relative URL: clients should resolve through their version-aware app URL helper. */
  image: string;
  /** Independent XMAX input; omitted on legacy materials that reuse the display image. */
  referenceImage?: string;
  referenceRoleSource?: 'independent' | 'legacy-shared';
  referenceImageInfo?: ExhibitionImageInfo;
  palette: string;
  mode: ExhibitionExperienceMode;
  /** Defaults to image. Free prompt-only presets use none; image remains a display cover. */
  referenceKind?: ExhibitionReferenceKind;
  /** Required for Free; other modes use the shared preset. */
  prompt?: string;
  category: string;
  tags: string[];
  source: 'sample' | 'upload';
  width?: number;
  height?: number;
  bytes?: number;
  mime?: 'image/png' | 'image/jpeg' | 'image/webp';
}
export interface ExhibitionImageInfo {
  width: number;
  height: number;
  bytes: number;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
}
export function exhibitionReferenceImage(look: Pick<ExhibitionLook, 'image' | 'referenceImage' | 'referenceKind'>): string | null {
  return look.referenceKind === 'none' ? null : look.referenceImage ?? look.image;
}
export interface ExhibitionLookInput {
  sku?: string;
  name: string;
  description?: string;
  mode?: ExhibitionExperienceMode;
  referenceKind?: ExhibitionReferenceKind;
  prompt?: string;
  category?: string;
  tags?: string[];
  expectedRevision?: number;
  /** Optional replacements when editing an existing material. */
  imageBase64?: string;
  referenceImageBase64?: string;
}
export interface ExhibitionUploadInput extends ExhibitionLookInput {
  /** Uploads append a disabled garment in any phase. Accepted for compatibility, but global revisions do not lock append operations. */
  expectedRevision?: number;
  /** Raw base64 or a data URL. Only fully decoded, static PNG/JPEG/WebP images are accepted. */
  imageBase64: string;
  referenceImageBase64: string;
}
export interface ExhibitionTaxonomyInput {
  categories: string[];
  tags: string[];
  expectedRevision?: number;
}
export interface ExhibitionCommand {
  commandId?: string;
  action: ExhibitionCommandAction;
  lookId?: ExhibitionLookId;
  enabledLookIds?: ExhibitionLookId[];
  /** Complete ordered catalog IDs for experienceMode, including disabled materials. */
  lookIds?: ExhibitionLookId[];
  switchMode?: ExhibitionSwitchMode;
  /** Result display interval, integer seconds from 5 through 600. */
  autoSwitchSeconds?: number;
  /** Zero disables automatic return; otherwise 15–600 seconds. */
  autoReturnSeconds?: number;
  uploadLimits?: ExhibitionUploadLimits;
  providerMode?: 'demo' | 'xmax';
  experienceMode?: ExhibitionExperienceMode;
  /** Selecting a built-in skin replaces any uploaded custom image. */
  uiSkinPreset?: ExhibitionUiSkinPreset;
  /** Number of columns in the mirror's material drawer; legacy mirrors use two. */
  materialDrawerColumns?: 1 | 2;
  /** Complete local gesture-recognition settings; an empty list disables recognition. */
  gestureRecognition?: ExhibitionGestureSettings;
  sessionLimits?: ExhibitionSessionLimits;
  expectedRevision?: number;
}

export interface ExhibitionPublication {
  revision: number;
  publishedAt: number;
  legacy: boolean;
  /** Immutable display/reference versions. Draft edits never alter this list. */
  looks: ExhibitionLook[];
}
export interface ExhibitionPublicationStatus {
  revision: number; publishedAt: number; legacy: boolean;
  lookIds: string[]; readyLookIds: string[]; unavailableLookIds: string[]; draftChanged: boolean;
}
export interface ExhibitionState {
  publication?: ExhibitionPublication;
  lifecycle?: import('./exhibitionLifecycle.js').ExperienceLifecycle;
  /** Stable registered mirror; deviceId in live state is a separate browser lease. */
  mirrorId?: string;
  revision: number;
  phase: ExhibitionPhase;
  selectedLookId: ExhibitionLookId | null;
  experienceMode: ExhibitionExperienceMode;
  displayedLookId: ExhibitionLookId | null;
  enabledLookIds: ExhibitionLookId[];
  looks: ExhibitionLook[];
  /** Flat, unique names. No nested taxonomy. */
  categories: string[];
  tags: string[];
  sessionNumber: number;
  generationNumber: number;
  /** Server epoch milliseconds. */
  updatedAt: number;
  generationReadyAt: number | null;
  /** Server deadline; null outside an automatic result display. */
  autoSwitchAt?: number | null;
  settings: { autoReturnSeconds: number; uploadLimits: ExhibitionUploadLimits; switchMode?: ExhibitionSwitchMode; autoSwitchSeconds?: number; uiSkinPreset?: ExhibitionUiSkinPreset; uiSkin?: ExhibitionUiSkin | null; materialDrawerColumns?: 1 | 2; gestureRecognition?: ExhibitionGestureSettings; sessionLimits?: ExhibitionSessionLimits };
  providerMode: 'demo' | 'xmax';
  live: ExhibitionLiveState | null;
  /** Newest first. Only an explicitly enabled live mode can allocate XMAX credentials. */
  logs: { id: string; time: number; message: string }[];
}

export interface ExhibitionMirrorSummary {
  id: string;
  name: string;
  phase: ExhibitionPhase;
  revision: number;
  providerMode: 'demo' | 'xmax';
  updatedAt: number;
  binding?: ExhibitionDeviceBinding | null;
}
export interface ExhibitionDeviceCredentials { terminalId?: string; terminalToken?: string; }
export interface ExhibitionDeviceBinding {
  terminalId: string;
  label: string;
  platform: 'android' | 'browser';
  boundAt: number;
  lastSeenAt: number;
  online: boolean;
  camera?: ExhibitionCameraStatus;
}
export interface ExhibitionDeviceConnectInput {
  terminalId: string;
  token: string;
  label: string;
  platform: 'android' | 'browser';
  cameraCapabilities?: { version: 1 };
  cameraReport?: ExhibitionCameraReport;
}
export interface ExhibitionDeviceConnection {
  terminalId: string;
  mirrorId: string | null;
  mirrorName?: string;
  code?: string;
  expiresAt?: number;
  cameraBindingId?: string;
  cameraRequest?: ExhibitionCameraRequest;
  cameraReportAccepted?: boolean;
}
export interface ExhibitionMirrorList {
  defaultMirrorId: string;
  mirrors: ExhibitionMirrorSummary[];
}
export interface ExhibitionMirrorCopyInput {
  sourceMirrorId: string;
  expectedRevision: number;
  copyLooks: boolean;
  copySettings: boolean;
}
export interface ExhibitionLookCopyInput {
  sourceMirrorId: string;
  sourceLookId: ExhibitionLookId;
  mode: ExhibitionExperienceMode;
  expectedRevision: number;
  /** Required when copying a non-Free material into Free. */
  prompt?: string;
}

export interface ExhibitionLiveState {
  controllerEpoch?: number;
  stopReason?: import('./exhibitionLifecycle.js').StopReason;
  generationNumber: number;
  deviceId: string;
  sessionId: string | null;
  lookId: string;
  status: 'preparing' | 'connecting' | 'running' | 'stopping' | 'error';
  updatedAt: number;
  heartbeatAt: number;
  firstFrameMs?: number;
  error?: string;
  /** The local experience ended; the retained cloud lease is still unconfirmed. */
  localEnded?: boolean;
  /** One planned renewal retains this device's lease until confirmed completion. */
  renewal?: { id: string; requestedAt: number };
  /** Derived from confirmed provider usage; never from an unexplained disconnect. */
  renewalDue?: boolean;
}
export function isExhibitionLocallyEnded(state: Pick<ExhibitionState, 'phase' | 'live'>): boolean {
  return ['idle', 'select'].includes(state.phase) && state.live?.status === 'error' && state.live.localEnded === true;
}
export interface ExhibitionLiveStatus {
  providerId?: 'xmax' | 'decart';
  configured: boolean;
  providerRegion?: XmaxRegion;
  mode: 'demo' | 'xmax';
  model: string;
  perSessionLimit: number;
  /** @deprecated Legacy local counters; not XMAX balance and omitted by current mirror APIs. */
  totalLimit?: number;
  /** @deprecated Legacy local counters; omitted by current mirror APIs. */
  allocatedCredits?: number;
  /** @deprecated Legacy local counters; omitted by current mirror APIs. */
  remainingCredits?: number;
  expireSeconds: number;
  heartbeatTimeoutSeconds: number;
  live: ExhibitionLiveState | null;
}
/** Safe server configuration summary; a permanent API key is never returned. */
export interface ExhibitionCredentialsStatus {
  configured: boolean;
  region?: XmaxRegion;
  hasUnconfirmedSession?: boolean;
  source: 'mirror' | 'default';
  /** Credential configuration revision, independent of the material state revision. */
  revision: number;
  editable: boolean;
  perSessionLimit: number;
  /** @deprecated Legacy local counters; not XMAX balance and omitted by current mirror APIs. */
  totalLimit?: number;
  /** @deprecated Legacy local counters; omitted by current mirror APIs. */
  allocatedCredits?: number;
  /** @deprecated Legacy local counters; omitted by current mirror APIs. */
  remainingCredits?: number;
}
export interface ExhibitionLiveSessionInput extends ExhibitionDeviceCredentials {
  generationNumber: number;
  deviceId: string;
  lookId: string;
  expectedRevision?: number;
}
export interface ExhibitionLiveReferenceInput {
  deviceId: string;
  lookId: string;
  bindingId: string;
}
export interface ExhibitionLiveHeartbeatInput { deviceId: string; sessionId: string; }

export interface ExhibitionLiveErrorInput { deviceId: string; sessionId?: string; lookId: string; sessionNumber: number; generationNumber: number; message: string; }
