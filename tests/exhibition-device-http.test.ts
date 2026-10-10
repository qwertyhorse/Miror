import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { createApiServer } from '../server/http.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { ExhibitionDeviceConnectInput, ExhibitionDeviceConnection } from '../shared/exhibition.ts';
import type { IssuedKey, KeyStatus, Provider } from '../server/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const finish of cleanup.splice(0)) await finish(); });

function terminal(): ExhibitionDeviceConnectInput {
  return { terminalId: `terminal-${randomUUID()}`, token: randomBytes(32).toString('hex'), label: '测试安卓镜端', platform: 'android' };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-device-http-'));
  let time = Date.now();
  const store = new SessionStore(':memory:'); const keys = new Map<string, KeyStatus>();
  const issue = vi.fn(async (): Promise<IssuedKey> => {
    const token = `tk-device-http-${keys.size + 1}`; const expiresAt = new Date(time + 120000).toISOString();
    keys.set(token, { status: 'active', consumedCredit: 0, expireTimestamp: expiresAt }); return { token, expiresAt };
  });
  const provider: Provider = { configured: true, issueKey: issue, keyStatus: async token => keys.get(token)!,
    deactivate: async token => { const value = { ...keys.get(token)!, status: 'inactive' as const }; keys.set(token, value); return value; },
    sessionStatus: async (_token, sessionUid) => ({ sessionUid, status: 'ACTIVE', consumedCredit: 0 }) };
  const service = new TryOnService({ provider, store, secrets: new SecretBox(randomBytes(32)) });
  const mirrors = new ExhibitionMirrors(directory, { now: () => time });
  const server = createApiServer(service, ['http://xuminghong.local:10200'], undefined, mirrors);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Origin: 'http://xuminghong.local:10200', 'Content-Type': 'application/json' };
  const request = (path: string, input?: unknown, method = input === undefined ? 'GET' : 'POST', origin = headers.Origin) => fetch(base + path, {
    method, headers: { ...headers, Origin: origin }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const root = (id = 'default') => `/api/exhibition/mirrors/${id}`;
  const connect = async (input: ExhibitionDeviceConnectInput) => {
    const response = await request('/api/exhibition/terminals/connect', input); expect(response.status).toBe(200);
    return await response.json() as ExhibitionDeviceConnection;
  };
  const bind = async (id: string, input: ExhibitionDeviceConnectInput) => {
    const connection = await connect(input);
    const response = await request(root(id) + '/binding', { code: connection.code }); expect(response.status).toBe(200);
    return response.json();
  };
  const start = (id = 'default') => {
    const mirror = mirrors.getMirror(id);
    mirror.command({ action: 'configure', providerMode: 'xmax', autoReturnSeconds: 0 }); mirror.command({ action: 'begin' });
    return { deviceId: 'test-device-browser', lookId: mirror.get().selectedLookId, generationNumber: mirror.get().generationNumber };
  };
  cleanup.push(async () => { server.close(); await once(server, 'close'); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { mirrors, store, issue, request, root, connect, bind, start, advance: (ms: number) => { time += ms; } };
}

describe('mirror terminal binding HTTP boundary', () => {
  it('provides a non-native fallback and binds only a private, one-use terminal code', async () => {
    const { request, root, connect } = await fixture(); const device = terminal();
    const native = await request('/api/exhibition/native-identity');
    expect(native.status).toBe(200); expect(await native.json()).toEqual({ native: false });
    const connection = await connect(device);
    expect(connection).toMatchObject({ terminalId: device.terminalId, mirrorId: null, code: expect.stringMatching(/^\d{6}$/), expiresAt: expect.any(Number) });
    expect(JSON.stringify(connection)).not.toContain(device.token);
    const bound = await request(root() + '/binding', { code: connection.code });
    expect(bound.status).toBe(200); expect(await bound.json()).toMatchObject({ terminalId: device.terminalId, label: device.label, platform: 'android', online: true });
    const following = await connect(device);
    expect(following).toMatchObject({ terminalId: device.terminalId, mirrorId: 'default', mirrorName: expect.any(String) });
    expect(following.code).toBeUndefined(); expect(following.expiresAt).toBeUndefined();
    const registry = await request('/api/exhibition/mirrors'); const summary = await registry.json();
    expect(summary.mirrors[0].binding).toMatchObject({ terminalId: device.terminalId, online: true });
    expect(JSON.stringify(summary)).not.toContain(device.token); expect(JSON.stringify(summary)).not.toContain(connection.code!);
  });

  it('rejects foreign-origin registration and pairing without changing the binding', async () => {
    const { request, root, mirrors, connect } = await fixture(); const device = terminal();
    const rejected = await request('/api/exhibition/terminals/connect', device, 'POST', 'https://outside.example');
    expect(rejected.status).toBe(403); expect(await rejected.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    const connection = await connect(device);
    expect((await request(root() + '/binding', { code: connection.code }, 'POST', 'https://outside.example')).status).toBe(403);
    expect(mirrors.list().mirrors[0].binding).toBeNull();
    expect((await request(root('missing') + '/binding', { code: connection.code })).status).toBe(404);
    expect((await request(root() + '/binding', { code: connection.code })).status).toBe(200);
    const wrongToken = await request('/api/exhibition/terminals/connect', { ...device, token: randomBytes(32).toString('hex') });
    expect(wrongToken.status).toBe(403); expect(await wrongToken.json()).toMatchObject({ code: 'EXHIBITION_DEVICE_UNAUTHORIZED' });
  });

  it('protects scoped and legacy-default live creation before any state or budget mutation', async () => {
    const { request, root, bind, start, mirrors, store, issue } = await fixture(); const device = terminal();
    await bind('default', device); const input = start(); const before = mirrors.getMirror().get();
    for (const path of [root() + '/live/session', '/api/exhibition/live/session']) {
      for (const credentials of [{}, { terminalId: device.terminalId, terminalToken: 'wrong-token-with-at-least-thirty-two-characters' }, { terminalId: terminal().terminalId, terminalToken: device.token }]) {
        const denied = await request(path, { ...input, ...credentials });
        expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ code: 'EXHIBITION_DEVICE_UNAUTHORIZED' });
      }
    }
    expect(mirrors.getMirror().get()).toEqual(before); expect(issue).not.toHaveBeenCalled(); expect(store.allocated()).toBe(0);
    const allowed = await request('/api/exhibition/live/session', { ...input, terminalId: device.terminalId, terminalToken: device.token });
    expect(allowed.status).toBe(201); expect(issue).toHaveBeenCalledOnce(); expect(store.allocated()).toBe(30);
  });

  it('limits a bound non-default mirror to its own terminal while keeping unbound legacy behavior', async () => {
    const { request, root, bind, start, mirrors, issue } = await fixture();
    const id = mirrors.create({ name: '另一台镜' }).id; const device = terminal(); await bind(id, device);
    const input = start(id);
    expect((await request(root(id) + '/live/session', input)).status).toBe(403);
    const allowed = await request(root(id) + '/live/session', { ...input, terminalId: device.terminalId, terminalToken: device.token });
    expect(allowed.status).toBe(201); expect((await allowed.json()).exhibition.mirrorId).toBe(id);
    expect((await request(root() + '/live/session', start())).status).toBe(201);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('requires an idle mirror and the exact current terminal ID to unbind', async () => {
    const { request, root, connect, mirrors, start, issue } = await fixture(); const device = terminal(); const connection = await connect(device);
    mirrors.getMirror().command({ action: 'begin' });
    const busy = await request(root() + '/binding', { code: connection.code });
    expect(busy.status).toBe(409); expect(await busy.json()).toMatchObject({ code: 'EXHIBITION_MIRROR_BUSY' });
    mirrors.getMirror().command({ action: 'end' });
    expect((await request(root() + '/binding', { code: connection.code })).status).toBe(200);
    mirrors.getMirror().command({ action: 'begin' });
    expect((await request(root() + '/binding', { terminalId: device.terminalId }, 'DELETE')).status).toBe(409);
    mirrors.getMirror().command({ action: 'end' });
    const stale = await request(root() + '/binding', { terminalId: terminal().terminalId }, 'DELETE');
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'EXHIBITION_DEVICE_BINDING_CHANGED' });
    expect(mirrors.list().mirrors[0].binding?.terminalId).toBe(device.terminalId);
    const removed = await request(root() + '/binding', { terminalId: device.terminalId }, 'DELETE');
    expect(removed.status).toBe(200); expect(await removed.json()).toEqual({ binding: null });
    expect(mirrors.list().mirrors[0].binding).toBeNull();
    const newConnection = await connect(device); expect(newConnection.mirrorId).toBeNull(); expect(newConnection.code).not.toBe(connection.code);
    const oldCode = await request(root() + '/binding', { code: connection.code });
    expect(oldCode.status).toBe(409); expect(await oldCode.json()).toMatchObject({ code: 'EXHIBITION_PAIRING_CODE_INVALID' });
    const formerOwner = await request(root() + '/live/session', { ...start(), terminalId: device.terminalId, terminalToken: device.token });
    expect(formerOwner.status).toBe(403); expect(await formerOwner.json()).toMatchObject({ code: 'EXHIBITION_DEVICE_UNAUTHORIZED' });
    expect(issue).not.toHaveBeenCalled();
  });

  it('reports code expiry and connection freshness without exposing pairing data in the registry', async () => {
    const { request, root, connect, advance, mirrors } = await fixture(); const device = terminal(); const connection = await connect(device);
    advance(10 * 60 * 1000);
    const expired = await request(root() + '/binding', { code: connection.code });
    expect(expired.status).toBe(410); expect(await expired.json()).toMatchObject({ code: 'EXHIBITION_PAIRING_CODE_EXPIRED' });
    const refreshed = await connect(device); expect(refreshed.code).not.toBe(connection.code);
    expect((await request(root() + '/binding', { code: refreshed.code })).status).toBe(200);
    advance(30000); expect(mirrors.list().mirrors[0].binding?.online).toBe(false);
    await connect(device); expect(mirrors.list().mirrors[0].binding?.online).toBe(true);
  });
});
