import { describe, expect, it, vi } from 'vitest';
import { XmaxProvider } from '../server/provider';
import { DEFAULT_SESSION_LIMITS, isSessionLimits, resolveSessionLimits } from '../shared/sessionLimits';

describe('session-limit boundary', () => {
  it('preserves explicit settings and the default of an older mirror', () => {
    expect(resolveSessionLimits(undefined)).toEqual(DEFAULT_SESSION_LIMITS);
    expect(resolveSessionLimits(undefined, { credits: 20, expireSeconds: 80 })).toEqual({ credits: 20, expireSeconds: 80 });
    expect(resolveSessionLimits({ credits: 3000, expireSeconds: 3600 })).toEqual({ credits: 3000, expireSeconds: 3600 });
  });

  it.each([
    {}, { credits: 0, expireSeconds: 120 }, { credits: -1, expireSeconds: 120 },
    { credits: '300', expireSeconds: 120 }, { credits: 300, expireSeconds: null },
    { credits: 300, expireSeconds: 0 }, { credits: 300, expireSeconds: 1.5 },
    { credits: Infinity, expireSeconds: 120 }, { credits: 300, expireSeconds: 120, unexpected: true },
  ])('rejects malformed settings without turning them into unlimited: %j', value => {
    expect(isSessionLimits(value)).toBe(false);
  });

  it('sends configured limits above the old hard-coded cap unchanged', async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, data: {
      temporaryApiKey: 'tk-session-limit-fixture', expireTimestamp: '2099-01-01T00:00:00.000Z',
    } }));
    const provider = new XmaxProvider('uk-session-limit-fixture', fetcher);
    await provider.issueKey(3000, 3600);
    expect(fetcher).toHaveBeenCalledWith('https://api.xmax.ai/open/api/v1/temporary-api-key', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ pointsLimit: 3000, expireSeconds: 3600 }),
    }));
  });

  it.each([null, undefined, -1, Infinity, NaN])('never sends an undocumented unlimited sentinel to XMAX: %s', async value => {
    const fetcher = vi.fn();
    const provider = new XmaxProvider('uk-session-limit-fixture', fetcher);
    await expect(provider.issueKey(value as number, 120)).rejects.toMatchObject({ code: 'INVALID_SESSION_LIMITS' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
