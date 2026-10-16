import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExhibitionMirrors } from './exhibitionMirrors.ts';
import type { ExhibitionService } from './exhibition.ts';
import type { RemoteGestureCoordinator } from './remoteGestures.ts';
import { resolveExhibitionGestureSettings } from '../shared/exhibitionGestures.ts';
import { ApiError } from './types.ts';

const MAX_FRAME_BYTES = 262_144;
const uploads = new WeakMap<RemoteGestureCoordinator, Set<string>>();

async function readBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    request.resume();
    throw new ApiError('GESTURE_FRAME_TOO_LARGE', '手势画面过大。', 413);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => finish(new ApiError('GESTURE_UPLOAD_TIMEOUT', '手势连接超时。', 408)), 2_000);
    timer.unref();
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('aborted', aborted);
      request.off('error', failed);
      if (error) { chunks.length = 0; request.resume(); reject(error); }
      else resolve(Buffer.concat(chunks, size));
    }
    function data(chunk: Buffer) {
      size += chunk.length;
      if (size > limit) finish(new ApiError('GESTURE_FRAME_TOO_LARGE', '手势画面过大。', 413));
      else chunks.push(chunk);
    }
    function end() { finish(); }
    function aborted() { finish(new ApiError('GESTURE_UPLOAD_CANCELLED', '手势连接已取消。', 409)); }
    function failed() { finish(new ApiError('GESTURE_UPLOAD_FAILED', '手势画面未收到。', 400)); }
    request.on('data', data).once('end', end).once('aborted', aborted).once('error', failed);
  });
}

