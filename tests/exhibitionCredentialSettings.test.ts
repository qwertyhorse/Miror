import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExhibitionState } from '../shared/exhibition';
import { MirrorCredentialSettings } from '../src/exhibition/MirrorCredentialSettings';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
import { appUrl } from '../src/versionScope';
import { createReactHost, flushReact } from './support/reactHost';

let host: Awaited<ReturnType<typeof createReactHost>> | undefined;
let restoreBounds: (() => void) | undefined;
afterEach(async () => { await host?.close(); host = undefined; restoreBounds?.(); restoreBounds = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type CredentialInfo = { configured: boolean; source: 'mirror' | 'default'; revision: number; editable: boolean; region?: 'cn' | 'global'; hasUnconfirmedSession?: boolean; perSessionLimit: number; totalLimit?: number; allocatedCredits?: number; remainingCredits?: number };
function safeInfo(overrides: Partial<CredentialInfo> = {}): CredentialInfo { return { configured: true, source: 'default', revision: 11, editable: true, perSessionLimit: 30, totalLimit: 360, allocatedCredits: 60, remainingCredits: 300, ...overrides }; }
type RequestHandler = (url: string, init?: RequestInit) => Promise<Response>;

async function fixture(options: { secure?: boolean; embedded?: boolean; httpPort?: number; parentOrigin?: string; info?: CredentialInfo; handler?: RequestHandler } = {}) {
  host = await createReactHost();
  const secure = options.secure ?? true;
  Object.assign(window, { isSecureContext: secure });
  const page = new URL(`${secure ? 'https' : 'http'}://xuminghong.local:${secure ? 10202 : options.httpPort ?? 10200}/v1.1/exhibition/control?mirror=east`);
  if (options.parentOrigin !== undefined) page.searchParams.set('parentOrigin', options.parentOrigin);
  Object.assign(window.location, { protocol: page.protocol, hostname: page.hostname, host: page.host, port: page.port,
    pathname: page.pathname, search: page.search, href: page.href });
  const postMessage = vi.fn();
  Object.assign(window, { parent: options.embedded ? { postMessage } : window });
  if (options.embedded) {
    const prototype = Object.getPrototypeOf(document.createElement('div'));
    const previous = Object.getOwnPropertyDescriptor(prototype, 'getBoundingClientRect');
    Object.defineProperty(prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ height: 82 }) });
    restoreBounds = () => { if (previous) Object.defineProperty(prototype, 'getBoundingClientRect', previous); else Reflect.deleteProperty(prototype, 'getBoundingClientRect'); };
  }
  const state: ExhibitionState = { mirrorId: 'east', revision: 7, phase: 'idle', experienceMode: 'clothx', selectedLookId: null, displayedLookId: null,
    looks: [], enabledLookIds: [], categories: [], tags: [], sessionNumber: 0, generationNumber: 0, updatedAt: 1000, generationReadyAt: null, providerMode: 'xmax', live: null, logs: [],
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 64, minHeight: 64, maxWidth: 4096, maxHeight: 4096 } } };
  const controller = { state, mirrorId: 'east', connected: true, pending: false, error: '', refresh: vi.fn(async () => {}), clearError: vi.fn() } as unknown as ExhibitionController;
  const live = { liveStatus: null, refreshStatus: vi.fn(async () => {}) } as unknown as ExhibitionLiveController;
  const fetcher = vi.fn(options.handler ?? (async () => Response.json(options.info ?? safeInfo())));
  vi.stubGlobal('fetch', fetcher);
  const render = () => host!.render(createElement(MirrorCredentialSettings, { key: controller.mirrorId, controller, live, embedded: options.embedded }));
  const input = () => host!.find(node => node.getReactProps()['aria-label'] === 'XMAX SK');
  const regionButton = (region: 'cn' | 'global') => host!.find(node => node.getReactProps()['data-region'] === region)!;
  const currentRegion = () => host!.find(node => node.getReactProps()['data-current-region']);
  const unsavedRegion = () => host!.find(node => node.getReactProps().role === 'status' && node.textContent === '未保存');
  const chooseRegion = async (region: 'cn' | 'global') => { await act(async () => regionButton(region).getReactProps().onClick()); };
  const saveButton = () => host!.find(node => node.nodeName === 'button' && /保存/.test(node.textContent));
  const putCalls = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT');
  const fill = async (value: string) => { await act(async () => { input()!.getReactProps().onChange({ target: { value } }); }); };
  const save = async () => {
    await act(async () => {
      const form = host!.find(node => node.nodeName === 'form');
      if (form) form.getReactProps().onSubmit({ preventDefault: vi.fn() });
      else saveButton()!.getReactProps().onClick();
    });
    await flushReact();
  };
  const switchMirror = async (id: string) => { controller.mirrorId = id; state.mirrorId = id; await render(); await flushReact(); };
  await render(); await flushReact();
  return { state, controller, live, fetcher, render, input, regionButton, currentRegion, unsavedRegion, chooseRegion, saveButton, putCalls, fill, save, switchMirror, postMessage };
}

