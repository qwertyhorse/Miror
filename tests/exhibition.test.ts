import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExhibitionService } from '../server/exhibition.ts';
import { createApiServer } from '../server/http.ts';
import type { TryOnService } from '../server/service.ts';
import type { ExhibitionState } from '../shared/exhibition.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openbuy-exhibition-test-'));
  directories.push(directory);
  let time = 1_800_000_000_000;
  const now = () => time;
  const service = new ExhibitionService(directory, { now });
  return { service, directory, now, advance: (milliseconds: number) => { time += milliseconds; } };
}

function beginGeneration(service: ExhibitionService) {
  return service.command({ action: 'begin' });
}

describe('exhibition experience lifecycle', () => {
  it('starts generation in one command and only displays a result after generation completes', () => {
    const { service, advance, now } = fixture();
    expect(service.get()).toMatchObject({ phase: 'select', providerMode: 'demo', sessionNumber: 0, displayedLookId: null });
    expect(() => service.command({ action: 'confirm' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
    service.command({ action: 'select', lookId: 'evening' });
    const selected = service.get();
    const generating = service.command({ action: 'begin', expectedRevision: selected.revision });
    expect(generating).toMatchObject({ phase: 'generating', selectedLookId: 'evening', displayedLookId: null,
      sessionNumber: 1, generationNumber: 1, generationReadyAt: now() + 2_200, revision: selected.revision + 1 });
    for (const action of ['begin', 'confirm']) {
      expect(() => service.command({ action })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
      expect(service.get()).toEqual(generating);
    }
    expect(() => service.command({ action: 'next' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
    advance(2_199);
    expect(service.get().phase).toBe('generating');
    advance(1);
    expect(service.get()).toMatchObject({ phase: 'showcase', displayedLookId: 'evening', generationReadyAt: null });
    expect(service.command({ action: 'end' })).toMatchObject({ phase: 'select', displayedLookId: null, generationReadyAt: null });
    expect(service.command({ action: 'begin' })).toMatchObject({ phase: 'generating', sessionNumber: 2, generationNumber: 2 });
    expect(service.command({ action: 'idle' })).toMatchObject({ phase: 'idle', displayedLookId: null });
    expect(service.command({ action: 'begin' })).toMatchObject({ phase: 'generating', sessionNumber: 3, generationNumber: 3 });
  });

  it('preserves the remaining generation time across pause and resumes showcase without regenerating', () => {
    const { service, advance, now } = fixture();
    beginGeneration(service);
    advance(800);
    expect(service.command({ action: 'pause' })).toMatchObject({ phase: 'paused', generationReadyAt: null });
    advance(120_000);
    expect(service.get().phase).toBe('paused');
    expect(service.command({ action: 'resume' })).toMatchObject({ phase: 'generating', generationReadyAt: now() + 1_400 });
    advance(1_399);
    expect(service.get().phase).toBe('generating');
    advance(1);
    expect(service.get().phase).toBe('showcase');
    service.command({ action: 'pause' });
    advance(5_000);
    expect(service.command({ action: 'resume' })).toMatchObject({ phase: 'showcase', displayedLookId: 'commute', generationReadyAt: null });
    service.command({ action: 'pause' });
    service.command({ action: 'end' });
    expect(() => service.command({ action: 'resume' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
  });

  it('switches directly to an enabled outfit within the same showcase experience', () => {
    const { service, advance, now } = fixture();
    beginGeneration(service); advance(2_200);
    const previous = service.get();
    expect(service.command({ action: 'switch', lookId: 'commute' })).toEqual(previous);
    const switching = service.command({ action: 'switch', lookId: 'evening', expectedRevision: previous.revision });
    expect(switching).toMatchObject({ phase: 'generating', selectedLookId: 'evening', displayedLookId: 'commute',
      sessionNumber: previous.sessionNumber, generationNumber: previous.generationNumber + 1,
      generationReadyAt: now() + 2_200, revision: previous.revision + 1 });
    expect(() => service.command({ action: 'switch', lookId: 'city' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
    expect(service.get()).toEqual(switching);
    advance(2_199); expect(service.get().displayedLookId).toBe('commute');
    advance(1); expect(service.get()).toMatchObject({ phase: 'showcase', displayedLookId: 'evening', sessionNumber: previous.sessionNumber });
  });

  it('rejects invalid, disabled, stale and out-of-phase direct outfit switches without mutating the round', () => {
    const { service, advance } = fixture();
    const selected = service.command({ action: 'configure', enabledLookIds: ['commute', 'evening'] });
    expect(() => service.command({ action: 'switch', lookId: 'evening' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
    expect(service.get()).toEqual(selected);
    beginGeneration(service); advance(2_200);
    const showcase = service.get();
    for (const lookId of [undefined, null, 1, 'unknown', 'city']) {
      expect(() => service.command({ action: 'switch', lookId })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_LOOK' }));
      expect(service.get()).toEqual(showcase);
    }
    expect(() => service.command({ action: 'switch', lookId: 'evening', expectedRevision: showcase.revision - 1 })).toThrow(expect.objectContaining({ code: 'EXHIBITION_STALE_REVISION' }));
    expect(service.get()).toEqual(showcase);
    const paused = service.command({ action: 'pause' });
    expect(() => service.command({ action: 'switch', lookId: 'evening' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
    expect(service.get()).toEqual(paused);
    const idle = service.command({ action: 'idle' });
    expect(() => service.command({ action: 'switch', lookId: 'evening' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
    expect(service.get()).toEqual(idle);
  });

  it('automatically returns to idle despite polling, clears the previous visitor, and supports disabling the timeout', () => {
    const { service, advance } = fixture();
    service.command({ action: 'configure', autoReturnSeconds: 15 });
    beginGeneration(service);
    advance(2_200);
    expect(service.get().phase).toBe('showcase');
    advance(12_799);
    expect(service.get().phase).toBe('showcase');
    advance(1);
    const idle = service.get();
    expect(idle).toMatchObject({ phase: 'idle', displayedLookId: null, generationReadyAt: null });
    expect(service.get().revision).toBe(idle.revision);
    service.command({ action: 'configure', autoReturnSeconds: 0 });
    beginGeneration(service);
    advance(1_000_000);
    expect(service.get().phase).toBe('showcase');
  });
});

describe('exhibition configuration and storage', () => {
  it('cycles only enabled looks, maintains their chosen order, and rejects changing the catalog mid-session', () => {
    const { service, advance } = fixture();
    expect(service.command({ action: 'configure', enabledLookIds: ['evening', 'city'] })).toMatchObject({
      enabledLookIds: ['evening', 'city'], selectedLookId: 'evening',
    });
    expect(() => service.command({ action: 'select', lookId: 'commute' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_LOOK' }));
    beginGeneration(service);
    expect(() => service.command({ action: 'configure', enabledLookIds: ['commute'] })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
    advance(2_200);
    expect(service.command({ action: 'previous' }).selectedLookId).toBe('city');
    advance(2_200);
    expect(service.command({ action: 'next' }).selectedLookId).toBe('evening');
    advance(2_200);
    expect(service.command({ action: 'next' }).selectedLookId).toBe('city');
  });

  it('rejects malformed commands and applies configuration atomically', () => {
    const { service } = fixture();
    const initial = service.get();
    for (const command of [null, [], {}, { action: 'unknown' }, { action: 'configure' },
      { action: 'configure', enabledLookIds: ['city', 'city'] },
      { action: 'configure', enabledLookIds: ['unknown'] }, { action: 'configure', autoReturnSeconds: 14 },
      { action: 'configure', autoReturnSeconds: 601 }, { action: 'configure', autoReturnSeconds: 15.5 },
      { action: 'configure', enabledLookIds: ['evening'], autoReturnSeconds: '90' },
      { action: 'begin', expectedRevision: -1 }, { action: 'begin', expectedRevision: 1.5 }]) {
      expect(() => service.command(command)).toThrow();
      expect(service.get()).toEqual(initial);
    }
    const detached = service.get();
    detached.enabledLookIds.splice(0);
    detached.settings.autoReturnSeconds = 0;
    detached.logs[0].message = 'mutated by client';
    expect(service.get()).toEqual(initial);
  });

  it('persists settings and session numbers, resets an interrupted visitor on restart, and leaves no temp files', () => {
    const { service, directory, now } = fixture();
    service.command({ action: 'configure', enabledLookIds: ['city', 'evening'], autoReturnSeconds: 45 });
    const saved = service.get();
    expect(new ExhibitionService(directory, { now }).get()).toEqual(saved);
    beginGeneration(service);
    service.command({ action: 'pause' });
    const beforeRestart = service.get();
    const restarted = new ExhibitionService(directory, { now });
    expect(restarted.get()).toMatchObject({
      phase: 'select', enabledLookIds: ['city', 'evening'], selectedLookId: 'city', sessionNumber: 1,
      settings: { autoReturnSeconds: 45 }, displayedLookId: null, generationReadyAt: null, revision: beforeRestart.revision + 1,
    });
    expect(() => restarted.command({ action: 'resume' })).toThrow(expect.objectContaining({ code: 'EXHIBITION_INVALID_PHASE' }));
    expect(restarted.command({ action: 'begin' }).sessionNumber).toBe(2);
    expect(readdirSync(directory)).toEqual(['exhibition.json']);
    expect(JSON.parse(readFileSync(join(directory, 'exhibition.json'), 'utf8')).state).toEqual(restarted.get());
  });

  it('recovers invalid saved JSON and retains only the newest 40 operations', () => {
    const { directory, now } = fixture();
    writeFileSync(join(directory, 'exhibition.json'), '{broken');
    const restarted = new ExhibitionService(directory, { now });
    expect(restarted.get()).toMatchObject({ phase: 'select', sessionNumber: 0, providerMode: 'demo' });
    for (let i = 0; i < 45; i += 1) restarted.command({ action: 'select', lookId: i % 2 ? 'city' : 'evening' });
    const state = restarted.get();
    expect(state.logs).toHaveLength(40);
    expect(new Set(state.logs.map(log => log.id)).size).toBe(40);
    expect(state.logs[0].message).toContain('优雅礼服');
    expect(new ExhibitionService(directory, { now }).get()).toEqual(state);
  });
});

describe('exhibition HTTP boundary and simultaneous controls', () => {
  async function withServer(run: (base: string, service: ExhibitionService) => Promise<void>) {
    const { service } = fixture();
    const unrelatedService = new Proxy({} as TryOnService, { get: () => { throw new Error('Exhibition must not call the XMAX service.'); } });
    const server = createApiServer(unrelatedService, ['http://xuminghong.local:10200'], undefined, service);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    try { await run(`http://127.0.0.1:${address.port}`, service); }
    finally { server.close(); await once(server, 'close'); }
  }
  const headers = { 'Content-Type': 'application/json', Origin: 'http://xuminghong.local:10200' };

  it('rejects foreign hosts, missing or foreign origins, and cross-site commands before mutating exhibition state', async () => {
    await withServer(async (base, service) => {
      const initial = service.get();
      const command = vi.spyOn(service, 'command');
      // Node fetch normalizes Host, so use an HTTP request to exercise the raw header guard.
      const hostResponse = await new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
        const req = request(`${base}/api/exhibition`, { headers: { Host: 'outside.example' } }, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
          response.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      expect(hostResponse.status).toBe(403);
      expect(hostResponse.body).toMatchObject({ code: 'INVALID_HOST' });
      for (const deniedHeaders of [{ 'Content-Type': 'application/json' },
        { ...headers, Origin: 'https://outside.example' }, { ...headers, 'Sec-Fetch-Site': 'cross-site' }]) {
        const response = await fetch(`${base}/api/exhibition/command`, { method: 'POST', headers: deniedHeaders, body: JSON.stringify({ action: 'begin' }) });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
      }
      expect(command).not.toHaveBeenCalled();
      expect(service.get()).toEqual(initial);
      const allowed = await fetch(`${base}/api/exhibition`);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('cache-control')).toBe('no-store');
      expect(await allowed.json()).toEqual(initial);
    });
  });

  it('accepts one simultaneous screen/control command and rejects the stale revision without overwriting it', async () => {
    await withServer(async (base, service) => {
      const initial = service.get();
      const responses = await Promise.all(['city', 'evening'].map(lookId => fetch(`${base}/api/exhibition/command`, {
        method: 'POST', headers, body: JSON.stringify({ action: 'select', lookId, expectedRevision: initial.revision }),
      })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const success = await responses.find(response => response.status === 200)!.json() as ExhibitionState;
      const conflict = await responses.find(response => response.status === 409)!.json();
      expect(conflict).toMatchObject({ code: 'EXHIBITION_STALE_REVISION' });
      expect(service.get()).toEqual(success);
      expect(success.revision).toBe(initial.revision + 1);
      const next = await fetch(`${base}/api/exhibition/command`, {
        method: 'POST', headers, body: JSON.stringify({ action: 'begin', expectedRevision: success.revision }),
      });
      expect(next.status).toBe(200);
      expect(await next.json()).toMatchObject({ phase: 'generating', selectedLookId: success.selectedLookId, sessionNumber: 1, generationNumber: 1, revision: success.revision + 1 });
    });
  });
});
