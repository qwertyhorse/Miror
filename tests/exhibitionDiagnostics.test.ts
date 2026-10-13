import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExhibitionDiagnostics, type DiagnosticContext, type DiagnosticEventInput, type DiagnosticEventType } from '../src/exhibition/diagnostics';
import { DiagnosticsPanel } from '../src/exhibition/DiagnosticsPanel';

const context = (patch: Partial<DiagnosticContext> = {}): DiagnosticContext => ({
  mirrorId: 'mirror-1', sessionNumber: 2, generationNumber: 3, lookId: 'look-1', ...patch,
});
function fixture(maxEvents?: number) {
  let time = 100;
  const store = createExhibitionDiagnostics({ now: () => time, maxEvents });
  const current = context();
  store.observe(current, { active: true });
  function record(type: DiagnosticEventType, patch: Partial<DiagnosticEventInput> = {}) {
    time += 10;
    return store.record({ type, context: current, operationId: 'op-1', ...patch });
  }
  function ready(operationId = 'op-1', round = current) {
    record('sdk_set_started', { operationId, context: round });
    record('sdk_set_resolved', { operationId, context: round });
    record('condition_committed', { operationId, context: round });
  }
  return { store, current, record, ready, advance: (value = 10) => { time += value; }, get time() { return time; } };
}

