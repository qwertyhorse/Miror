import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReferenceAssets } from '../server/referenceAssets.ts';
import { createHash, randomBytes } from 'node:crypto';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { Provider } from '../server/types.ts';
import type { ExhibitionExperienceMode } from '../shared/exhibition.ts';

const cleanup: (() => void)[] = [];
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network calls are forbidden in condition service fixtures')); });
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });
async function fixture(mode: ExhibitionExperienceMode = 'clothx') {
  const store = new SessionStore(':memory:'); cleanup.push(() => store.close());
  const expiresAt = new Date(Date.now() + 120000).toISOString();
  const issueKey = vi.fn(async () => ({ token: 'tk-condition-fixture', expiresAt }));
  const deactivate = vi.fn(async () => ({ status: 'inactive' as const, consumedCredit: 4, expireTimestamp: expiresAt }));
  const provider: Provider = { configured: true, region: 'cn', credentialSnapshot: () => 'uk-condition-fixture', issueKey, deactivate,
    keyStatus: async () => ({ status: 'active', consumedCredit: 4, expireTimestamp: expiresAt }),
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'ACTIVE', consumedCredit: 4 }) };
  const resolveHost = vi.fn(async () => ['8.8.8.8']);
  const dir = mkdtempSync(join(tmpdir(), 'condition-trusted-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('reference'); const expected = { sha256: createHash('sha256').update(bytes).digest('hex'), mime: 'image/webp' };
  const service = new TryOnService({ referenceAssets: new ReferenceAssets(dir), referenceStorage: () => ({ upload: async () => 'https://fixture-123.cos.ap-test.myqcloud.com/image.webp', check: async () => true }), provider, providerForApiKey: () => provider, store, secrets: new SecretBox(randomBytes(32)), resolveHost });
  const session = await service.createExhibition({ lookId: 'commute', deviceId: 'screen-condition', name: '通勤', referenceAsset: '/assets/exhibition/commute-cutout.png', mode,
    prompt: mode === 'free' ? '初始水彩风格' : undefined, sessionNumber: 3, generationNumber: 5 });
  const prepared = (await service.prepareReference('default', bytes, expected.mime))!;
  await service.bindExhibitionReference(session.id, { deviceId: 'screen-condition', lookId: 'commute', bindingId: prepared.bindingId }, expected);
  await service.link(session.id, 'ums-condition-fixture');
  store.update(session.id, { firstFrameMs: 750, resultAvailable: true, resultUrl: 'https://results.example/old.mp4', verification: 'sdk-reported' });
  resolveHost.mockClear();
  const input = { deviceId: 'screen-condition', lookId: 'city', sessionNumber: 3, generationNumber: 6, mode,
    prompt: mode === 'free' ? '  新的油画风格  ' : undefined, referenceAsset: '/assets/exhibition/city-cutout.png', bindingId: prepared.bindingId, refImageUrl: prepared.url };
  const update = service.updateExhibitionCondition.bind(service);
  service.updateExhibitionCondition = (id, input, current) => update(id, input, current, expected);
  return { store, service, session, input, resolveHost, issueKey, deactivate };
}

describe('camera exhibition condition updates', () => {
  it('updates one lease without replacing credentials, RTC UID, expiry, limit or usage', async () => {
    const { store, service, session, input, issueKey, deactivate } = await fixture();
    const original = store.get(session.id);
    const updated = await service.updateExhibitionCondition(session.id, input, () => true);
    expect(updated).toMatchObject({ id: session.id, targetItemId: 'city', referenceAsset: input.referenceAsset, refImageUrl: input.refImageUrl, referenceVersion: 2,
      resultAvailable: false, verification: 'none', exhibition: { lookId: 'city', sessionNumber: 3, generationNumber: 6, mode: 'clothx' } });
    expect(updated).not.toHaveProperty('token'); expect(updated).not.toHaveProperty('tokenCipher'); expect(updated).not.toHaveProperty('providerKeyCipher');
    expect(store.get(session.id)).toMatchObject({ tokenCipher: original.tokenCipher, providerKeyCipher: original.providerKeyCipher, providerSessionId: original.providerSessionId,
      expiresAt: original.expiresAt, pointsLimit: original.pointsLimit, consumedCredits: original.consumedCredits, providerRegion: 'cn', firstFrameMs: 750, createdAt: original.createdAt });
    expect(store.get(session.id).resultUrl).toBeUndefined(); expect(store.list()).toHaveLength(1);
    expect(issueKey).toHaveBeenCalledTimes(1); expect(deactivate).not.toHaveBeenCalled();
  });

  it('treats a repeated accepted condition as idempotent and rejects changed or older generations', async () => {
    const { store, service, session, input, resolveHost } = await fixture();
    const accepted = await service.updateExhibitionCondition(session.id, input, () => true);
    await expect(service.updateExhibitionCondition(session.id, input, () => true)).resolves.toEqual(accepted);
    expect(resolveHost).not.toHaveBeenCalled();
    await expect(service.updateExhibitionCondition(session.id, { ...input, generationNumber: 5 }, () => true)).rejects.toMatchObject({ code: 'EXHIBITION_STALE_GENERATION', statusCode: 409 });
    await expect(service.updateExhibitionCondition(session.id, { ...input, bindingId: 'unknown' }, () => true)).rejects.toMatchObject({ code: 'REFERENCE_NOT_READY' });
    await expect(service.updateExhibitionCondition(session.id, input, () => false)).rejects.toMatchObject({ code: 'EXHIBITION_STALE_GENERATION' });
    expect(store.get(session.id).referenceVersion).toBe(2);
  });

  it.each([
    ['mirror', { mirrorId: 'other' }, 'EXHIBITION_MIRROR_MISMATCH'],
    ['device', { deviceId: 'other-screen' }, 'EXHIBITION_OWNER_MISMATCH'],
    ['round', { sessionNumber: 4 }, 'EXHIBITION_OWNER_MISMATCH'],
    ['mode', { mode: 'charx' }, 'EXHIBITION_SESSION_INCOMPATIBLE'],
    ['MoX', { mode: 'mox' }, 'EXHIBITION_SESSION_INCOMPATIBLE'],
  ] as const)('rejects a different %s before mutating the active lease', async (_name, patch, code) => {
    const { store, service, session, input, resolveHost } = await fixture(); const original = store.get(session.id);
    await expect(service.updateExhibitionCondition(session.id, { ...input, ...patch }, () => true)).rejects.toMatchObject({ code });
    expect(store.get(session.id)).toEqual(original); expect(resolveHost).not.toHaveBeenCalled();
  });

  it.each([
    ['ordinary', { exhibition: undefined }, 'EXHIBITION_MIRROR_MISMATCH'],
    ['unlinked', { providerSessionId: undefined }, 'SESSION_NOT_LINKED'],
    ['inactive', { status: 'stopped' }, 'SESSION_INACTIVE'],
    ['photo', { sourceKind: 'photo' }, 'EXHIBITION_SESSION_INCOMPATIBLE'],
  ] as const)('rejects an %s session', async (_name, patch, code) => {
    const { store, service, session, input } = await fixture(); store.update(session.id, patch); const original = store.get(session.id);
    await expect(service.updateExhibitionCondition(session.id, input, () => true)).rejects.toMatchObject({ code });
    expect(store.get(session.id)).toEqual(original);
  });

  it('checks camera lease compatibility synchronously without provider access', async () => {
    const { store, service, session, resolveHost, issueKey, deactivate } = await fixture();
    expect(service.canUpdateExhibitionCondition(session.id, 'default')).toBe(true);
    expect(service.canUpdateExhibitionCondition(session.id, 'other')).toBe(false);
    expect(service.canUpdateExhibitionCondition('missing', 'default')).toBe(false);
    for (const patch of [{ providerSessionId: undefined }, { status: 'stopped' as const }, { sourceKind: 'photo' as const }]) {
      const original = store.get(session.id); store.update(session.id, patch);
      expect(service.canUpdateExhibitionCondition(session.id, 'default')).toBe(false); store.update(session.id, original);
    }
    expect(resolveHost).not.toHaveBeenCalled(); expect(issueKey).toHaveBeenCalledTimes(1); expect(deactivate).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown binding', { bindingId: 'unknown' }, 'REFERENCE_NOT_READY'],
    ['missing binding', { bindingId: undefined }, 'REFERENCE_BINDING_INVALID'],
    ['foreign upload', { referenceAsset: '/api/exhibition/mirrors/other/assets/upload-12345678-1234-1234-1234-123456789012' }, 'EXHIBITION_INVALID_REFERENCE'],
    ['no image outside Free', { referenceKind: 'none', referenceAsset: '', refImageUrl: '' }, 'EXHIBITION_INVALID_REFERENCE'],
  ] as const)('rejects %s without replacing accepted condition', async (_name, patch, code) => {
    const { store, service, session, input } = await fixture(); const original = store.get(session.id);
    await expect(service.updateExhibitionCondition(session.id, { ...input, ...patch }, () => true)).rejects.toMatchObject({ code });
    expect(store.get(session.id)).toEqual(original);
  });

  it('switches Free between uploaded references and prompt-only conditions within one lease', async () => {
    const { store, service, session, input, resolveHost } = await fixture('free');
    const promptOnly = { ...input, referenceKind: 'none' as const, referenceAsset: '', refImageUrl: '' };
    const accepted = await service.updateExhibitionCondition(session.id, promptOnly, () => true);
    expect(accepted).toMatchObject({ referenceAsset: '', refImageUrl: '', referenceVersion: 2, exhibition: { prompt: '新的油画风格' } });
    expect(resolveHost).not.toHaveBeenCalled();
    await expect(service.updateExhibitionCondition(session.id, { ...input, generationNumber: 7 }, () => true)).resolves.toMatchObject({ referenceVersion: 3, refImageUrl: input.refImageUrl });
    expect(store.list()).toHaveLength(1);
    await expect(service.updateExhibitionCondition(session.id, { ...promptOnly, generationNumber: 8, refImageUrl: 'https://uploads.example/cover.webp' }, () => true)).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_REFERENCE' });
    await expect(service.updateExhibitionCondition(session.id, { ...promptOnly, generationNumber: 8, prompt: '  ' }, () => true)).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_PROMPT' });
  });

  it('rejects a newer selection before mutation without asynchronous DNS', async () => {
    const { store, service, session, input, resolveHost } = await fixture(); const original = store.get(session.id);
    await expect(service.updateExhibitionCondition(session.id, input, () => false)).rejects.toMatchObject({ code: 'EXHIBITION_STALE_GENERATION' });
    expect(store.get(session.id)).toEqual(original); expect(resolveHost).not.toHaveBeenCalled();
  });

  it('coalesces concurrent identical accepted conditions to a single version', async () => {
    const { store, service, session, input, resolveHost } = await fixture();
    const results = await Promise.all([service.updateExhibitionCondition(session.id, input, () => true), service.updateExhibitionCondition(session.id, input, () => true)]);
    expect(results[0]).toEqual(results[1]); expect(store.get(session.id).referenceVersion).toBe(2); expect(resolveHost).not.toHaveBeenCalled();
  });
});
