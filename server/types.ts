import type { ExhibitionExperienceMode } from '../shared/exhibition.ts';
import type { XmaxRegion } from '../shared/xmax.ts';

export type SourceKind = 'photo' | 'video' | 'camera';
export type SessionState = 'reserved' | 'active' | 'stopping' | 'stopped' | 'issuance_unknown' | 'error';
export interface SessionRequest {
  targetItemId: string; sourceId: string; sourceKind: SourceKind; sourceName: string;
}
export interface SessionRecord extends SessionRequest {
  id: string; status: SessionState; pointsLimit: number; tokenCipher?: string;
  /** Permanent signing credential is encrypted and frozen for safe revocation. */
  providerKeyCipher?: string;
  providerRegion?: XmaxRegion;
  expiresAt?: string; refImageUrl: string; providerSessionId?: string; consumedCredits: number;
  referenceVersion: number; firstFrameMs?: number; referenceAsset?: string;
  exhibition?: { mirrorId?: string; lookId: string; deviceId: string; sessionNumber: number; generationNumber: number; mode?: ExhibitionExperienceMode; prompt?: string };
  resultUrl?: string; resultAvailable: boolean; verification: 'sdk-reported' | 'none';
  errorCode?: string; createdAt: string; updatedAt: string;
}
export interface IssuedKey { token: string; expiresAt: string; }
export interface KeyStatus { status: 'active' | 'inactive' | 'timeout'; consumedCredit: number; expireTimestamp: string; }
export interface ProviderSessionStatus { sessionUid: string; status: string; consumedCredit: number; }
export interface Provider {
  configured: boolean;
  readonly region?: XmaxRegion;
  credentialSnapshot?(): string;
  forCredential?(apiKey: string, region?: XmaxRegion): Provider;
  issueKey(pointsLimit: number, expireSeconds: number): Promise<IssuedKey>;
  keyStatus(token: string): Promise<KeyStatus>;
  deactivate(token: string): Promise<KeyStatus>;
  sessionStatus(token: string, sessionUid: string): Promise<ProviderSessionStatus>;
}
export class ApiError extends Error {
  constructor(public code: string, public message: string, public statusCode = 400) { super(message); }
}