async function readMetadata(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw new ApiError('GESTURE_INVALID_INPUT', '手势请求无效。', 415);
  try {
    const value: unknown = JSON.parse((await readBytes(request, 2_048)).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) { if (error instanceof ApiError) throw error; }
  throw new ApiError('GESTURE_INVALID_INPUT', '手势请求无效。', 400);
}

function reply(response: ServerResponse, value: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

/** Dedicated bounded JPEG ingress. Frames never enter catalog metadata or persistent storage. */
export async function remoteGestureRequest(request: IncomingMessage, response: ServerResponse, input: {
  mirrorId: string; path: string; mirrors: ExhibitionMirrors; current: ExhibitionService;
  coordinator: RemoteGestureCoordinator; assertCurrent: () => void;
}): Promise<void> {
  const { mirrorId, path, mirrors, current, coordinator, assertCurrent } = input;
  if (request.method !== 'POST') throw new ApiError('NOT_FOUND', '未找到手势接口。', 404);
  const authenticate = (terminalId: unknown, terminalToken: unknown) => {
    assertCurrent();
    if (typeof terminalId !== 'string' || typeof terminalToken !== 'string')
      throw new ApiError('EXHIBITION_DEVICE_UNAUTHORIZED', '请使用已绑定的镜端。', 403);
    mirrors.devices.assertOwner(mirrorId, { terminalId, terminalToken });
    return terminalId;
  };
  const assertSession = (sessionId: unknown, terminalId: string) => {
    if (typeof sessionId !== 'string') throw new ApiError('GESTURE_SESSION_INVALID', '手势连接已失效。', 409);
    const owner = coordinator.session(sessionId);
    if (!owner || owner.terminalId !== terminalId || owner.mirrorId !== mirrorId)
      throw new ApiError('GESTURE_SESSION_INVALID', '手势连接已失效。', 409);
    return sessionId;
  };
  if (path === '/gestures/frame') {
    const terminalId = request.headers['x-openbuy-terminal-id'];
    const token = request.headers['x-openbuy-terminal-token'];
    const owner = authenticate(terminalId, token);
    const id = assertSession(request.headers['x-openbuy-gesture-session'], owner);
    if (request.headers['content-type']?.split(';')[0].trim() !== 'image/jpeg')
      throw new ApiError('GESTURE_INVALID_IMAGE', '手势画面格式无效。', 415);
    const integer = (name: string) => {
      const value = request.headers[`x-openbuy-gesture-${name}`];
      if (typeof value !== 'string' || !/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new ApiError('GESTURE_INVALID_INPUT', '手势帧编号无效。', 400);
      return Number(value);
    };
    const blocked = request.headers['x-openbuy-gesture-blocked'];
    if (blocked !== 'true' && blocked !== 'false') throw new ApiError('GESTURE_INVALID_INPUT', '手势状态无效。', 400);
    const metadata = { epoch: integer('epoch'), seq: integer('seq'), timestamp: integer('time'), blocked: blocked === 'true' };
    let reading = uploads.get(coordinator);
    if (!reading) { reading = new Set(); uploads.set(coordinator, reading); }
    if (reading.has(id)) { request.resume(); throw new ApiError('GESTURE_BUSY', '手势帧已丢弃。', 429); }
    reading.add(id);
    try {
      const jpeg = await readBytes(request, MAX_FRAME_BYTES);
      authenticate(terminalId, token);
      assertSession(id, owner);
      if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8)
        throw new ApiError('GESTURE_INVALID_IMAGE', '手势画面格式无效。', 400);
      const state = current.get();
      const runtimeLookIds = (value: ReturnType<ExhibitionService['get']>) =>
        value.providerMode === 'xmax'
          ? value.catalog?.availableLookIds ?? []
          : value.enabledLookIds.filter(id => value.looks.some(look => look.id === id && look.mode === value.experienceMode));
      const scope = (value: ReturnType<ExhibitionService['get']>) => JSON.stringify([
        value.sessionNumber, value.generationNumber, value.experienceMode, value.phase, value.selectedLookId,
        value.providerMode, runtimeLookIds(value), value.providerMode === 'xmax' ? value.catalog?.revision : null,
        value.settings.gestureRecognition,
        // Heartbeats must not invalidate every camera sample. Only ownership/completion boundaries matter.
        value.live?.deviceId, value.live?.sessionId, value.live?.status, value.live?.localEnded,
      ]);
      const before = scope(state);
      const serverBlocked = state.providerMode !== 'xmax' || state.experienceMode === 'mox'
        || !runtimeLookIds(state).some(id => id !== state.selectedLookId) || !['idle', 'select', 'showcase'].includes(state.phase) || state.live?.localEnded === true;
      const result = await coordinator.frame(id, metadata, jpeg, resolveExhibitionGestureSettings(state.settings.gestureRecognition), serverBlocked, () => {
        try { authenticate(terminalId, token); assertSession(id, owner); return !response.destroyed && before === scope(current.get()); }
        catch { return false; }
      });
      authenticate(terminalId, token);
      assertSession(id, owner);
      if (!response.destroyed) reply(response, result);
    } finally { reading.delete(id); }
    return;
  }
  if (!['/gestures/open', '/gestures/control', '/gestures/close'].includes(path))
    throw new ApiError('NOT_FOUND', '未找到手势接口。', 404);
  const metadata = await readMetadata(request);
  const terminalId = authenticate(metadata.terminalId, metadata.terminalToken);
  if (path === '/gestures/open') {
    // Every connection starts blocked at epoch zero; Android then sends its current control epoch.
    const result = await coordinator.open({ terminalId, mirrorId, blocked: true },
      resolveExhibitionGestureSettings(current.get().settings.gestureRecognition));
    try { authenticate(metadata.terminalId, metadata.terminalToken); }
    catch (error) { await coordinator.close(result.sessionId); throw error; }
    if (response.destroyed) { await coordinator.close(result.sessionId); return; }
    reply(response, result);
    return;
  }
  const id = assertSession(metadata.sessionId, terminalId);
  if (path === '/gestures/close') { await coordinator.close(id); reply(response, { closed: true }); return; }
  if (!Number.isSafeInteger(metadata.epoch) || (metadata.epoch as number) < 0 || typeof metadata.blocked !== 'boolean'
    || (metadata.reset !== undefined && typeof metadata.reset !== 'boolean')) throw new ApiError('GESTURE_INVALID_INPUT', '手势状态无效。', 400);
  reply(response, coordinator.control(id, { epoch: metadata.epoch as number, blocked: metadata.blocked, reset: metadata.reset as boolean | undefined }));
}
