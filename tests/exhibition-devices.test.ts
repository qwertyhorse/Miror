import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionDevices } from '../server/exhibitionDevices.ts';
import { ExhibitionMirrors } from '../server/exhibitionMirrors.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-terminal-pairing-')); directories.push(directory);
  let time = 1_800_000_000_000;
  return { directory, now: () => time, advance: (ms: number) => { time += ms; } };
}
function terminal(label = '测试镜端', platform: 'android' | 'browser' = 'android') { return { terminalId: `terminal-${randomUUID()}`, token: randomBytes(32).toString('hex'), label, platform }; }
const code = (value: string) => expect.objectContaining({ code: value });

describe('terminal registration and pairing', () => {
  it('registers without claiming URL input, preserves one code for ten minutes and never stores the raw terminal secret', () => {
    const { directory, now, advance } = fixture(); const devices = new ExhibitionDevices(directory, { now }); const input = terminal();
    const result = devices.connect({ ...input, mirrorId: 'default' });
    expect(result).toMatchObject({ terminalId: input.terminalId, mirrorId: null, expiresAt: now() + 600_000 });
    expect(result.code).toMatch(/^[0-9]{6}$/);
    const saved = readFileSync(join(directory, 'exhibition-devices.json'), 'utf8');
    expect(saved).not.toContain(input.token); expect(JSON.parse(saved).terminals[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    advance(599_999);
    expect(devices.connect(input)).toEqual(result);
    expect(readFileSync(join(directory, 'exhibition-devices.json'), 'utf8')).toBe(saved);
    expect(devices.binding('default')).toBeNull();
  });

  it('validates terminal identity, token, platform and label and rejects another secret for an existing terminal', () => {
    const { directory, now } = fixture(); const devices = new ExhibitionDevices(directory, { now }); const input = terminal();
    for (const invalid of [{ ...input, terminalId: 'default' }, { ...input, token: 'short' }, { ...input, token: 'x'.repeat(32) + '\n' }, { ...input, platform: 'ios' }, { ...input, label: '   ' }]) {
      expect(() => devices.connect(invalid)).toThrow(code('EXHIBITION_INVALID_TERMINAL'));
    }
    devices.connect(input);
    const before = readFileSync(join(directory, 'exhibition-devices.json'), 'utf8');
    expect(() => devices.connect({ ...input, token: randomBytes(32).toString('hex') })).toThrow(code('EXHIBITION_DEVICE_UNAUTHORIZED'));
    expect(readFileSync(join(directory, 'exhibition-devices.json'), 'utf8')).toBe(before);
    // Native installation tokens consist of two UUIDs and remain valid opaque credentials.
    expect(devices.connect({ ...terminal('安卓原生'), token: randomUUID() + randomUUID() }).code).toMatch(/^[0-9]{6}$/);
  });

  it('keeps a single terminal per mirror and a single mirror per terminal; consumed codes cannot be reused', () => {
    const { directory, now } = fixture(); const devices = new ExhibitionDevices(directory, { now });
    const a = terminal('A'); const b = terminal('B', 'browser'); const pairingA = devices.connect(a); const pairingB = devices.connect(b);
    expect(devices.bind('default', { code: pairingA.code })).toMatchObject({ terminalId: a.terminalId, platform: 'android', label: 'A', boundAt: now(), online: true });
    expect(devices.connect(a)).toEqual({ terminalId: a.terminalId, mirrorId: 'default' });
    expect(() => devices.bind('mirror-b', { code: pairingA.code })).toThrow(code('EXHIBITION_PAIRING_CODE_INVALID'));
    expect(() => devices.bind('default', { code: pairingB.code })).toThrow(code('EXHIBITION_MIRROR_ALREADY_BOUND'));
    expect(devices.binding('default')!.terminalId).toBe(a.terminalId);
    expect(devices.bind('mirror-b', { code: pairingB.code }).terminalId).toBe(b.terminalId);
    expect(devices.binding('mirror-b')!.platform).toBe('browser');
  });

  it('expires old codes at ten minutes and replaces them only after an authenticated terminal reconnect', () => {
    const { directory, now, advance } = fixture(); const values = ['123456', '123456', '234567'];
    const devices = new ExhibitionDevices(directory, { now, generateCode: () => values.shift()! }); const input = terminal();
    const first = devices.connect(input); advance(600_000);
    expect(() => devices.bind('default', { code: first.code })).toThrow(code('EXHIBITION_PAIRING_CODE_EXPIRED'));
    const second = devices.connect(input);
    expect(second.code).toBe('234567'); expect(second.expiresAt).toBe(now() + 600_000);
    expect(() => devices.bind('default', { code: first.code })).toThrow(code('EXHIBITION_PAIRING_CODE_INVALID'));
    expect(devices.bind('default', { code: second.code }).terminalId).toBe(input.terminalId);
  });

  it('handles code collisions and never reissues a retired code after restart or unbinding', () => {
    const { directory, now } = fixture(); const values = ['111111', '111111', '222222'];
    const devices = new ExhibitionDevices(directory, { now, generateCode: () => values.shift()! }); const a = terminal('A'); const b = terminal('B');
    expect(devices.connect(a).code).toBe('111111'); expect(devices.connect(b).code).toBe('222222');
    devices.bind('default', { code: '111111' }); devices.unbind('default', { terminalId: a.terminalId });
    const next = ['111111', '222222', '333333']; const restarted = new ExhibitionDevices(directory, { now, generateCode: () => next.shift()! });
    expect(restarted.connect(a).code).toBe('333333');
    expect(() => restarted.bind('default', { code: '111111' })).toThrow(code('EXHIBITION_PAIRING_CODE_INVALID'));
  });

  it('bounds collision retries without registering a partial second terminal', () => {
    const { directory, now } = fixture(); const devices = new ExhibitionDevices(directory, { now, generateCode: () => '123456' });
    devices.connect(terminal('A')); const file = join(directory, 'exhibition-devices.json'); const before = readFileSync(file, 'utf8');
    expect(() => devices.connect(terminal('B'))).toThrow(code('EXHIBITION_PAIRING_CODE_BUSY'));
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('preserves bindings across restart but marks them offline until a fresh heartbeat, without writing on each heartbeat', () => {
    const { directory, now, advance } = fixture(); const input = terminal(); const devices = new ExhibitionDevices(directory, { now });
    const pairing = devices.connect(input); devices.bind('default', { code: pairing.code });
    const file = join(directory, 'exhibition-devices.json'); const saved = readFileSync(file, 'utf8');
    advance(29_999); expect(devices.binding('default')!.online).toBe(true);
    advance(1); expect(devices.binding('default')!.online).toBe(false);
    const restarted = new ExhibitionDevices(directory, { now });
    expect(restarted.binding('default')).toMatchObject({ terminalId: input.terminalId, online: false, lastSeenAt: 0 });
    expect(restarted.connect(input)).toEqual({ terminalId: input.terminalId, mirrorId: 'default' });
    expect(restarted.binding('default')).toMatchObject({ online: true, lastSeenAt: now() });
    expect(readFileSync(file, 'utf8')).toBe(saved);
    advance(10_000); restarted.connect(input); expect(readFileSync(file, 'utf8')).toBe(saved);
  });

  it('requires the bound terminal secret for realtime ownership and validates stale unbind requests', () => {
    const { directory, now } = fixture(); const devices = new ExhibitionDevices(directory, { now }); const input = terminal();
    const pairing = devices.connect(input); devices.bind('default', { code: pairing.code });
    expect(() => devices.assertOwner('unbound', {})).not.toThrow();
    for (const invalid of [{}, { terminalId: input.terminalId }, { terminalId: input.terminalId, terminalToken: randomBytes(32).toString('hex') }, { terminalId: terminal().terminalId, terminalToken: input.token }]) {
      expect(() => devices.assertOwner('default', invalid)).toThrow(code('EXHIBITION_DEVICE_UNAUTHORIZED'));
    }
    expect(() => devices.assertOwner('default', { terminalId: input.terminalId, terminalToken: input.token })).not.toThrow();
    expect(() => devices.unbind('default', { terminalId: terminal().terminalId })).toThrow(code('EXHIBITION_DEVICE_BINDING_CHANGED'));
    expect(devices.binding('default')).not.toBeNull();
    devices.unbind('default', { terminalId: input.terminalId });
    expect(devices.binding('default')).toBeNull();
    expect(() => devices.assertOwner('default', { terminalId: input.terminalId, terminalToken: input.token })).toThrow(code('EXHIBITION_DEVICE_UNAUTHORIZED'));
    expect(() => devices.assertOwner('unbound', { terminalId: 'unknown', terminalToken: input.token })).toThrow(code('EXHIBITION_DEVICE_UNAUTHORIZED'));
    expect(() => devices.assertOwner('default', {})).not.toThrow();
    expect(() => devices.unbind('default', { terminalId: input.terminalId })).toThrow(code('EXHIBITION_DEVICE_BINDING_CHANGED'));
    const reconnect = devices.connect(input); expect(reconnect.mirrorId).toBeNull(); expect(reconnect.code).not.toBe(pairing.code);
  });

  it('atomically rolls back bind and unbind when disk commit fails, keeping the code usable after a failed bind', () => {
    const { directory, now } = fixture(); const devices = new ExhibitionDevices(directory, { now }); const input = terminal();
    const pairing = devices.connect(input); const file = join(directory, 'exhibition-devices.json');
    renameSync(file, `${file}.saved`); mkdirSync(file);
    expect(() => devices.bind('default', { code: pairing.code })).toThrow(); expect(devices.binding('default')).toBeNull();
    expect(devices.connect(input)).toEqual(pairing);
    rmSync(file, { recursive: true }); renameSync(`${file}.saved`, file);
    devices.bind('default', { code: pairing.code });
    renameSync(file, `${file}.saved`); mkdirSync(file);
    expect(() => devices.unbind('default', { terminalId: input.terminalId })).toThrow(); expect(devices.binding('default')!.terminalId).toBe(input.terminalId);
    rmSync(file, { recursive: true }); renameSync(`${file}.saved`, file);
    expect(new ExhibitionDevices(directory, { now }).binding('default')!.terminalId).toBe(input.terminalId);
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('limits failed pairing attempts across mirrors and permits retry after the minute window', () => {
    const { directory, now, advance } = fixture(); const devices = new ExhibitionDevices(directory, { now, generateCode: () => '654321' });
    const pairing = devices.connect(terminal());
    for (let attempt = 0; attempt < 30; attempt++) expect(() => devices.bind(`mirror-${attempt}`, { code: '000000' })).toThrow(code('EXHIBITION_PAIRING_CODE_INVALID'));
    expect(() => devices.bind('default', { code: pairing.code })).toThrow(code('EXHIBITION_PAIRING_RATE_LIMITED'));
    advance(60_000);
    expect(devices.bind('default', { code: pairing.code })).toMatchObject({ online: false });
  });

  it('refuses corrupted or duplicate bindings without overwriting persistent records', () => {
    const { directory, now } = fixture(); const devices = new ExhibitionDevices(directory, { now }); const a = terminal(); const pairing = devices.connect(a); devices.bind('default', { code: pairing.code });
    const file = join(directory, 'exhibition-devices.json'); const data = JSON.parse(readFileSync(file, 'utf8'));
    data.terminals.push({ ...data.terminals[0], terminalId: terminal().terminalId }); writeFileSync(file, JSON.stringify(data));
    const saved = readFileSync(file, 'utf8');
    expect(() => new ExhibitionDevices(directory, { now })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(saved);
  });
});

describe('mirror binding integration', () => {
  it('blocks active mirror changes, exposes safe binding summaries and follows renamed mirror names on reconnect', () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now }); const input = terminal();
    const pairing = manager.connectDevice(input); const mirror = manager.getMirror(); mirror.command({ action: 'begin' });
    expect(() => manager.bindDevice('default', { code: pairing.code })).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    mirror.command({ action: 'end' }); manager.bindDevice('default', { code: pairing.code });
    manager.rename('default', { name: '入口大屏' });
    expect(manager.connectDevice(input)).toEqual({ terminalId: input.terminalId, mirrorId: 'default', mirrorName: '入口大屏' });
    const summary = manager.list().mirrors[0]; expect(summary.binding).toMatchObject({ terminalId: input.terminalId, online: true });
    expect(JSON.stringify(summary)).not.toContain(input.token); expect(JSON.stringify(summary)).not.toContain(pairing.code);
    mirror.command({ action: 'begin' });
    expect(() => manager.unbindDevice('default', { terminalId: input.terminalId })).toThrow(code('EXHIBITION_MIRROR_BUSY'));
    mirror.command({ action: 'end' }); expect(manager.unbindDevice('default', { terminalId: input.terminalId })).toBeNull();
    expect(manager.list().mirrors[0].binding).toBeNull();
    expect(() => manager.bindDevice('missing', { code: pairing.code })).toThrow(code('EXHIBITION_MIRROR_NOT_FOUND'));
  });

  it('does not transfer or overwrite terminal bindings when copying mirror content', () => {
    const { directory, now } = fixture(); const manager = new ExhibitionMirrors(directory, { now });
    const bId = manager.create({ name: '第二台' }).id; const a = terminal('A'); const b = terminal('B');
    manager.bindDevice('default', { code: manager.connectDevice(a).code }); manager.bindDevice(bId, { code: manager.connectDevice(b).code });
    const aBefore = manager.devices.binding('default'); const bBefore = manager.devices.binding(bId);
    manager.copy(bId, { sourceMirrorId: 'default', expectedRevision: manager.getMirror(bId).get().revision, copyLooks: true, copySettings: true });
    expect(manager.devices.binding('default')).toEqual(aBefore); expect(manager.devices.binding(bId)).toEqual(bBefore);
    const restarted = new ExhibitionMirrors(directory, { now });
    expect(restarted.list().mirrors.map(mirror => mirror.binding?.terminalId)).toEqual([a.terminalId, b.terminalId]);
    expect(restarted.list().mirrors.every(mirror => mirror.binding?.online === false)).toBe(true);
  });

  it('blocks re-pairing while a previous realtime lease remains after returning to idle', () => {
    const { directory, now } = fixture(); const initial = new ExhibitionMirrors(directory, { now }); const a = terminal();
    const pairing = initial.connectDevice(a); const file = join(directory, 'exhibition-mirrors', 'default', 'exhibition.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.state.live = { deviceId: 'screen-owner', sessionId: 'stopping-session', generationNumber: 0, lookId: 'commute', status: 'stopping', updatedAt: now(), heartbeatAt: now() };
    writeFileSync(file, JSON.stringify(state));
    const manager = new ExhibitionMirrors(directory, { now });
    expect(() => manager.bindDevice('default', { code: pairing.code })).toThrow(code('EXHIBITION_MIRROR_BUSY'));
  });
});
