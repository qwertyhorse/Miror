import {
  XmaxClient, XmaxConfiguration, XmaxEnvironment, XmaxLoggerOption, RealtimeConfiguration,
  RealtimeContext, RealtimeVideoFormat, defaultCameraVideoFormat, apiBaseURL,
  type RealtimeMediaStream, type RealtimeVideoTrack, type XmaxRealtimeManaging,
} from '@xmaxai/web-sdk';
import { xmaxNativeModel, type XmaxRegion } from '../../shared/xmax';
import type { RealtimeConnectOptions, RealtimeSessionState } from './xmaxSdkContract';
import { registerXmaxVideoStream } from './xmaxVideoBinding';
import { prepareXmaxVideoInput } from './xmaxCameraStream';

type Context = { prompt: string; refImageUrl?: string | null };

function sdkError(cause: unknown, stage: string) {
  const original = cause && typeof cause === 'object' ? cause as { message?: unknown; code?: unknown; details?: unknown; apiCode?: unknown; httpStatus?: unknown } : undefined;
  return Object.assign(new Error(typeof original?.message === 'string' ? original.message : '换装连接失败，请重试。'), {
    code: typeof original?.code === 'string' ? original.code : 'SESSION_ERROR',
    details: {
      // Native SDK API errors expose these outside details. Keep the evidence
      // used by failure classification without copying credentials or raw payloads.
      ...(typeof original?.apiCode === 'number' && Number.isFinite(original.apiCode) ? { business_code: original.apiCode } : {}),
      ...(typeof original?.httpStatus === 'number' && Number.isFinite(original.httpStatus) ? { http_status: original.httpStatus } : {}),
      ...(original?.details && typeof original.details === 'object' ? original.details : {}),
      failure_stage: stage,
    },
  });
}

function videoFormatForDimensions(client: XmaxClient, model: string, dimensions: MediaTrackSettings) {
  const fallback = defaultCameraVideoFormat(model);
  let width = fallback.width; let height = fallback.height; let fps = fallback.fps;
  if (dimensions.width && dimensions.height) { width = dimensions.width; height = dimensions.height; }
  if (dimensions.frameRate && Number.isFinite(dimensions.frameRate)) fps = Math.min(fallback.fps, dimensions.frameRate);
  const media = client.createMediaService(model);
  let size: { width: number; height: number };
  try { size = media.resolveModelInputSize({ width, height }); }
  catch {
    // The model advertises a portrait default. Rotate that supported bucket to
    // match the source; capture/output preferences never override model limits.
    const short = Math.min(fallback.width, fallback.height); const long = Math.max(fallback.width, fallback.height);
    size = media.resolveModelInputSize(width > height ? { width: long, height: short } : { width: short, height: long });
  }
  return new RealtimeVideoFormat({ ...size, fps });
}

async function inputFormat(client: XmaxClient, model: string, source: MediaStream | File) {
  if (source instanceof File) {
    if (typeof createImageBitmap === 'function') {
      const image = await createImageBitmap(source);
      try { return videoFormatForDimensions(client, model, image); } finally { image.close(); }
    }
    return videoFormatForDimensions(client, model, {});
  }
  return videoFormatForDimensions(client, model, source.getVideoTracks()[0]?.getSettings() ?? {});
}

