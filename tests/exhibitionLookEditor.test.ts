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
type ImageSide = '展示图' | '模型参考图';
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
  const imageField = (side: ImageSide) => host!.find(node => node.getReactProps()['aria-label'] === `${side}文件`)!.parentNode!.parentNode!;
  const drag = async (side: ImageSide, handler: 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop', files: File[] = [], types = ['Files']) => {
    const field = imageField(side);
    const event = { dataTransfer: { files, types, dropEffect: 'none' }, currentTarget: field, target: field.firstChild,
      preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => { field.getReactProps()[handler](event); }); await flushReact();
    return event;
  };
  const button = (label: string) => props(node => node.nodeName === 'button' && (node.textContent === label || node.getReactProps()['aria-label'] === label));
  const saveButton = () => props(node => node.nodeName === 'button' && node.getReactProps().className === 'ex-button ex-primary');
  const submit = async () => { await act(async () => { props(node => node.nodeName === 'form').onSubmit({ preventDefault: vi.fn() }); }); await flushReact(); };
  const chooseMode = async (value: string) => { await act(async () => { props(node => node.getReactProps().type === 'radio' && node.getReactProps().value === value).onChange(); }); };
  const preview = (side: ImageSide) => host!.find(node => node.nodeName === 'img' && node.getReactProps().alt === side)?.getReactProps().src;
  await render();
  return { state, controller, upload, updateLook, saved, close, render, choose, imageField, drag, button, saveButton, submit, chooseMode, preview, revoke, images,
    set holdImages(value: boolean) { holdImages = value; } };
}

