import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMediaHost } from '../server/network.ts';
import { publicAddress, TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { Provider } from '../server/types.ts';

const stores: SessionStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));

function fixture(localAddresses: string[], publicAnswers = ['8.8.8.8', '2606:4700:4700::1111']) {
  const store = new SessionStore(':memory:'); stores.push(store);
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const issueKey = vi.fn(async () => ({ token: 'tk-dns-fixture', expiresAt }));
  const provider: Provider = {
    configured: true, issueKey,
    keyStatus: async () => ({ status: 'active', consumedCredit: 0, expireTimestamp: expiresAt }),
    deactivate: async () => ({ status: 'inactive', consumedCredit: 0, expireTimestamp: expiresAt }),
    sessionStatus: async (_, sessionUid) => ({ sessionUid, status: 'active', consumedCredit: 0 }),
  };
  const fetcher = vi.fn<typeof fetch>(async input => {
    const type = new URL(String(input)).searchParams.get('type');
    return Response.json({ Status: 0, Answer: [{ type: type === 'A' ? 1 : 28, data: publicAnswers[type === 'A' ? 0 : 1] }] });
  });
  const service = new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)),
    resolveHost: host => resolveMediaHost(host, { local: async () => localAddresses, fetcher }),
  });
  return { service, store, issueKey, fetcher };
}

const initial = { lookId: 'commute', deviceId: 'screen-dns-fixture', name: '通勤',
  referenceAsset: '/assets/exhibition/commute-cutout.png', sessionNumber: 1, generationNumber: 1 };

describe('reference validation behind dual-stack fake-IP DNS', () => {
  it('binds the first reference and changes clothing in the same lease after public DNS verification', async () => {
    const { service, store, issueKey, fetcher } = fixture(['198.18.0.40', '2001:2::28']);
    const session = await service.createExhibition(initial);
    const bound = await service.bindExhibitionReference(session.id, { deviceId: initial.deviceId,
      lookId: initial.lookId, refImageUrl: 'https://uploads.example/commute.webp' });
    expect(bound.referenceVersion).toBe(1);
    await service.link(session.id, 'ums-dns-fixture');
    const updated = await service.updateExhibitionCondition(session.id, { deviceId: initial.deviceId,
      lookId: 'city', sessionNumber: 1, generationNumber: 2, referenceAsset: '/assets/exhibition/city-cutout.png',
      refImageUrl: 'https://uploads.example/city.webp' }, () => true);
    expect(updated).toMatchObject({ id: session.id, referenceVersion: 2,
      refImageUrl: 'https://uploads.example/city.webp', providerSessionId: 'ums-dns-fixture' });
    expect(store.list()).toHaveLength(1);
    expect(issueKey).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalled();
  });

  it.each([
    ['local private address', ['198.18.0.40', '2001:2::28', '192.168.1.2'], ['8.8.8.8', '2606:4700:4700::1111']],
    ['public resolver private answer', ['198.18.0.40', '2001:2::28'], ['8.8.8.8', 'fd00::1']],
  ])('still rejects a %s without accepting the reference', async (_, local, answers) => {
    const { service, store } = fixture(local as string[], answers as string[]);
    const session = await service.createExhibition(initial);
    await expect(service.bindExhibitionReference(session.id, { deviceId: initial.deviceId,
      lookId: initial.lookId, refImageUrl: 'https://uploads.example/commute.webp' }))
      .rejects.toMatchObject({ code: 'REFERENCE_ADDRESS_BLOCKED' });
    expect(store.get(session.id)).toMatchObject({ refImageUrl: '', referenceVersion: 0 });
  });

  it.each(['2001:2::28', '2001:0002:0000:ffff:ffff:ffff:ffff:ffff', '198.18.0.40', '198.19.255.255'])
    ('does not accept benchmark address %s as globally reachable', address => {
      expect(publicAddress(address)).toBe(false);
    });
});
