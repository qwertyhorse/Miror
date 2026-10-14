import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { appUrl } from '../versionScope';
import { exhibitionApiPath } from './mirrorApi';
import { isExhibitionLocallyEnded, type ExhibitionCommand, type ExhibitionState, type ExhibitionLookInput, type ExhibitionLookCopyInput, type ExhibitionUploadInput, type ExhibitionTaxonomyInput } from '../../shared/exhibition';

interface RequestScope { epoch: number; controller: AbortController; busy: boolean; changes?: boolean; }
interface ExhibitionSnapshot { state: ExhibitionState | null; pending: boolean; selectionPending: boolean; stopPending: boolean; connected: boolean; error: string; }
export interface ExhibitionCommandObservation {
  type: 'sent' | 'accepted' | 'rejected' | 'cancelled';
  command: ExhibitionCommand;
  state: ExhibitionState;
  at: number;
  attempt: number;
}
export type ExhibitionCommandObserver = (event: ExhibitionCommandObservation) => void;
interface CommandIntent {
  command: ExhibitionCommand; observer?: ExhibitionCommandObserver; state: ExhibitionState;
  attempt: number; settled: boolean; cancelled: boolean; sentCommand?: ExhibitionCommand;
}
interface SelectionIntent extends CommandIntent { resolve: (value: boolean) => void; }
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
  private snapshot: ExhibitionSnapshot = { state: null, pending: false, selectionPending: false, stopPending: false, connected: false, error: '' };
  private listeners = new Set<() => void>();
  private scope: RequestScope | null = null;
  private epoch = 0;
  private refreshError = '';
  private timer?: ReturnType<typeof setTimeout>;
  private stopping?: { scope: RequestScope; promise: Promise<boolean>; intent?: CommandIntent };
  private selectingScope?: RequestScope;
  private queuedSelection?: SelectionIntent;
  private activeSelection?: SelectionIntent;
  private activeMutation?: CommandIntent;

  constructor(readonly mirrorId = 'default') {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<ExhibitionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach(listener => listener());
  }
  private current(scope: RequestScope) { return this.scope === scope && scope.epoch === this.epoch && !scope.controller.signal.aborted; }
  private observe(intent: CommandIntent, type: ExhibitionCommandObservation['type'], state = intent.state) {
    if (!intent.observer || (intent.cancelled && type !== 'cancelled')) return;
    try {
      intent.observer({ type, command: structuredClone(intent.sentCommand ?? intent.command), state: structuredClone(state),
        at: performance.now(), attempt: intent.attempt });
    } catch { /* Observers cannot alter the request or its result. */ }
  }
  private cancel(intent: CommandIntent | undefined) {
    if (!intent || intent.settled || intent.cancelled) return;
    intent.cancelled = true; this.observe(intent, 'cancelled');
  }
  private intent(command: ExhibitionCommand, state: ExhibitionState, observer?: ExhibitionCommandObserver): CommandIntent {
    return { command: { ...command, commandId: command.commandId ?? globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }, state, observer, attempt: 0, settled: false, cancelled: false };
  }
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
  private async refreshScope(scope: RequestScope, waitForChange = false): Promise<void> {
    if (!this.current(scope)) return;
    try {
      const revision = this.snapshot.state?.revision;
      const waiting = waitForChange && scope.changes !== false && revision !== undefined;
      const { ok, result } = await timedJson(waiting ? this.url(`changes?after=${revision}`) : this.url(), scope, { cache: 'no-store' }, waiting ? 10_000 : 5_000);
      if (waiting && !ok && (result.code === 'NOT_FOUND' || result.error?.code === 'NOT_FOUND')) {
        scope.changes = false; return this.refreshScope(scope);
      }
      if (waiting && ok) scope.changes = true;
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
    this.publish({ pending: false, selectionPending: false, stopPending: false, connected: false, error: '' });
    const poll = async () => {
      await this.refreshScope(scope, true);
      if (this.current(scope)) this.timer = setTimeout(poll, scope.changes && this.snapshot.connected ? 25 : 850);
    };
    void poll();
  }
  stop() {
    const scope = this.scope;
    this.scope = null;
    ++this.epoch;
    clearTimeout(this.timer);
    scope?.controller.abort();
    this.cancel(this.queuedSelection); this.cancel(this.activeSelection); this.cancel(this.activeMutation); this.cancel(this.stopping?.intent);
    this.queuedSelection?.resolve(false); this.activeSelection?.resolve(false);
    this.queuedSelection = undefined; this.activeSelection = undefined; this.selectingScope = undefined;
    this.activeMutation = undefined;
  }
  private select(command: SelectionIntent['command'], observer?: ExhibitionCommandObserver): Promise<boolean> {
    const scope = this.scope;
    if (!scope || !this.current(scope) || !this.snapshot.state || this.snapshot.stopPending
      || (scope.busy && this.selectingScope !== scope)) {
      if (observer && this.snapshot.state) this.cancel(this.intent(command, this.snapshot.state, observer));
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      this.cancel(this.queuedSelection);
      this.queuedSelection?.resolve(false);
      this.queuedSelection = { ...this.intent(command, this.snapshot.state!, observer), resolve };
      if (this.selectingScope === scope) return;
      this.selectingScope = scope; scope.busy = true;
      this.publish({ pending: true, selectionPending: true, error: '' });
      void this.drainSelections(scope);
    });
  }
  private async drainSelections(scope: RequestScope) {
    try {
      while (this.current(scope) && this.queuedSelection && !this.snapshot.stopPending) {
        const intent = this.queuedSelection;
        this.queuedSelection = undefined; this.activeSelection = intent;
        let completed = false;
        let rejectionObserved = false;
        try {
          // Only the last unsent choice survives. A revision conflict may be
          // retried once after a fresh read, without replaying a superseded choice.
          for (let attempt = 0; attempt < 2 && this.current(scope); attempt++) {
            const state = this.snapshot.state!;
            const action = ['idle', 'select'].includes(state.phase) ? 'select' : 'switch';
            intent.state = state; intent.attempt = attempt + 1; rejectionObserved = false;
            intent.sentCommand = { ...intent.command, action, expectedRevision: intent.command.expectedRevision ?? state.revision };
            this.observe(intent, 'sent');
            const { ok, result } = await timedJson(this.url('command'), scope, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(intent.sentCommand),
            });
            if (!this.current(scope)) break;
            if (ok) {
              if (((result as ExhibitionState).mirrorId ?? 'default') !== this.mirrorId) throw new Error('后台返回的试衣镜不匹配，请检查当前入口。');
              intent.settled = true; this.observe(intent, 'accepted', result as ExhibitionState);
              this.adopt(result as ExhibitionState, scope);
              completed = !this.queuedSelection;
              break;
            }
            this.observe(intent, 'rejected'); rejectionObserved = true;
            await this.refreshScope(scope);
            if (!this.current(scope) || this.queuedSelection) break;
            if (attempt === 0 && result.code === 'EXHIBITION_STALE_REVISION' && intent.command.expectedRevision === undefined) continue;
            throw new Error(result.message ?? '素材切换未完成，请重试。');
          }
        } catch (cause) {
          if (this.current(scope) && !rejectionObserved && !intent.settled) this.observe(intent, 'rejected');
          if (this.current(scope) && !this.queuedSelection) this.publish({ error: cause instanceof Error ? cause.message : '素材切换未完成，请重试。' });
        } finally {
          intent.resolve(completed);
          if (this.activeSelection === intent) this.activeSelection = undefined;
        }
      }
    } finally {
      if (this.selectingScope === scope) {
        this.selectingScope = undefined;
        if (this.current(scope)) { scope.busy = false; this.publish({ pending: false, selectionPending: false }); }
      }
    }
  }
  private async mutate(path: string, input: { expectedRevision?: number }, method = 'POST', timeout = 5000, withRevision = true, onSuccess?: (next: ExhibitionState) => void, observer?: ExhibitionCommandObserver) {
    const scope = this.scope;
    const state = this.snapshot.state;
    if (!scope || !this.current(scope) || scope.busy || this.snapshot.stopPending || !state) {
      if (observer && state) this.cancel(this.intent(input as ExhibitionCommand, state, observer));
      return false;
    }
    const intent = path === 'command' ? this.intent(input as ExhibitionCommand, state, observer) : undefined;
    const payload = intent?.command ?? input;
    if (intent) this.activeMutation = intent;
    let rejectionObserved = false;
    scope.busy = true;
    this.publish({ pending: true, error: '' });
    try {
      if (intent) {
        intent.attempt = 1;
        intent.sentCommand = withRevision ? { ...intent.command, expectedRevision: input.expectedRevision ?? state.revision } : intent.command;
        this.observe(intent, 'sent');
      }
      const { ok, result } = await timedJson(this.url(path), scope, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withRevision ? { ...payload, expectedRevision: input.expectedRevision ?? state.revision } : payload),
      }, timeout);
      if (!this.current(scope)) return false;
      if (!ok) {
        if (intent) this.observe(intent, 'rejected'); rejectionObserved = true;
        await this.refreshScope(scope);
        throw new Error(result.code === 'EXHIBITION_STALE_REVISION' && input.expectedRevision !== undefined ? (path === 'copy' || path === 'looks/copy' ? '目标智能镜已更新，请刷新并核对后再复制。' : path === 'skin' ? method === 'DELETE' ? '后台状态已变化，请核对当前皮肤后再恢复默认。' : '后台状态已变化，请重新选择皮肤后再保存。' : method === 'DELETE' ? '后台状态已变化，请重新打开素材后再删除。' : 'action' in input && input.action === 'confirm' ? '状态已更新，请重新开始。' : '后台状态已变化。请重新打开编辑区域，核对最新内容后再保存。') : result.message ?? '操作未完成，请重试。');
      }
      if (((result as ExhibitionState).mirrorId ?? 'default') !== this.mirrorId) throw new Error('后台返回的试衣镜不匹配，请检查当前入口。');
      if (intent) { intent.settled = true; this.observe(intent, 'accepted', result as ExhibitionState); }
      this.adopt(result as ExhibitionState, scope);
      if (!this.current(scope)) return false;
      onSuccess?.(result as ExhibitionState);
      return true;
    } catch (cause) {
      if (intent && this.current(scope) && !rejectionObserved && !intent.settled) this.observe(intent, 'rejected');
      if (this.current(scope)) this.publish({ error: cause instanceof Error ? cause.message : '连接中断，请重试。' });
      return false;
    } finally {
      if (this.activeMutation === intent) this.activeMutation = undefined;
      if (this.current(scope)) { scope.busy = false; this.publish({ pending: false }); }
    }
  }
  private stopCommand(action: 'end' | 'idle', observer?: ExhibitionCommandObserver): Promise<boolean> {
    const previous = this.scope;
    if (!previous || !this.current(previous) || !this.snapshot.state) {
      if (observer && this.snapshot.state) this.cancel(this.intent({ action }, this.snapshot.state, observer));
      return Promise.resolve(false);
    }
    if (this.stopping?.scope === previous) {
      if (observer) this.cancel(this.intent({ action }, this.snapshot.state, observer));
      return this.stopping.promise;
    }
    const intent = this.intent({ action }, this.snapshot.state, observer);
    // Stop takes priority over an in-flight start, upload or selection. Their
    // late responses cannot revive this request epoch or overwrite its result.
    this.stop(); this.start();
    const scope = this.scope!;
    this.publish({ stopPending: true, error: '' });
    let rejectionObserved = false;
    const promise = (async () => {
      try {
        if (intent) { intent.attempt = 1; intent.sentCommand = intent.command; this.observe(intent, 'sent'); }
        const { ok, result } = await timedJson(this.url('command'), scope, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent.command),
        }, 15000);
        if (!this.current(scope)) return false;
        if (!ok) { if (intent) this.observe(intent, 'rejected'); rejectionObserved = true; await this.refreshScope(scope); throw new Error(STOP_UNCONFIRMED); }
        const next = result as ExhibitionState;
        if ((next.mirrorId ?? 'default') !== this.mirrorId) throw new Error('后台返回的试衣镜不匹配，请检查当前入口。');
        if (intent) { intent.settled = true; this.observe(intent, 'accepted', next); }
        this.adopt(next, scope);
        if ((!isExhibitionLocallyEnded(next) && next.live) || !['idle', 'select'].includes(next.phase)) throw new Error(STOP_UNCONFIRMED);
        return true;
      } catch {
        if (intent && this.current(scope) && !rejectionObserved && !intent.settled) this.observe(intent, 'rejected');
        if (this.current(scope)) { this.publish({ error: STOP_UNCONFIRMED }); void this.refreshScope(scope); }
        return false;
      } finally {
        if (this.current(scope)) this.publish({ stopPending: false });
        if (this.stopping?.scope === scope) this.stopping = undefined;
      }
    })();
    this.stopping = { scope, promise, intent };
    return promise;
  }
  stopExperience = () => this.stopCommand('end');
  send = (command: ExhibitionCommand) => command.action === 'end' || command.action === 'idle' ? this.stopCommand(command.action)
    : command.action === 'select' || command.action === 'switch' ? this.select(command) : this.mutate('command', command);
  sendDiagnosed = (command: ExhibitionCommand, observer?: ExhibitionCommandObserver) => command.action === 'end' || command.action === 'idle' ? this.stopCommand(command.action, observer)
    : command.action === 'select' || command.action === 'switch' ? this.select(command, observer) : this.mutate('command', command, 'POST', 5000, true, undefined, observer);
  upload = async (input: ExhibitionUploadInput): Promise<{ lookId: string; index: number } | null> => {
    let created: { lookId: string; index: number } | null = null;
    await this.mutate('looks', input, 'POST', 60000, false, next => {
      const index = next.looks.length - 1;
      if (next.looks[index]) created = { lookId: next.looks[index].id, index };
    });
    return created;
  };
  updateLook = (id: string, input: ExhibitionLookInput) => this.mutate(`looks/${encodeURIComponent(id)}`, input, 'PATCH', input.imageBase64 || input.referenceImageBase64 ? 60000 : 5000);
  deleteLook = (id: string, input: { expectedRevision?: number }) => this.mutate(`looks/${encodeURIComponent(id)}`, input, 'DELETE');
  saveTaxonomy = (input: ExhibitionTaxonomyInput) => this.mutate('taxonomy', input);
  copyData = (input: ExhibitionCopyInput) => this.mutate('copy', input, 'POST', 60000);
  copyLook = async (input: ExhibitionLookCopyInput): Promise<{ lookId: string; index: number } | null> => {
    let created: { lookId: string; index: number } | null = null;
    await this.mutate('looks/copy', input, 'POST', 60000, true, next => {
      const index = next.looks.length - 1;
      if (next.looks[index]) created = { lookId: next.looks[index].id, index };
    });
    return created;
  };
  uploadUiSkin = (input: ExhibitionUiSkinUploadInput) => this.mutate('skin', input, 'POST', 60000);
  removeUiSkin = (input: { expectedRevision?: number } = {}) => this.mutate('skin', input, 'DELETE');
  clearError = () => this.publish({ error: '' });
}

export function useExhibition(mirrorId = 'default') {
  const client = useMemo(() => new ExhibitionMirrorClient(mirrorId), [mirrorId]);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => { client.start(); return () => client.stop(); }, [client]);
  return { ...snapshot, pending: snapshot.pending || snapshot.stopPending, mirrorId, send: client.send, sendDiagnosed: client.sendDiagnosed, stopExperience: client.stopExperience, upload: client.upload, updateLook: client.updateLook, deleteLook: client.deleteLook,
    saveTaxonomy: client.saveTaxonomy, copyData: client.copyData, copyLook: client.copyLook, uploadUiSkin: client.uploadUiSkin, removeUiSkin: client.removeUiSkin,
    refresh: client.refresh, clearError: client.clearError };
}
export type ExhibitionController = ReturnType<typeof useExhibition>;
