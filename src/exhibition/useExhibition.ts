import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { appUrl } from '../versionScope';
import { exhibitionApiPath } from './mirrorApi';
import { isExhibitionLocallyEnded, type ExhibitionCommand, type ExhibitionState, type ExhibitionLookInput, type ExhibitionUploadInput, type ExhibitionTaxonomyInput } from '../../shared/exhibition';

interface RequestScope { epoch: number; controller: AbortController; busy: boolean; }
interface ExhibitionSnapshot { state: ExhibitionState | null; pending: boolean; stopPending: boolean; connected: boolean; error: string; }
export interface ExhibitionCopyInput { sourceMirrorId: string; copyLooks: boolean; copySettings: boolean; expectedRevision: number; }
export interface ExhibitionUiSkinUploadInput { imageBase64: string; expectedRevision?: number; }
const STOP_UNCONFIRMED = '停止状态未确认，请联系工作人员。';

async function timedJson(url: string, scope: RequestScope, init: RequestInit = {}, timeout = 5000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signal = scope.controller.signal;
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, timeout);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { ok: response.ok, result: await response.json() };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** One immutable mirror identity; every start/stop also advances its request epoch. */
export class ExhibitionMirrorClient {
  private snapshot: ExhibitionSnapshot = { state: null, pending: false, stopPending: false, connected: false, error: '' };
  private listeners = new Set<() => void>();
  private scope: RequestScope | null = null;
  private epoch = 0;
  private refreshError = '';
  private timer?: ReturnType<typeof setTimeout>;
  private stopping?: { scope: RequestScope; promise: Promise<boolean> };

