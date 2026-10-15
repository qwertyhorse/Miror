import { LifecycleTryOnService } from './support/lifecycleReferenceFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';
import { createApiServer } from '../server/http.ts';
import { TryOnService } from '../server/service.ts';
import { SecretBox, SessionStore } from '../server/store.ts';
import type { ExhibitionCameraReport } from '../shared/exhibitionCamera.ts';
import type { ExhibitionDeviceConnectInput } from '../shared/exhibition.ts';

const resources: { directory: string; server?: Server; store?: SessionStore }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { directory, server, store } of resources.splice(0)) {
    if (server) { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; }
    store?.close(); rmSync(directory, { recursive: true, force: true });
  }
});
const error = (code: string) => expect.objectContaining({ code });
function terminal(label = '摄像头镜端', capable = true): ExhibitionDeviceConnectInput {
  return { terminalId: `terminal-${randomUUID()}`, token: randomBytes(32).toString('hex'), label, platform: 'android',
    ...(capable ? { cameraCapabilities: { version: 1 as const } } : {}) };
}
function fixture() {
  const resource: typeof resources[number] = { directory: mkdtempSync(join(tmpdir(), 'mirror-camera-management-')) }; resources.push(resource);
  let time = 1_800_000_000_000;
  const mirrors = new ExhibitionMirrors(resource.directory, { now: () => time });
  const device = terminal(); const pairing = mirrors.connectDevice(device); mirrors.bindDevice('default', { code: pairing.code });
  const connected = mirrors.connectDevice(device);
  const report = (overrides: Partial<ExhibitionCameraReport> = {}): ExhibitionCameraReport => ({
    mirrorId: 'default', bindingId: connected.cameraBindingId!, requestId: null, status: 'ready',
    devices: [{ id: 'usb-camera-1', label: '绿联摄像头', kind: 'external' }], selectedDeviceId: 'usb-camera-1', activeDeviceId: 'usb-camera-1', ...overrides,
  });
  const open = () => mirrors.openCamera('default', { action: 'open', terminalId: device.terminalId });
  return { resource, mirrors, device, report, open, now: () => time, advance: (ms: number) => { time += ms; } };
}

