import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLimitSettings } from '../src/exhibition/SessionLimitSettings';
import { CONTINUOUS_MIN_EXPIRY_SECONDS, DEFAULT_SESSION_LIMITS, SESSION_CREDIT_MAX, SESSION_EXPIRY_MAX, type ExhibitionSessionLimits } from '../shared/sessionLimits';
import type { ExhibitionState } from '../shared/exhibition';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import { createReactHost, flushReact } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(limits?: ExhibitionSessionLimits) {
  host = await createReactHost();
  const state: ExhibitionState = { mirrorId: 'default', revision: 7, phase: 'idle', experienceMode: 'clothx', selectedLookId: null, displayedLookId: null,
    looks: [], enabledLookIds: [], categories: [], tags: [], sessionNumber: 1, generationNumber: 2, updatedAt: 1, generationReadyAt: null,
    providerMode: 'xmax', live: null, logs: [], settings: { autoReturnSeconds: 90,
      uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 }, ...(limits ? { sessionLimits: limits } : {}) } };
  const send = vi.fn<ExhibitionController['send']>(async command => {
    state.settings.sessionLimits = command.sessionLimits;
    state.revision++; return true;
  });
  const controller = { state, send, pending: false, stopPending: false, connected: true, error: '', clearError: vi.fn() } as unknown as ExhibitionController;
  const render = () => host!.render(createElement(SessionLimitSettings, { key: state.mirrorId, controller }));
  await render();
  const inputNode = (name: string) => host!.find(node => node.nodeName === 'input' && node.getReactProps().name === name);
  const input = (name: string) => inputNode(name)!.getReactProps();
  const choice = (mode: 'limited' | 'unlimited') => host!.find(node => node.nodeName === 'input' && node.getReactProps().type === 'radio' && node.getReactProps().value === mode)!.getReactProps();
  const button = (label: string) => host!.find(node => node.nodeName === 'button' && node.textContent === label)!.getReactProps();
  const mode = async (value: 'limited' | 'unlimited') => act(async () => choice(value).onChange({ target: { checked: true } }));
  const change = async (name: string, value: string) => act(async () => input(name).onChange({ target: { value } }));
  const submit = async () => { await act(async () => { host!.find(node => node.nodeName === 'form')!.getReactProps().onSubmit({ preventDefault: vi.fn() }); }); await flushReact(); };
  return { state, controller, send, render, input, inputNode, choice, button, mode, change, submit };
}

