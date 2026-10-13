import { afterEach, describe, expect, it, vi } from 'vitest';
import { exhibitionSdk, prepareExhibitionEntry } from '../src/exhibition/sdkPreparation';

const clients = vi.hoisted(() => ({ cn: vi.fn(), global: vi.fn() }));
vi.mock('@xmaxai/sdk', () => ({ createXmaxClient: clients.cn, XMAX_OPEN_API_PRODUCTION_BASE_URL: 'https://api.xmaxai.com/open/api/v1' }));
vi.mock('@xmaxai/sdk-global', () => ({ createXmaxClient: clients.global, XMAX_OPEN_API_PRODUCTION_BASE_URL: 'https://api.xmax.ai/open/api/v1' }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
function documentFixture() {
  const remove = vi.fn();
  const link = { rel: '', href: '', crossOrigin: '', remove };
  const appendChild = vi.fn();
  vi.stubGlobal('document', { head: { appendChild }, createElement: vi.fn(() => link) });
  return { link, appendChild, remove };
}

describe('exhibition entry SDK preparation', () => {
  it.each([['cn', 'https://api.xmaxai.com'], ['global', 'https://api.xmax.ai']] as const)(
    'warms %s code and its API transport without creating an authenticated client', async (region, origin) => {
      const f = documentFixture();
      await exhibitionSdk(region);
      const release = prepareExhibitionEntry(region); await flush();
      expect(f.appendChild).toHaveBeenCalledExactlyOnceWith(f.link);
      expect(f.link).toMatchObject({ rel: 'preconnect', href: origin, crossOrigin: 'anonymous' });
      expect(clients.cn).not.toHaveBeenCalled(); expect(clients.global).not.toHaveBeenCalled();
      release(); expect(f.remove).toHaveBeenCalledOnce();
    });
  it('discards a late import after leaving the screen', async () => {
    const f = documentFixture(); const release = prepareExhibitionEntry('cn'); release(); await flush();
    expect(f.appendChild).not.toHaveBeenCalled(); expect(clients.cn).not.toHaveBeenCalled();
  });
  it('keeps code warm without a browser document', async () => {
    vi.stubGlobal('document', undefined);
    const release = prepareExhibitionEntry('global'); await flush(); release();
    expect(clients.global).not.toHaveBeenCalled();
  });
});
