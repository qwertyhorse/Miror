import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXHIBITION_DEFAULT_UPLOAD_LIMITS, type ExhibitionLook, type ExhibitionState } from '../shared/exhibition';
import { LookEditor, WardrobePanel } from '../src/exhibition/WardrobePanel';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import { appUrl } from '../src/versionScope';
import { createReactHost, flushReact } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
const restores: (() => void)[] = [];
afterEach(async () => {
  await host?.close(); host = undefined;
  restores.splice(0).forEach(restore => restore());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const legacy: ExhibitionLook = { id: 'outfit', name: '测试套装', description: '原有说明', mode: 'clothx', image: '/display-original.webp',
  palette: '', category: '', tags: [], source: 'upload' };
const dual: ExhibitionLook = { ...legacy, referenceImage: '/reference-original.webp', referenceKind: 'image' };
const promptOnly: ExhibitionLook = { ...legacy, mode: 'free', referenceKind: 'none', prompt: '保留人物表情' };
type ImageSide = '展示图' | 'XMAX 参考图';
const file = (name: string) => new File([name], name, { type: 'image/png' });
const base64 = (name: string) => `data:image/png;base64,${Buffer.from(name).toString('base64')}`;

async function fixture(look?: ExhibitionLook) {
  host = await createReactHost();
  const prototype = Object.getPrototypeOf(document.createElement('div'));
  const descriptors = new Map(['showModal', 'close', 'querySelector', 'focus', 'matches', 'isConnected'].map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
  Object.defineProperties(prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
    querySelector: { configurable: true, value(selector: string) {
      return host!.find(node => !node.getReactProps().disabled && (selector.startsWith('input[type="file"]') ? node.getReactProps().type === 'file'
        : selector.startsWith('[autofocus]') ? node.getReactProps().autoFocus : selector.startsWith('button') && node.nodeName === 'button'));
    } },
    focus: { configurable: true, value() { Reflect.set(document, 'activeElement', this); } },
    matches: { configurable: true, value() { return false; } },
    isConnected: { configurable: true, get() { return document.body.contains(this); } },
  });
  restores.push(() => descriptors.forEach((value, key) => { if (value) Object.defineProperty(prototype, key, value); else Reflect.deleteProperty(prototype, key); }));
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  const state: ExhibitionState = { mirrorId: 'east', revision: 7, phase: 'idle', experienceMode: 'clothx', selectedLookId: null, displayedLookId: null,
    looks: look ? [look] : [], enabledLookIds: look ? [look.id] : [], categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1000,
    generationReadyAt: null, providerMode: 'demo', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { ...EXHIBITION_DEFAULT_UPLOAD_LIMITS } } };
  const upload = vi.fn<ExhibitionController['upload']>(async () => ({ lookId: 'new', index: 0 }));
  const updateLook = vi.fn<ExhibitionController['updateLook']>(async () => true);
  const controller = { state, mirrorId: 'east', pending: false, connected: true, error: '', upload, updateLook, deleteLook: vi.fn(async () => true) } as unknown as ExhibitionController;
  const saved = vi.fn(); const close = vi.fn(); const deleted = vi.fn();
  const images: { naturalWidth: number; naturalHeight: number; onload: (() => void) | null; onerror: (() => void) | null; src: string }[] = [];
  let holdImages = false;
  let sequence = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => `blob:${(blob as File).name}:${++sequence}`);
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('Image', class {
    naturalWidth = 800; naturalHeight = 1200; onload: (() => void) | null = null; onerror: (() => void) | null = null; private url = '';
    constructor() { images.push(this); }
    get src() { return this.url; }
    set src(value: string) {
      this.url = value;
      if (value.includes('small')) this.naturalWidth = 100;
      if (!holdImages) queueMicrotask(() => value.includes('corrupt') ? this.onerror?.() : this.onload?.());
    }
  });
  vi.stubGlobal('FileReader', class {
    result = ''; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    readAsDataURL(value: File) { this.result = base64(value.name); queueMicrotask(() => this.onload?.()); }
  });
  const render = () => host!.render(createElement(LookEditor, { controller, look, initialMode: 'clothx', saved, close, deleted }));
  const props = (predicate: Parameters<NonNullable<typeof host>['find']>[0]) => host!.find(predicate)!.getReactProps();
  const choose = async (side: ImageSide, value: File | undefined) => {
    await act(async () => { props(node => node.getReactProps()['aria-label'] === `${side}文件`).onChange({ target: { files: value ? [value] : [] } }); });
    await flushReact();
  };
  const button = (label: string) => props(node => node.nodeName === 'button' && (node.textContent === label || node.getReactProps()['aria-label'] === label));
  const saveButton = () => props(node => node.nodeName === 'button' && node.getReactProps().className === 'ex-button ex-primary');
  const submit = async () => { await act(async () => { props(node => node.nodeName === 'form').onSubmit({ preventDefault: vi.fn() }); }); await flushReact(); };
  const chooseMode = async (value: string) => { await act(async () => { props(node => node.getReactProps().type === 'radio' && node.getReactProps().value === value).onChange(); }); };
  const preview = (side: ImageSide) => host!.find(node => node.nodeName === 'img' && node.getReactProps().alt === side)?.getReactProps().src;
  await render();
  return { state, controller, upload, updateLook, saved, close, render, choose, button, saveButton, submit, chooseMode, preview, revoke, images,
    set holdImages(value: boolean) { holdImages = value; } };
}

