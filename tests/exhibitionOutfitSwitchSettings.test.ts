import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionState } from '../shared/exhibition';
import { OutfitSwitchSettings } from '../src/exhibition/OutfitSwitchSettings';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import { createReactHost, flushReact } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(options: { phase?: ExhibitionState['phase']; mode?: 'manual' | 'auto'; seconds?: number; count?: number } = {}) {
  host = await createReactHost();
  const looks = Array.from({ length: options.count ?? 2 }, (_, index) => ({ id: `look-${index}`, mode: 'clothx' as const, name: `素材 ${index}`, description: '', image: '/test.png', source: 'sample' as const, palette: '', category: '', tags: [] }));
  const state: ExhibitionState = { mirrorId: 'default', revision: 7, phase: options.phase ?? 'idle', experienceMode: 'clothx', selectedLookId: looks[0]?.id ?? null, displayedLookId: null, looks, enabledLookIds: looks.map(look => look.id), categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1000, generationReadyAt: null, providerMode: 'demo', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 }, ...(options.mode ? { switchMode: options.mode } : {}), ...(options.seconds ? { autoSwitchSeconds: options.seconds } : {}) } };
  const send = vi.fn<ExhibitionController['send']>(async () => true);
  const controller = { state, connected: true, pending: false, error: '', send, clearError: vi.fn() } as unknown as ExhibitionController;
  const render = () => host!.render(createElement(OutfitSwitchSettings, { controller }));
  await render();
  const findProps = (predicate: Parameters<NonNullable<typeof host>['find']>[0]) => host!.find(predicate)!.getReactProps();
  const radio = (value: string) => findProps(node => node.nodeName === 'input' && node.getReactProps().type === 'radio' && node.getReactProps().value === value);
  const input = () => findProps(node => node.nodeName === 'input' && node.getReactProps().type === 'number');
  const button = (label: string) => findProps(node => node.nodeName === 'button' && node.textContent === label);
  const change = async (value: string) => act(async () => { input().onChange({ target: { value } }); });
  const save = async () => { await act(async () => { findProps(node => node.nodeName === 'form').onSubmit({ preventDefault: vi.fn() }); }); await flushReact(); };
  return { state, controller, send, render, radio, input, button, change, save };
}

describe('manual and automatic outfit switching controls', () => {
  it('defaults old mirrors to manual and persists auto without beginning an experience', async () => {
    const f = await fixture();
    expect(f.radio('manual').checked).toBe(true); expect(f.radio('auto').checked).toBe(false);
    await act(async () => { f.radio('auto').onChange(); });
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', switchMode: 'auto' });
    f.state.settings.switchMode = 'auto'; await f.render();
    expect(f.input().value).toBe('30');
    expect(host!.find(node => node.getReactProps().className === 'ex-outfit-switch-hint')?.getReactProps().children[0]).toContain('显示生成结果后，每 30 秒按素材顺序切换。');
  });

  it.each(['generating', 'showcase', 'paused'] as const)('can turn automatic switching off while %s', async phase => {
    const f = await fixture({ mode: 'auto', phase });
    await act(async () => { f.radio('manual').onChange(); });
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', switchMode: 'manual' });
  });

  it('keeps a draft through unrelated polling and saves the interval with the latest revision', async () => {
    const f = await fixture({ mode: 'auto', seconds: 30 });
    await f.change('45');
    f.state.revision = 12; f.state.phase = 'showcase'; await f.render();
    expect(f.input().value).toBe('45'); expect(f.button('保存间隔').disabled).toBe(false);
    await f.save();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', autoSwitchSeconds: 45, expectedRevision: 12 });
  });

  it('detects concurrent interval changes without discarding the draft and can reload them', async () => {
    const f = await fixture({ mode: 'auto', seconds: 30 });
    await f.change('45');
    f.state.settings.autoSwitchSeconds = 60; f.state.revision++; await f.render();
    expect(f.input().value).toBe('45'); expect(f.button('保存间隔').disabled).toBe(true);
    await f.save(); expect(f.send).not.toHaveBeenCalled();
    expect(host!.find(node => node.textContent === '间隔已在其他页面更新，请读取最新设置。')).toBeDefined();
    await act(async () => { f.button('放弃修改，读取最新间隔').onClick(); });
    expect(f.input().value).toBe('60');
    expect(f.controller.clearError).toHaveBeenCalledOnce();
  });

  it.each(['', '4', '601', '5.5', 'NaN'])('rejects invalid interval %j even if submitted directly', async value => {
    const f = await fixture({ mode: 'auto' });
    await f.change(value); expect(f.button('保存间隔').disabled).toBe(true);
    await f.save(); expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['5', '600'])('accepts boundary interval %s', async value => {
    const f = await fixture({ mode: 'auto' });
    await f.change(value); await f.save();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', autoSwitchSeconds: Number(value), expectedRevision: 7 });
  });

  it.each(['pending', 'disconnected'] as const)('guards changes while %s, including direct handler calls', async reason => {
    const f = await fixture({ mode: 'auto' });
    await f.change('45');
    if (reason === 'pending') f.controller.pending = true; else f.controller.connected = false;
    await f.render();
    expect(f.input().disabled).toBe(true);
    await act(async () => { f.radio('manual').onChange(); }); await f.save();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('guards rapid double changes before the pending prop arrives and retains failed drafts', async () => {
    const f = await fixture({ mode: 'auto' });
    await f.change('45');
    let finish!: (success: boolean) => void;
    f.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const manual = f.radio('manual');
    await act(async () => { manual.onChange(); manual.onChange(); });
    expect(f.send).toHaveBeenCalledOnce();
    await act(async () => { finish(false); });
    expect(f.input().value).toBe('45');
    expect(host!.find(node => node.getReactProps().role === 'alert' && node.textContent.includes('设置未保存'))).toBeDefined();
    await f.save(); expect(f.send).toHaveBeenCalledTimes(2);
    await act(async () => { finish(true); });
  });

  it('explains why rotation needs multiple enabled materials without starting one', async () => {
    const f = await fixture({ mode: 'auto', count: 1 });
    expect(host!.find(node => node.textContent.includes('当前模式至少启用 2 份素材后才能自动换装。'))).toBeDefined();
    expect(f.send).not.toHaveBeenCalled();
  });
});
