import type { IncomingMessage, ServerResponse } from 'node:http';
import { COMPUTER_DISPLAY_MAX_REQUEST_BYTES } from '../shared/computerDisplay.ts';
import type { ComputerDisplayBroker } from './computerDisplay.ts';
import type { ExhibitionMirrors } from './exhibitionMirrors.ts';
import type { ExhibitionService } from './exhibition.ts';
import { ApiError } from './types.ts';

export async function computerDisplayRequest(request: IncomingMessage, response: ServerResponse, options: {
  mirrorId: string; path: string; mirrors: ExhibitionMirrors; current: ExhibitionService; broker: ComputerDisplayBroker;
  readBody: (limit: number) => Promise<Record<string, unknown>>;
}): Promise<void> {
  const { mirrorId, path, mirrors, current, broker, readBody } = options;
  if (request.method !== 'POST' || !/^\/display\/(?:host\/(?:open|poll|signal|close)|receiver\/(?:poll|signal))$/.test(path))
    throw new ApiError('NOT_FOUND', '未找到显示连接接口。', 404);
  const input = await readBody(path.endsWith('/signal') ? COMPUTER_DISPLAY_MAX_REQUEST_BYTES : 2_048);
  let result: unknown;
  if (path === '/display/host/open') {
    const state = current.read();
    if (!['idle', 'select'].includes(state.phase) || state.live || ['active', 'paused'].includes(state.lifecycle?.state ?? '')
      || (state.lifecycle?.connection && state.lifecycle.connection !== 'idle'))
      throw new ApiError('DISPLAY_MIRROR_BUSY', '请先结束当前体验，再连接电脑。', 409);
    mirrors.devices.assertCameraClosed(mirrorId);
    result = broker.open(mirrorId, input.deviceId, input.output, input.replaceHost);
  } else if (path === '/display/host/poll') result = broker.hostPoll(mirrorId, input);
  else if (path === '/display/host/signal') { broker.hostSignal(mirrorId, input); result = { accepted: true }; }
  else if (path === '/display/host/close') { broker.hostClose(mirrorId, input); result = { closed: true }; }
  else {
    // assertOwner permits credential-less use only for unbound legacy mirrors; receivers never do.
    if (typeof input.terminalId !== 'string' || typeof input.terminalToken !== 'string' || !mirrors.devices.binding(mirrorId))
      throw new ApiError('EXHIBITION_DEVICE_UNAUTHORIZED', '请使用已绑定的安卓显示屏。', 403);
    mirrors.devices.assertOwner(mirrorId, { terminalId: input.terminalId, terminalToken: input.terminalToken });
    if (path === '/display/receiver/poll') result = broker.receiverPoll(mirrorId, input.terminalId, input);
    else { broker.receiverSignal(mirrorId, input.terminalId, input); result = { accepted: true }; }
  }
  if (response.destroyed) return;
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(result));
}