describe('per-mirror session limits', () => {
  it('defaults to continuous experience and reads explicit per-mirror settings without saving', async () => {
    const f = await fixture();
    expect(f.choice('limited').checked).toBe(false); expect(f.choice('unlimited').checked).toBe(true);
    expect(f.inputNode('credits')).toBeUndefined();
    expect(f.input('expireSeconds')).toMatchObject({ value: '120', min: CONTINUOUS_MIN_EXPIRY_SECONDS, max: SESSION_EXPIRY_MAX, step: 1 });
    expect(f.button('保存会话额度').disabled).toBe(true);
    f.state.settings.sessionLimits = { credits: 90, expireSeconds: 600 }; await f.render();
    expect(f.input('credits').value).toBe('90'); expect(f.input('expireSeconds').value).toBe('600');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('submits explicit null for unlimited while retaining the credential expiry and revision protection', async () => {
    const f = await fixture({ credits: 30, expireSeconds: 120 });
    await f.mode('unlimited'); await f.change('expireSeconds', '3600');
    expect(f.inputNode('credits')).toBeUndefined();
    expect(f.input('expireSeconds').min).toBe(CONTINUOUS_MIN_EXPIRY_SECONDS);
    expect(host!.find(node => node.nodeName === 'label' && node.textContent === '无限制（自动续接）')).toBeDefined();
    expect(host!.find(node => node.nodeName === 'label' && node.textContent === '每段有效期（秒）')).toBeDefined();
    expect(host!.find(node => node.nodeName === 'p' && node.textContent.includes('仍受 XMAX 余额限制'))).toBeDefined();
    f.state.revision = 10; await f.render(); await f.submit();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', expectedRevision: 10, sessionLimits: { credits: null, expireSeconds: 3600 } });
    expect(f.choice('unlimited').checked).toBe(true); expect(f.button('保存会话额度').disabled).toBe(true);
  });

  it('switches a persisted unlimited configuration back to finite credits', async () => {
    const f = await fixture({ credits: null, expireSeconds: 3600 });
    await f.mode('limited');
    expect(f.input('credits')).toMatchObject({ value: '30', min: 1, max: SESSION_CREDIT_MAX, step: 1 });
    expect(f.button('保存会话额度').disabled).toBe(false);
    await f.change('credits', '150'); await f.submit();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', expectedRevision: 7, sessionLimits: { credits: 150, expireSeconds: 3600 } });
    expect(f.input('credits').value).toBe('150'); expect(f.choice('limited').checked).toBe(true);
  });

  it('retains an edited credit value when toggling the unsaved mode', async () => {
    const f = await fixture({ credits: 30, expireSeconds: 120 }); await f.change('credits', '75');
    await f.mode('unlimited'); await f.mode('limited');
    expect(f.input('credits').value).toBe('75'); expect(f.send).not.toHaveBeenCalled();
  });

  it('requires a 60-second segment for continuous mode without silently changing a finite one-second draft', async () => {
    const f = await fixture({ credits: 30, expireSeconds: 1 });
    expect(f.input('expireSeconds').min).toBe(1);
    await f.mode('unlimited');
    expect(f.input('expireSeconds').value).toBe('1'); expect(f.button('保存会话额度').disabled).toBe(true);
    expect(host!.find(node => node.getReactProps().role === 'alert')!.textContent).toBe('每段有效期须为 60–86,400 秒的整数。');
    await f.change('expireSeconds', '59'); await f.submit(); expect(f.send).not.toHaveBeenCalled();
    await f.change('expireSeconds', '60'); await f.submit();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', expectedRevision: 7, sessionLimits: { credits: null, expireSeconds: 60 } });
    await f.mode('limited'); await f.change('expireSeconds', '1'); await f.submit();
    expect(f.input('expireSeconds').min).toBe(1);
    expect(f.send).toHaveBeenLastCalledWith({ action: 'configure', expectedRevision: 8, sessionLimits: { credits: 30, expireSeconds: 1 } });
  });

  it('restores continuous defaults as a draft before saving', async () => {
    const f = await fixture({ credits: 90, expireSeconds: 3600 });
    await act(async () => f.button('恢复默认').onClick());
    expect(f.choice('unlimited').checked).toBe(true); expect(f.inputNode('credits')).toBeUndefined();
    expect(f.input('expireSeconds').value).toBe('120'); expect(f.send).not.toHaveBeenCalled();
    await f.submit(); expect(f.send.mock.calls[0][0].sessionLimits).toEqual(DEFAULT_SESSION_LIMITS);
  });

  it.each([['credits', '0'], ['credits', '1.5'], ['credits', String(SESSION_CREDIT_MAX + 1)], ['credits', ''],
    ['expireSeconds', '0'], ['expireSeconds', '2.5'], ['expireSeconds', String(SESSION_EXPIRY_MAX + 1)], ['expireSeconds', 'Infinity']])('rejects invalid %s=%s without a request', async (name, value) => {
    const f = await fixture({ credits: 30, expireSeconds: 120 }); await f.change(name, value);
    expect(f.button('保存会话额度').disabled).toBe(true); await f.submit(); expect(f.send).not.toHaveBeenCalled();
    expect(host!.find(node => node.getReactProps().role === 'alert')!.textContent).toBe(name === 'credits'
      ? '积分额度须为 1–1,000,000 的整数。' : '凭证有效期须为 1–86,400 秒的整数。');
  });

  it('preserves drafts during polling and refuses conflicting remote settings', async () => {
    const f = await fixture(); await f.mode('unlimited'); await f.change('expireSeconds', '300');
    f.state.revision++; await f.render();
    expect(f.choice('unlimited').checked).toBe(true); expect(f.input('expireSeconds').value).toBe('300');
    f.state.settings.sessionLimits = { credits: 60, expireSeconds: 600 }; await f.render();
    expect(f.button('保存会话额度').disabled).toBe(true);
    await f.submit(); expect(f.send).not.toHaveBeenCalled();
    await act(async () => f.button('取消修改').onClick());
    expect(f.choice('limited').checked).toBe(true); expect(f.input('credits').value).toBe('60');
    expect(f.input('expireSeconds').value).toBe('600');
  });

  it.each(['pending', 'stopPending', 'disconnected', 'positioning', 'generating', 'showcase', 'paused', 'live'] as const)('blocks saving and direct edits while %s', async reason => {
    const f = await fixture({ credits: 30, expireSeconds: 120 }); await f.change('credits', '40');
    if (reason === 'pending' || reason === 'stopPending') f.controller[reason] = true;
    else if (reason === 'disconnected') f.controller.connected = false;
    else if (reason === 'live') f.state.live = { status: 'stopping' } as ExhibitionState['live'];
    else f.state.phase = reason;
    await f.render(); expect(f.button('保存会话额度').disabled).toBe(true);
    expect(f.input('credits').disabled).toBe(true); expect(f.input('expireSeconds').disabled).toBe(true);
    await f.mode('unlimited'); await f.change('credits', '90'); await f.change('expireSeconds', '900');
    expect(f.choice('limited').checked).toBe(true); expect(f.input('credits').value).toBe('40'); expect(f.input('expireSeconds').value).toBe('120');
    await f.submit(); expect(f.send).not.toHaveBeenCalled();
  });

  it('prevents duplicate submits and retains a failed unlimited draft', async () => {
    const f = await fixture(); await f.mode('unlimited'); await f.change('expireSeconds', '300');
    let finish!: (saved: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.submit(); await f.submit(); await f.mode('limited'); await f.change('expireSeconds', '900');
    expect(f.send).toHaveBeenCalledTimes(1);
    await act(async () => finish(false));
    expect(f.choice('unlimited').checked).toBe(true); expect(f.input('expireSeconds').value).toBe('300');
    expect(f.button('保存会话额度').disabled).toBe(false);
    expect(host!.find(node => node.getReactProps().role === 'alert' && node.textContent.includes('未保存'))).toBeDefined();
  });

  it('discards another mirror draft and ignores its late save reply', async () => {
    const f = await fixture({ credits: 30, expireSeconds: 120 }); await f.mode('unlimited');
    let finish!: (saved: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await f.submit();
    f.state.mirrorId = 'mirror-other'; f.state.settings.sessionLimits = { credits: 80, expireSeconds: 600 }; await f.render();
    await act(async () => finish(true));
    expect(f.choice('limited').checked).toBe(true); expect(f.input('credits').value).toBe('80');
    expect(f.input('expireSeconds').value).toBe('600');
    expect(host!.find(node => node.getReactProps().role === 'status' && node.textContent === '已保存')).toBeUndefined();
  });
});