describe('page-owned exhibition diagnostics', () => {
  it('creates independent stores and a stable immutable useSyncExternalStore snapshot', () => {
    const f = fixture();
    const other = fixture();
    const first = f.store.getSnapshot();
    expect(f.store.getSnapshot()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.current).toEqual(f.current);
    const listener = vi.fn();
    const unsubscribe = f.store.subscribe(listener);
    f.record('sample');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.store.getSnapshot()).not.toBe(first);
    expect(other.store.getSnapshot().events).toEqual([]);
    unsubscribe();
    f.record('sample');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('serializes only context, event and metric allowlists, never arbitrary errors, URLs, prompts or credentials', () => {
    const f = fixture();
    const raw = { type: 'sample', context: { ...f.current, prompt: 'private-prompt', apiKey: 'uk-private', url: 'https://private.test' },
      metrics: { fps: 14, armed: true, operatorStatus: 'locked', captureStatus: 'active', source: 'gesture', controlSource: 'hand', ambiguityReason: 'hands', gesture: 'open_palm', needsRelease: true, frameId: 8,
        durationMs: Infinity, inferenceMs: -1, recognitionMs: 'bad', packetLoss: NaN, rawMessage: 'private-message', referenceUrl: 'https://private.test' },
      message: 'private-message', token: 'tk-private', detail: { confidential: true }, prompt: 'private-prompt' };
    const event = f.store.record(raw as unknown as DiagnosticEventInput)!;
    expect(event.context).toEqual(f.current);
    expect(event.metrics).toEqual({ fps: 14, frameId: 8, armed: true, operatorStatus: 'locked', captureStatus: 'active', source: 'gesture', controlSource: 'hand', ambiguityReason: 'hands', gesture: 'open_palm', needsRelease: true });
    raw.context.lookId = 'changed'; raw.metrics.fps = 99;
    expect(event.context.lookId).toBe('look-1');
    expect(event.metrics!.fps).toBe(14);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.context)).toBe(true);
    expect(Object.isFrozen(event.metrics)).toBe(true);
    expect(f.store.exportJSON()).not.toMatch(/private-|confidential|rawMessage|referenceUrl/);
  });

  it.each([
    { type: 'message' }, { at: NaN }, { at: -1 }, { operationId: 'https://private.test' }, { actionId: 'uk-private' },
    { reason: 'raw error message' }, { interactionId: 'https://private.test' }, { interactionId: 'tk-private' },
    { context: context({ sessionNumber: -1 }) }, { context: context({ generationNumber: 1.2 }) },
    { context: context({ lookId: 'blob:secret' }) }, { context: context({ sessionId: 'tk-private' }) },
    { context: context({ referenceVersion: Infinity }) },
  ])('rejects an invalid required field: %j', patch => {
    const f = fixture();
    expect(f.store.record({ type: 'sample', context: f.current, ...patch } as unknown as DiagnosticEventInput)).toBeNull();
    expect(f.store.getSnapshot().events).toHaveLength(0);
  });

  it('exports bounded confirmation reasons and numeric progress without hand landmarks or free text', () => {
    const f = fixture();
    f.record('sample', { metrics: { confirmationState: 'holding', palmHoldMs: 200, rawHandCount: 1, matchedHandCount: 1,
      landmarks: [{ x: 0.4, y: 0.3 }], debug: 'private-hand-data' } as DiagnosticEventInput['metrics'] });
    f.record('sample', { metrics: { confirmationState: 'private-reason', palmHoldMs: -1, rawHandCount: Infinity,
      matchedHandCount: NaN } as unknown as DiagnosticEventInput['metrics'] });
    const exported = JSON.parse(f.store.exportJSON());
    expect(exported.events[0].metrics).toEqual({ confirmationState: 'holding', palmHoldMs: 200, rawHandCount: 1, matchedHandCount: 1 });
    expect(exported.events[1].metrics).toBeUndefined();
    expect(f.store.exportJSON()).not.toMatch(/landmarks|private-|debug/);
  });

  it('shows confirmation progress and rejection conditions separately from gesture counts', () => {
    const f = fixture();
    f.record('sample', { metrics: { captureStatus: 'active', handDetected: true, armed: true, confirmationState: 'holding', palmHoldMs: 200, rawHandCount: 1, matchedHandCount: 1 } });
    const render = () => renderToStaticMarkup(createElement(DiagnosticsPanel, { store: f.store, onClose: () => {} }));
    expect(render()).toContain('展掌确认 200 / 300 ms');
    expect(render()).toContain('检出 1 / 匹配 1');
    f.record('sample', { metrics: { captureStatus: 'active', handDetected: true, armed: true, confirmationState: 'fingers_folded' } });
    expect(render()).toContain('掌形未确认');
    f.record('sample', { metrics: { captureStatus: 'hidden', confirmationState: 'holding', palmHoldMs: 200 } });
    expect(render()).toContain('暂停取景');
    expect(render()).not.toContain('展掌确认 200');
    expect(f.store.getSnapshot().events.filter(event => event.type === 'gesture_confirmed')).toHaveLength(0);
  });

  it('requires operation IDs for cloud milestones and action IDs for commands', () => {
    const f = fixture();
    expect(f.record('sdk_set_resolved', { operationId: undefined })).toBeNull();
    expect(f.record('command_sent', { operationId: undefined })).toBeNull();
    expect(f.record('sample', { operationId: undefined })).not.toBeNull();
  });

  it('requires resolved set plus committed condition from one exact operation and marks it manually once', () => {
    const f = fixture();
    expect(f.store.markVisible()).toBeNull();
    f.record('sdk_set_resolved');
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    expect(f.record('condition_committed', { operationId: 'other-op' })).toBeNull();
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    f.record('condition_committed');
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
    f.advance();
    expect(f.store.markVisible()).toMatchObject({ type: 'manual_visible', operationId: 'op-1', metrics: { source: 'manual' } });
    expect(f.store.getSnapshot().stats).toMatchObject({ confirmed: 1, failed: 0, unconfirmed: 0 });
    expect(f.store.markVisible()).toBeNull();
    expect(f.record('manual_visible')).toBeNull();
  });

  it('accepts an initial session first frame but not a first frame falsely attached to a later update in that session', () => {
    const f = fixture();
    const initial = context({ sessionId: 'ums-1' });
    f.store.observe(initial, { active: true });
    f.record('session_first_frame', { context: initial, operationId: 'initial' });
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
    f.record('sdk_set_started', { context: initial, operationId: 'update' });
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    f.record('session_first_frame', { context: initial, operationId: 'update' });
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    f.record('sdk_set_resolved', { context: initial, operationId: 'update' });
    f.record('condition_committed', { context: initial, operationId: 'update' });
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
  });

  it('rejects out-of-order commits, backwards timestamps, prior stages and incompatible reference versions', () => {
    const f = fixture();
    expect(f.record('condition_committed')).toBeNull();
    f.record('bind_ready', { context: context({ sessionId: 'ums-1', referenceVersion: 4 }) });
    expect(f.record('sdk_set_started', { context: context({ sessionId: 'ums-1', referenceVersion: 3 }) })).toBeNull();
    f.record('sdk_set_resolved', { context: context({ sessionId: 'ums-1', referenceVersion: 4 }) });
    expect(f.record('bind_ready')).toBeNull();
    expect(f.record('condition_committed', { at: 1 })).toBeNull();
    expect(f.record('condition_committed', { context: context({ sessionId: 'ums-other', referenceVersion: 4 }) })).toBeNull();
    expect(f.record('condition_committed', { context: context({ sessionId: 'ums-1', referenceVersion: 5 }) })).toBeNull();
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    f.record('condition_committed', { context: context({ sessionId: 'ums-1', referenceVersion: 4 }) });
    f.store.observe(context({ sessionId: 'ums-1', referenceVersion: 4 }), { active: true });
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
  });

  it('retains future command milestones until observe matches the complete tuple and associates the manual marker', () => {
    const f = fixture();
    const next = context({ generationNumber: 4, lookId: 'look-2' });
    f.record('command_sent', { context: next, operationId: undefined, actionId: 'action-next' });
    f.record('command_accepted', { context: next, operationId: undefined, actionId: 'action-next' });
    f.ready('op-next', next);
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    f.store.observe(context({ lookId: 'look-2' }), { active: true });
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    f.store.observe(next, { active: true });
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
    f.advance();
    expect(f.store.markVisible()).toMatchObject({ operationId: 'op-next', actionId: 'action-next', context: next });
    expect(f.store.getSnapshot().stats).toMatchObject({ confirmed: 1, unconfirmed: 0 });
  });

  it('invalidates the old manual button immediately when a new command is sent, before observe catches up', () => {
    const f = fixture();
    f.ready();
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
    const next = context({ generationNumber: 4, lookId: 'look-2' });
    f.record('command_sent', { context: next, operationId: undefined, actionId: 'action-next' });
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    expect(f.store.markVisible()).toBeNull();
    expect(f.record('condition_committed')).toBeNull();
    f.ready('op-next', next);
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    f.store.observe(next, { active: true });
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
  });

  it('links a gesture and its retry attempts through a safe interaction ID inherited by the manual observation', () => {
    const f = fixture();
    f.record('gesture_confirmed', { operationId: undefined, interactionId: 'gesture-1' });
    f.record('command_sent', { operationId: undefined, actionId: 'gesture-1-attempt-1', interactionId: 'gesture-1' });
    f.record('command_rejected', { operationId: undefined, actionId: 'gesture-1-attempt-1', interactionId: 'gesture-1', reason: 'rejected' });
    f.record('command_sent', { operationId: undefined, actionId: 'gesture-1-attempt-2', interactionId: 'gesture-1' });
    f.record('command_accepted', { operationId: undefined, actionId: 'gesture-1-attempt-2', interactionId: 'gesture-1' });
    f.ready('retried-operation');
    f.advance();
    expect(f.store.markVisible()).toMatchObject({ actionId: 'gesture-1-attempt-2', interactionId: 'gesture-1', operationId: 'retried-operation' });
    expect(JSON.parse(f.store.exportJSON()).events.map((event: { interactionId?: string }) => event.interactionId).filter(Boolean))
      .toEqual(Array(6).fill('gesture-1'));
  });

  it('logs a cancelled queued action without counting failure or opening manual confirmation', () => {
    const f = fixture();
    expect(f.record('command_cancelled', { operationId: undefined, actionId: 'gesture-2-attempt-0', interactionId: 'gesture-2', reason: 'cancelled' }))
      .toMatchObject({ type: 'command_cancelled', reason: 'cancelled', interactionId: 'gesture-2' });
    expect(f.store.getSnapshot().stats).toMatchObject({ confirmed: 0, failed: 0, unconfirmed: 0 });
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    expect(f.record('command_accepted', { operationId: undefined, actionId: 'gesture-2-attempt-0', interactionId: 'gesture-2' })).toBeNull();
  });

  it('allows idle/select A→B→A loops with fresh IDs, while rejecting old callbacks and old markers', () => {
    const f = fixture();
    f.store.observe(f.current, { active: false });
    f.ready();
    const other = context({ lookId: 'look-2' });
    f.store.observe(other, { active: false });
    f.store.observe(f.current, { active: true });
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    expect(f.record('condition_committed')).toBeNull();
    f.record('command_sent', { operationId: undefined, actionId: 'fresh-action' });
    f.record('command_accepted', { operationId: undefined, actionId: 'fresh-action' });
    f.ready('fresh-op');
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
    f.advance();
    expect(f.store.markVisible()).toMatchObject({ operationId: 'fresh-op', actionId: 'fresh-action' });
  });

  it.each(['failed', 'stopped'] as const)('a %s invalidates older eligible operations and does not resurrect on inactive→active', type => {
    const f = fixture();
    f.ready();
    f.record(type, { reason: type === 'failed' ? 'provider_error' : 'stopped' });
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    f.store.observe(f.current, { active: false });
    f.store.observe(f.current, { active: true });
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    expect(f.record('sdk_set_resolved')).toBeNull();
    expect(f.record('condition_committed')).toBeNull();
    f.ready('retry');
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
  });

  it('retains a stop after observe disables the round and terminates its pending statistic', () => {
    const f = fixture();
    f.ready();
    expect(f.store.getSnapshot().stats.unconfirmed).toBe(1);
    f.store.observe(f.current, { active: false });
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    expect(f.record('stopped', { reason: 'stopped' })).not.toBeNull();
    expect(f.store.getSnapshot().stats.unconfirmed).toBe(0);
    expect(f.store.getSnapshot().latestStage).toBe('stopped');
    f.store.observe(f.current, { active: true });
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    expect(f.record('condition_committed')).toBeNull();
    expect(f.record('stopped', { reason: 'stopped' })).toBeNull();
  });

  it('accepts an old attempt teardown without disabling a fresh retry in the same tuple', () => {
    const f = fixture();
    f.ready('old');
    f.store.observe(f.current, { active: false });
    f.store.observe(f.current, { active: true });
    f.ready('fresh');
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
    expect(f.record('stopped', { operationId: 'old', reason: 'stopped' })).not.toBeNull();
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
    f.advance();
    expect(f.store.markVisible()).toMatchObject({ operationId: 'fresh' });
  });

  it('does not borrow readiness across look, generation, mirror, session or optional supplier identity', () => {
    for (const patch of [{ lookId: 'look-2' }, { generationNumber: 4 }, { sessionNumber: 3 }, { mirrorId: 'mirror-2' }, { sessionId: 'ums-other' }]) {
      const f = fixture();
      f.ready('initial', context({ sessionId: 'ums-1' }));
      f.store.observe(context({ sessionId: 'ums-1' }), { active: true });
      expect(f.store.getSnapshot().canMarkVisible).toBe(true);
      expect(f.store.markVisible(context(patch))).toBeNull();
      f.store.observe(context(patch), { active: true });
      expect(f.store.getSnapshot().canMarkVisible).toBe(false);
    }
  });

  it('clears eligibility and all visible data but remembers IDs even when their events were evicted', () => {
    const f = fixture(2);
    f.record('gesture_confirmed', { actionId: 'gesture-old', operationId: undefined });
    f.ready('old-op');
    f.record('command_accepted', { actionId: 'old-action', operationId: undefined });
    f.record('sample'); f.record('sample');
    f.store.clear();
    expect(f.store.getSnapshot()).toMatchObject({ events: [], canMarkVisible: false, latestStage: null, droppedCount: 0,
      stats: { confirmed: 0, failed: 0, unconfirmed: 0 } });
    expect(f.record('sdk_set_resolved', { operationId: 'old-op' })).toBeNull();
    expect(f.record('command_accepted', { operationId: undefined, actionId: 'old-action' })).toBeNull();
    expect(f.record('gesture_confirmed', { operationId: undefined, actionId: 'gesture-old' })).toBeNull();
    expect(f.record('sample', { at: 1, operationId: undefined })).toBeNull();
    f.ready('new-op');
    expect(f.store.getSnapshot().canMarkVisible).toBe(true);
  });

  it('reports the latest non-sample stage in the current round only', () => {
    const f = fixture();
    f.record('stopped', { reason: 'stopped' });
    const next = context({ generationNumber: 4, lookId: 'look-2' });
    f.store.observe(next, { active: true });
    expect(f.store.getSnapshot().latestStage).toBeNull();
    f.record('sdk_set_started', { operationId: 'next-op', context: next });
    f.record('sample', { operationId: undefined, context: next });
    expect(f.store.getSnapshot().latestStage).toBe('sdk_set_started');
    expect(f.record('failed', { reason: 'provider_error' })).toBeNull();
    expect(f.store.getSnapshot().latestStage).toBe('sdk_set_started');
  });

  it('counts manual observations, unique command/generation failures and pending attempts separately', () => {
    const f = fixture();
    f.ready('seen'); f.advance(); f.store.markVisible();
    f.record('failed', { operationId: 'generation-failed', reason: 'provider_error' });
    expect(f.record('failed', { operationId: 'generation-failed', reason: 'provider_error' })).toBeNull();
    f.record('command_rejected', { operationId: undefined, actionId: 'command-failed', reason: 'rejected' });
    expect(f.record('command_rejected', { operationId: undefined, actionId: 'command-failed', reason: 'rejected' })).toBeNull();
    f.ready('pending');
    expect(f.store.getSnapshot().stats).toEqual({ confirmed: 1, failed: 2, failedCommands: 1, failedGenerations: 1, unconfirmed: 1 });
  });

  it('keeps the manual evidence but excludes an eventually failed operation from successful samples', () => {
    const f = fixture();
    f.ready(); f.advance(); f.store.markVisible();
    expect(f.store.getSnapshot().stats.confirmed).toBe(1);
    f.record('failed', { reason: 'provider_error' });
    expect(f.store.getSnapshot().stats).toMatchObject({ confirmed: 0, failed: 1, failedGenerations: 1, unconfirmed: 0 });
    expect(f.store.getSnapshot().events.some(event => event.type === 'manual_visible')).toBe(true);
    expect(f.store.getSnapshot().canMarkVisible).toBe(false);
  });

  it('strictly caps retained events at ten thousand, including configured oversized limits', () => {
    const f = fixture(50_000);
    for (let i = 0; i < 10_005; i++) f.record('sample', { operationId: undefined, metrics: { frameId: i } });
    expect(f.store.getSnapshot().events).toHaveLength(10_000);
    expect(f.store.getSnapshot().droppedCount).toBe(5);
    expect(f.store.getSnapshot().events[0].metrics!.frameId).toBe(5);
  });

  it('exports a versioned report with observation and unverified labels without automatic acceptance claims', () => {
    const f = fixture(); f.ready();
    const report = JSON.parse(f.store.exportJSON());
    expect(report).toMatchObject({ schemaVersion: 1, current: f.current, droppedCount: 0, statisticsScope: 'since_clear' });
    expect(Number.isFinite(Date.parse(report.startTime))).toBe(true);
    expect(Number.isFinite(Date.parse(report.exportTime))).toBe(true);
    expect(report.timeOrigin).toBe(performance.timeOrigin);
    expect(report.clock).toContain('milliseconds from timeOrigin');
    expect(report.observationLabel).toContain('人工观察');
    expect(report.unverifiedFields).toContain('自动识别服装已变化');
    expect(report.stats.confirmed).toBe(0);
    expect(report.stats.unconfirmed).toBe(1);
  });

  it('closes permanently, releases listeners and history, and never lets evidence callbacks interrupt business code', () => {
    const f = fixture();
    f.store.subscribe(() => { throw new Error('UI observer failed'); });
    expect(() => f.record('sample')).not.toThrow();
    f.store.close();
    const final = f.store.getSnapshot();
    expect(final.events).toEqual([]);
    expect(final.current).toBeNull();
    expect(f.record('sample')).toBeNull();
    expect(f.store.markVisible()).toBeNull();
    f.store.clear(); f.store.observe(f.current, { active: true }); f.store.close();
    expect(f.store.getSnapshot()).toBe(final);
    const listener = vi.fn(); f.store.subscribe(listener); f.record('sample');
    expect(listener).not.toHaveBeenCalled();
  });
});
