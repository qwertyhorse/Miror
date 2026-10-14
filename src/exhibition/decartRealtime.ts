import type { ExhibitionSdkSession } from './useExhibitionLive';
import type { CreatedSession, SessionData } from '../api';
import { DECART_MODEL } from '../../shared/providers';

/** A single dial per business segment. Recovery belongs to the experience orchestrator. */
export async function connectDecart(source: MediaStream | File, local: CreatedSession & { exhibition: { prompt?: string } }, callbacks: {
  onRemoteStream: (stream: MediaStream) => void;
  onError: (message: string, error?: unknown) => void;
  onDisconnect: (reason?: unknown, details?: unknown) => void;
}, dial: () => Promise<{ token: string }>, released: () => Promise<SessionData>): Promise<ExhibitionSdkSession> {
  if (source instanceof File || local.model !== DECART_MODEL) throw new Error('Decart 当前支持摄像头实时换装。');
  const { createDecartClient, models, noopLogger } = await import('@decartai/sdk');
  let closed = false; let dials = 0;
  let session: Awaited<ReturnType<ReturnType<typeof createDecartClient>['realtime']['connect']>> | undefined;
  const client = createDecartClient({ logger: noopLogger, telemetry: false, apiKeyProvider: async () => {
    if (closed || ++dials !== 1) throw new Error('连接已结束。');
    const grant = await dial(); if (closed) throw new Error('连接已结束。'); return grant.token;
  } });
  try { session = await client.realtime.connect(source, {
    model: models.realtime(DECART_MODEL), retries: 0, capacityRetryBudgetMs: 0, mirror: false,
    initialState: { prompt: { text: local.exhibition.prompt ?? 'Replace the clothing with the reference garment', enhance: false }, image: local.refImageUrl },
    onRemoteStream: stream => { if (!closed) callbacks.onRemoteStream(stream); },
    onConnectionChange: state => {
      if (!closed && state === 'reconnecting') { closed = true; session?.disconnect(); callbacks.onDisconnect('rtc_failed'); }
    },
  });
  } catch (error) {
    closed = true;
    // SDK 0.2.11 tears down its partially built transport before connect rejects.
    await released().catch(() => undefined);
    throw error;
  }
  const current = session;
  if (closed) current.disconnect();
  current.on('error', error => { if (!closed) callbacks.onError('换装连接异常。', { code: error.code }); });
  current.on('sessionEnded', event => {
    if (!closed) callbacks.onError('换装服务已结束，请检查服务状态。', { code: event.reason === 'insufficient_credits' ? 'PROVIDER_QUOTA_EXHAUSTED' : 'PROVIDER_REQUEST_REJECTED' });
  });
  let releasing: Promise<void> | undefined;
  return {
    getSessionUid: () => current.sessionId,
    set: async ({ prompt, refImageUrl }) => { if (closed) throw new Error('连接已结束。'); await current.set({ prompt, ...(refImageUrl ? { image: refImageUrl } : {}), enhance: false }); },
    stopGeneration: async () => { closed = true; current.disconnect(); },
    stopLocalStream: async () => {},
    disconnect: () => releasing ??= (async () => {
      closed = true; current.disconnect();
      if (current.getConnectionState() !== 'disconnected') throw new Error('视频连接尚未关闭。');
      await released();
    })().catch(error => { releasing = undefined; throw error; }),
  };
}