describe('bound mirror camera diagnostics', () => {
  it('only accepts bounded metadata from the authenticated owner and isolates every mirror', () => {
    const f = fixture(); const otherId = f.mirrors.create({ name: '另一台镜子' }).id; const other = terminal('另一台镜端');
    f.mirrors.bindDevice(otherId, { code: f.mirrors.connectDevice(other).code });
    const otherBinding = f.mirrors.connectDevice(other);
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: { ...f.report(), frame: 'never retained', updatedAt: 123 } }).cameraReportAccepted).toBe(true);
    expect(f.mirrors.cameraStatus('default')).toMatchObject({ state: 'ready', supported: true, online: true, devices: f.report().devices, updatedAt: f.now() });
    expect(f.mirrors.list().mirrors[0].binding?.camera).toEqual(f.mirrors.cameraStatus('default'));
    expect(f.mirrors.cameraStatus(otherId)).toMatchObject({ state: 'idle', devices: [], selectedDeviceId: null });
    const before = f.mirrors.cameraStatus('default');
    expect(() => f.mirrors.connectDevice({ ...f.device, token: randomBytes(32).toString('hex'), cameraReport: f.report() })).toThrow(error('EXHIBITION_DEVICE_UNAUTHORIZED'));
    expect(f.mirrors.connectDevice({ ...other, cameraReport: f.report({ bindingId: otherBinding.cameraBindingId! }) }).cameraReportAccepted).toBe(false);
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ bindingId: randomUUID() }) }).cameraReportAccepted).toBe(false);
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ mirrorId: otherId }) }).cameraReportAccepted).toBe(false);
    expect(f.mirrors.cameraStatus('default')).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('never retained');
    const disk = readFileSync(join(f.resource.directory, 'exhibition-devices.json'), 'utf8');
    expect(disk).not.toContain('usb-camera-1'); expect(disk).not.toContain(f.report().bindingId);
  });

  it('coalesces requests, delivers only to the bound terminal, and waits for a matching close before a new request', () => {
    const f = fixture(); const first = f.open();
    expect(first).toMatchObject({ state: 'requested', request: { action: 'open', mirrorId: 'default', terminalId: f.device.terminalId,
      createdAt: f.now(), expiresAt: f.now() + 120_000, bindingId: f.report().bindingId } });
    expect(f.open().request?.id).toBe(first.request?.id);
    expect(f.mirrors.connectDevice(f.device).cameraRequest).toEqual(first.request);
    expect(f.mirrors.connectDevice(f.device).cameraRequest).toEqual(first.request);
    expect(() => f.mirrors.devices.assertCameraClosed('default')).toThrow(error('EXHIBITION_CAMERA_BUSY'));
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ requestId: first.request!.id, status: 'preview' }) })).toMatchObject({ cameraReportAccepted: true });
    expect(f.mirrors.connectDevice(f.device).cameraRequest).toBeUndefined();
    expect(f.open()).toMatchObject({ state: 'preview', request: first.request });
    // Routine metadata cannot acknowledge or release the staff request.
    f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ status: 'closed' }) });
    expect(() => f.mirrors.devices.assertCameraClosed('default')).toThrow(error('EXHIBITION_CAMERA_BUSY'));
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ requestId: first.request!.id, status: 'closed' }) }).cameraReportAccepted).toBe(true);
    expect(() => f.mirrors.devices.assertCameraClosed('default')).not.toThrow();
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ requestId: first.request!.id, status: 'preview' }) }).cameraReportAccepted).toBe(false);
    const next = f.open(); expect(next.request?.id).not.toBe(first.request?.id);
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ requestId: first.request!.id, status: 'closed' }) }).cameraReportAccepted).toBe(false);
    expect(f.mirrors.cameraStatus('default').request).toEqual(next.request);
  });

  it('rejects stale local open intents after the same terminal immediately rebinds to the same mirror', () => {
    const f = fixture();
    const localInput = { action: 'open', terminalId: f.device.terminalId, bindingId: f.report().bindingId };
    expect(f.mirrors.openCamera('default', localInput).request?.bindingId).toBe(localInput.bindingId);
    f.mirrors.unbindDevice('default', { terminalId: f.device.terminalId });
    f.mirrors.bindDevice('default', { code: f.mirrors.connectDevice(f.device).code });
    const before = f.mirrors.cameraStatus('default');
    expect(() => f.mirrors.openCamera('default', localInput)).toThrow(error('EXHIBITION_DEVICE_BINDING_CHANGED'));
    expect(f.mirrors.cameraStatus('default')).toEqual(before);
    const rebound = f.mirrors.connectDevice(f.device);
    expect(rebound.cameraBindingId).not.toBe(localInput.bindingId); expect(rebound.cameraRequest).toBeUndefined();
    for (const bindingId of [null, 123, '', localInput.bindingId]) {
      expect(() => f.mirrors.openCamera('default', { ...localInput, bindingId })).toThrow(error('EXHIBITION_DEVICE_BINDING_CHANGED'));
    }
    expect(f.mirrors.cameraStatus('default').request).toBeNull();
    const request = f.mirrors.openCamera('default', { ...localInput, bindingId: rebound.cameraBindingId }).request;
    expect(request?.bindingId).toBe(rebound.cameraBindingId);
    expect(f.open().request).toEqual(request); // The staff entry still works without an epoch.
  });

  it('expires requests without accepting delayed acknowledgements or keeping the experience locked', () => {
    const f = fixture(); const request = f.open().request!; f.advance(120_000);
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ requestId: request.id, status: 'preview' }) }).cameraReportAccepted).toBe(false);
    expect(f.mirrors.cameraStatus('default')).toMatchObject({ state: 'expired', request: null, devices: [] });
    expect(() => f.mirrors.devices.assertCameraClosed('default')).not.toThrow();
    expect(f.open().request?.id).not.toBe(request.id);
  });

  it.each(['closed', 'error', 'busy'] as const)('releases a reported %s request without retrying it', status => {
    const f = fixture(); const request = f.open().request!;
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ requestId: request.id, status }) }).cameraReportAccepted).toBe(true);
    expect(() => f.mirrors.devices.assertCameraClosed('default')).not.toThrow();
    expect(f.mirrors.connectDevice(f.device).cameraRequest).toBeUndefined();
    expect(f.mirrors.cameraStatus('default').state).toBe(status);
    expect(f.open().request?.id).not.toBe(request.id);
  });

  it('accepts a late cleanup error after close without reopening the completed request', () => {
    const f = fixture(); const request = f.open().request!;
    f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ requestId: request.id, status: 'closed' }) });
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ requestId: request.id, status: 'error', error: '摄像头释放失败' }) }).cameraReportAccepted).toBe(true);
    expect(f.mirrors.cameraStatus('default')).toMatchObject({ state: 'error', error: '摄像头释放失败' });
    expect(() => f.mirrors.devices.assertCameraClosed('default')).not.toThrow();
    expect(f.mirrors.connectDevice({ ...f.device, cameraReport: f.report({ requestId: request.id, status: 'preview' }) }).cameraReportAccepted).toBe(false);
  });

  it('clears pending requests on restart and rotates the report binding even when the same terminal rebinds immediately', () => {
    const f = fixture(); const request = f.open().request!;
    const restarted = new ExhibitionMirrors(f.resource.directory, { now: f.now });
    expect(restarted.cameraStatus('default')).toMatchObject({ state: 'offline', supported: false, request: null, devices: [] });
    const connection = restarted.connectDevice({ ...f.device, cameraReport: f.report({ requestId: request.id, status: 'preview' }) });
    expect(connection.cameraBindingId).not.toBe(f.report().bindingId); expect(connection.cameraRequest).toBeUndefined(); expect(connection.cameraReportAccepted).toBe(false);
    restarted.unbindDevice('default', { terminalId: f.device.terminalId });
    const unbound = restarted.connectDevice(f.device);
    expect(unbound.cameraBindingId).toBeUndefined();
    restarted.bindDevice('default', { code: unbound.code });
    const rebound = restarted.connectDevice({ ...f.device, cameraReport: f.report({ bindingId: connection.cameraBindingId!, status: 'ready' }) });
    expect(rebound.cameraBindingId).not.toBe(connection.cameraBindingId); expect(rebound.cameraReportAccepted).toBe(false);
    expect(restarted.cameraStatus('default')).toMatchObject({ state: 'idle', devices: [], request: null });
  });

  it('rejects unbound, stale, offline and legacy targets without opening a different device', () => {
    const f = fixture(); const unbound = f.mirrors.create({ name: '未绑定镜子' }).id;
    expect(f.mirrors.cameraStatus(unbound)).toMatchObject({ state: 'unbound', terminalId: null });
    expect(() => f.mirrors.openCamera(unbound, { action: 'open', terminalId: f.device.terminalId })).toThrow(error('EXHIBITION_DEVICE_BINDING_CHANGED'));
    expect(() => f.mirrors.openCamera('default', { action: 'open', terminalId: terminal().terminalId })).toThrow(error('EXHIBITION_DEVICE_BINDING_CHANGED'));
    f.advance(30_000); expect(() => f.open()).toThrow(error('EXHIBITION_CAMERA_OFFLINE'));
    f.mirrors.connectDevice({ ...f.device, cameraCapabilities: undefined });
    expect(() => f.open()).toThrow(error('EXHIBITION_CAMERA_UNSUPPORTED'));
    expect(f.mirrors.cameraStatus('default')).toMatchObject({ state: 'unsupported', request: null, supported: false });
  });

  it.each(['generating', 'showcase', 'positioning', 'paused'] as const)('does not interrupt a %s experience to inspect the camera', phase => {
    const f = fixture(); const mirror = f.mirrors.getMirror(); const state = mirror.get();
    vi.spyOn(mirror, 'get').mockReturnValue({ ...state, phase });
    expect(() => f.open()).toThrow(error('EXHIBITION_MIRROR_BUSY'));
    expect(f.mirrors.cameraStatus('default').request).toBeNull();
  });

  it('refuses cleanup-pending and active lifecycle states, cancels delivery if experience state changes before polling', () => {
    const f = fixture(); const mirror = f.mirrors.getMirror(); const state = mirror.get(); const get = vi.spyOn(mirror, 'get');
    get.mockReturnValue({ ...state, lifecycle: { ...state.lifecycle!, connection: 'cleaning' } });
    expect(() => f.open()).toThrow(error('EXHIBITION_MIRROR_BUSY'));
    get.mockReturnValue({ ...state, lifecycle: { ...state.lifecycle!, state: 'active' } });
    expect(() => f.open()).toThrow(error('EXHIBITION_MIRROR_BUSY'));
    get.mockReturnValue(state); f.open();
    get.mockReturnValue({ ...state, phase: 'generating' });
    expect(f.mirrors.connectDevice(f.device).cameraRequest).toBeUndefined();
    expect(f.mirrors.cameraStatus('default').state).toBe('busy');
  });

  it('rejects malformed and oversized metadata without modifying the previous status', () => {
    const f = fixture(); f.mirrors.connectDevice({ ...f.device, cameraReport: f.report() }); const before = f.mirrors.cameraStatus('default');
    for (const value of [f.report({ devices: Array(25).fill(f.report().devices[0]) }), f.report({ devices: [f.report().devices[0], f.report().devices[0]] }),
      f.report({ selectedDeviceId: 'x'.repeat(513) }), f.report({ error: 'x'.repeat(241) }), { ...f.report(), status: 'arbitrary' }, { ...f.report(), requestId: undefined }]) {
      expect(() => f.mirrors.connectDevice({ ...f.device, cameraReport: value })).toThrow(error('EXHIBITION_INVALID_CAMERA_REPORT'));
    }
    expect(f.mirrors.cameraStatus('default')).toEqual(before);
  });
});