async function frameMessage(data: unknown, origin: string, source: unknown) {
  const event = new Event('message');
  Object.defineProperties(event, { data: { value: data }, origin: { value: origin }, source: { value: source } });
  await act(async () => window.dispatchEvent(event)); await flushReact();
}

describe('per-mirror XMAX credential settings', () => {
  it('fetches safe configuration status on its own mirror and never populates the password', async () => {
    const f = await fixture();
    expect(f.fetcher.mock.calls[0][0]).toContain('/exhibition/mirrors/east/credentials');
    expect(f.input()!.getReactProps()).toMatchObject({ type: 'password', value: '', autoComplete: 'new-password', spellCheck: false });
    expect(f.putCalls()).toHaveLength(0);
    expect(f.currentRegion()!.textContent).toBe('当前：国际版');
    expect(f.unsavedRegion()).toBeUndefined();
  });

  it('loads and saves credentials without legacy local-credit fields or budget messages', async () => {
    const info: CredentialInfo = { configured: true, source: 'mirror', revision: 11, editable: true, region: 'cn', perSessionLimit: 30 };
    const f = await fixture({ handler: async (_url, init) => Response.json(init?.method === 'PUT' ? { ...info, revision: 12 } : info) });
    expect(f.input()!.getReactProps().disabled).toBe(false);
    expect(f.currentRegion()!.textContent).toBe('当前：国内版');
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    await f.fill('uk-no-local-credit-fields-fixture'); await f.save();
    expect(f.putCalls()).toHaveLength(1);
    expect(JSON.parse(f.putCalls()[0][1]!.body as string)).toEqual({ apiKey: 'uk-no-local-credit-fields-fixture', region: 'cn', expectedRevision: 11 });
    expect(f.controller.refresh).toHaveBeenCalledOnce(); expect(f.live.refreshStatus).toHaveBeenCalledOnce();
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    expect(host!.find(node => /额度|预算|credits|剩余/.test(node.textContent))).toBeUndefined();
  });

  it('does not claim a current region before loading its saved configuration', async () => {
    const pending = deferred<Response>();
    const f = await fixture({ handler: () => pending.promise });
    expect(f.currentRegion()).toBeUndefined(); expect(f.unsavedRegion()).toBeUndefined();
    await act(async () => pending.resolve(Response.json(safeInfo({ region: 'cn' })))); await flushReact();
    expect(f.currentRegion()!.textContent).toBe('当前：国内版');
  });

  it('does not claim a current region for an unconfigured credential', async () => {
    const f = await fixture({ info: safeInfo({ configured: false }) });
    expect(f.currentRegion()).toBeUndefined(); expect(f.unsavedRegion()).toBeUndefined();
    await f.chooseRegion('cn');
    expect(f.currentRegion()).toBeUndefined(); expect(f.unsavedRegion()).toBeDefined();
    expect(f.putCalls()).toHaveLength(0);
  });

  it('keeps blank values from replacing the current credential', async () => {
    const f = await fixture();
    expect(f.saveButton()!.getReactProps().disabled).toBe(true);
    await f.fill('   '); await f.save();
    expect(f.putCalls()).toHaveLength(0);
  });

  it('submits one revision-bound mirror secret, immediately clears it and refreshes both safe statuses', async () => {
    const pending = deferred<Response>();
    const secret = 'uk-isolated-fixture-do-not-use';
    const f = await fixture({ handler: async (_url, init) => init?.method === 'PUT' ? pending.promise : Response.json(safeInfo()) });
    await f.fill(secret); await f.save();
    expect(f.putCalls()).toHaveLength(1);
    const [url, init] = f.putCalls()[0];
    expect(url).toContain('/exhibition/mirrors/east/credentials');
    expect(JSON.parse(init!.body as string)).toEqual({ apiKey: secret, region: 'global', expectedRevision: 11 });
    expect(f.input()!.getReactProps().value).toBe('');
    expect(f.saveButton()!.getReactProps().disabled).toBe(true);
    await f.save(); expect(f.putCalls()).toHaveLength(1);
    await act(async () => pending.resolve(Response.json(safeInfo({ source: 'mirror', revision: 12 })))); await flushReact();
    expect(f.controller.refresh).toHaveBeenCalledOnce(); expect(f.live.refreshStatus).toHaveBeenCalledOnce();
    expect(host!.find(node => node.textContent.includes(secret))).toBeUndefined();
    expect(f.input()!.getReactProps().value).toBe('');
  });

  it.each([400, 409, 500])('uses a safe short error and never restores or renders a failed secret for HTTP %s', async status => {
    const secret = 'uk-isolated-failed-fixture';
    const f = await fixture({ handler: async (_url, init) => init?.method === 'PUT' ? Response.json({ message: `failure ${secret}`, code: status === 409 ? 'EXHIBITION_STALE_REVISION' : 'INVALID_API_KEY' }, { status }) : Response.json(safeInfo()) });
    await f.fill(secret); await f.save();
    expect(f.input()!.getReactProps().value).toBe('');
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeDefined();
    expect(host!.find(node => node.textContent.includes(secret))).toBeUndefined();
    expect(f.live.refreshStatus).not.toHaveBeenCalled();
  });

  it.each([10200, 10201, 10601])('embeds a mirror-specific HTTPS form from HTTP %s without collecting a password or opening a page', async httpPort => {
    const f = await fixture({ secure: false, httpPort });
    expect(f.input()).toBeUndefined(); expect(f.saveButton()).toBeUndefined();
    const frame = host!.find(node => node.nodeName === 'iframe')!;
    const destination = new URL(frame.getReactProps().src);
    expect(destination.protocol).toBe('https:'); expect(destination.host).toBe('xuminghong.local:10202');
    expect(destination.pathname).toBe(appUrl('/exhibition/control')); expect(destination.searchParams.get('mirror')).toBe('east');
    expect(destination.searchParams.get('credentialForm')).toBe('1'); expect(destination.hash).toBe('');
    expect(destination.searchParams.get('parentOrigin')).toBe(`http://xuminghong.local:${httpPort}`);
    expect(frame.getReactProps().title).toBe('XMAX SK 配置');
    expect(host!.find(node => node.nodeName === 'a')).toBeUndefined();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.putCalls()).toHaveLength(0);
  });

  it('accepts only safe messages from the current secure credential frame', async () => {
    const f = await fixture({ secure: false });
    const frame = host!.find(node => node.nodeName === 'iframe')!;
    const source = {}; Object.defineProperty(frame, 'contentWindow', { value: source });
    const origin = 'https://xuminghong.local:10202';
    const base = { type: 'openbuy:mirror-credential', mirrorId: 'east' };
    for (const [data, eventOrigin, eventSource] of [
      [{ ...base, saved: true }, 'http://xuminghong.local:10200', source],
      [{ ...base, saved: true }, origin, {}],
      [{ ...base, mirrorId: 'west', saved: true }, origin, source],
      [{ ...base, saved: true, apiKey: 'uk-never-accept' }, origin, source],
      [{ ...base, height: Number.NaN, saved: true }, origin, source],
      [{ ...base, saved: 'true' }, origin, source],
    ]) await frameMessage(data, eventOrigin as string, eventSource);
    expect(f.controller.refresh).not.toHaveBeenCalled();
    await frameMessage({ ...base, height: 800 }, origin, source);
    expect(frame.getReactProps().style.height).toBe(300);
    await frameMessage({ ...base, height: 4 }, origin, source);
    expect(frame.getReactProps().style.height).toBe(68);
    await frameMessage({ ...base, saved: true, height: 87.4 }, origin, source);
    expect(frame.getReactProps().style.height).toBe(88);
    expect(f.controller.refresh).toHaveBeenCalledOnce(); expect(f.live.refreshStatus).toHaveBeenCalledOnce();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('rejects notifications from an old frame after changing mirrors', async () => {
    const f = await fixture({ secure: false });
    const oldSource = {}; Object.defineProperty(host!.find(node => node.nodeName === 'iframe')!, 'contentWindow', { value: oldSource });
    await f.switchMirror('west');
    const frame = host!.find(node => node.nodeName === 'iframe')!;
    const source = {}; Object.defineProperty(frame, 'contentWindow', { value: source });
    expect(new URL(frame.getReactProps().src).searchParams.get('mirror')).toBe('west');
    await frameMessage({ type: 'openbuy:mirror-credential', mirrorId: 'east', saved: true }, 'https://xuminghong.local:10202', oldSource);
    expect(f.controller.refresh).not.toHaveBeenCalled();
    await frameMessage({ type: 'openbuy:mirror-credential', mirrorId: 'west', saved: true }, 'https://xuminghong.local:10202', source);
    expect(f.controller.refresh).toHaveBeenCalledOnce();
  });

  it('notifies the fixed HTTP parent of height and successful save without including the secret', async () => {
    const f = await fixture({ embedded: true });
    const secret = 'uk-isolated-embedded-fixture';
    expect(f.postMessage).toHaveBeenCalledWith({ type: 'openbuy:mirror-credential', mirrorId: 'east', height: 86 }, 'http://xuminghong.local:10200');
    await f.fill(secret); await f.save();
    expect(f.postMessage).toHaveBeenCalledWith({ type: 'openbuy:mirror-credential', mirrorId: 'east', saved: true }, 'http://xuminghong.local:10200');
    expect(JSON.stringify(f.postMessage.mock.calls)).not.toContain(secret);
    for (const [message, origin] of f.postMessage.mock.calls) {
      expect(Object.keys(message).every(key => ['type', 'mirrorId', 'height', 'saved'].includes(key))).toBe(true);
      expect(origin).toBe('http://xuminghong.local:10200');
    }
  });

  it.each([10200, 10201, 10601])('notifies the selected trusted HTTP %s parent without including the secret', async port => {
    const parentOrigin = `http://xuminghong.local:${port}`;
    const f = await fixture({ embedded: true, parentOrigin });
    const secret = 'uk-isolated-parent-origin-fixture';
    expect(f.postMessage).toHaveBeenCalledWith({ type: 'openbuy:mirror-credential', mirrorId: 'east', height: 86 }, parentOrigin);
    await f.fill(secret); await f.save();
    expect(f.postMessage).toHaveBeenCalledWith({ type: 'openbuy:mirror-credential', mirrorId: 'east', saved: true }, parentOrigin);
    expect(JSON.stringify(f.postMessage.mock.calls)).not.toContain(secret);
    for (const [message, origin] of f.postMessage.mock.calls) {
      expect(Object.keys(message).every(key => ['type', 'mirrorId', 'height', 'saved'].includes(key))).toBe(true);
      expect(origin).toBe(parentOrigin);
    }
  });

  it.each(['http://evil.example:10601', 'https://xuminghong.local:10601', 'http://xuminghong.local:5173',
    'http://user:password@xuminghong.local:10601', 'http://xuminghong.local:10601/path', 'http://xuminghong.local:10601?other=1',
    'http://xuminghong.local:10601#other', '*', ''])('rejects an untrusted credential parent origin %s', async parentOrigin => {
    const f = await fixture({ embedded: true, parentOrigin });
    expect(f.postMessage).not.toHaveBeenCalled();
    await f.fill('uk-isolated-invalid-parent-fixture'); await f.save();
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it.each(['generating', 'showcase', 'positioning', 'paused'] as const)('guards saving during %s', async phase => {
    const f = await fixture(); await f.fill('uk-isolated-fixture'); f.state.phase = phase; await f.render(); await f.save();
    expect(f.input()!.getReactProps().disabled).toBe(true); expect(f.putCalls()).toHaveLength(0);
  });

  it.each(['pending', 'disconnected', 'live'] as const)('guards saving when %s', async reason => {
    const f = await fixture(); await f.fill('uk-isolated-fixture');
    if (reason === 'pending') f.controller.pending = true;
    if (reason === 'disconnected') f.controller.connected = false;
    if (reason === 'live') f.state.live = { status: 'stopping' } as ExhibitionState['live'];
    await f.render(); await f.save();
    expect(f.input()!.getReactProps().disabled).toBe(true); expect(f.putCalls()).toHaveLength(0);
  });

  it('honors the credential endpoint edit lock independently of the material phase', async () => {
    const f = await fixture({ info: safeInfo({ editable: false }) });
    expect(f.state.phase).toBe('idle');
    expect(f.input()!.getReactProps().disabled).toBe(true); expect(f.saveButton()!.getReactProps().disabled).toBe(true);
    await f.fill('uk-isolated-locked-fixture'); await f.save();
    expect(f.putCalls()).toHaveLength(0);
  });

  it('allows future configuration during a paused error without restarting or clearing the old lease', async () => {
    const f = await fixture({ info: safeInfo({ hasUnconfirmedSession: true }) });
    f.state.phase = 'paused';
    f.state.live = { status: 'error', sessionId: 'unknown-session-fixture' } as ExhibitionState['live'];
    await f.render(); await f.fill('uk-future-configuration-fixture'); await f.save();
    expect(f.putCalls()).toHaveLength(1);
    expect(f.state.phase).toBe('paused'); expect(f.state.live!.sessionId).toBe('unknown-session-fixture');
    expect(host!.find(node => node.textContent === '旧会话待核实，新配置仅用于后续体验。')).toBeDefined();
    expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'PUT')).toBe(true);
  });

  it('saves the chosen region with a fresh key and clears a draft when changing regions', async () => {
    const f = await fixture();
    expect(host!.find(node => node.nodeName === 'select')).toBeUndefined();
    expect(host!.find(node => node.getReactProps().role === 'radiogroup')!.getReactProps()['aria-label']).toBe('XMAX 服务区域');
    expect(f.regionButton('global').getReactProps()['aria-checked']).toBe(true);
    await f.fill('uk-global-unsaved-fixture');
    await f.chooseRegion('cn');
    expect(f.input()!.getReactProps().value).toBe('');
    expect(f.currentRegion()!.textContent).toBe('当前：国际版');
    expect(f.unsavedRegion()).toBeDefined();
    expect(f.saveButton()!.getReactProps().disabled).toBe(true);
    await act(async () => window.dispatchEvent(new Event('focus'))); await flushReact();
    expect(f.regionButton('cn').getReactProps()['aria-checked']).toBe(true);
    expect(f.currentRegion()!.textContent).toBe('当前：国际版');
    expect(f.unsavedRegion()).toBeDefined();
    await f.fill('uk-cn-isolated-fixture'); await f.save();
    expect(JSON.parse(f.putCalls()[0][1]!.body as string)).toMatchObject({ region: 'cn', apiKey: 'uk-cn-isolated-fixture' });
  });

  it('changes the current region only after a fresh-key save succeeds and retains it after remount', async () => {
    const pending = deferred<Response>();
    let info = safeInfo({ region: 'global', source: 'mirror' });
    const f = await fixture({ handler: async (_url, init) => init?.method === 'PUT' ? pending.promise : Response.json(info) });
    await f.chooseRegion('cn'); await f.save();
    expect(f.putCalls()).toHaveLength(0);
    expect(f.currentRegion()!.textContent).toBe('当前：国际版');
    expect(f.unsavedRegion()).toBeDefined();
    await f.fill('uk-domestic-region-save-fixture'); await f.save();
    expect(f.currentRegion()!.textContent).toBe('当前：国际版');
    expect(f.unsavedRegion()).toBeDefined();
    expect(JSON.parse(f.putCalls()[0][1]!.body as string)).toEqual({ region: 'cn', apiKey: 'uk-domestic-region-save-fixture', expectedRevision: 11 });
    info = safeInfo({ region: 'cn', source: 'mirror', revision: 12 });
    await act(async () => pending.resolve(Response.json(info))); await flushReact();
    expect(f.currentRegion()!.textContent).toBe('当前：国内版');
    expect(f.unsavedRegion()).toBeUndefined();
    await host!.render(null); await f.render(); await flushReact();
    expect(f.currentRegion()!.textContent).toBe('当前：国内版');
    expect(f.regionButton('cn').getReactProps()['aria-checked']).toBe(true);
    expect(f.input()!.getReactProps().value).toBe('');
    expect(f.unsavedRegion()).toBeUndefined(); expect(f.putCalls()).toHaveLength(1);
  });

  it('does not keep an unsaved region marker when switching back to the saved region', async () => {
    const f = await fixture();
    await f.chooseRegion('cn'); expect(f.unsavedRegion()).toBeDefined();
    await f.chooseRegion('global');
    expect(f.unsavedRegion()).toBeUndefined();
    expect(f.currentRegion()!.textContent).toBe('当前：国际版');
    expect(f.putCalls()).toHaveLength(0);
  });

  it('supports roving keyboard selection and leaves a draft intact when reselecting its region', async () => {
    const f = await fixture();
    await f.fill('uk-keyboard-draft-fixture');
    await f.chooseRegion('global');
    expect(f.input()!.getReactProps().value).toBe('uk-keyboard-draft-fixture');
    expect(f.regionButton('global').getReactProps().tabIndex).toBe(0);
    expect(f.regionButton('cn').getReactProps().tabIndex).toBe(-1);
    for (const [key, expected] of [['ArrowRight', 'cn'], ['ArrowLeft', 'global'], ['Home', 'cn'], ['End', 'global']] as const) {
      const focus = vi.fn(); const querySelector = vi.fn(() => ({ focus })); const preventDefault = vi.fn();
      const selected = host!.find(node => node.getReactProps().role === 'radio' && node.getReactProps()['aria-checked'])!;
      await act(async () => selected.getReactProps().onKeyDown({ key, preventDefault, currentTarget: { parentElement: { querySelector } } }));
      expect(f.regionButton(expected).getReactProps()['aria-checked']).toBe(true);
      expect(f.regionButton(expected).getReactProps().tabIndex).toBe(0);
      expect(querySelector).toHaveBeenCalledWith(`[data-region="${expected}"]`);
      expect(focus).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce();
    }
    expect(f.input()!.getReactProps().value).toBe('');
    expect(f.putCalls()).toHaveLength(0);
  });

  it('keeps the custom region controls locked while credentials are not editable', async () => {
    const f = await fixture({ info: safeInfo({ editable: false }) });
    expect(f.regionButton('cn').getReactProps().disabled).toBe(true);
    expect(f.regionButton('global').getReactProps().disabled).toBe(true);
    await f.chooseRegion('cn');
    expect(f.regionButton('global').getReactProps()['aria-checked']).toBe(true);
    expect(f.putCalls()).toHaveLength(0);
  });

  it('keeps future credentials editable after a locally ended unconfirmed session', async () => {
    const f = await fixture({ info: safeInfo({ hasUnconfirmedSession: true }) });
    f.state.phase = 'select';
    f.state.live = { status: 'error', sessionId: 'unknown-session-fixture', localEnded: true } as ExhibitionState['live'];
    await f.render(); await f.fill('uk-after-local-end-fixture'); await f.save();
    expect(f.input()!.getReactProps().disabled).toBe(false);
    expect(f.putCalls()).toHaveLength(1);
    expect(f.state.live?.sessionId).toBe('unknown-session-fixture');
  });

  it('loads the saved domestic region without revealing its credential', async () => {
    const f = await fixture({ info: safeInfo({ region: 'cn', source: 'mirror' }) });
    expect(f.regionButton('cn').getReactProps()['aria-checked']).toBe(true);
    expect(f.currentRegion()!.textContent).toBe('当前：国内版');
    expect(f.input()!.getReactProps().value).toBe('');
  });

  it('clears an old draft when another operator changes the credential region', async () => {
    let info = safeInfo({ region: 'global' });
    const f = await fixture({ handler: async () => Response.json(info) });
    await f.chooseRegion('cn');
    await f.fill('uk-old-region-draft-fixture');
    expect(f.currentRegion()!.textContent).toBe('当前：国际版'); expect(f.unsavedRegion()).toBeDefined();
    info = safeInfo({ region: 'cn', revision: 12 });
    await act(async () => window.dispatchEvent(new Event('focus'))); await flushReact();
    expect(f.input()!.getReactProps().value).toBe('');
    expect(f.regionButton('cn').getReactProps()['aria-checked']).toBe(true);
    expect(f.currentRegion()!.textContent).toBe('当前：国内版'); expect(f.unsavedRegion()).toBeUndefined();
    expect(host!.find(node => node.getReactProps().role === 'alert')!.textContent).toBe('配置已变化，请重新输入 SK。');
    await f.save(); expect(f.putCalls()).toHaveLength(0);
  });

  it('fails closed for an unknown service region in the status response', async () => {
    const f = await fixture({ handler: async () => Response.json({ ...safeInfo(), region: 'untrusted' }) });
    expect(f.input()!.getReactProps().disabled).toBe(true);
    expect(host!.find(node => node.getReactProps().role === 'alert')!.textContent).toBe('SK 配置读取失败。');
  });

  it('clears the password draft when switching mirrors', async () => {
    const f = await fixture(); await f.fill('uk-east-unsaved-fixture'); await f.switchMirror('west');
    expect(f.input()!.getReactProps().value).toBe('');
    expect(f.fetcher.mock.calls.at(-1)![0]).toContain('/exhibition/mirrors/west/credentials');
    await f.save(); expect(f.putCalls()).toHaveLength(0);
  });

  it('loads each mirror current region without leaking the previous mirror unsaved selection', async () => {
    const f = await fixture({ handler: async url => Response.json(safeInfo({ region: url.includes('/mirrors/east/') ? 'cn' : 'global' })) });
    expect(f.currentRegion()!.textContent).toBe('当前：国内版');
    await f.chooseRegion('global'); await f.fill('uk-east-region-draft-fixture');
    expect(f.unsavedRegion()).toBeDefined();
    await f.switchMirror('west');
    expect(f.currentRegion()!.textContent).toBe('当前：国际版');
    expect(f.regionButton('global').getReactProps()['aria-checked']).toBe(true);
    expect(f.unsavedRegion()).toBeUndefined(); expect(f.input()!.getReactProps().value).toBe('');
    expect(f.putCalls()).toHaveLength(0);
  });

  it('does not apply a late old-mirror GET response after switching to another mirror', async () => {
    const pending = deferred<Response>();
    const f = await fixture({ handler: async url => url.includes('/mirrors/east/') ? pending.promise : Response.json(safeInfo({ source: 'mirror', revision: 12 })) });
    await f.switchMirror('west');
    await act(async () => pending.resolve(Response.json(safeInfo({ configured: false })))); await flushReact();
    expect(f.input()!.getReactProps().value).toBe('');
    expect(host!.find(node => node.textContent.includes('未配置'))).toBeUndefined();
    expect(f.putCalls()).toHaveLength(0);
  });

  it('does not apply or refresh a late old-mirror save response after switching', async () => {
    const pending = deferred<Response>();
    const f = await fixture({ handler: async (_url, init) => init?.method === 'PUT' ? pending.promise : Response.json(safeInfo()) });
    await f.fill('uk-east-late-fixture'); await f.save(); await f.switchMirror('west');
    await act(async () => pending.resolve(Response.json(safeInfo({ source: 'mirror', revision: 12 })))); await flushReact();
    expect(f.input()!.getReactProps().value).toBe('');
    expect(f.controller.refresh).not.toHaveBeenCalled(); expect(f.live.refreshStatus).not.toHaveBeenCalled();
    expect(f.putCalls()).toHaveLength(1);
  });

  it('clears a status read error after a successful safe refresh', async () => {
    let available = false;
    const f = await fixture({ handler: async () => available ? Response.json(safeInfo()) : Response.json({}, { status: 503 }) });
    expect(host!.find(node => node.getReactProps().role === 'alert')!.textContent).toBe('SK 配置读取失败。');
    available = true;
    await act(async () => window.dispatchEvent(new Event('focus'))); await flushReact();
    expect(host!.find(node => node.getReactProps().role === 'alert')).toBeUndefined();
    expect(f.input()!.getReactProps().disabled).toBe(false);
  });

  it('refreshes the independent credential revision immediately after a conflict', async () => {
    let revision = 11; let puts = 0;
    const f = await fixture({ handler: async (_url, init) => {
      if (init?.method !== 'PUT') return Response.json(safeInfo({ revision }));
      puts++;
      if (puts === 1) { revision = 12; return Response.json({ message: 'stale' }, { status: 409 }); }
      return Response.json(safeInfo({ revision: 13, source: 'mirror' }));
    } });
    await f.fill('uk-conflict-isolated-first'); await f.save();
    expect(f.input()!.getReactProps().value).toBe('');
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method !== 'PUT')).toHaveLength(2);
    await f.fill('uk-conflict-isolated-second'); await f.save();
    expect(JSON.parse(f.putCalls()[1][1]!.body as string).expectedRevision).toBe(12);
    expect(f.controller.refresh).toHaveBeenCalledOnce();
  });
});
