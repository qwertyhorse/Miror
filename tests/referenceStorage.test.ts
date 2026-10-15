import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createReferenceCosProvider, referenceStorage } from '../server/referenceStorage';
const bytes = Buffer.from('original transparent image');
const sha = createHash('sha256').update(bytes).digest('hex');
const sts = { success: true, data: { bucket: 'fixture-123', region: 'ap-test', prefix: 'references/',
  credentials: { accessKeyId: 'fixture-id', secretAccessKey: 'fixture-secret', sessionToken: 'fixture-sts' } } };
const url = `https://fixture-123.cos.ap-test.myqcloud.com/references/miror-reference-${sha}.png`;
it.each(['cn', 'global'] as const)('preserves bytes and MIME and safety checks with the same %s account', async region => {
  const call = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(sts)).mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(Response.json({ success: true, data: { safe: true, url } }));
  const provider = referenceStorage('uk-fixture-only', region, call, async () => ['8.8.8.8']);
  expect(await provider.upload(bytes, sha, 'image/png')).toBe(url);
  const base = region === 'cn' ? 'https://api.xmaxai.com' : 'https://api.xmax.ai';
  expect(call.mock.calls[0][0]).toBe(base + '/open/api/v1/cos/sts');
  expect(call.mock.calls[1][0]).toBe(url);
  expect(Buffer.from(call.mock.calls[1][1]!.body as Uint8Array)).toEqual(bytes);
  expect(call.mock.calls[1][1]!.headers).toMatchObject({ 'Content-Type': 'image/png', 'x-cos-security-token': 'fixture-sts', Authorization: expect.stringContaining('q-signature=') });
  expect(call.mock.calls[2][0]).toBe(base + '/open/api/v1/cos/image/check');
  expect(call.mock.calls[2][1]).toMatchObject({ redirect: 'error', body: JSON.stringify({ url }), headers: { 'X-Api-Key': 'uk-fixture-only' } });
});
it('rejects unsafe or malformed checked URLs and never repeats ambiguous writes', async () => {
  for (const data of [{ safe: false, url }, { safe: true, url: 'http://127.0.0.1/private' }, {}]) {
    const call = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(sts)).mockResolvedValueOnce(new Response())
      .mockResolvedValueOnce(Response.json({ success: true, data }));
    await expect(referenceStorage('uk-fixture', 'cn', call, async () => ['8.8.8.8']).upload(bytes, sha, 'image/png')).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(3);
  }
  const call = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(sts)).mockRejectedValueOnce(new Error('lost put reply'));
  await expect(referenceStorage('uk-fixture', 'cn', call, async () => ['8.8.8.8']).upload(bytes, sha, 'image/png')).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(2);
});
it('refreshes STS only on explicit expiry and reuses fresh STS across materials', async () => {
  const call = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(sts))
    .mockResolvedValueOnce(new Response('<Code>ExpiredToken</Code>', { status: 403 }))
    .mockResolvedValueOnce(Response.json(sts)).mockResolvedValue(new Response());
  const provider = createReferenceCosProvider({ apiKey: 'uk-fixture', fetch: call });
  expect(await provider.upload(bytes, sha, 'image/png')).toEqual({ ok: true, url });
  await provider.upload(bytes, sha, 'image/png');
  expect(call.mock.calls.filter(([target]) => String(target).endsWith('/cos/sts'))).toHaveLength(2);
});
it('distinguishes a missing object from network uncertainty without following redirects', async () => {
  const call = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 })).mockRejectedValueOnce(new Error('offline'));
  const provider = referenceStorage('uk-fixture', 'global', call, async () => ['8.8.8.8']);
  expect(await provider.check(url)).toBe(false);
  await expect(provider.check(url)).rejects.toThrow(); await expect(provider.check(url)).rejects.toThrow();
  await expect(provider.check('http://127.0.0.1/private')).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(3);
  expect(call.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
});
it('verifies DNS at preparation before uploading and keeps bind acquisition independent of DNS', async () => {
  const call = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(sts));
  const resolveHost = vi.fn(async () => ['127.0.0.1']);
  await expect(referenceStorage('uk-fixture', 'cn', call, resolveHost).upload(bytes, sha, 'image/png')).rejects.toThrow();
  expect(resolveHost).toHaveBeenCalledOnce(); expect(call).toHaveBeenCalledOnce();
});
it('bounds a hanging preparation resolver, releases deadline timer, and never sends COS PUT', async () => {
  vi.useFakeTimers();
  try {
    const call = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(sts));
    const provider = referenceStorage('uk-fixture', 'cn', call, () => new Promise(() => undefined), { dnsTimeoutMs: 1_000 });
    const pending = expect(provider.upload(bytes, sha, 'image/png')).rejects.toMatchObject({ stage: 'availability', failure: 'timeout' });
    await vi.advanceTimersByTimeAsync(1_000); await pending;
    expect(call).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('cleans a successful resolver deadline and also bounds hanging availability refresh', async () => {
  vi.useFakeTimers();
  try {
    const call = vi.fn<typeof fetch>().mockResolvedValue(new Response());
    const checked = referenceStorage('uk-fixture', 'cn', call, async () => ['8.8.8.8'], { dnsTimeoutMs: 1_000 });
    await expect(checked.check(url)).resolves.toBe(true); expect(vi.getTimerCount()).toBe(0);
    const hanging = referenceStorage('uk-fixture', 'cn', call, () => new Promise(() => undefined), { dnsTimeoutMs: 1_000 });
    const pending = expect(hanging.check(url)).rejects.toMatchObject({ stage: 'availability', failure: 'timeout' });
    await vi.advanceTimersByTimeAsync(1_000); await pending;
    expect(call).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
