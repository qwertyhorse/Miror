import { appUrl } from './versionScope';
import type { XmaxRegion } from '../shared/xmax';

/** The fields used to verify and close a smart-mirror generation session. */
export interface SessionData {
  id: string;
  providerId?: 'xmax' | 'decart';
  releaseKey?: string;
  providerRegion?: XmaxRegion;
  referenceScope?: string;
  status: string;
  sourceKind: 'photo' | 'video' | 'camera';
  providerSessionId?: string;
  expiresAt: string;
  refImageUrl: string;
  referenceAsset?: string;
  referenceVersion: number;
}

export interface CreatedSession extends SessionData {
  token: string;
  model: string;
}

export class ApiError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

/** Mirror callers supply their own device-scoped API route. */
export async function api<T>(path: string, method = 'GET', payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(appUrl(`/api${path}`), {
    method,
    headers: { 'X-Miror-Protocol': '2', 'X-Miror-Realtime': 'decart-v1', ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
    cache: 'no-store',
    signal,
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiError('本地服务未连接，请确认前端和后端都已启动。', 'BACKEND_UNAVAILABLE');
  }
  if (!response.ok) {
    const error = value as { message?: string; code?: string; error?: { message?: string; code?: string } };
    throw new ApiError(error.error?.message ?? error.message ?? '请求失败，请重试。', error.error?.code ?? error.code ?? 'REQUEST_FAILED');
  }
  if (value && typeof value === 'object' && 'referenceAsset' in value && typeof value.referenceAsset === 'string') {
    value.referenceAsset = appUrl(value.referenceAsset);
  }
  return value as T;
}
