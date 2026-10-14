import { describe, expect, it, vi } from 'vitest';
import { isBenchmarkAddress, resolveMediaHost } from '../server/network.ts';

const host = 'media.example.com';
const publicV4 = '8.8.8.8';
const publicV6 = '2606:4700:4700::1111';
const placeholders = ['198.18.0.15', '2001:2::15'];
const response = (addresses: string[] = []) => new Response(JSON.stringify({
  Status: 0,
  Answer: addresses.map(data => ({ type: data.includes(':') ? 28 : 1, data })),
}), { headers: { 'Content-Type': 'application/dns-json' } });
function resolver(handler: (url: URL) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => handler(new URL(String(input))));
  return { fetcher, options: { local: async () => placeholders, fetcher: fetcher as typeof fetch } };
}

describe('benchmark proxy address detection', () => {
  it.each([
    '198.18.0.0', '198.18.255.255', '198.19.0.0', '198.19.255.255',
    '2001:2::', '2001:2::15', '2001:2:0:ffff:ffff:ffff:ffff:ffff',
    '2001:0002:0000:0000:0000:0000:0000:0015',
    '2001:0002::ABCD', '2001:2::192.0.2.1',
  ])('recognizes %s', address => expect(isBenchmarkAddress(address)).toBe(true));

  it.each([
    '198.17.255.255', '198.20.0.0', '198.18.0.999', '198.18.invalid',
    '2001:1:ffff:ffff:ffff:ffff:ffff:ffff', '2001:2:1::', '2001:3::',
    '2001:20::', '2001:2', '2001:2:::15', '::ffff:198.18.0.1',
    publicV4, publicV6, '192.168.1.2', '::1',
  ])('does not misclassify %s', address => expect(isBenchmarkAddress(address)).toBe(false));
});

describe('media DNS validation behind proxy placeholders', () => {
  it.each([[publicV4, publicV6], ['192.168.1.2'], ['::1']])('preserves ordinary local DNS without DoH: %j', async (...addresses) => {
    const { options, fetcher } = resolver(() => response());
    expect(await resolveMediaHost(host, { ...options, local: async () => addresses })).toEqual(addresses);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([placeholders, ['2001:0002:0000:0000:0000:0000:0000:0015'], ['198.19.255.255']])('verifies both DNS families for %j', async (...addresses) => {
    const { options, fetcher } = resolver(url => response(url.searchParams.get('type') === 'A' ? [publicV4] : [publicV6]));
    expect(await resolveMediaHost(host, { ...options, local: async () => addresses })).toEqual([publicV4, publicV6]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [input] of fetcher.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://cloudflare-dns.com');
      expect(url.searchParams.get('name')).toBe(host);
    }
  });

  it('accepts a confirmed empty family and deduplicates public addresses', async () => {
    const { options } = resolver(url => response(url.searchParams.get('type') === 'A' ? [publicV4, publicV4] : []));
    expect(await resolveMediaHost(host, { ...options, local: async () => [...placeholders, publicV4] })).toEqual([publicV4]);
  });

  it.each(['192.168.1.2', '127.0.0.1', 'fd12::1', 'fe80::1'])('retains genuine non-public local address %s for the caller to block', async privateAddress => {
    const { options } = resolver(url => response(url.searchParams.get('type') === 'A' ? [publicV4] : [publicV6]));
    expect(await resolveMediaHost(host, { ...options, local: async () => [...placeholders, privateAddress] }))
      .toEqual([privateAddress, publicV4, publicV6]);
  });

  it.each(['A', 'AAAA'])('retries failed %s even when the other family succeeded', async failedType => {
    const { options, fetcher } = resolver(url => {
      const type = url.searchParams.get('type');
      if (url.hostname === 'cloudflare-dns.com' && type === failedType) throw new Error('DNS unavailable');
      return response(type === 'A' ? [publicV4] : [publicV6]);
    });
    expect(await resolveMediaHost(host, options)).toEqual([publicV4, publicV6]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetcher.mock.calls[2][0])).hostname).toBe('dns.google');
    expect(new URL(String(fetcher.mock.calls[2][0])).searchParams.get('type')).toBe(failedType);
  });

  it.each(['A', 'AAAA'])('fails closed when %s remains unknown despite a successful other family', async failedType => {
    const { options, fetcher } = resolver(url => {
      if (url.searchParams.get('type') === failedType) throw new Error('DNS unavailable');
      return response([publicV4]);
    });
    await expect(resolveMediaHost(host, options)).rejects.toMatchObject({ code: 'MEDIA_DNS_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('retries both failed families and rejects complete DNS outages', async () => {
    const { options, fetcher } = resolver(() => { throw new Error('DNS unavailable'); });
    await expect(resolveMediaHost(host, options)).rejects.toMatchObject({ code: 'MEDIA_DNS_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('preserves a private address from either response, including an unexpected family', async () => {
    const { options } = resolver(url => response(url.searchParams.get('type') === 'A' ? [publicV4, 'fd12::1'] : ['192.168.1.2']));
    expect(await resolveMediaHost(host, options)).toEqual([publicV4, 'fd12::1', '192.168.1.2']);
  });

  it('preserves a private address returned by the fallback resolver', async () => {
    const { options } = resolver(url => {
      if (url.searchParams.get('type') === 'A') return response([publicV4]);
      if (url.hostname === 'cloudflare-dns.com') throw new Error('DNS unavailable');
      return response(['fd12::1']);
    });
    expect(await resolveMediaHost(host, options)).toEqual([publicV4, 'fd12::1']);
  });

  it.each(['198.18.0.1', '2001:2::1', '2001:0002:0000:0000:0000:0000:0000:0001'])('rejects a public DNS reply that still contains %s', async address => {
    const { options } = resolver(url => response(url.searchParams.get('type') === 'A' ? [publicV4] : [address]));
    await expect(resolveMediaHost(host, options)).rejects.toMatchObject({ code: 'MEDIA_DNS_UNAVAILABLE' });
  });

  it.each([
    { Status: 2 }, { Status: 0, Answer: {} },
    { Status: 0, Answer: [{ type: 1, data: 'invalid' }] },
    { Status: 0, Answer: [{ type: 28 }] },
  ])('rejects unresolved or malformed public DNS replies: %j', async body => {
    const { options } = resolver(() => new Response(JSON.stringify(body)));
    await expect(resolveMediaHost(host, options)).rejects.toMatchObject({ code: 'MEDIA_DNS_UNAVAILABLE' });
  });

  it('fails closed when both families are confirmed empty', async () => {
    const { options, fetcher } = resolver(() => response());
    await expect(resolveMediaHost(host, options)).rejects.toMatchObject({ code: 'MEDIA_DNS_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not replace failed or empty local DNS with a fabricated success', async () => {
    const { options, fetcher } = resolver(() => response([publicV4]));
    await expect(resolveMediaHost(host, { ...options, local: async () => [] })).rejects.toMatchObject({ code: 'MEDIA_DNS_UNAVAILABLE' });
    await expect(resolveMediaHost(host, { ...options, local: async () => { throw new Error('DNS unavailable'); } })).rejects.toMatchObject({ code: 'MEDIA_DNS_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