describe('dual-image material editor', () => {
  it('uses a dropped display image for both upload images by default', async () => {
    const f = await fixture();
    const event = await f.drag('展示图', 'onDrop', [file('person.png')]);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(f.preview('模型参考图')).toBe(f.preview('展示图'));
    expect(host!.find(node => node.nodeName === 'img' && node.getReactProps().alt === '展示图')!.getReactProps().draggable).toBe(false);
    await f.submit();
    expect(f.upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ imageBase64: base64('person.png'), referenceImageBase64: base64('person.png') }));
  });

  it('keeps dropped display and reference images in their own upload fields', async () => {
    const f = await fixture();
    await f.drag('展示图', 'onDrop', [file('person.png')]);
    await f.drag('模型参考图', 'onDrop', [file('outfit.png')]);
    await f.drag('展示图', 'onDrop', [file('latest-person.png')]);
    expect(f.preview('展示图')).toContain('latest-person.png'); expect(f.preview('模型参考图')).toContain('outfit.png');
    await f.submit();
    expect(f.upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ imageBase64: base64('latest-person.png'), referenceImageBase64: base64('outfit.png') }));
  });

  it.each([
    ['wrong.gif', 8, '请选择 JPG'], ['huge.png', 10 * 1024 * 1024 + 1, '图片不能超过'], ['small.png', 8, '宽度需为'],
  ])('validates dropped %s before allowing it to be saved', async (name, bytes, error) => {
    const f = await fixture(dual);
    await f.drag('模型参考图', 'onDrop', [new File([new Uint8Array(bytes)], name, { type: 'image/png' })]);
    expect(f.preview('展示图')).toBe(appUrl(dual.image)); expect(f.saveButton().disabled).toBe(true);
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain(error);
    await f.submit(); expect(f.updateLook).not.toHaveBeenCalled();
  });

  it('rejects multiple dropped files without replacing a selection and recovers through the picker', async () => {
    const f = await fixture(); await f.choose('展示图', file('person.png'));
    const previous = f.preview('展示图');
    const input = host!.find(node => node.getReactProps()['aria-label'] === '展示图文件')!;
    Object.assign(input, { value: 'C:\\fakepath\\person.png' });
    await f.drag('展示图', 'onDrop', [file('first.png'), file('second.png')]);
    expect(f.preview('展示图')).toBe(previous); expect(f.preview('模型参考图')).toBe(previous);
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toBe('每次请拖入一张图片。');
    await f.choose('展示图', file('person.png'));
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    expect(Reflect.get(input, 'value')).toBe('');
    await f.submit();
    expect(f.upload.mock.calls[0][0]).toMatchObject({ imageBase64: base64('person.png'), referenceImageBase64: base64('person.png') });
  });

  it('keeps the file drag highlight while crossing children and clears it after leaving or dropping', async () => {
    const f = await fixture();
    await f.drag('展示图', 'onDragEnter'); await f.drag('展示图', 'onDragEnter');
    await f.drag('展示图', 'onDragLeave');
    expect(f.imageField('展示图').getReactProps().className).toContain('is-dragging');
    const over = await f.drag('展示图', 'onDragOver');
    expect(over.preventDefault).toHaveBeenCalledOnce(); expect(over.stopPropagation).toHaveBeenCalledOnce();
    expect(over.dataTransfer.dropEffect).toBe('copy');
    await f.drag('展示图', 'onDragLeave');
    expect(f.imageField('展示图').getReactProps().className).not.toContain('is-dragging');
    await f.drag('展示图', 'onDragEnter'); await f.drag('展示图', 'onDrop', [file('person.png')]);
    expect(f.imageField('展示图').getReactProps().className).not.toContain('is-dragging');
  });

  it.each(['pending', 'disconnected'] as const)('does not accept dropped images when %s', async reason => {
    const f = await fixture(dual);
    if (reason === 'pending') f.controller.pending = true;
    else f.controller.connected = false;
    await f.render();
    await f.drag('展示图', 'onDragEnter');
    expect(f.imageField('展示图').getReactProps().className).not.toContain('is-dragging');
    const over = await f.drag('展示图', 'onDragOver');
    expect(over.dataTransfer.dropEffect).toBe('none'); expect(over.preventDefault).toHaveBeenCalledOnce();
    const dropped = await f.drag('展示图', 'onDrop', [file('replacement.png')]);
    expect(dropped.preventDefault).toHaveBeenCalledOnce(); expect(dropped.stopPropagation).toHaveBeenCalledOnce();
    expect(f.preview('展示图')).toBe(appUrl(dual.image)); expect(f.preview('模型参考图')).toBe(appUrl(dual.referenceImage!));
  });

  it('ignores non-file drags and empty drops without disturbing selected images', async () => {
    const f = await fixture(dual);
    for (const handler of ['onDragEnter', 'onDragOver', 'onDragLeave', 'onDrop'] as const) {
      const event = await f.drag('展示图', handler, [], ['text/plain']);
      expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    await f.drag('展示图', 'onDrop');
    expect(f.imageField('展示图').getReactProps().className).not.toContain('is-dragging');
    expect(f.preview('展示图')).toBe(appUrl(dual.image)); expect(f.preview('模型参考图')).toBe(appUrl(dual.referenceImage!));
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
  });

  it('prevents dropped files from navigating away when they miss an image field', async () => {
    await fixture();
    const dialog = host!.find(node => node.nodeName === 'dialog')!.getReactProps();
    for (const handler of ['onDragOver', 'onDrop']) {
      const event = { dataTransfer: { types: ['Files'], files: [file('person.png')], dropEffect: 'copy' }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      await act(async () => { dialog[handler](event); });
      expect(event.preventDefault).toHaveBeenCalledOnce();
      const textEvent = { dataTransfer: { types: ['text/plain'], files: [] }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      await act(async () => { dialog[handler](textEvent); });
      expect(textEvent.preventDefault).not.toHaveBeenCalled();
    }
    expect(host!.find(node => node.nodeName === 'img' && node.getReactProps().alt === '展示图')).toBeUndefined();
  });

  it('allows 432 × 768 images in both upload fields', async () => {
    const f = await fixture(); f.holdImages = true;
    await f.choose('展示图', file('cover.png'));
    await f.choose('模型参考图', file('reference.png'));
    await act(async () => { for (const image of f.images) { image.naturalWidth = 432; image.naturalHeight = 768; image.onload?.(); } });
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    expect(f.saveButton().disabled).toBe(false);
    await f.submit();
    expect(f.upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ imageBase64: base64('cover.png'), referenceImageBase64: base64('reference.png') }));
  });

  it('defaults the reference to the display image and uploads both from one selection', async () => {
    const f = await fixture();
    expect(document.activeElement.getReactProps()['aria-label']).toBe('展示图文件');
    expect(host!.find(node => node.getReactProps().type === 'text')).toBeUndefined();
    expect(f.saveButton().disabled).toBe(true);
    await f.submit(); expect(f.upload).not.toHaveBeenCalled();
    await f.choose('展示图', file('person.png'));
    expect(f.preview('模型参考图')).toBe(f.preview('展示图'));
    expect(host!.find(node => node.getReactProps()['aria-label'] === '模型参考图文件')!.getReactProps().required).toBe(false);
    expect(f.saveButton().disabled).toBe(false);
    await f.submit();
    expect(f.upload).toHaveBeenCalledExactlyOnceWith({ name: 'person', description: '', mode: 'clothx', prompt: '',
      imageBase64: base64('person.png'), referenceImageBase64: base64('person.png') });
    expect(f.saved).toHaveBeenCalledExactlyOnceWith('clothx');
  });

  it('follows display replacements until a separate reference is chosen', async () => {
    const f = await fixture();
    await f.choose('展示图', file('first-person.png'));
    await f.choose('展示图', file('person.png'));
    expect(f.preview('模型参考图')).toBe(f.preview('展示图'));
    await f.choose('模型参考图', file('white-outfit.png'));
    await f.choose('展示图', file('latest-person.png'));
    expect(f.preview('展示图')).toContain('latest-person.png'); expect(f.preview('模型参考图')).toContain('white-outfit.png');
    expect(f.saveButton().disabled).toBe(false);
    await f.submit();
    expect(f.upload).toHaveBeenCalledExactlyOnceWith({ name: 'latest-person', description: '', mode: 'clothx', prompt: '',
      imageBase64: base64('latest-person.png'), referenceImageBase64: base64('white-outfit.png') });
  });

  it('keeps a reference selected before the display and can restore automatic following', async () => {
    const f = await fixture();
    await f.choose('模型参考图', file('white-outfit.png'));
    await f.choose('展示图', file('person.png'));
    expect(f.preview('展示图')).toContain('person.png'); expect(f.preview('模型参考图')).toContain('white-outfit.png');
    await act(async () => f.button('模型参考图使用展示图').onClick());
    expect(f.preview('模型参考图')).toBe(f.preview('展示图'));
    await f.choose('展示图', file('latest-person.png'));
    expect(f.preview('模型参考图')).toBe(f.preview('展示图'));
    expect(f.saveButton().disabled).toBe(false);
    await f.submit();
    expect(f.upload.mock.calls[0][0]).toMatchObject({ imageBase64: base64('latest-person.png'), referenceImageBase64: base64('latest-person.png') });
  });

  it('clears the default reference with the display and rejects an invalid synchronized replacement', async () => {
    const f = await fixture();
    await f.choose('展示图', file('person.png'));
    await act(async () => f.button('移除展示图').onClick());
    expect(f.preview('展示图')).toBeUndefined(); expect(f.preview('模型参考图')).toBeUndefined();
    expect(f.saveButton().disabled).toBe(true);
    await f.choose('展示图', file('small.png')); await f.submit();
    expect(f.saveButton().disabled).toBe(true); expect(f.upload).not.toHaveBeenCalled();
    await f.choose('展示图', file('person.png'));
    expect(f.saveButton().disabled).toBe(false);
  });

  it.each([
    ['  夏日套装.JPG', '夏日套装'], ['  Cafe\u0301\u0000\u007f\u0085.png', 'Café'],
    ['套'.repeat(45) + '.webp', '套'.repeat(40)], ['  \t.png', '未命名素材'],
    ['衣'.repeat(39) + '👗.png', '衣'.repeat(39)],
  ])('derives a valid internal name from display filename %j', async (filename, expectedName) => {
    const f = await fixture();
    await f.choose('展示图', file(filename)); await f.choose('模型参考图', file('reference.png')); await f.submit();
    expect(f.upload.mock.calls[0][0].name).toBe(expectedName);
  });

  it.each(['展示图', '模型参考图'] as const)('only replaces %s and preserves the opened revision and other image', async side => {
    const f = await fixture(dual);
    expect(f.preview('展示图')).toBe(appUrl(dual.image)); expect(f.preview('模型参考图')).toBe(appUrl(dual.referenceImage!));
    await f.choose(side, file('replacement.png'));
    f.state.revision = 19; await f.render(); await f.submit();
    expect(f.updateLook).toHaveBeenCalledExactlyOnceWith('outfit', { name: '测试套装', description: '原有说明', mode: 'clothx', prompt: '', expectedRevision: 7,
      [side === '展示图' ? 'imageBase64' : 'referenceImageBase64']: base64('replacement.png') });
    expect(f.state.enabledLookIds).toEqual(['outfit']); expect(f.state.looks[0]).toEqual(dual);
  });

  it('preserves a legacy material name and images when changing its mode', async () => {
    const f = await fixture(legacy);
    expect(f.preview('模型参考图')).toBe(appUrl(legacy.image));
    await f.chooseMode('charx'); await f.submit();
    expect(f.updateLook).toHaveBeenCalledExactlyOnceWith('outfit', { name: '测试套装', description: '原有说明', mode: 'charx', prompt: '', expectedRevision: 7 });
  });

  it('continues following an existing material that shares the same display and reference URL', async () => {
    const f = await fixture(legacy); await f.choose('展示图', file('new-person.png'));
    expect(f.preview('展示图')).toContain('new-person.png'); expect(f.preview('模型参考图')).toBe(f.preview('展示图'));
    await f.submit(); expect(f.updateLook.mock.calls[0][1]).toMatchObject({ imageBase64: base64('new-person.png'), referenceImageBase64: base64('new-person.png') });
  });

  it('keeps prompt-only Free materials image-free when editing their display picture', async () => {
    const f = await fixture(promptOnly);
    expect(f.preview('模型参考图')).toBeUndefined(); expect(f.saveButton().disabled).toBe(false);
    await f.choose('展示图', file('new-cover.png')); await f.submit();
    expect(f.updateLook.mock.calls[0][1]).toMatchObject({ referenceKind: 'none', mode: 'free', prompt: '保留人物表情', imageBase64: base64('new-cover.png') });
    expect(f.updateLook.mock.calls[0][1]).not.toHaveProperty('referenceImageBase64');
  });

  it('uses the display as the default reference for a new Free material while requiring its prompt', async () => {
    const f = await fixture(); await f.chooseMode('free');
    await f.choose('展示图', file('cover.png'));
    expect(f.saveButton().disabled).toBe(true); await f.submit(); expect(f.upload).not.toHaveBeenCalled();
    await act(async () => host!.find(node => node.nodeName === 'textarea')!.getReactProps().onChange({ target: { value: '保留人物表情' } }));
    expect(f.saveButton().disabled).toBe(false); await f.submit();
    expect(f.upload.mock.calls[0][0]).toMatchObject({ mode: 'free', prompt: '保留人物表情', imageBase64: base64('cover.png'), referenceImageBase64: base64('cover.png') });
  });

  it('upgrades a prompt-only Free material only when a reference image is supplied', async () => {
    const f = await fixture(promptOnly); await f.choose('模型参考图', file('outfit.png')); await f.submit();
    expect(f.updateLook.mock.calls[0][1]).toMatchObject({ referenceKind: 'image', mode: 'free', referenceImageBase64: base64('outfit.png') });
    expect(f.updateLook.mock.calls[0][1]).not.toHaveProperty('imageBase64');
  });

  it('requires an explicit reference to move a prompt-only material into another mode', async () => {
    const f = await fixture(promptOnly); await f.chooseMode('clothx');
    expect(f.saveButton().disabled).toBe(true); await f.submit(); expect(f.updateLook).not.toHaveBeenCalled();
    await f.choose('模型参考图', file('outfit.png')); await f.submit();
    expect(f.updateLook.mock.calls[0][1]).toMatchObject({ referenceKind: 'image', mode: 'clothx', prompt: '', referenceImageBase64: base64('outfit.png') });
  });

  it.each([
    ['empty.png', 0, '图片为空'], ['wrong.gif', 8, '请选择 JPG'], ['huge.png', 10 * 1024 * 1024 + 1, '图片不能超过'],
    ['small.png', 8, '宽度需为'], ['corrupt.png', 8, '无法读取这张图片'],
  ])('blocks an invalid replacement %s without discarding the other image', async (name, bytes, error) => {
    const f = await fixture(dual); await f.choose('模型参考图', new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
    expect(f.saveButton().disabled).toBe(true); expect(f.preview('展示图')).toBe(appUrl(dual.image));
    expect(host!.find(node => node.getReactProps().role === 'alert')?.textContent).toContain(error);
    await f.submit(); expect(f.updateLook).not.toHaveBeenCalled();
    await act(async () => f.button('撤销更换模型参考图').onClick());
    expect(f.preview('模型参考图')).toBe(appUrl(dual.referenceImage!)); expect(f.saveButton().disabled).toBe(false);
  });

  it('ignores a cancelled picker and restores prompt-only mode when the unsaved reference is removed', async () => {
    const f = await fixture(promptOnly); await f.choose('模型参考图', file('outfit.png')); await f.choose('模型参考图', undefined);
    expect(f.preview('模型参考图')).toContain('outfit.png');
    await act(async () => f.button('移除模型参考图').onClick()); await f.submit();
    expect(f.updateLook.mock.calls[0][1]).toMatchObject({ referenceKind: 'none' });
    expect(f.updateLook.mock.calls[0][1]).not.toHaveProperty('referenceImageBase64');
  });

  it('does not accept a late size result for a superseded selection', async () => {
    const f = await fixture(dual); f.holdImages = true;
    await f.choose('模型参考图', file('old.png')); await f.choose('模型参考图', file('latest.png'));
    expect(f.saveButton().disabled).toBe(true);
    await act(async () => f.images[0].onload?.()); expect(f.saveButton().disabled).toBe(true);
    await act(async () => f.images[1].onload?.()); expect(f.saveButton().disabled).toBe(false);
    await f.submit(); expect(f.updateLook.mock.calls[0][1]).toMatchObject({ referenceImageBase64: base64('latest.png') });
    expect(f.revoke).toHaveBeenCalledWith('blob:old.png:1');
  });

  it('retains both selected images after a failed save and allows retry', async () => {
    const f = await fixture(dual); await f.choose('展示图', file('cover.png')); await f.choose('模型参考图', file('outfit.png'));
    f.updateLook.mockResolvedValueOnce(false); await f.submit();
    expect(f.saved).not.toHaveBeenCalled(); expect(f.preview('展示图')).toContain('cover.png'); expect(f.preview('模型参考图')).toContain('outfit.png');
    expect(f.saveButton().disabled).toBe(false); await f.submit(); expect(f.saved).toHaveBeenCalledOnce();
  });

  it('guards duplicate submissions while files are being read and sends nothing after unmount', async () => {
    const f = await fixture(dual); await f.choose('展示图', file('cover.png')); await f.choose('模型参考图', file('outfit.png'));
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

  it.each(['live', 'generating'] as const)('allows draft edits while %s without altering published snapshots', async reason => {
    const f = await fixture(dual);
    const published = { ...dual };
    f.state.publication = { revision: 1, publishedAt: Date.now(), legacy: false, looks: [published] };
    if (reason === 'live') f.state.live = { status: 'running' } as ExhibitionState['live']; else f.state.phase = 'generating';
    await f.render(); await f.choose('展示图', file('cover.png')); await f.submit();
    expect(f.updateLook).toHaveBeenCalledOnce(); expect(published.image).toBe(dual.image);
  });

  it.each(['pending', 'disconnected'] as const)('blocks editing images when %s', async reason => {
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
    await render(); await flushReact(); expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/references'))).toHaveLength(1);
    f.state.looks = [{ ...dual, image: '/new-cover.webp' }]; await render(); await flushReact();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/references'))).toHaveLength(1);
    f.state.looks = [{ ...f.state.looks[0], referenceImage: '/new-outfit.webp' }]; await render(); await flushReact();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/references'))).toHaveLength(2);
    expect(host!.find(node => node.getReactProps()['aria-label'] === '测试套装：待准备')).toBeDefined();
    expect(host!.find(node => node.nodeName === 'img' && node.getReactProps().src === appUrl('/new-cover.webp'))).toBeDefined();
  });

  it('returns to the first card after uploading into the same mode from a scrolled library', async () => {
    const f = await fixture(dual);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ references: {} })));
    f.controller.clearError = vi.fn();
    const render = () => host!.render(createElement(WardrobePanel, { controller: f.controller }));
    await render(); await flushReact();
    const region = host!.find(node => node.getReactProps().className === 'ex-library-results')!;
    Object.assign(region, { scrollTop: 600 });
    f.upload.mockImplementation(async () => {
      f.state.looks.unshift({ ...dual, id: 'new', name: '新素材' });
      f.state.revision++;
      return { lookId: 'new', index: 0 };
    });
    await act(async () => f.button('上传素材').onClick());
    await f.choose('展示图', file('新素材.png')); await f.choose('模型参考图', file('reference.png'));
    await f.submit();
    expect(f.upload).toHaveBeenCalledOnce();
    expect(host!.find(node => node.nodeName === 'dialog')).toBeUndefined();
    expect(host!.find(node => node.getReactProps().className === 'ex-library-grid')!.childNodes.map(node => node.getReactProps()['data-material-id']))
      .toEqual(['new', 'outfit']);
    expect(Reflect.get(region, 'scrollTop')).toBe(0);
    await render();
    expect(Reflect.get(region, 'scrollTop')).toBe(0);
  });
});
