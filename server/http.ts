import { validateMaterialImport } from './materialImport.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiError } from './types.ts';
import { TryOnService } from './service.ts';
import type { ExhibitionService } from './exhibition.ts';
import type { ExhibitionMirrors } from './exhibitionMirrors.ts';
import { RemoteGestureCoordinator, RemoteGestureError } from './remoteGestures.ts';
import { remoteGestureRequest } from './remoteGestureHttp.ts';
import { ComputerDisplayBroker } from './computerDisplay.ts';
import { computerDisplayRequest } from './computerDisplayHttp.ts';
import { BROWSER_TEST_TTL_MS } from './browserTests.ts';

const BROWSER_TEST_ID = /^test-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BROWSER_TEST_COOKIE = 'miror_browser_test';
const BROWSER_TEST_COMMANDS = new Set(['keepalive', 'select', 'begin', 'confirm', 'switch', 'next', 'previous', 'pause', 'resume', 'end', 'idle', 'recover']);
function browserTestToken(request: IncomingMessage): string {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${BROWSER_TEST_COOKIE}=`));
  return values.length === 1 ? values[0].slice(BROWSER_TEST_COOKIE.length + 1) : '';
}
function browserTestCookie(id: string, token: string, expired = false): string {
  return `${BROWSER_TEST_COOKIE}=${token}; Path=/v1.1/api/exhibition/mirrors/${id}; Max-Age=${expired ? 0 : Math.ceil(BROWSER_TEST_TTL_MS / 1_000)}; HttpOnly; Secure; SameSite=Strict`;
}
function browserTestRouteAllowed(method: string, path: string): boolean {
  if (['GET', 'HEAD'].includes(method) && (/^\/assets\/[^/]+(?:\/(?:display|reference)\/[^/]+)?$/.test(path) || /^\/skin\/[a-f0-9-]{36}$/.test(path))) return true;
  if (method === 'GET') return ['', '/changes', '/diagnostics', '/live/status', '/references', '/browser-test'].includes(path)
    || /^\/references\/[^/]+$/.test(path) || /^\/sessions\/[a-f0-9-]{36}$/.test(path);
  if (method !== 'POST') return false;
  return ['/command', '/live/session', '/live/heartbeat', '/live/error'].includes(path)
    || /^\/references\/[^/]+(?:\/retry)?$/.test(path)
    || /^\/live\/session\/[a-f0-9-]{36}\/(?:reference|condition(?:\/applied)?|renewal(?:\/commit)?)$/.test(path)
    || /^\/sessions\/[a-f0-9-]{36}\/(?:stop|link|first-frame|dial|released)$/.test(path);
}

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
export function createApiServer(service: TryOnService, allowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173'], _unusedKeySettings?: unknown, exhibition?: ExhibitionService | ExhibitionMirrors, gestures?: RemoteGestureCoordinator, display?: ComputerDisplayBroker) {
  exhibition?.attachLiveService(service);
  const mirrors = exhibition && 'getMirror' in exhibition ? exhibition : undefined;
  const computerDisplay = mirrors ? display ?? new ComputerDisplayBroker({ binding: mirrorId => {
    mirrors.getMirror(mirrorId);
    return mirrors.devices.binding(mirrorId);
  } }) : undefined;
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
          // Bounded UTF-8 metadata for up to 24 cameras; no frame payload is retained.
          return json(response, 200, await mirrors.connectDevice(await body(request, 65_536)));
        }
        if (url.pathname === '/api/exhibition/mirrors') {
          if (!mirrors) throw new ApiError('EXHIBITION_UNAVAILABLE', '多试衣镜服务尚未启动。', 503);
          if (request.method === 'GET') return json(response, 200, mirrors.list());
          if (request.method === 'POST') return json(response, 201, mirrors.create(await body(request)));
          throw new ApiError('NOT_FOUND', '未找到试衣镜接口。', 404);
        }
        const mirrorRoute = /^\/api\/exhibition\/mirrors\/([^/]+)(\/.*)?$/.exec(url.pathname);
        const mirrorId = mirrorRoute?.[1] ?? mirrors?.defaultMirrorId ?? 'default';
        const path = mirrorRoute ? mirrorRoute[2] ?? '' : url.pathname.slice('/api/exhibition'.length);
        const browserTest = !!mirrorRoute && BROWSER_TEST_ID.test(mirrorId);
        const testToken = browserTest ? browserTestToken(request) : '';
        // A failed close remains retryable with its original cookie even while
        // ordinary test reads/writes are fenced by the manager's closing state.
        if (browserTest && mirrors && path === '/browser-test/close' && request.method === 'POST') {
          await body(request, 2_048);
          await mirrors.browserTests.close(mirrorId, testToken);
          response.setHeader('Set-Cookie', browserTestCookie(mirrorId, '', true));
          return json(response, 200, { closed: true });
        }
        const context = browserTest ? mirrors?.browserTests.resolve(mirrorId, testToken) : undefined;
        const current = context?.exhibition ?? (browserTest ? undefined : mirrorRoute ? mirrors?.getMirror(mirrorId) : defaultExhibition());
        const currentService = context?.service ?? service;
        if (!current) throw new ApiError('EXHIBITION_MIRROR_NOT_FOUND', '未找到这面试衣镜。', 404);
        if (browserTest && !browserTestRouteAllowed(request.method ?? '', path)) throw new ApiError('BROWSER_TEST_OPERATION_FORBIDDEN', '浏览器测试不支持此操作。', 403);
        if (context) response.setHeader('Set-Cookie', browserTestCookie(mirrorId, testToken));
        const assertCurrent = () => {
          if (browserTest) mirrors!.browserTests.resolve(mirrorId, testToken);
          else if (mirrors) mirrors.getMirror(mirrorId);
        };
        const readBody = async (maximumBytes?: number) => {
          const input = await body(request, maximumBytes);
          // The body can arrive after removal, expiration or an explicit close.
          assertCurrent();
          return input;
        };
        if (!browserTest && mirrorRoute && path.startsWith('/display/')) {
          if (!mirrors || !computerDisplay) throw new ApiError('DISPLAY_UNAVAILABLE', '电脑显示暂不可用。', 503);
          await computerDisplayRequest(request, response, { mirrorId, path, mirrors, current, broker: computerDisplay, readBody });
          return;
        }
        if (!browserTest && mirrorRoute && path.startsWith('/gestures/')) {
          if (!mirrors || !gestures) throw new ApiError('GESTURE_UNAVAILABLE', 'Linux 手势识别暂不可用。', 503);
          await remoteGestureRequest(request, response, { mirrorId, path, mirrors, current, coordinator: gestures, assertCurrent });
          return;
        }
        if (browserTest && path === '/browser-test' && request.method === 'GET') return json(response, 200, { mirror: context!.mirror, expiresAt: context!.expiresAt });
        if (!browserTest && mirrorRoute && path === '/browser-tests' && request.method === 'POST') {
          const input = await readBody(2_048);
          if (Object.keys(input).length) throw new ApiError('BROWSER_TEST_INVALID_INPUT', '浏览器测试请求无效。');
          const created = mirrors!.browserTests.create(current);
          response.setHeader('Set-Cookie', browserTestCookie(created.mirror.id, created.token));
          return json(response, 201, { mirror: created.mirror, expiresAt: created.expiresAt });
        }
        if (mirrorRoute && !path && request.method === 'DELETE') {
          const removed = mirrors!.remove(mirrorId, await readBody());
          computerDisplay?.invalidate(mirrorId);
          return json(response, 200, removed);
        }
        if (mirrorRoute && path === '/provider-settings' && !browserTest) {
          if (request.method === 'GET') return json(response, 200, currentService.providerSettings(mirrorId));
          if (request.method === 'PUT') {
            const input = await readBody(2048); let ready = false;
            if (!input.apiKey && (input.provider === 'xmax' || input.provider === 'decart')) { try { current.assertProviderMaterialsReady(input.provider); ready = true; } catch { /* Save target configuration before preparation. */ } }
            const saved = currentService.saveProviderSettings(mirrorId, input, current.credentialsEditable(), ready);
            current.refreshMaterials();
            return json(response, 200, saved);
          }
        }
        if (mirrorRoute && path === '/provider-settings/apply' && !browserTest && request.method === 'POST') {
          const input = await readBody(2048);
          const target = currentService.providerSettings(mirrorId)?.desired;
          if (target) current.assertProviderMaterialsReady(target);
          currentService.requestProviderSwitch(mirrorId, input.expectedRevision);
          current.command({ action: 'end' }); await current.reconcileLive();
          return json(response, 200, currentService.providerSettings(mirrorId));
        }
        if (mirrorRoute && path === '/provider-settings/verify' && !browserTest && request.method === 'POST') {
          await readBody(2048); return json(response, 200, await currentService.verifyProvider(mirrorId));
        }
        if (mirrorRoute && path === '/credentials') {
          if (request.method === 'GET') return json(response, 200, { ...currentService.mirrorCredentialsStatus(mirrorId, current.credentialsEditable()), perSessionLimit: current.credentialLimits().credits });
          if (request.method === 'PUT') {
            const input = await readBody(2_048);
            const saved = currentService.saveMirrorCredentials(mirrorId, input, current.credentialsEditable());
            current.refreshMaterials();
            return json(response, 200, { ...saved, perSessionLimit: current.credentialLimits().credits });
          }
          throw new ApiError('NOT_FOUND', '未找到镜端密钥接口。', 404);
        }
        if (mirrorRoute && !path && request.method === 'PATCH') return json(response, 200, mirrors!.rename(mirrorId, await readBody()));
        if (mirrorRoute && path === '/copy' && request.method === 'POST') return json(response, 200, await mirrors!.copy(mirrorId, await readBody()));
        if (mirrorRoute && path === '/looks/copy' && request.method === 'POST') return json(response, 200, await mirrors!.copyLook(mirrorId, await readBody()));
        if (mirrorRoute && path === '/binding' && request.method === 'POST') {
          const binding = await mirrors!.bindDevice(mirrorId, await readBody());
          computerDisplay?.invalidate(mirrorId);
          return json(response, 200, binding);
        }
        if (mirrorRoute && path === '/binding' && request.method === 'DELETE') {
          await mirrors!.unbindDevice(mirrorId, await readBody());
          computerDisplay?.invalidate(mirrorId);
          return json(response, 200, { binding: null });
        }
        if (mirrorRoute && path === '/camera' && request.method === 'GET') return json(response, 200, mirrors!.cameraStatus(mirrorId));
        if (mirrorRoute && path === '/camera' && request.method === 'POST') return json(response, 200, mirrors!.openCamera(mirrorId, await readBody(2_048)));
        if (request.method === 'GET' && path === '/changes') {
          const after = Number(url.searchParams.get('after'));
          if (!url.searchParams.has('after') || !Number.isSafeInteger(after) || after < 0) throw new ApiError('INVALID_REVISION', '状态版本无效。');
          const state = current.read();
          if (state.revision !== after) return json(response, 200, state);
          if (waitingForChanges >= 128) throw new ApiError('TOO_MANY_REQUESTS', '连接繁忙，请稍后重试。', 429);
          waitingForChanges++;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            try { assertCurrent(); json(response, 200, current.read()); }
            catch (error) {
              const safe = error instanceof ApiError ? error : new ApiError('INTERNAL_ERROR', '本地服务暂时不可用。', 500);
              json(response, safe.statusCode, { error: { code: safe.code, message: safe.message }, code: safe.code, message: safe.message });
            }
          };
          const unsubscribe = current.subscribe(finish);
          const timer = setTimeout(finish, 8_000);
          response.once('close', () => { done = true; clearTimeout(timer); unsubscribe(); waitingForChanges--; });
          return;
        }
        if (request.method === 'GET' && path === '/diagnostics') return json(response, 200, { mirrorId, state: current.read().lifecycle, policy: { sessionLimits: current.sessionLimits(), autoReturnSeconds: current.read().settings.autoReturnSeconds, leaseTtlMs: 20000 }, events: current.diagnosticTimeline() });
        if (request.method === 'POST' && path === '/imports/validate') return json(response, 200, validateMaterialImport(await readBody(131072)));
        if (request.method === 'GET' && path === '/materials/readiness') return json(response, 200, current.materialReadinessStatus());
        if (request.method === 'POST' && ['/publication/prepare', '/publication/publish'].includes(path)) throw new ApiError('MATERIAL_WORKFLOW_UPGRADE_REQUIRED', '素材已自动生效，请刷新后台。', 409);
        if (request.method === 'GET' && path === '/references') return json(response, 200, { references: current.referencePreparationStatuses() });
        const retryReference = /^\/references\/([^/]+)\/retry$/.exec(path);
        if (request.method === 'POST' && retryReference) {
          const input = await readBody();
          return json(response, 202, { status: current.retryReferencePreparation(retryReference[1], input.replace === true) });
        }
        const preparedReference = /^\/references\/([^/]+)$/.exec(path);
        if (preparedReference && request.method === 'GET') return json(response, 200, { reference: current.readyReference(preparedReference[1], true) });
        if (preparedReference && request.method === 'POST') {
          await readBody();
          return json(response, 200, { reference: await current.prepareReference(preparedReference[1]) });
        }
        if (request.method === 'GET' && !path) { return json(response, 200, current.read()); }
        if (request.method === 'POST' && path === '/skin') return json(response, 200, await current.uploadUiSkin(await readBody(Infinity)));
        if (request.method === 'DELETE' && path === '/skin') return json(response, 200, current.removeUiSkin(await readBody()));
        const skin = /^\/skin\/([a-f0-9-]{36})$/.exec(path);
        if (skin && ['GET', 'HEAD'].includes(request.method ?? '')) {
          const image = current.uiSkinAsset(skin[1]);
          response.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return response.end(request.method === 'HEAD' ? undefined : image.data);
        }
        if (request.method === 'GET' && path === '/live/status') { return json(response, 200, current.liveStatus()); }
        if (request.method === 'POST' && path === '/live/error') return json(response, 200, await current.reportLiveError(await readBody()));
        if (request.method === 'POST' && path === '/live/heartbeat') return json(response, 200, current.heartbeat(await readBody()));
        if (request.method === 'POST' && path === '/live/session') {
          if (request.headers['x-miror-material'] !== 'catalog-v2') throw new ApiError('EXHIBITION_CLIENT_UPGRADE_REQUIRED', '请更新镜端后开始体验。', 426);
          if (request.headers['x-miror-protocol'] !== '2') throw new ApiError('EXHIBITION_CLIENT_UPGRADE_REQUIRED', '请更新镜端后开始体验。', 426);
          if (current.liveStatus().providerId === 'decart' && request.headers['x-miror-realtime'] !== 'decart-v1') throw new ApiError('EXHIBITION_CLIENT_UPGRADE_REQUIRED', '请升级镜端以使用 Decart。', 426);
          const input = await readBody(); let localId: string | undefined;
          let desktopOwner = false;
          const desktopStillOwns = () => {
            if (!desktopOwner) return true;
            try { return computerDisplay?.assertDesktopOwner(mirrorId, input) === true; } catch { return false; }
          };
          if (!browserTest) {
            desktopOwner = computerDisplay?.assertDesktopOwner(mirrorId, input) ?? false;
            if (!desktopOwner) {
              if (computerDisplay?.hasHost(mirrorId)) throw new ApiError('DISPLAY_HOST_ACTIVE', '当前由电脑提供画面，请从电脑开始体验。', 409);
              mirrors?.devices.assertOwner(mirrorId, { terminalId: input.terminalId as string | undefined, terminalToken: input.terminalToken as string | undefined });
            }
            mirrors?.devices.assertCameraClosed(mirrorId);
          }
          response.once('close', () => { if (!response.writableEnded && localId) void currentService.stop(localId).then(() => current.reconcileLive()).catch(() => undefined); });
          const created = await current.createLiveSession(input, { cancelled: () => response.destroyed || !desktopStillOwns() }); localId = created.id;
          if (response.destroyed) { await currentService.stop(created.id); await current.reconcileLive(); return; }
          if (!desktopStillOwns()) {
            await currentService.stop(created.id); await current.reconcileLive();
            throw new ApiError('DISPLAY_UNAUTHORIZED', '电脑显示身份已失效。', 403);
          }
          return json(response, 201, created);
        }
        const liveRenewal = /^\/live\/session\/([a-f0-9-]{36})\/renewal(?:\/(commit))?$/.exec(path);
        if (request.method === 'POST' && liveRenewal) {
          currentService.assertSessionMirror(liveRenewal[1], mirrorId, true);
          const input = await readBody();
          return json(response, 200, liveRenewal[2]
            ? await current.commitLiveRenewal(liveRenewal[1], input)
            : await current.prepareLiveRenewal(liveRenewal[1], input));
        }
        const liveReference = /^\/live\/session\/([a-f0-9-]{36})\/reference$/.exec(path);
        if (request.method === 'POST' && liveReference) {
          currentService.assertSessionMirror(liveReference[1], mirrorId, true);
          return json(response, 200, await current.bindLiveReference(liveReference[1], await readBody()));
        }
        const liveCondition = /^\/live\/session\/([a-f0-9-]{36})\/condition(?:\/(applied))?$/.exec(path);
        if (request.method === 'POST' && liveCondition) {
          currentService.assertSessionMirror(liveCondition[1], mirrorId, true);
          const input = await readBody();
          return json(response, 200, liveCondition[2]
            ? await current.liveConditionApplied(liveCondition[1], input)
            : await current.updateLiveCondition(liveCondition[1], input));
        }
        const session = /^\/sessions\/([a-f0-9-]{36})(?:\/(stop|link|first-frame|dial|released))?$/.exec(path);
        if (mirrorRoute && session) {
          const [, id, action] = session;
          currentService.assertSessionMirror(id, mirrorId, true);
          if (!action && request.method === 'GET') return json(response, 200, await currentService.get(id));
          if (action === 'dial' && request.method === 'POST') { const input = await readBody(); await current.reconcileLive(); return json(response, 200, await currentService.decartDial(id, input.releaseKey, request.headers.origin)); }
          if (action === 'released' && request.method === 'POST') { const input = await readBody(); const result = currentService.clientReleased(id, input.releaseKey); await current.reconcileLive(); return json(response, 200, result); }
          if (action === 'stop' && request.method === 'POST') { const stopped = await currentService.stop(id); await current.reconcileLive(); return json(response, 200, stopped); }
          if (action === 'link' && request.method === 'POST') { const input = await readBody(); return json(response, 200, await currentService.link(id, input.providerSessionId as string)); }
          if (action === 'first-frame' && request.method === 'POST') { const input = await readBody(); const framed = await currentService.firstFrame(id, input.firstFrameMs as number); current.liveFirstFrame(id, framed.firstFrameMs!); return json(response, 200, framed); }
        }
        if (request.method === 'POST' && path === '/command') {
          const input = await readBody();
          if (browserTest && !BROWSER_TEST_COMMANDS.has(String(input.action))) throw new ApiError('BROWSER_TEST_OPERATION_FORBIDDEN', '浏览器测试不支持此操作。', 403);
          if (!browserTest && ['begin', 'confirm', 'resume', 'recover'].includes(String(input.action))) mirrors?.devices.assertCameraClosed(mirrorId);
          current.command(input);
          // Selection is immediate. Running camera sessions apply conditions in place;
          // incompatible or unfinished connections stop in the background.
          const reconciling = current.reconcileLive();
          if (['switch', 'next', 'previous'].includes(String(input.action))) void reconciling.catch(() => undefined);
          else await reconciling;
          return json(response, 200, current.read());
        }
        if (request.method === 'POST' && path === '/looks') return json(response, 201, await current.upload(await readBody(current.uploadRequestLimit())));
        if (request.method === 'POST' && path === '/taxonomy') return json(response, 200, current.taxonomy(await readBody()));
        const look = /^\/looks\/([^/]+)$/.exec(path);
        if (request.method === 'PATCH' && look) return json(response, 200, await current.updateLook(look[1], await readBody(current.uploadRequestLimit())));
        if (request.method === 'DELETE' && look) return json(response, 200, current.removeLook(look[1], await readBody()));
        const asset = /^\/assets\/([^/]+)(?:\/(display|reference)\/([^/]+))?$/.exec(path);
        if (asset && ['GET', 'HEAD'].includes(request.method ?? '')) {
          const image = current.assetResource(asset[1], asset[2], asset[3]);
          response.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return response.end(request.method === 'HEAD' ? undefined : image.data);
        }
        throw new ApiError('NOT_FOUND', '未找到展会接口。', 404);
      }
      throw new ApiError('NOT_FOUND', '未找到接口。', 404);
    } catch (error) {
      const safe = error instanceof ApiError ? error : error instanceof RemoteGestureError
        ? new ApiError(error.code, error.message, error.status) : new ApiError('INTERNAL_ERROR', '本地服务暂时不可用。', 500);
      if (response.headersSent) { response.destroy(); return; }
      json(response, safe.statusCode, { error: { code: safe.code, message: safe.message }, code: safe.code, message: safe.message });
    }
  });
  const exhibitionWatchdog = exhibition ? setInterval(() => { computerDisplay?.sweep(); void exhibition.sweepLive().catch(() => undefined); }, 1_000) : undefined;
  exhibitionWatchdog?.unref();
  server.on('close', () => { if (exhibitionWatchdog) clearInterval(exhibitionWatchdog); computerDisplay?.closeAll(); void gestures?.closeAll(); });
  return server;
}