  constructor(readonly mirrorId = 'default') {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<ExhibitionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach(listener => listener());
  }
  private current(scope: RequestScope) { return this.scope === scope && scope.epoch === this.epoch && !scope.controller.signal.aborted; }
  private url(path = '') { return appUrl(`/api${exhibitionApiPath(path, this.mirrorId)}`); }
  private adopt(next: ExhibitionState, scope: RequestScope) {
    if (!this.current(scope)) return;
    if ((next.mirrorId ?? 'default') !== this.mirrorId) throw new Error('后台返回的试衣镜不匹配，请检查当前入口。');
    const previous = this.snapshot.state;
    const acceptsState = !previous || next.revision >= previous.revision;
    const clearsStopError = acceptsState && isExhibitionLocallyEnded(next) && this.snapshot.error === STOP_UNCONFIRMED;
    this.publish({ connected: true, ...((this.refreshError && this.snapshot.error === this.refreshError) || clearsStopError ? { error: '' } : {}),
      ...(acceptsState ? { state: next } : {}) });
    this.refreshError = '';
  }
  private async refreshScope(scope: RequestScope) {
    if (!this.current(scope)) return;
    try {
      const { ok, result } = await timedJson(this.url(), scope, { cache: 'no-store' });
      if (!ok) throw new Error(result.message ?? '后台暂时未连接');
      this.adopt(result as ExhibitionState, scope);
    } catch (cause) {
      if (this.current(scope)) {
        this.refreshError = cause instanceof Error ? cause.message : '后台暂时未连接';
        this.publish({ connected: false, error: this.refreshError });
      }
    }
  }
  refresh = async () => { if (this.scope) await this.refreshScope(this.scope); };
  start() {
    if (this.scope) return;
    const scope: RequestScope = { epoch: ++this.epoch, controller: new AbortController(), busy: false };
    this.scope = scope;
    this.publish({ pending: false, stopPending: false, connected: false, error: '' });
    const poll = async () => {
      await this.refreshScope(scope);
      if (this.current(scope)) this.timer = setTimeout(poll, 850);
    };
    void poll();
  }
  stop() {
    const scope = this.scope;
    this.scope = null;
    ++this.epoch;
    clearTimeout(this.timer);
    scope?.controller.abort();
  }
  private async mutate(path: string, input: { expectedRevision?: number }, method = 'POST', timeout = 5000, withRevision = true, onSuccess?: (next: ExhibitionState) => void) {
    const scope = this.scope;
    const state = this.snapshot.state;
    if (!scope || !this.current(scope) || scope.busy || this.snapshot.stopPending || !state) return false;
    scope.busy = true;
    this.publish({ pending: true, error: '' });
    try {
      const { ok, result } = await timedJson(this.url(path), scope, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withRevision ? { ...input, expectedRevision: input.expectedRevision ?? state.revision } : input),
      }, timeout);
      if (!this.current(scope)) return false;
      if (!ok) {
        await this.refreshScope(scope);
        throw new Error(result.code === 'EXHIBITION_STALE_REVISION' && input.expectedRevision !== undefined ? (path === 'skin' ? method === 'DELETE' ? '后台状态已变化，请核对当前皮肤后再恢复默认。' : '后台状态已变化，请重新选择皮肤后再保存。' : method === 'DELETE' ? '后台状态已变化，请重新打开素材后再删除。' : 'action' in input && input.action === 'confirm' ? '状态已更新，请重新开始。' : '后台状态已变化。请重新打开编辑区域，核对最新内容后再保存。') : result.message ?? '操作未完成，请重试。');
      }
      this.adopt(result as ExhibitionState, scope);
      if (!this.current(scope)) return false;
      onSuccess?.(result as ExhibitionState);
      return true;
    } catch (cause) {
      if (this.current(scope)) this.publish({ error: cause instanceof Error ? cause.message : '连接中断，请重试。' });
      return false;
    } finally {
      if (this.current(scope)) { scope.busy = false; this.publish({ pending: false }); }
    }
  }
  private stopCommand(action: 'end' | 'idle'): Promise<boolean> {
    const previous = this.scope;
    if (!previous || !this.current(previous) || !this.snapshot.state) return Promise.resolve(false);
    if (this.stopping?.scope === previous) return this.stopping.promise;
    // Stop takes priority over an in-flight start, upload or selection. Their
    // late responses cannot revive this request epoch or overwrite its result.
    this.stop(); this.start();
    const scope = this.scope!;
    this.publish({ stopPending: true, error: '' });
    const promise = (async () => {
      try {
        const { ok, result } = await timedJson(this.url('command'), scope, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
        }, 15000);
        if (!this.current(scope)) return false;
        if (!ok) { await this.refreshScope(scope); throw new Error(STOP_UNCONFIRMED); }
        const next = result as ExhibitionState;
        this.adopt(next, scope);
        if ((!isExhibitionLocallyEnded(next) && next.live) || !['idle', 'select'].includes(next.phase)) throw new Error(STOP_UNCONFIRMED);
        return true;
      } catch {
        if (this.current(scope)) { this.publish({ error: STOP_UNCONFIRMED }); void this.refreshScope(scope); }
        return false;
      } finally {
        if (this.current(scope)) this.publish({ stopPending: false });
        if (this.stopping?.scope === scope) this.stopping = undefined;
      }
    })();
    this.stopping = { scope, promise };
    return promise;
  }
  stopExperience = () => this.stopCommand('end');
  send = (command: ExhibitionCommand) => command.action === 'end' || command.action === 'idle' ? this.stopCommand(command.action) : this.mutate('command', command);
  upload = async (input: ExhibitionUploadInput): Promise<{ lookId: string; index: number } | null> => {
    let created: { lookId: string; index: number } | null = null;
    await this.mutate('looks', input, 'POST', 60000, false, next => {
      const index = next.looks.length - 1;
      if (next.looks[index]) created = { lookId: next.looks[index].id, index };
    });
    return created;
  };
  updateLook = (id: string, input: ExhibitionLookInput) => this.mutate(`looks/${encodeURIComponent(id)}`, input, 'PATCH');
  deleteLook = (id: string, input: { expectedRevision?: number }) => this.mutate(`looks/${encodeURIComponent(id)}`, input, 'DELETE');
  saveTaxonomy = (input: ExhibitionTaxonomyInput) => this.mutate('taxonomy', input);
  copyData = (input: ExhibitionCopyInput) => this.mutate('copy', input, 'POST', 60000);
  uploadUiSkin = (input: ExhibitionUiSkinUploadInput) => this.mutate('skin', input, 'POST', 60000);
  removeUiSkin = (input: { expectedRevision?: number } = {}) => this.mutate('skin', input, 'DELETE');
  clearError = () => this.publish({ error: '' });
}

export function useExhibition(mirrorId = 'default') {
  const client = useMemo(() => new ExhibitionMirrorClient(mirrorId), [mirrorId]);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => { client.start(); return () => client.stop(); }, [client]);
  return { ...snapshot, pending: snapshot.pending || snapshot.stopPending, mirrorId, send: client.send, stopExperience: client.stopExperience, upload: client.upload, updateLook: client.updateLook, deleteLook: client.deleteLook,
    saveTaxonomy: client.saveTaxonomy, copyData: client.copyData, uploadUiSkin: client.uploadUiSkin, removeUiSkin: client.removeUiSkin,
    refresh: client.refresh, clearError: client.clearError };
}
export type ExhibitionController = ReturnType<typeof useExhibition>;
