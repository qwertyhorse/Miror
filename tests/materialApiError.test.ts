import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api';

afterEach(() => vi.unstubAllGlobals());
it('reports network failure as its own typed error without marking a material bad', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(api('/exhibition/live/session', 'POST', { lookId: 'shirt' })).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE', message: '连接中断，请检查网络后重试。' });
});
it('preserves abort ownership', async () => {
  const abort = new AbortController(); abort.abort();
  const cause = new DOMException('Aborted', 'AbortError');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
  await expect(api('/exhibition/live/session', 'POST', {}, abort.signal)).rejects.toBe(cause);
});
it('preserves backend material version errors for the live client', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'MATERIAL_VERSION_CHANGED', message: '素材已更新' }), { status: 409 })));
  await expect(api('/exhibition/live/session', 'POST', {})).rejects.toEqual(new ApiError('素材已更新', 'MATERIAL_VERSION_CHANGED'));
});
