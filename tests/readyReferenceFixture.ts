/** Models backend acquisition only: no transport, SDK, or file upload. */
export function readyReferenceFixture(url: string, scope: string | undefined = undefined) {
  return { url, scope: scope as string, freshUntil: Date.now() + 60_000, bindingId: `binding:${url}`, sha256: 'a'.repeat(64) };
}
export function resolvedBinding(bindingId: string | undefined) { return bindingId?.replace(/^binding:/, '') ?? ''; }
