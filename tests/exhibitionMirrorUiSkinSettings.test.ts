import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionState, ExhibitionUiSkinPreset } from '../shared/exhibition';
import { MirrorUiSkinSettings } from '../src/exhibition/MirrorUiSkinSettings';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import { appUrl } from '../src/versionScope';
import { createReactHost, flushReact } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
afterEach(async () => { await host?.close(); host = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(options: { phase?: ExhibitionState['phase']; skin?: boolean; preset?: ExhibitionUiSkinPreset; width?: number; height?: number } = {}) {
  host = await createReactHost();
  const state: ExhibitionState = { mirrorId: 'east', revision: 7, phase: options.phase ?? 'idle', experienceMode: 'clothx', selectedLookId: null, displayedLookId: null, looks: [], enabledLookIds: [], categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1000, generationReadyAt: null, providerMode: 'demo', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 }, uiSkinPreset: options.preset, uiSkin: options.skin ? { image: '/api/exhibition/mirrors/east/skin/current-id', width: 1080, height: 1920, bytes: 1234 } : null } };
  const uploadUiSkin = vi.fn<ExhibitionController['uploadUiSkin']>(async () => true);
  const removeUiSkin = vi.fn<ExhibitionController['removeUiSkin']>(async () => true);
  const send = vi.fn<ExhibitionController['send']>(async () => true);
  const controller = { state, mirrorId: 'east', connected: true, pending: false, error: '', uploadUiSkin, removeUiSkin, send, clearError: vi.fn() } as unknown as ExhibitionController;
  const createObjectURL = vi.fn(() => 'blob:test-skin'); const revokeObjectURL = vi.fn();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL);
  vi.stubGlobal('Image', class {
    naturalWidth = options.width ?? 1080; naturalHeight = options.height ?? 1920;
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  const readers: any[] = [];
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,dGVzdA=='; onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
    readAsDataURL = vi.fn(() => { queueMicrotask(() => this.onload?.()); }); abort = vi.fn(() => this.onabort?.());
    constructor() { readers.push(this); }
  });
  const render = () => host!.render(createElement(MirrorUiSkinSettings, { controller }));
  const props = (predicate: Parameters<NonNullable<typeof host>['find']>[0]) => host!.find(predicate)!.getReactProps();
  const button = (label: string) => props(node => node.nodeName === 'button' && (node.getReactProps()['aria-label'] === label || node.textContent === label));
  const choose = async (file = new File(['fixture'], 'skin.png', { type: 'image/png' })) => { await act(async () => { props(node => node.getReactProps()['aria-label'] === '镜端皮肤图片').onChange({ target: { files: [file] } }); }); await flushReact(); };
  const save = async () => { await act(async () => { props(node => node.nodeName === 'form').onSubmit({ preventDefault: vi.fn() }); }); await flushReact(); };
  await render();
  return { state, controller, uploadUiSkin, removeUiSkin, send, render, button, choose, save, createObjectURL, revokeObjectURL, readers };
}