describe('camera control HTTP contract', () => {
  it('opens only the bound terminal, reports through authenticated polls, and gates start without making XMAX calls', async () => {
    const f = fixture(); const store = new SessionStore(':memory:'); f.resource.store = store;
    const issueKey = vi.fn();
    const service = new LifecycleTryOnService({ store, secrets: new SecretBox(randomBytes(32)), catalog: async () => [],
      provider: { configured: true, issueKey, keyStatus: vi.fn(), deactivate: vi.fn(), sessionStatus: vi.fn() } });
    const origin = 'http://xuminghong.local:10200'; const server = createApiServer(service, [origin], undefined, f.mirrors); f.resource.server = server;
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/exhibition`;
    const post = (path: string, data: unknown, from = origin) => fetch(base + path, { method: 'POST', headers: { Origin: from, 'Content-Type': 'application/json', 'x-miror-protocol': '2', 'x-miror-material': 'binding-v1' }, body: JSON.stringify(data) });
    expect((await post('/mirrors/default/camera', { action: 'open', terminalId: f.device.terminalId }, 'https://wrong.example')).status).toBe(403);
    const devices = Array.from({ length: 24 }, (_, index) => ({ id: '镜'.repeat(510) + String(index).padStart(2, '0'), label: '摄'.repeat(120), kind: 'unknown' as const }));
    const metadata = { ...f.device, cameraReport: f.report({ devices, selectedDeviceId: devices[0].id, activeDeviceId: devices[0].id, error: '错'.repeat(240) }) };
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeGreaterThan(16_384);
    expect((await post('/terminals/connect', metadata)).status).toBe(200);
    expect((await post('/terminals/connect', { ...metadata, extra: 'x'.repeat(65_536) })).status).toBe(413);
    // A durable orphan awaiting supplier cleanup blocks diagnostics even when state.live is absent.
    const orphanId = randomUUID(); const timestamp = new Date(f.now()).toISOString();
    store.reserve({ id: orphanId, status: 'stopping', pointsLimit: 1, targetItemId: 'fixture', sourceId: 'fixture', sourceKind: 'camera', sourceName: 'fixture',
      refImageUrl: '', referenceVersion: 1, consumedCredits: 0, resultAvailable: false, verification: 'none', createdAt: timestamp, updatedAt: timestamp,
      exhibition: { mirrorId: 'default', lookId: 'fixture', deviceId: 'fixture', generationNumber: 1, sessionNumber: 1 } });
    expect(f.mirrors.getMirror().get().live).toBeNull();
    expect((await post('/mirrors/default/camera', { action: 'open', terminalId: f.device.terminalId })).status).toBe(409);
    store.update(orphanId, { status: 'stopped' });
    const opened = await post('/mirrors/default/camera', { action: 'open', terminalId: f.device.terminalId }); expect(opened.status).toBe(200);
    const request = (await opened.json()).request;
    expect(await (await fetch(base + '/mirrors/default/camera')).json()).toMatchObject({ state: 'requested', request });
    expect((await post('/mirrors/default/command', { action: 'begin' })).status).toBe(409);
    expect((await post('/mirrors/default/command', { action: 'resume' })).status).toBe(409);
    expect((await post('/mirrors/default/live/session', { terminalId: f.device.terminalId, terminalToken: f.device.token })).status).toBe(409);
    const delivered = await (await post('/terminals/connect', f.device)).json(); expect(delivered.cameraRequest).toEqual(request);
    expect(await (await post('/terminals/connect', { ...f.device, cameraReport: f.report({ requestId: request.id, status: 'closed' }) })).json()).toMatchObject({ cameraReportAccepted: true });
    expect((await post('/mirrors/default/command', { action: 'begin' })).status).toBe(200);
    expect((await post('/mirrors/default/camera', { action: 'open', terminalId: f.device.terminalId })).status).toBe(409);
    expect((await post('/mirrors/default/command', { action: 'end' })).status).toBe(200);
    f.mirrors.unbindDevice('default', { terminalId: f.device.terminalId });
    f.mirrors.bindDevice('default', { code: f.mirrors.connectDevice(f.device).code });
    const rebound = await (await post('/terminals/connect', f.device)).json();
    const staleOpen = await post('/mirrors/default/camera', { action: 'open', terminalId: f.device.terminalId, bindingId: delivered.cameraBindingId });
    expect(staleOpen.status).toBe(409); expect(await staleOpen.json()).toMatchObject({ code: 'EXHIBITION_DEVICE_BINDING_CHANGED' });
    expect(f.mirrors.cameraStatus('default').request).toBeNull();
    const localOpen = await post('/mirrors/default/camera', { action: 'open', terminalId: f.device.terminalId, bindingId: rebound.cameraBindingId });
    expect(localOpen.status).toBe(200); expect(await localOpen.json()).toMatchObject({ request: { bindingId: rebound.cameraBindingId } });
    expect(issueKey).not.toHaveBeenCalled();
  });
});
