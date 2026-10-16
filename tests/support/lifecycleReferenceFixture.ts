import { createHash } from 'node:crypto';
import { TryOnService } from '../../server/service';
import { ApiError } from '../../server/types';
import type { ReferenceDeliveryIdentity } from '../../shared/referenceDelivery';
import type { ReadyReference } from '../../server/referenceAssets';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Lifecycle suites isolate media preparation at its public seam. The real persisted
 * delivery, expiry, account and publication contracts have dedicated integration suites. */
export class LifecycleTryOnService extends TryOnService {
  private fixtures = new Map<string, ReadyReference>();
  override readyReference(mirrorId: string, bytes: Buffer, mime: string) { return this.readyReferenceIdentity(mirrorId, { sha256: hash(bytes), mime }); }
  override readyReferenceIdentity(mirrorId: string, identity: ReferenceDeliveryIdentity) {
    if (!this.providerDescriptor(mirrorId).configured) return null;
    const status = this.providerDescriptor(mirrorId); const scope = this.materialScope(mirrorId);
    const { sha256, mime } = identity; const bindingId = hash(`${scope}:${sha256}:${mime}`);
    const value = { bindingId, sha256, scope, freshUntil: Number.MAX_SAFE_INTEGER,
      url: status.providerId === 'decart' ? `file_${sha256}` : `https://fixture-123.cos.ap-test.myqcloud.com/${sha256}.png` };
    this.fixtures.set(bindingId, value); return value;
  }
  override assertReferenceBinding(_mirrorId: string, bindingId: unknown, expected: ReferenceDeliveryIdentity | undefined) {
    const value = typeof bindingId === 'string' ? this.fixtures.get(bindingId) : undefined;
    if (!value || value.sha256 !== expected?.sha256) throw new ApiError('REFERENCE_BINDING_INVALID', 'Fixture requires a prepared binding', 409);
    return value;
  }
  override referencePreparationStatus() { return { state: 'ready' as const, freshUntil: Number.MAX_SAFE_INTEGER }; }
  override isReferenceReadyForProvider() { return true; }
}

/** Add the same explicit delivery seam to small lifecycle provider doubles. */
export function withLifecycleReferenceDelivery<T extends object>(service: T): T {
  const bindings = new Map<string, ReadyReference>();
  const identityReady = (_mirrorId: string, identity: ReferenceDeliveryIdentity) => { const { sha256, mime } = identity; const value = { bindingId: hash(`${sha256}:${mime}`), sha256, scope: hash('lifecycle-fixture'), freshUntil: Number.MAX_SAFE_INTEGER, url: `https://fixture-123.cos.ap-test.myqcloud.com/${sha256}.png` }; bindings.set(value.bindingId, value); return value; };
  return Object.assign(service, {
    providerDescriptor: (mirrorId: string) => (service as T & { status: (id: string) => unknown }).status(mirrorId),
    readyReferenceIdentity: identityReady,
    materialScope: () => hash('lifecycle-fixture'),
    materialProviderConfigured: () => true,
    readyReference(_mirrorId: string, bytes: Buffer, mime: string) {
      const sha256 = hash(bytes); const value = { bindingId: hash(`${sha256}:${mime}`), sha256, scope: hash('lifecycle-fixture'), freshUntil: Number.MAX_SAFE_INTEGER, url: `https://fixture-123.cos.ap-test.myqcloud.com/${sha256}.png` };
      bindings.set(value.bindingId, value); return value;
    },
    assertReferenceBinding(_mirrorId: string, bindingId: string, expected: ReferenceDeliveryIdentity) {
      const value = bindings.get(bindingId);
      if (!value || value.sha256 !== expected.sha256) throw new ApiError('REFERENCE_BINDING_INVALID', 'Fixture requires a prepared binding', 409);
      return value;
    },
    bindExhibitionReference: async () => ({}),
    referencePreparationStatus: () => ({ state: 'ready' as const, freshUntil: Number.MAX_SAFE_INTEGER }),
    isReferenceReadyForProvider: () => true,
  });
}
