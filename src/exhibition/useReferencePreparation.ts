import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReferencePreparationStatus } from '../../shared/referencePreparation';
import { appUrl } from '../versionScope';
import { exhibitionApiPath } from './mirrorApi';

type References = Record<string, ReferencePreparationStatus>;
interface Snapshot {
  scope: string;
  references: References;
  error: string;
  retryErrors: Record<string, string>;
  retrying: Set<string>;
  now: number;
}
const emptyReferences: References = {};
const emptyRetrying = new Set<string>();
const states = new Set(['queued', 'preparing', 'ready', 'failed', 'unconfigured', 'not_required']);
function isStatus(value: unknown): value is ReferencePreparationStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as ReferencePreparationStatus;
  return states.has(status.state) && (status.message === undefined || typeof status.message === 'string')
    && [status.retryAt, status.updatedAt, status.freshUntil].every(value => value === undefined || (typeof value === 'number' && Number.isFinite(value)));
}

/** One batch request per library, with all responses scoped to its mirror and catalog. */
export function useReferencePreparation(mirrorId: string, catalogKey: string, enabled = true) {
  const scope = JSON.stringify([mirrorId, catalogKey, enabled]);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({ scope: '', references: {}, error: '', retryErrors: {}, retrying: new Set(), now: Date.now() }));
  const controls = useRef<{ scope: string; refresh: () => void; retry: (lookId: string) => Promise<void> } | null>(null);

  useEffect(() => {
    let stopped = false;
    let listSequence = 0;
    const listRequest: { current: AbortController | null } = { current: null };
    let interval: ReturnType<typeof setInterval> | undefined;
    const requests = new Set<AbortController>();
    const pendingRetries = new Set<string>();
    let references: References = {};
    const cancelList = () => { ++listSequence; listRequest.current?.abort(); listRequest.current = null; };
    setSnapshot({ scope, references, error: '', retryErrors: {}, retrying: new Set(), now: Date.now() });
    const update = (change: (previous: Snapshot) => Snapshot) => {
      if (!stopped) setSnapshot(previous => previous.scope === scope ? change(previous) : previous);
    };
    const request = async (suffix: string, abort: AbortController, post = false, replace = false): Promise<unknown> => {
      requests.add(abort);
      const timeout = setTimeout(() => abort.abort(), 10000);
      try {
        const response = await fetch(appUrl(`/api${exhibitionApiPath(suffix, mirrorId)}`), {
          cache: 'no-store', signal: abort.signal,
          ...(post ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(replace ? { replace: true } : {}) } : {}),
        });
        if (!response.ok) throw new Error('Reference preparation request failed');
        return await response.json();
      } finally { clearTimeout(timeout); requests.delete(abort); }
    };
    const refresh = async () => {
      if (stopped || !enabled || document.hidden) return;
      const sequence = ++listSequence;
      listRequest.current?.abort();
      const abort = new AbortController();
      listRequest.current = abort;
      update(previous => ({ ...previous, now: Date.now() }));
      try {
        const result = await request('references', abort) as { references?: unknown };
        if (stopped || sequence !== listSequence || abort.signal.aborted) return;
        if (!result?.references || typeof result.references !== 'object' || Array.isArray(result.references)
          || !Object.values(result.references).every(isStatus)) throw new Error('Invalid reference preparation statuses');
        references = result.references as References;
        update(previous => ({ ...previous, references, error: '', now: Date.now(),
          retryErrors: Object.fromEntries(Object.entries(previous.retryErrors).filter(([id]) => references[id]?.state === 'failed')) }));
      } catch {
        if (!stopped && sequence === listSequence) {
          references = {};
          update(previous => ({ ...previous, references, error: '素材准备状态获取失败', now: Date.now() }));
        }
      } finally { if (listRequest.current === abort) listRequest.current = null; }
    };
    const retry = async (lookId: string) => {
      const status = references[lookId];
      if (stopped || !enabled || pendingRetries.has(lookId) || (status?.state !== 'failed' && status?.state !== 'ready') || status?.refreshState === 'preparing' || (status.retryAt ?? 0) > Date.now()) return;
      pendingRetries.add(lookId);
      // A list response from before the action must not overwrite the accepted retry.
      cancelList();
      update(previous => ({ ...previous, retrying: new Set(pendingRetries), retryErrors: { ...previous.retryErrors, [lookId]: '' } }));
      const abort = new AbortController();
      try {
        const result = await request(`references/${encodeURIComponent(lookId)}/retry`, abort, true, status?.state === 'ready') as { status?: unknown };
        if (stopped || abort.signal.aborted) return;
        if (!isStatus(result?.status)) throw new Error('Invalid reference preparation status');
        cancelList();
        references = { ...references, [lookId]: result.status };
        update(previous => ({ ...previous, references, now: Date.now() }));
      } catch {
        if (!stopped) update(previous => ({ ...previous, retryErrors: { ...previous.retryErrors, [lookId]: '重试请求失败，请再试一次' } }));
      } finally {
        pendingRetries.delete(lookId);
        update(previous => ({ ...previous, retrying: new Set(pendingRetries) }));
      }
    };
    const polling = () => {
      clearInterval(interval);
      if (document.hidden) { cancelList(); return; }
      void refresh();
      interval = setInterval(() => { if (!listRequest.current) void refresh(); }, 3000);
    };
    controls.current = { scope, refresh: () => { void refresh(); }, retry };
    if (enabled) { document.addEventListener('visibilitychange', polling); polling(); }
    return () => {
      stopped = true; ++listSequence; clearInterval(interval);
      document.removeEventListener('visibilitychange', polling);
      for (const abort of requests) abort.abort();
      if (controls.current?.scope === scope) controls.current = null;
    };
  }, [scope, mirrorId, enabled]);

  const refresh = useCallback(() => { if (controls.current?.scope === scope) controls.current.refresh(); }, [scope]);
  const retry = useCallback(async (lookId: string) => { if (controls.current?.scope === scope) await controls.current.retry(lookId); }, [scope]);
  const current = snapshot.scope === scope ? snapshot : null;
  return { references: current?.references ?? emptyReferences, error: current?.error ?? '', retryErrors: current?.retryErrors ?? {},
    retrying: current?.retrying ?? emptyRetrying, now: current?.now ?? Date.now(), refresh, retry };
}
