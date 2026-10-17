import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); vi.stubEnv('BASE_URL', '/v1.1/'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function fixture() {
  const state = { closed: false };
  const focus = vi.fn();
  const popup = new Proxy({}, {
    get(_target, property) {
      if (property === 'closed') return state.closed;
      if (property === 'focus') return focus;
      throw new Error(`Cross-origin child property accessed: ${String(property)}`);
    },
    set() { throw new Error('The active wireless window must never be navigated'); },
  }) as Window;
  const open = vi.fn<Window['open']>(() => popup);
  vi.stubGlobal('window', { open, location: { href: 'http://xuminghong.local:10601/v1.1/exhibition/control', pathname: '/v1.1/exhibition/control' } });
  const { openWirelessWindow } = await import('../src/exhibition/wirelessWindow');
  return { openWirelessWindow, open, focus, state };
}

describe('wireless popup lifecycle', () => {
  it('opens the HTTPS browser presentation directly and focuses subsequent clicks without child DOM access', async () => {
    const f = await fixture();
    expect(f.openWirelessWindow('mirror-1')).toBe('opened');
    expect(f.open).toHaveBeenCalledWith('https://xuminghong.local:10202/v1.1/exhibition/computer?mirror=mirror-1&presentation=wireless', '_blank');
    f.focus.mockClear();
    expect(f.openWirelessWindow('mirror-1')).toBe('focused');
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.focus).toHaveBeenCalledOnce();
  });

  it('reopens a closed window', async () => {
    const f = await fixture();
    f.openWirelessWindow('mirror-1');
    f.state.closed = true;
    expect(f.openWirelessWindow('mirror-1')).toBe('opened');
    expect(f.open).toHaveBeenCalledTimes(2);
  });

  it('keeps mirrors and server origins independent while retaining a mirror across staff ports', async () => {
    const f = await fixture();
    f.openWirelessWindow('mirror-1');
    f.openWirelessWindow('mirror-2');
    f.openWirelessWindow('mirror-1', 'http://xuxin.local:10101/');
    expect(f.open).toHaveBeenCalledTimes(3);
    expect(f.openWirelessWindow('mirror-1', 'http://xuminghong.local:10200/')).toBe('focused');
    expect(f.open).toHaveBeenCalledTimes(3);
  });

  it.each(['null', 'throw'] as const)('reports a %s popup block and allows a later retry', async failure => {
    const f = await fixture();
    if (failure === 'null') f.open.mockReturnValueOnce(null);
    else f.open.mockImplementationOnce(() => { throw new DOMException('Blocked', 'NotAllowedError'); });
    expect(f.openWirelessWindow('mirror-1')).toBe('blocked');
    expect(f.openWirelessWindow('mirror-1')).toBe('opened');
    expect(f.open).toHaveBeenCalledTimes(2);
  });

  it('does not restart an existing session when the browser refuses focus', async () => {
    const f = await fixture();
    f.focus.mockImplementation(() => { throw new DOMException('Focus blocked', 'NotAllowedError'); });
    expect(f.openWirelessWindow('mirror-1')).toBe('opened');
    expect(f.openWirelessWindow('mirror-1')).toBe('focused');
    expect(f.open).toHaveBeenCalledOnce();
  });
});
