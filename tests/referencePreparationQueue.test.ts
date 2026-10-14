import { expect, it, vi } from 'vitest';
import { ReferencePreparationQueue, type ReferencePreparationMirror } from '../server/referencePreparationQueue';
import type { ExhibitionLook } from '../shared/exhibition';
import type { ReferencePreparationStatus } from '../shared/referencePreparation';

function fixture(id = 'a') {
  const statuses = new Map<string, ReferencePreparationStatus>();
  const calls: string[] = [];
  const mirror: ReferencePreparationMirror = {
    id, configured: true,
    state: { looks: ['unused', 'enabled', 'selected'].map(id => ({ id } as ExhibitionLook)),
      selectedLookId: 'selected', enabledLookIds: ['enabled', 'selected'], live: null },
    status: id => statuses.get(id) ?? { state: 'queued' },
    prepare: vi.fn(async id => { calls.push(id); statuses.set(id, { state: 'ready', freshUntil: 3_601_000 }); }),
  };
  return { mirror, statuses, calls };
}

it('prepares selected, enabled, then unused materials regardless of catalog order', async () => {
  const f = fixture(); const queue = new ReferencePreparationQueue(() => [f.mirror], () => 1_000);
  await queue.runOnce(); await queue.runOnce(); await queue.runOnce(); await queue.runOnce();
  expect(f.calls).toEqual(['selected', 'enabled', 'unused']);
});

it('uses the newest selection and enabled list on the next tick', async () => {
  const f = fixture(); const queue = new ReferencePreparationQueue(() => [f.mirror], () => 1_000);
  await queue.runOnce();
  f.mirror.state.selectedLookId = 'unused'; f.mirror.state.enabledLookIds = ['unused'];
  await queue.runOnce();
  expect(f.calls).toEqual(['selected', 'unused']);
});

it('prioritizes selections across mirrors and rotates mirrors for equal priority work', async () => {
  const a = fixture('a'); const b = fixture('b'); const calls: string[] = [];
  for (const f of [a, b]) {
    f.mirror.prepare = async id => { calls.push(`${f.mirror.id}:${id}`); f.statuses.set(id, { state: 'ready', freshUntil: 3_601_000 }); };
  }
  const queue = new ReferencePreparationQueue(() => [a.mirror, b.mirror], () => 1_000);
  for (let i = 0; i < 6; i++) await queue.runOnce();
  expect(calls).toEqual(['a:selected', 'b:selected', 'a:enabled', 'b:enabled', 'a:unused', 'b:unused']);
});

it('skips live mirrors, unconfigured mirrors and prompt-only material', async () => {
  const active = fixture('live'); active.mirror.state.live = {} as NonNullable<ReferencePreparationMirror['state']['live']>;
  const unconfigured = fixture('unconfigured'); unconfigured.mirror.configured = false;
  const f = fixture(); f.mirror.state.looks[2].referenceKind = 'none';
  const queue = new ReferencePreparationQueue(() => [active.mirror, unconfigured.mirror, f.mirror], () => 1_000);
  await queue.runOnce();
  expect(active.calls).toEqual([]); expect(unconfigured.calls).toEqual([]); expect(f.calls).toEqual(['enabled']);
});

it('skips pending and cooling-down work without blocking other materials, then retries after cooldown', async () => {
  let now = 1_000;
  const f = fixture(); f.statuses.set('selected', { state: 'failed', retryAt: 61_000 });
  f.statuses.set('enabled', { state: 'preparing' });
  const queue = new ReferencePreparationQueue(() => [f.mirror], () => now);
  await queue.runOnce(); expect(f.calls).toEqual(['unused']);
  now = 61_001; await queue.runOnce(); expect(f.calls).toEqual(['unused', 'selected']);
});

it('refreshes references near expiry and detects newly uploaded materials', async () => {
  const f = fixture();
  for (const look of f.mirror.state.looks) f.statuses.set(look.id, { state: 'ready', freshUntil: 3_601_000 });
  f.statuses.set('selected', { state: 'ready', freshUntil: 301_000 });
  const queue = new ReferencePreparationQueue(() => [f.mirror], () => 1_000);
  await queue.runOnce();
  f.mirror.state.looks.push({ id: 'new-upload' } as ExhibitionLook);
  await queue.runOnce(); expect(f.calls).toEqual(['selected', 'new-upload']);
});

it('never overlaps background uploads and recovers after a failed attempt', async () => {
  const f = fixture(); let reject!: (reason: unknown) => void;
  f.mirror.prepare = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
  const queue = new ReferencePreparationQueue(() => [f.mirror], () => 1_000);
  const first = queue.runOnce(); await queue.runOnce(); expect(f.mirror.prepare).toHaveBeenCalledOnce();
  f.statuses.set('selected', { state: 'failed', retryAt: 61_000 }); reject(new Error('failure')); await first;
  f.mirror.prepare = vi.fn(async () => undefined); await queue.runOnce();
  expect(f.mirror.prepare).toHaveBeenCalledWith('enabled');
});

it('does not starve later enabled materials when earlier uploads time out past their cooldown', async () => {
  const f = fixture(); let now = 1_000;
  const ids = ['timeout-1', 'timeout-2', 'timeout-3', 'timeout-4', 'healthy'];
  f.mirror.state.looks = ids.map(id => ({ id } as ExhibitionLook));
  f.mirror.state.selectedLookId = null; f.mirror.state.enabledLookIds = ids;
  f.mirror.prepare = async id => {
    f.calls.push(id);
    if (id === 'healthy') { f.statuses.set(id, { state: 'ready', freshUntil: now + 3_600_000 }); return; }
    now += 20_000;
    f.statuses.set(id, { state: 'failed', retryAt: now + 60_000 });
    throw new Error('upload timeout');
  };
  const queue = new ReferencePreparationQueue(() => [f.mirror], () => now);
  for (let i = 0; i < 5; i++) await queue.runOnce();
  expect(f.calls).toEqual(ids);
});

it('serves new enabled materials before retrying repeatedly failing selections across mirrors', async () => {
  const mirrors = ['a', 'b', 'c', 'd'].map(fixture); let now = 1_000;
  const calls: string[] = [];
  for (const f of mirrors) f.mirror.prepare = async id => {
    calls.push(`${f.mirror.id}:${id}`);
    if (id === 'selected') {
      now += 20_000; f.statuses.set(id, { state: 'failed', retryAt: now + 60_000 });
      throw new Error('upload timeout');
    }
    f.statuses.set(id, { state: 'ready', freshUntil: now + 3_600_000 });
  };
  const queue = new ReferencePreparationQueue(() => mirrors.map(f => f.mirror), () => now);
  for (let i = 0; i < 5; i++) await queue.runOnce();
  expect(calls).toEqual(['a:selected', 'b:selected', 'c:selected', 'd:selected', 'a:enabled']);
});