describe('mirror UI skin settings', () => {
  it('shows the shared current skin with a version-aware URL and restores it explicitly', async () => {
    const f = await fixture({ skin: true });
    expect(host!.find(node => node.getReactProps().alt === '当前镜端皮肤')!.getReactProps()).toMatchObject({ src: appUrl('/api/exhibition/mirrors/east/skin/current-id') });
    expect(f.removeUiSkin).not.toHaveBeenCalled();
    await act(async () => { f.button('恢复默认').onClick(); });
    expect(f.removeUiSkin).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 7 });
  });

  it('shows both built-in choices and switches with the latest revision', async () => {
    const f = await fixture();
    expect(f.button('水晶浅紫')['aria-pressed']).toBe(true);
    expect(f.button('品牌紫')['aria-pressed']).toBe(false);
    f.state.revision = 9; await f.render();
    await act(async () => { f.button('品牌紫').onClick(); });
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: 'configure', uiSkinPreset: 'brand', expectedRevision: 9 });
    expect(f.uploadUiSkin).not.toHaveBeenCalled();
    f.state.settings.uiSkinPreset = 'brand'; await f.render();
    expect(f.button('品牌紫')['aria-pressed']).toBe(true);
    expect(f.button('水晶浅紫')['aria-pressed']).toBe(false);
  });

  it('keeps custom skin active until preset switching succeeds and supports retry', async () => {
    const f = await fixture({ skin: true, preset: 'brand' });
    expect(f.button('品牌紫')['aria-pressed']).toBe(false);
    f.send.mockResolvedValueOnce(false);
    await act(async () => { f.button('品牌紫').onClick(); });
    expect(f.state.settings.uiSkin?.image).toContain('current-id');
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain('皮肤未切换');
    expect(f.button('品牌紫').disabled).toBe(false);
    await act(async () => { f.button('品牌紫').onClick(); });
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('clears an unsaved upload when selecting the already active preset without a server write', async () => {
    const f = await fixture(); await f.choose();
    await act(async () => { f.button('水晶浅紫').onClick(); });
    expect(f.send).not.toHaveBeenCalled(); expect(f.uploadUiSkin).not.toHaveBeenCalled();
    expect(f.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test-skin');
    expect(host!.find(node => node.getReactProps().alt === '待保存的镜端皮肤')).toBeUndefined();
  });

  it('blocks duplicate preset clicks while a switch is saving', async () => {
    const f = await fixture();
    let finish!: (value: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const brand = f.button('品牌紫');
    await act(async () => { brand.onClick(); brand.onClick(); });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.button('水晶浅紫').disabled).toBe(true);
    await act(async () => { finish(true); });
    expect(f.button('水晶浅紫').disabled).toBe(false);
  });

  it('checks a selected portrait image and saves it with the selection revision', async () => {
    const f = await fixture();
    await f.choose();
    expect(f.uploadUiSkin).not.toHaveBeenCalled();
    expect(f.button('保存皮肤').disabled).toBe(false);
    f.state.revision = 9; await f.render(); await f.save();
    expect(f.uploadUiSkin).toHaveBeenCalledExactlyOnceWith({ imageBase64: 'data:image/png;base64,dGVzdA==', expectedRevision: 7 });
    expect(f.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test-skin');
  });

  it.each([
    { file: () => new File(['fixture'], 'skin.gif'), message: '请选择 PNG、JPG 或 WebP 图片。' },
    { file: () => new File([], 'skin.png'), message: '图片为空，请重新选择。' },
    { file: () => new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'skin.png'), message: '皮肤图片不能超过 8 MB。' },
  ])('rejects unsuitable files before decoding or sending', async ({ file, message }) => {
    const f = await fixture(); await f.choose(file()); await f.save();
    expect(f.createObjectURL).not.toHaveBeenCalled(); expect(f.uploadUiSkin).not.toHaveBeenCalled();
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toBe(message);
  });

  it.each([{ width: 1000, height: 1000 }, { width: 400, height: 1000 }])('rejects a $width × $height image outside the portrait range', async dimensions => {
    const f = await fixture(dimensions); await f.choose(); await f.save();
    expect(f.button('保存皮肤').disabled).toBe(true); expect(f.uploadUiSkin).not.toHaveBeenCalled();
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain('0.45–0.75');
  });

  it.each(['generating', 'showcase', 'paused', 'positioning'] as const)('blocks uploads and restores while %s', async phase => {
    const f = await fixture({ skin: true, phase });
    await f.choose(); await f.save();
    await act(async () => { f.button('恢复默认').onClick(); });
    await act(async () => { f.button('品牌紫').onClick(); });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.createObjectURL).not.toHaveBeenCalled(); expect(f.uploadUiSkin).not.toHaveBeenCalled(); expect(f.removeUiSkin).not.toHaveBeenCalled();
  });

  it.each(['live', 'pending', 'stopping', 'disconnected'] as const)('guards direct handlers when unavailable because of %s', async reason => {
    const f = await fixture({ skin: true }); await f.choose();
    if (reason === 'live') f.state.live = { status: 'stopping' } as ExhibitionState['live'];
    else if (reason === 'pending') f.controller.pending = true;
    else if (reason === 'stopping') f.controller.stopPending = true;
    else f.controller.connected = false;
    await f.render(); await f.save();
    await act(async () => { f.button('恢复默认').onClick(); });
    await act(async () => { f.button('品牌紫').onClick(); });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.uploadUiSkin).not.toHaveBeenCalled(); expect(f.removeUiSkin).not.toHaveBeenCalled();
  });

  it('keeps the current skin when upload fails and leaves selection available for retry', async () => {
    const f = await fixture({ skin: true }); await f.choose();
    f.uploadUiSkin.mockResolvedValueOnce(false); await f.save();
    expect(f.state.settings.uiSkin?.image).toBe('/api/exhibition/mirrors/east/skin/current-id');
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain('皮肤未保存');
    expect(host!.find(node => node.getReactProps()['aria-label'] === '镜端皮肤图片')?.getReactProps().disabled).toBe(false);
  });

  it('does not send a decoded file after the panel unmounts', async () => {
    const f = await fixture(); await f.choose();
    let finishRead!: () => void;
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,dGVzdA=='; onload: (() => void) | null = null;
      readAsDataURL() { finishRead = () => this.onload?.(); } abort() {}
    });
    await f.save();
    await host!.close(); host = undefined;
    await act(async () => { finishRead(); }); await flushReact();
    expect(f.uploadUiSkin).not.toHaveBeenCalled(); expect(f.revokeObjectURL).toHaveBeenCalledOnce();
  });
});
