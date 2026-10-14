import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiError } from './types.ts';
import { TryOnService } from './service.ts';
import type { ExhibitionService } from './exhibition.ts';
import type { ExhibitionMirrors } from './exhibitionMirrors.ts';

function json(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage, maximumBytes = 16_384): Promise<Record<string, unknown>> {
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) throw new ApiError('INVALID_CONTENT_TYPE', '请使用 JSON 请求。', 415);
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new ApiError('REQUEST_TOO_LARGE', '请求内容过大。', 413);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > maximumBytes) throw new ApiError('REQUEST_TOO_LARGE', '请求内容过大。', 413); chunks.push(Buffer.from(chunk)); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('INVALID_JSON', 'JSON 内容无效。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('INVALID_JSON', '请提供有效的 JSON 对象。');
  return value as Record<string, unknown>;
}
export function createApiServer(service: TryOnService, allowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173'], _unusedKeySettings?: unknown, exhibition?: ExhibitionService | ExhibitionMirrors) {
  exhibition?.attachLiveService(service);
  const mirrors = exhibition && 'getMirror' in exhibition ? exhibition : undefined;
  const defaultExhibition = () => mirrors ? mirrors.getMirror() : exhibition as ExhibitionService | undefined;
  let waitingForChanges = 0;
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new ApiError('INVALID_HOST', '仅允许本地内部测试访问。', 403);
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        const origin = request.headers.origin;
        if (!origin || !allowedOrigins.includes(origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('ORIGIN_NOT_ALLOWED', '写入请求必须来自本地原型页面。', 403);
      }
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname === '/api/exhibition' || url.pathname.startsWith('/api/exhibition/')) {
        if (request.method === 'GET' && url.pathname === '/api/exhibition/native-identity') return json(response, 200, { native: false });
        if (!exhibition) throw new ApiError('EXHIBITION_UNAVAILABLE', '展会演示服务尚未启动。', 503);
        if (request.method === 'POST' && url.pathname === '/api/exhibition/terminals/connect') {
          if (!mirrors) throw new ApiError('EXHIBITION_UNAVAILABLE', '镜端设备服务尚未启动。', 503);
          return json(response, 200, await mirrors.connectDevice(await body(request)));
        }
        if (url.pathname === '/api/exhibition/mirrors') {
          if (!mirrors) throw new ApiError('EXHIBITION_UNAVAILABLE', '多试衣镜服务尚未启动。', 503);
          if (request.method === 'GET') return json(response, 200, mirrors.list());
          if (request.method === 'POST') return json(response, 201, mirrors.create(await body(request)));
          throw new ApiError('NOT_FOUND', '未找到试衣镜接口。', 404);
        }
        const mirrorRoute = /^\/api\/exhibition\/mirrors\/([^/]+)(\/.*)?$/.exec(url.pathname);
        const mirrorId = mirrorRoute?.[1] ?? mirrors?.defaultMirrorId ?? 'default';
        const current = mirrorRoute ? mirrors?.getMirror(mirrorId) : defaultExhibition();
        if (!current) throw new ApiError('EXHIBITION_MIRROR_NOT_FOUND', '未找到这面试衣镜。', 404);
        const path = mirrorRoute ? mirrorRoute[2] ?? '' : url.pathname.slice('/api/exhibition'.length);
        if (mirrorRoute && path === '/credentials') {
          if (request.method === 'GET') return json(response, 200, { ...service.mirrorCredentialsStatus(mirrorId, current.credentialsEditable()), perSessionLimit: current.credentialLimits().credits });
          if (request.method === 'PUT') {
            const input = await body(request, 2_048);
            return json(response, 200, { ...service.saveMirrorCredentials(mirrorId, input, current.credentialsEditable()), perSessionLimit: current.credentialLimits().credits });
          }
          throw new ApiError('NOT_FOUND', '未找到镜端密钥接口。', 404);
        }
        if (mirrorRoute && !path && request.method === 'PATCH') return json(response, 200, mirrors!.rename(mirrorId, await body(request)));
        if (mirrorRoute && path === '/copy' && request.method === 'POST') return json(response, 200, await mirrors!.copy(mirrorId, await body(request)));
        if (mirrorRoute && path === '/binding' && request.method === 'POST') return json(response, 200, await mirrors!.bindDevice(mirrorId, await body(request)));
        if (mirrorRoute && path === '/binding' && request.method === 'DELETE') {
          await mirrors!.unbindDevice(mirrorId, await body(request));
          return json(response, 200, { binding: null });
        }
        if (request.method === 'GET' && path === '/changes') {
          const after = Number(url.searchParams.get('after'));
          if (!url.searchParams.has('after') || !Number.isSafeInteger(after) || after < 0) throw new ApiError('INVALID_REVISION', '状态版本无效。');
          const state = current.get();
          if (state.revision !== after) return json(response, 200, state);
          if (waitingForChanges >= 128) throw new ApiError('TOO_MANY_REQUESTS', '连接繁忙，请稍后重试。', 429);
          waitingForChanges++;
          let done = false;
          const finish = () => { if (!done) { done = true; json(response, 200, current.get()); } };
          const unsubscribe = current.subscribe(finish);
          const timer = setTimeout(finish, 8_000);
          response.once('close', () => { done = true; clearTimeout(timer); unsubscribe(); waitingForChanges--; });
          return;
        }
        if (request.method === 'GET' && path === '/references') return json(response, 200, { references: current.referencePreparationStatuses() });
        const retryReference = /^\/references\/([^/]+)\/retry$/.exec(path);
        if (request.method === 'POST' && retryReference) {
          await body(request);
          return json(response, 202, { status: current.retryReferencePreparation(retryReference[1]) });
        }
        const preparedReference = /^\/references\/([^/]+)$/.exec(path);
        if (preparedReference && request.method === 'GET') return json(response, 200, { reference: current.readyReference(preparedReference[1]) });
        if (preparedReference && request.method === 'POST') {
          await body(request);
          return json(response, 200, { reference: await current.prepareReference(preparedReference[1]) });
        }
        if (request.method === 'GET' && !path) { void current.sweepLive().catch(() => undefined); return json(response, 200, current.get()); }
        if (request.method === 'POST' && path === '/skin') return json(response, 200, await current.uploadUiSkin(await body(request, Infinity)));
        if (request.method === 'DELETE' && path === '/skin') return json(response, 200, current.removeUiSkin(await body(request)));
        const skin = /^\/skin\/([a-f0-9-]{36})$/.exec(path);
        if (skin && ['GET', 'HEAD'].includes(request.method ?? '')) {
          const image = current.uiSkinAsset(skin[1]);
          response.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return response.end(request.method === 'HEAD' ? undefined : image.data);
        }
        if (request.method === 'GET' && path === '/live/status') { void current.sweepLive().catch(() => undefined); return json(response, 200, current.liveStatus()); }
        if (request.method === 'POST' && path === '/live/error') return json(response, 200, await current.reportLiveError(await body(request)));
        if (request.method === 'POST' && path === '/live/heartbeat') return json(response, 200, current.heartbeat(await body(request)));
        if (request.method === 'POST' && path === '/live/session') {
          const input = await body(request); let localId: string | undefined;
          mirrors?.devices.assertOwner(mirrorId, { terminalId: input.terminalId as string | undefined, terminalToken: input.terminalToken as string | undefined });
          response.once('close', () => { if (!response.writableEnded && localId) void service.stop(localId).then(() => current.reconcileLive()).catch(() => undefined); });
          const created = await current.createLiveSession(input, { cancelled: () => response.destroyed }); localId = created.id;
          if (response.destroyed) { await service.stop(created.id); await current.reconcileLive(); return; }
          return json(response, 201, created);
        }
        const liveRenewal = /^\/live\/session\/([a-f0-9-]{36})\/renewal(?:\/(commit))?$/.exec(path);
        if (request.method === 'POST' && liveRenewal) {
          service.assertSessionMirror(liveRenewal[1], mirrorId, true);
          const input = await body(request);
          return json(response, 200, liveRenewal[2]
            ? await current.commitLiveRenewal(liveRenewal[1], input)
            : await current.prepareLiveRenewal(liveRenewal[1], input));
        }
        const liveReference = /^\/live\/session\/([a-f0-9-]{36})\/reference$/.exec(path);
        if (request.method === 'POST' && liveReference) {
          service.assertSessionMirror(liveReference[1], mirrorId, true);
          return json(response, 200, await current.bindLiveReference(liveReference[1], await body(request)));
        }
        const liveCondition = /^\/live\/session\/([a-f0-9-]{36})\/condition(?:\/(applied))?$/.exec(path);
        if (request.method === 'POST' && liveCondition) {
          service.assertSessionMirror(liveCondition[1], mirrorId, true);
          const input = await body(request);
          return json(response, 200, liveCondition[2]
            ? await current.liveConditionApplied(liveCondition[1], input)
            : await current.updateLiveCondition(liveCondition[1], input));
        }
        const session = /^\/sessions\/([a-f0-9-]{36})(?:\/(stop|link|first-frame))?$/.exec(path);
        if (mirrorRoute && session) {
          const [, id, action] = session;
          service.assertSessionMirror(id, mirrorId, true);
          if (!action && request.method === 'GET') return json(response, 200, await service.get(id));
          if (action === 'stop' && request.method === 'POST') { const stopped = await service.stop(id); await current.reconcileLive(); return json(response, 200, stopped); }
          if (action === 'link' && request.method === 'POST') { const input = await body(request); return json(response, 200, await service.link(id, input.providerSessionId as string)); }
          if (action === 'first-frame' && request.method === 'POST') { const input = await body(request); const framed = await service.firstFrame(id, input.firstFrameMs as number); current.liveFirstFrame(id, framed.firstFrameMs!); return json(response, 200, framed); }
        }
        if (request.method === 'POST' && path === '/command') {
          const input = await body(request);
          current.command(input);
          // Selection is immediate. Running camera sessions apply conditions in place;
          // incompatible or unfinished connections stop in the background.
          const reconciling = current.reconcileLive();
          if (['switch', 'next', 'previous'].includes(String(input.action))) void reconciling.catch(() => undefined);
          else await reconciling;
          return json(response, 200, current.get());
        }
        if (request.method === 'POST' && path === '/looks') return json(response, 201, await current.upload(await body(request, current.uploadRequestLimit())));
        if (request.method === 'POST' && path === '/taxonomy') return json(response, 200, current.taxonomy(await body(request)));
        const look = /^\/looks\/([^/]+)$/.exec(path);
        if (request.method === 'PATCH' && look) return json(response, 200, current.updateLook(look[1], await body(request)));
        if (request.method === 'DELETE' && look) return json(response, 200, current.removeLook(look[1], await body(request)));
        const asset = /^\/assets\/([^/]+)$/.exec(path);
        if (asset && ['GET', 'HEAD'].includes(request.method ?? '')) {
          const image = current.asset(asset[1]);
          response.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return response.end(request.method === 'HEAD' ? undefined : image.data);
        }
        throw new ApiError('NOT_FOUND', '未找到展会接口。', 404);
      }
      throw new ApiError('NOT_FOUND', '未找到接口。', 404);
    } catch (error) {
      const safe = error instanceof ApiError ? error : new ApiError('INTERNAL_ERROR', '本地服务暂时不可用。', 500);
      if (response.headersSent) { response.destroy(); return; }
      json(response, safe.statusCode, { error: { code: safe.code, message: safe.message }, code: safe.code, message: safe.message });
    }
  });
  const exhibitionWatchdog = exhibition ? setInterval(() => { void exhibition.sweepLive().catch(() => undefined); }, 1_000) : undefined;
  exhibitionWatchdog?.unref();
  server.on('close', () => { if (exhibitionWatchdog) clearInterval(exhibitionWatchdog); });
  return server;
}
