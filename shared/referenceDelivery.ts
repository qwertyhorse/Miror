/** Content identity is derived from local reference bytes by the backend, never trusted from HTTP. */
export interface ReferenceDeliveryIdentity { sha256: string; mime: string }
export interface PreparedReferenceBinding extends ReferenceDeliveryIdentity {
  bindingId: string; scope: string; url: string; freshUntil: number; providerExpiresAt?: number;
}