async function connect(client: XmaxClient, region: XmaxRegion, source: MediaStream | File, options: RealtimeConnectOptions) {
  // Model-specific endpoints override the SDK environment. Never send a
  // region-bound credential to a model endpoint in another region.
  if (options.model.name !== xmaxNativeModel(region)) {
    throw sdkError({ message: '模型区域与连接区域不一致，请重新连接。', code: 'MODEL_REGION_MISMATCH' }, 'model_config');
  }
  const manager: XmaxRealtimeManaging = client.createRealtimeManager(new RealtimeConfiguration({ model: options.model.name }));
  let state: RealtimeSessionState = 'idle';
  let local: RealtimeMediaStream | undefined;
  let remote: RealtimeMediaStream | undefined;
  let publishedTrack: RealtimeVideoTrack | undefined;
  let publishedNative: MediaStreamTrack | undefined;
  let published = false;
  let firstFrame = false;
  let connected = false;
  let stopped = false;
  let stopRequested = false;
  let closePending: Promise<void> | undefined;
  let videoInput: Awaited<ReturnType<typeof prepareXmaxVideoInput>> | undefined;
  let unwatchInput: (() => void) | undefined;
  let failureStage = 'rtc_prepare';
  let watch: ReturnType<typeof setInterval> | undefined;
  let context: Context = { prompt: options.context?.prompt ?? '', ...(options.context?.refImageUrl !== undefined ? { refImageUrl: options.context.refImageUrl } : {}) };
  const bindings = new Set<() => void>();
  const requireSource = () => {
    if (stopRequested) throw new DOMException('视频连接已取消。', 'AbortError');
    if (!(source instanceof File) && !source.getVideoTracks().some(track => track.readyState === 'live')) {
      throw sdkError({ message: '摄像头已断开，请重新开启。', code: 'CAMERA_INPUT_ERROR',
        details: { reason_code: 'local_outbound_track_ended' } }, 'video_input');
    }
  };
  const changeState = (next: RealtimeSessionState) => {
    if (state === next) return;
    state = next; options.onStateChange?.(next);
  };
  const publishRemote = () => {
    if (stopRequested || !remote?.videoTrack) return;
    const track = remote.videoTrack;
    const native = track.mediaStreamTrack?.readyState === 'live' ? track.mediaStreamTrack : undefined;
    if (published && publishedTrack === track && publishedNative === native) return;
    published = true; publishedTrack = track; publishedNative = native;
    const stream = new MediaStream(native ? [native] : []);
    bindings.add(registerXmaxVideoStream(stream, track));
    options.onRemoteStream?.(stream);
  };
  const close = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (closePending) return closePending;
    stopRequested = true; clearInterval(watch);
    closePending = Promise.resolve().then(() => manager.close()).then(async () => {
      // Only close() completion certifies release. SDK Ready/Idle notifications
      // can precede its asynchronous resource cleanup and must not unlock retry.
      stopped = true;
      unwatchInput?.();
      try { videoInput?.dispose(); } catch { /* SDK release remains confirmed even if a detached preview rejects cleanup. */ }
      for (const release of bindings) { try { release(); } catch { /* A detached view cannot invalidate confirmed SDK release. */ } }
      bindings.clear();
      try { await manager.setStateListener(undefined); } catch { /* close has already confirmed resource release. */ }
      changeState('disconnected');
    }).finally(() => { closePending = undefined; });
    return closePending;
  };
  const failure = (cause: unknown, stage = failureStage) => {
    const error = sdkError(cause, stage);
    if (!stopRequested) options.onError?.(error.message, error);
    return error;
  };
  const session = {
    get state() { return state; },
    nativeInteraction: true as const,
    getSessionUid: () => manager.currentState.sessionID ?? null,
    set: async (next: Context) => {
      if (stopRequested || !local) throw new Error('换装连接已关闭。');
      const updated = { ...context, ...next };
      const request = new RealtimeContext({ prompt: updated.prompt,
        ...(typeof updated.refImageUrl === 'string' ? { referencePath: updated.refImageUrl } : {}) });
      // The public constructor drops null, but change_condition must send an
      // explicit null to clear a previous image instead of retaining it remotely.
      if (updated.refImageUrl === null) Object.assign(request, { referencePath: null });
      try {
        const result = await manager.startGeneration({ localStream: local, context: request, faceRestoration: true });
        if (stopRequested) { await close(); return; }
        context = updated; remote = result; publishRemote();
      } catch (cause) {
        const error = failure(cause, 'context_set');
        await close();
        throw error;
      }
    },
    disconnect: close,
    stopGeneration: close,
    stopLocalStream: close,
  };
  try {
    await manager.setStateListener(next => {
      if (stopRequested) return;
      publishRemote();
      if (next.reason?.kind === 'failure') { failure(next.reason.error); return; }
      if (next.connectionState === 'Generating') {
        changeState('running');
        if (!firstFrame) { firstFrame = true; options.onRemoteVideoFirstFrame?.(); }
      } else if (connected && (next.connectionState === 'Idle' || next.connectionState === 'Ready')) {
        options.onDisconnect?.('connection_lost');
      }
    });
    failureStage = 'audio_config';
    await manager.setLocalAudioVolume(0); await manager.setRemoteAudioVolume(0);
    failureStage = 'video_input';
    let relayFormat: RealtimeVideoFormat | undefined;
    if (!(source instanceof File)) videoInput = await prepareXmaxVideoInput(source, undefined, decoded => {
      relayFormat = videoFormatForDimensions(client, options.model.name, {
        ...decoded, frameRate: source.getVideoTracks()[0]?.getSettings().frameRate,
      });
      return relayFormat;
    });
    requireSource();
    const sdkSource = videoInput?.stream ?? source;
    if (sdkSource !== source && !(sdkSource instanceof File)) {
      const inputTrack = sdkSource.getVideoTracks()[0];
      const ended = () => {
        failure({ message: '摄像头画面已中断，请重新开启。', code: 'CAMERA_INPUT_ERROR',
          details: { reason_code: 'local_outbound_track_ended' } }, 'video_input');
        // SDK-owned clones do not receive the original canvas track's ended event.
        // Cancel an in-flight join too, so bootstrap cannot wait on a frozen input.
        void close().catch(() => { /* Bootstrap/application teardown retries unconfirmed cleanup. */ });
      };
      inputTrack.addEventListener('ended', ended, { once: true });
      unwatchInput = () => inputTrack.removeEventListener('ended', ended);
    }
    failureStage = 'input_format';
    // A relay selects its model format before shrinking the frame. Resolving again
    // from the smaller output could select a different model bucket.
    const videoFormat = relayFormat ?? await inputFormat(client, options.model.name, sdkSource);
    requireSource();
    if (sdkSource instanceof File) {
      failureStage = 'image_stream';
      local = await manager.createLocalImageStream({ file: sdkSource, videoFormat });
    }
    else {
      const videoTrack = sdkSource.getVideoTracks().find(track => track.readyState === 'live');
      if (!videoTrack) throw new Error('摄像头已断开，请重新开启。');
      // This is already the exhibition-owned clone. The SDK creates and closes
      // its own copy; this adapter never stops the caller's capture or output.
      failureStage = 'external_stream';
      local = await manager.createExternalVideoStream({ videoTrack, videoFormat });
      const dimensions = videoTrack.getSettings();
      const width = dimensions.width; const height = dimensions.height;
      if (width && height && Number.isFinite(width) && Number.isFinite(height) && width >= 2 && height >= 2) {
        const scale = Math.min(1, videoFormat.width / width, videoFormat.height / height);
        const uplink = { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) };
        if (uplink.width !== videoFormat.width || uplink.height !== videoFormat.height) {
          // Agora also applies capture constraints here. Generated camera frames
          // use an owned canvas input that supports those constraints.
          failureStage = 'uplink_format';
          await manager.updateUplinkVideoFormat(new RealtimeVideoFormat({ ...uplink, fps: videoFormat.fps }));
        }
      }
    }
    failureStage = 'rtc_connect';
    requireSource();
    remote = await manager.connect(local);
    requireSource();
    failureStage = 'rtc';
    connected = true; publishRemote();
    watch = setInterval(publishRemote, 250);
    return session;
  } catch (cause) {
    const error = failure(cause);
    // Bootstrap has no returned session whose disconnect the caller can retry.
    // Keep the lifecycle barrier pending and retry cleanup until SDK confirms it.
    for (;;) {
      try { await close(); break; }
      catch { await new Promise<void>(resolve => setTimeout(resolve, 1000)); }
    }
    throw error;
  }
}

/** Compatibility facade keeps the application lifecycle independent of vendor API names. */
export function createExhibitionSdk(region: XmaxRegion = 'global') {
  const environment = region === 'cn' ? XmaxEnvironment.china : XmaxEnvironment.global;
  return {
    XMAX_OPEN_API_PRODUCTION_BASE_URL: apiBaseURL(environment),
    models: { realtime: (name: string) => ({ name }) },
    createXmaxClient: ({ apiKey }: { apiKey: string; locale?: string; telemetry?: boolean }) => {
      const client = new XmaxClient(new XmaxConfiguration({ apiKey, environment, loggerOptions: XmaxLoggerOption.all }));
      return { realtime: {
        connect: (source: MediaStream, options: RealtimeConnectOptions) => connect(client, region, source, options),
        connectMedia: (source: File, options: RealtimeConnectOptions) => connect(client, region, source, options),
      } };
    },
  };
}
