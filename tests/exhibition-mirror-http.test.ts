import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTINUOUS_SEGMENT_CREDITS } from '../shared/sessionLimits';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { createApiServer } from '../server/http.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import { ApiError, type IssuedKey, type KeyStatus, type Provider } from '../server/types.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });

async function fixture(totalLimit = 360) {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-mirror-http-'));
  const store = new SessionStore(':memory:');
  const keys = new Map<string, KeyStatus>();
  const issue = vi.fn(async (): Promise<IssuedKey> => {
    const token = `tk-mirror-test-${keys.size + 1}`;
    const expiresAt = new Date(Date.now() + 120000).toISOString();
    keys.set(token, { status: 'active', consumedCredit: 1, expireTimestamp: expiresAt });
    return { token, expiresAt };
  });
  const deactivate = vi.fn(async (token: string) => {
    const status = { ...keys.get(token)!, status: 'inactive' as const };
    keys.set(token, status); return status;
  });
  const keyStatus = vi.fn(async (token: string) => keys.get(token)!);
  const sessionStatus = vi.fn(async (_token: string, sessionUid: string) => ({ sessionUid, status: 'ACTIVE', consumedCredit: 1 }));
  const provider: Provider = { configured: true, issueKey: issue, deactivate, keyStatus, sessionStatus };
  const resolveHost = vi.fn(async () => ['8.8.8.8']);
  const service = new LifecycleTryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)), catalog: async () => [], totalLimit, resolveHost });
  const mirrors = new ExhibitionMirrors(directory);
  const server = createApiServer(service, ['http://xuminghong.local:10200'], undefined, mirrors);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, value?: unknown, method = value === undefined ? 'GET' : 'POST', protocol = '2') => fetch(base + path, {
    method, headers: { 'X-Miror-Protocol': protocol, 'X-Miror-Material': 'catalog-v2', 'Content-Type': 'application/json', Origin: 'http://xuminghong.local:10200' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const root = (id: string) => `/api/exhibition/mirrors/${id}`;
  const start = (id: string) => {
    const mirror = mirrors.getMirror(id);
    mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 });
    mirror.command({ action: 'begin' });
    return { deviceId: 'shared-browser-device', lookId: mirror.get().selectedLookId, generationNumber: mirror.get().generationNumber };
  };
  cleanups.push(async () => { server.close(); await once(server, 'close'); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { mirrors, service, store, issue, deactivate, keyStatus, sessionStatus, resolveHost, request, root, start };
}

describe('mirror-scoped exhibition HTTP APIs', () => {
  it('requires the current terminal protocol before issuing a credential', async () => {
    const { request, root, start, issue } = await fixture(); const input = start('default');
    const response = await request(root('default') + '/live/session', input, 'POST', '1');
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ code: 'EXHIBITION_CLIENT_UPGRADE_REQUIRED' });
    expect(issue).not.toHaveBeenCalled();
  });

  it('uses the prepared binding despite DNS outage and rejects client URL replacement', async () => {
    const { request, root, start, resolveHost, store, issue, sessionStatus } = await fixture();
    const input = start('default');
    const created = await request(root('default') + '/live/session', input);
    expect(created.status).toBe(201); const session = await created.json();
    resolveHost.mockRejectedValueOnce(new ApiError('MEDIA_DNS_UNAVAILABLE', '素材地址解析失败，请重试。', 502));
    const failed = await request(root('default') + `/live/session/${session.id}/reference`, {
      deviceId: input.deviceId, lookId: input.lookId, refImageUrl: 'https://uploads.example/a.webp',
    });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ code: 'EXHIBITION_REFERENCE_LOCKED' });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(store.get(session.id)).toMatchObject({ referenceVersion: 1, refImageUrl: expect.stringMatching(/^https:/) });
    expect(store.get(session.id).providerSessionId).toBeUndefined();
    expect(issue).toHaveBeenCalledOnce(); expect(sessionStatus).not.toHaveBeenCalled();
    const stopped = await request(root('default') + `/sessions/${session.id}/stop`, {});
    expect(stopped.status).toBe(200); expect(await stopped.json()).toMatchObject({ status: 'stopped' });
  });

  it('maintains an explicit mirror registry and never falls back from an unknown mirror', async () => {
    const { mirrors, request, root } = await fixture();
    const created = await request('/api/exhibition/mirrors', { name: '右侧试衣镜' });
    expect(created.status).toBe(201); const mirror = await created.json();
    expect(mirror).toMatchObject({ name: '右侧试衣镜' });
    expect((await request(root(mirror.id))).status).toBe(200);
    const renamed = await request(root(mirror.id), { name: '入口试衣镜' }, 'PATCH');
    expect(renamed.status).toBe(200); expect(await renamed.json()).toMatchObject({ id: mirror.id, name: '入口试衣镜' });
    const listed = await request('/api/exhibition/mirrors');
    expect(await listed.json()).toMatchObject({ defaultMirrorId: 'default', mirrors: expect.arrayContaining([expect.objectContaining({ id: mirror.id, name: '入口试衣镜' })]) });
    const before = mirrors.getMirror().get();
    expect((await request(root('missing-mirror'))).status).toBe(404);
    expect((await request(root('missing-mirror') + '/command', { action: 'begin' })).status).toBe(404);
    expect(mirrors.getMirror().get()).toEqual(before);
    expect(await (await request('/api/exhibition')).json()).toEqual(before);
  });

  it('copies the requested source into the addressed target with revision protection', async () => {
    const { mirrors, request, root } = await fixture();
    const source = mirrors.create({ name: '来源镜' }); const target = mirrors.create({ name: '目标镜' });
    const configure = await request(root(source.id) + '/command', { action: 'configure', autoReturnSeconds: 180, enabledLookIds: ['evening', 'city'] });
    expect(configure.status).toBe(200); const sourceState = await configure.json();
    const before = mirrors.getMirror(target.id).get();
    const input = { sourceMirrorId: source.id, copyLooks: true, copySettings: true, expectedRevision: before.revision };
    const copied = await request(root(target.id) + '/copy', input);
    expect(copied.status).toBe(200); expect(await copied.json()).toMatchObject({ mirrorId: target.id, phase: 'idle', enabledLookIds: ['evening', 'city'], settings: { autoReturnSeconds: 180 } });
    const stale = await request(root(target.id) + '/copy', input);
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
    expect(mirrors.getMirror(source.id).get()).toEqual(sourceState);
  });

  it('appends one independent material to the addressed target group with revision protection', async () => {
    const { mirrors, request, root } = await fixture();
    const source = mirrors.create({ name: '素材来源镜' }); const target = mirrors.create({ name: '素材目标镜' });
    const sourceBefore = mirrors.getMirror(source.id).read(); const before = mirrors.getMirror(target.id).read();
    const input = { sourceMirrorId: source.id, sourceLookId: 'commute', mode: 'free', prompt: '人物身后出现彩虹', expectedRevision: before.revision };
    const response = await request(root(target.id) + '/looks/copy', input);
    expect(response.status).toBe(200); const state = await response.json(); const copied = state.looks.at(-1);
    expect(copied).toMatchObject({ mode: 'free', prompt: input.prompt, source: 'upload', name: sourceBefore.looks[0].name, mime: 'image/webp' });
    expect(copied.id).not.toBe('commute'); expect(copied.image).toContain(root(target.id) + '/assets/');
    expect(state).toMatchObject({ mirrorId: target.id, selectedLookId: before.selectedLookId, experienceMode: before.experienceMode, settings: before.settings });
    expect(state.looks.slice(0, -1)).toEqual(before.looks); expect(mirrors.getMirror(source.id).read()).toEqual(sourceBefore);
    expect((await request(copied.image)).status).toBe(200); expect((await request(copied.referenceImage)).status).toBe(200);
    const stale = await request(root(target.id) + '/looks/copy', input);
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
    const ownGroup = await request(root(target.id) + '/looks/copy', { ...input, sourceMirrorId: target.id, sourceLookId: copied.id, mode: 'mox', expectedRevision: state.revision });
    expect(ownGroup.status).toBe(200); expect((await ownGroup.json()).looks.at(-1)).toMatchObject({ mode: 'mox' });
  });

  it('validates material-copy bodies and never falls back from a missing source or target', async () => {
    const { mirrors, request, root } = await fixture(); const before = mirrors.getMirror().read();
    const path = root('default') + '/looks/copy';
    const input = { sourceMirrorId: 'default', sourceLookId: 'commute', mode: 'clothx', expectedRevision: before.revision };
    expect((await request(path, {})).status).toBe(400);
    expect((await request(root('missing') + '/looks/copy', input)).status).toBe(404);
    expect((await request(path, { ...input, sourceMirrorId: 'missing' })).status).toBe(404);
    expect((await request(path, { ...input, sourceLookId: 'missing' })).status).toBe(404);
    expect((await request('/api/exhibition/looks/copy', input)).status).toBe(404);
    expect(mirrors.getMirror().read()).toEqual(before);
  });

  it('rejects every wrong-mirror and legacy session path before provider calls or mutations', async () => {
    const { mirrors, store, request, root, start, keyStatus, sessionStatus, deactivate, resolveHost } = await fixture();
    const a = mirrors.create({ name: '试衣镜 A' }); const b = mirrors.create({ name: '试衣镜 B' });
    const aInput = start(a.id); start(b.id);
    const created = await request(root(a.id) + '/live/session', aInput);
    expect(created.status).toBe(201); const session = await created.json();
    expect(session.exhibition.mirrorId).toBe(a.id);
    const original = store.get(session.id);
    const beforeA = mirrors.getMirror(a.id).get(); const beforeB = mirrors.getMirror(b.id).get();
    const denied: [string, unknown?, string?][] = [
      [root(b.id) + `/sessions/${session.id}`],
      [root(b.id) + `/sessions/${session.id}/link`, { providerSessionId: 'ums-wrong-mirror' }],
      [root(b.id) + `/sessions/${session.id}/first-frame`, { firstFrameMs: 120 }],
      [root(b.id) + `/sessions/${session.id}/stop`, {}],
      [root(b.id) + `/live/session/${session.id}/reference`, { ...aInput, refImageUrl: 'https://uploads.example/a.webp' }],
      [`/api/sessions/${session.id}`],
      [`/api/sessions/${session.id}/link`, { providerSessionId: 'ums-legacy-bypass' }],
      [`/api/sessions/${session.id}/first-frame`, { firstFrameMs: 120 }],
      [`/api/sessions/${session.id}/stop`, {}],
      [`/api/sessions/${session.id}/reference`, { targetItemId: 'city' }, 'PATCH'],
      [`/api/sessions/${session.id}/outfit-reference`, {}],
      [`/api/sessions/${session.id}/single-reference`, {}],
      [`/api/sessions/${session.id}/result`, {}],
      [`/api/sessions/${session.id}/download`],
      [`/api/exhibition/live/session/${session.id}/reference`, { ...aInput, refImageUrl: 'https://uploads.example/a.webp' }],
    ];
    for (const [path, value, method] of denied) {
      const response = await request(path, value, method);
      const mainSitePath = path.startsWith('/api/sessions/');
      expect(response.status, path).toBe(mainSitePath ? 404 : 409);
      expect(await response.json()).toMatchObject({ code: mainSitePath ? 'NOT_FOUND' : 'EXHIBITION_MIRROR_MISMATCH' });
    }
    expect(keyStatus).not.toHaveBeenCalled(); expect(sessionStatus).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled(); expect(resolveHost).not.toHaveBeenCalled();
    expect(store.get(session.id)).toEqual(original);
    expect(mirrors.getMirror(a.id).get()).toEqual(beforeA); expect(mirrors.getMirror(b.id).get()).toEqual(beforeB);
  });

  it('runs two mirrors from one browser independently and stops only the addressed session', async () => {
    const { mirrors, store, request, root, start, deactivate } = await fixture();
    const a = mirrors.create({ name: '左镜' }); const b = mirrors.create({ name: '右镜' });
    const sessions = [];
    for (const mirror of [a, b]) {
      const input = start(mirror.id);
      const response = await request(root(mirror.id) + '/live/session', input);
      expect(response.status).toBe(201); const session = await response.json(); sessions.push(session);
      expect(session.referenceVersion).toBe(1);
      expect((await request(root(mirror.id) + `/sessions/${session.id}/link`, { providerSessionId: `ums-${mirror.id}` })).status).toBe(200);
      expect((await request(root(mirror.id) + `/sessions/${session.id}/first-frame`, { firstFrameMs: 120 })).status).toBe(200);
      expect(mirrors.getMirror(mirror.id).get().phase).toBe('showcase');
    }
    const beforeB = mirrors.getMirror(b.id).get();
    const stop = await request(root(a.id) + `/sessions/${sessions[0].id}/stop`, {});
    expect(stop.status).toBe(200); expect(store.get(sessions[0].id).status).toBe('stopped');
    expect(store.get(sessions[1].id).status).toBe('active'); expect(deactivate).toHaveBeenCalledTimes(1);
    expect(mirrors.getMirror(b.id).get()).toEqual(beforeB);
    expect((await request(root(b.id) + `/sessions/${sessions[1].id}`)).status).toBe(200);
    expect(store.allocated()).toBe(2 * CONTINUOUS_SEGMENT_CREDITS);
  });

  it('allows simultaneous mirror reservations regardless of the ordinary local test limit', async () => {
    const { mirrors, store, issue, request, root, start } = await fixture(30);
    const a = mirrors.create({ name: '左镜' }); const b = mirrors.create({ name: '右镜' });
    for (const mirror of [a, b]) mirrors.getMirror(mirror.id).command({ action: 'configure', sessionLimits: { credits: 30, expireSeconds: 120 } });
    const responses = await Promise.all([a, b].map(mirror => request(root(mirror.id) + '/live/session', start(mirror.id))));
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    expect(issue).toHaveBeenCalledTimes(2); expect(store.allocated()).toBe(60); expect(store.list()).toHaveLength(2);
  });

  it('scopes uploaded asset reads and deletion to the selected mirror', async () => {
    const { mirrors, request, root } = await fixture();
    const a = mirrors.create({ name: '左镜' }); const b = mirrors.create({ name: '右镜' });
    const bytes = await sharp({ create: { width: 512, height: 768, channels: 4, background: '#aa88ff' } }).png().toBuffer();
    const uploaded = await request(root(a.id) + '/looks', { name: '临时素材', category: '通勤', tags: ['简约'], imageBase64: bytes.toString('base64'), referenceImageBase64: bytes.toString('base64') });
    expect(uploaded.status).toBe(201); const state = await uploaded.json(); const look = state.looks[0];
    expect(look.image).toMatch(new RegExp(`^${root(a.id)}/assets/${look.id}/display/[a-f0-9-]+$`));
    expect((await request(look.referenceImage)).status).toBe(200);
    expect((await request(look.image)).status).toBe(200);
    expect((await request(root(b.id) + `/assets/${look.id}`)).status).toBe(404);
    expect((await request(root(b.id) + `/looks/${look.id}`, {}, 'DELETE')).status).toBe(404);
    expect((await request(`/api/exhibition/assets/${look.id}`)).status).toBe(404);
    expect((await request(look.image)).status).toBe(200);
  });

  it('treats historical session metadata without a mirror ID as the default mirror only', async () => {
    const { mirrors, store, service, request, root, start } = await fixture();
    const input = start('default');
    const response = await request('/api/exhibition/live/session', input); const session = await response.json();
    const metadata = { ...store.get(session.id).exhibition! }; delete metadata.mirrorId;
    store.update(session.id, { exhibition: metadata });
    const legacyResponse = await request(`/api/sessions/${session.id}`);
    expect(legacyResponse.status).toBe(404);
    expect(await legacyResponse.json()).toMatchObject({ code: 'NOT_FOUND' });
    const scopedResponse = await request(root('default') + `/sessions/${session.id}`);
    expect(scopedResponse.status).toBe(200);
    expect(await scopedResponse.json()).toMatchObject({ id: session.id, exhibition: { mirrorId: 'default' } });
    const other = mirrors.create({ name: '新镜' });
    expect((await request(root(other.id) + `/sessions/${session.id}`)).status).toBe(409);
    await expect(service.bindExhibitionReference(session.id, { ...input, mirrorId: other.id, refImageUrl: 'https://uploads.example/a.webp' })).rejects.toMatchObject({ code: 'EXHIBITION_MIRROR_MISMATCH' });
    await expect(service.bindExhibitionReference(session.id, { ...input, refImageUrl: 'https://uploads.example/a.webp' })).rejects.toMatchObject({ code: 'EXHIBITION_REFERENCE_LOCKED' });
  });

  it('rejects another mirror’s reference asset before reserving any credits', async () => {
    const { service, store, issue } = await fixture();
    const lookId = 'upload-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const input = { mirrorId: 'mirror-a', lookId, deviceId: 'screen-reference', name: '测试服装', referenceAsset: `/api/exhibition/mirrors/mirror-b/assets/${lookId}`, sessionNumber: 1, generationNumber: 1 };
    await expect(service.createExhibition(input)).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_REFERENCE' });
    await expect(service.createExhibition({ ...input, referenceAsset: `/api/exhibition/assets/${lookId}` })).rejects.toMatchObject({ code: 'EXHIBITION_INVALID_REFERENCE' });
    expect(store.allocated()).toBe(0); expect(issue).not.toHaveBeenCalled();
  });
});