describe('dual-image material editor', () => {
  it('allows 432 × 768 images in both upload fields', async () => {
    const f = await fixture(); f.holdImages = true;
    await f.choose('展示图', file('cover.png'));
    await f.choose('XMAX 参考图', file('reference.png'));
    await act(async () => { for (const image of f.images) { image.naturalWidth = 432; image.naturalHeight = 768; image.onload?.(); } });
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    expect(f.saveButton().disabled).toBe(false);
    await f.submit();
    expect(f.upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ imageBase64: base64('cover.png'), referenceImageBase64: base64('reference.png') }));
  });

  it('requires both distinct images for new uploads and sends their bytes in the right fields', async () => {
    const f = await fixture();
    expect(document.activeElement.getReactProps()['aria-label']).toBe('展示图文件');
    expect(host!.find(node => node.getReactProps().type === 'text')).toBeUndefined();
    await f.choose('展示图', file('person.png'));
    expect(f.saveButton().disabled).toBe(true);
    await f.submit(); expect(f.upload).not.toHaveBeenCalled();
    await f.choose('XMAX 参考图', file('white-outfit.png'));
    expect(f.preview('展示图')).toContain('person.png'); expect(f.preview('XMAX 参考图')).toContain('white-outfit.png');
    expect(f.saveButton().disabled).toBe(false);
    await f.submit();
    expect(f.upload).toHaveBeenCalledExactlyOnceWith({ name: 'person', description: '', mode: 'clothx', prompt: '',
      imageBase64: base64('person.png'), referenceImageBase64: base64('white-outfit.png') });
    expect(f.saved).toHaveBeenCalledExactlyOnceWith('clothx');
  });

  it.each([
    ['  夏日套装.JPG', '夏日套装'], ['  Cafe\u0301\u0000\u007f\u0085.png', 'Café'],
    ['套'.repeat(45) + '.webp', '套'.repeat(40)], ['  \t.png', '未命名素材'],
    ['衣'.repeat(39) + '👗.png', '衣'.repeat(39)],
  ])('derives a valid internal name from display filename %j', async (filename, expectedName) => {
    const f = await fixture();
    await f.choose('展示图', file(filename)); await f.choose('XMAX 参考图', file('reference.png')); await f.submit();
    expect(f.upload.mock.calls[0][0].name).toBe(expectedName);
  });

  it.each(['展示图', 'XMAX 参考图'] as const)('only replaces %s and preserves the opened revision and other image', async side => {
    const f = await fixture(dual);
    expect(f.preview('展示图')).toBe(appUrl(dual.image)); expect(f.preview('XMAX 参考图')).toBe(appUrl(dual.referenceImage!));
    await f.choose(side, file('replacement.png'));
    f.state.revision = 19; await f.render(); await f.submit();
    expect(f.updateLook).toHaveBeenCalledExactlyOnceWith('outfit', { name: '测试套装', description: '原有说明', mode: 'clothx', prompt: '', expectedRevision: 7,
      [side === '展示图' ? 'imageBase64' : 'referenceImageBase64']: base64('replacement.png') });
    expect(f.state.enabledLookIds).toEqual(['outfit']); expect(f.state.looks[0]).toEqual(dual);
  });

  it('preserves a legacy material name and images when changing its mode', async () => {
    const f = await fixture(legacy);
    expect(f.preview('XMAX 参考图')).toBe(appUrl(legacy.image));
    await f.chooseMode('charx'); await f.submit();
    expect(f.updateLook).toHaveBeenCalledExactlyOnceWith('outfit', { name: '测试套装', description: '原有说明', mode: 'charx', prompt: '', expectedRevision: 7 });
  });

  it('keeps a legacy reference preview fixed while only the display image is replaced', async () => {
    const f = await fixture(legacy); await f.choose('展示图', file('new-person.png'));
    expect(f.preview('展示图')).toContain('new-person.png'); expect(f.preview('XMAX 参考图')).toBe(appUrl(legacy.image));
    await f.submit(); expect(f.updateLook.mock.calls[0][1]).not.toHaveProperty('referenceImageBase64');
  });

  it('keeps prompt-only Free materials image-free when editing their display picture', async () => {
    const f = await fixture(promptOnly);
    expect(f.preview('XMAX 参考图')).toBeUndefined(); expect(f.saveButton().disabled).toBe(false);
    await f.choose('展示图', file('new-cover.png')); await f.submit();
    expect(f.updateLook.mock.calls[0][1]).toMatchObject({ referenceKind: 'none', mode: 'free', prompt: '保留人物表情', imageBase64: base64('new-cover.png') });
    expect(f.updateLook.mock.calls[0][1]).not.toHaveProperty('referenceImageBase64');
  });

  it('requires both images for a new Free material as well as its prompt', async () => {
    const f = await fixture(); await f.chooseMode('free');
    await act(async () => host!.find(node => node.nodeName === 'textarea')!.getReactProps().onChange({ target: { value: '保留人物表情' } }));
    await f.choose('展示图', file('cover.png'));
    expect(f.saveButton().disabled).toBe(true); await f.submit(); expect(f.upload).not.toHaveBeenCalled();
    await f.choose('XMAX 参考图', file('outfit.png')); await f.submit();
    expect(f.upload.mock.calls[0][0]).toMatchObject({ mode: 'free', prompt: '保留人物表情', imageBase64: base64('cover.png'), referenceImageBase64: base64('outfit.png') });
  });

  it('upgrades a prompt-only Free material only when a reference image is supplied', async () => {
    const f = await fixture(promptOnly); await f.choose('XMAX 参考图', file('outfit.png')); await f.submit();
    expect(f.updateLook.mock.calls[0][1]).toMatchObject({ referenceKind: 'image', mode: 'free', referenceImageBase64: base64('outfit.png') });
    expect(f.updateLook.mock.calls[0][1]).not.toHaveProperty('imageBase64');
  });

  it('requires an explicit reference to move a prompt-only material into another mode', async () => {
    const f = await fixture(promptOnly); await f.chooseMode('clothx');
    expect(f.saveButton().disabled).toBe(true); await f.submit(); expect(f.updateLook).not.toHaveBeenCalled();
    await f.choose('XMAX 参考图', file('outfit.png')); await f.submit();
    expect(f.updateLook.mock.calls[0][1]).toMatchObject({ referenceKind: 'image', mode: 'clothx', prompt: '', referenceImageBase64: base64('outfit.png') });
  });

  it.each([
    ['empty.png', 0, '图片为空'], ['wrong.gif', 8, '请选择 JPG'], ['huge.png', 10 * 1024 * 1024 + 1, '图片不能超过'],
    ['small.png', 8, '宽度需为'], ['corrupt.png', 8, '无法读取这张图片'],
  ])('blocks an invalid replacement %s without discarding the other image', async (name, bytes, error) => {
    const f = await fixture(dual); await f.choose('XMAX 参考图', new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
    expect(f.saveButton().disabled).toBe(true); expect(f.preview('展示图')).toBe(appUrl(dual.image));
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain(error);
    await f.submit(); expect(f.updateLook).not.toHaveBeenCalled();
    await act(async () => f.button('撤销更换XMAX 参考图').onClick());
    expect(f.preview('XMAX 参考图')).toBe(appUrl(dual.referenceImage!)); expect(f.saveButton().disabled).toBe(false);
  });

  it('ignores a cancelled picker and restores prompt-only mode when the unsaved reference is removed', async () => {
    const f = await fixture(promptOnly); await f.choose('XMAX 参考图', file('outfit.png')); await f.choose('XMAX 参考图', undefined);
    expect(f.preview('XMAX 参考图')).toContain('outfit.png');
    await act(async () => f.button('移除XMAX 参考图').onClick()); await f.submit();
    expect(f.updateLook.mock.calls[0][1]).toMatchObject({ referenceKind: 'none' });
    expect(f.updateLook.mock.calls[0][1]).not.toHaveProperty('referenceImageBase64');
  });

  it('does not accept a late size result for a superseded selection', async () => {
    const f = await fixture(dual); f.holdImages = true;
    await f.choose('XMAX 参考图', file('old.png')); await f.choose('XMAX 参考图', file('latest.png'));
    expect(f.saveButton().disabled).toBe(true);
    await act(async () => f.images[0].onload?.()); expect(f.saveButton().disabled).toBe(true);
    await act(async () => f.images[1].onload?.()); expect(f.saveButton().disabled).toBe(false);
    await f.submit(); expect(f.updateLook.mock.calls[0][1]).toMatchObject({ referenceImageBase64: base64('latest.png') });
    expect(f.revoke).toHaveBeenCalledWith('blob:old.png:1');
  });

  it('retains both selected images after a failed save and allows retry', async () => {
    const f = await fixture(dual); await f.choose('展示图', file('cover.png')); await f.choose('XMAX 参考图', file('outfit.png'));
    f.updateLook.mockResolvedValueOnce(false); await f.submit();
    expect(f.saved).not.toHaveBeenCalled(); expect(f.preview('展示图')).toContain('cover.png'); expect(f.preview('XMAX 参考图')).toContain('outfit.png');
    expect(f.saveButton().disabled).toBe(false); await f.submit(); expect(f.saved).toHaveBeenCalledOnce();
  });

  it('guards duplicate submissions while files are being read and sends nothing after unmount', async () => {
    const f = await fixture(dual); await f.choose('展示图', file('cover.png')); await f.choose('XMAX 参考图', file('outfit.png'));
    const finish: (() => void)[] = [];
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,fixture'; onload: (() => void) | null = null;
      readAsDataURL() { finish.push(() => this.onload?.()); }
    });
    await f.submit(); await f.submit(); expect(finish).toHaveLength(2);
    await host!.close(); host = undefined;
    await act(async () => finish.forEach(done => done())); await flushReact();
    expect(f.updateLook).not.toHaveBeenCalled(); expect(f.revoke).toHaveBeenCalledTimes(2);
  });

  it.each(['live', 'generating', 'pending', 'disconnected'] as const)('blocks editing images when %s', async reason => {
    const f = await fixture(dual);
    if (reason === 'live') f.state.live = { status: 'stopping' } as ExhibitionState['live'];
    else if (reason === 'generating') f.state.phase = 'generating';
    else if (reason === 'pending') f.controller.pending = true;
    else f.controller.connected = false;
    await f.render(); await f.choose('展示图', file('cover.png')); await f.submit();
    expect(f.preview('展示图')).toBe(appUrl(dual.image)); expect(f.saveButton().disabled).toBe(true); expect(f.updateLook).not.toHaveBeenCalled();
  });

  it('refreshes preparation immediately when the reference changes, without re-preparing a display-only edit', async () => {
    const f = await fixture(dual);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ references: { outfit: { state: 'ready', freshUntil: Date.now() + 100000 } } }))
      .mockImplementation(async () => Response.json({ references: { outfit: { state: 'queued' } } }));
    vi.stubGlobal('fetch', fetcher);
    const render = () => host!.render(createElement(WardrobePanel, { controller: f.controller }));
    await render(); await flushReact(); expect(fetcher).toHaveBeenCalledOnce();
    f.state.looks = [{ ...dual, image: '/new-cover.webp' }]; await render(); await flushReact();
    expect(fetcher).toHaveBeenCalledOnce();
    f.state.looks = [{ ...f.state.looks[0], referenceImage: '/new-outfit.webp' }]; await render(); await flushReact();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(host!.find(node => node.getReactProps()['aria-label'] === '测试套装：待准备')).toBeDefined();
    expect(host!.find(node => node.nodeName === 'img' && node.getReactProps().src === appUrl('/new-cover.webp'))).toBeDefined();
  });
});
