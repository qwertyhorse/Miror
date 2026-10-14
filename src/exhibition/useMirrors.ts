import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExhibitionMirrorList, ExhibitionMirrorSummary } from '../../shared/exhibition';
import { appUrl } from '../versionScope';

export function useMirrors() {
  const [data, setData] = useState<ExhibitionMirrorList | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const listSequence = useRef(0);
  const mutating = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const request = useCallback(async <T,>(path = '', init: RequestInit = {}): Promise<T> => {
    const abort = new AbortController();
    const epoch = generation.current;
    requests.current.add(abort);
    const timer = window.setTimeout(() => abort.abort(), 10000);
    try {
      const response = await fetch(appUrl(`/api/exhibition/mirrors${path}`), { ...init, cache: 'no-store', signal: abort.signal });
      const result = await response.json();
      if (epoch !== generation.current) throw new DOMException('Device list closed', 'AbortError');
      if (!response.ok) throw new Error(result.message ?? '设备列表暂时不可用。');
      return result as T;
    } finally { clearTimeout(timer); requests.current.delete(abort); }
  }, []);
  const refresh = useCallback(async () => {
    if (mutating.current) return;
    const epoch = generation.current;
    const sequence = ++listSequence.current;
    try {
      const next = await request<ExhibitionMirrorList>();
      if (epoch === generation.current && sequence === listSequence.current) { setData(next); setError(''); }
    } catch (cause) {
      if (epoch === generation.current && sequence === listSequence.current) setError(cause instanceof Error ? cause.message : '设备列表连接中断。');
    }
  }, [request]);
  useEffect(() => {
    generation.current++;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, 2000); };
    void poll();
    const activeRequests = requests.current;
    return () => { stopped = true; generation.current++; clearTimeout(timer); for (const item of activeRequests) item.abort(); };
  }, [refresh]);
  const save = useCallback(async (name: string, id?: string) => {
    if (mutating.current) throw new Error('设备列表正在更新，请稍后重试。');
    mutating.current = true;
    ++listSequence.current;
    let result: ExhibitionMirrorSummary;
    try {
      result = await request<ExhibitionMirrorSummary>(id ? `/${encodeURIComponent(id)}` : '', {
        method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      setData(previous => previous ? { ...previous, mirrors: previous.mirrors.some(item => item.id === result.id)
        ? previous.mirrors.map(item => item.id === result.id ? result : item)
        : [...previous.mirrors, result] } : { defaultMirrorId: 'default', mirrors: [result] });
    } finally { ++listSequence.current; mutating.current = false; }
    await refresh();
    return result;
  }, [request, refresh]);
  const remove = useCallback(async (id: string, expectedRevision: number) => {
    if (mutating.current) throw new Error('设备列表正在更新，请稍后重试。');
    mutating.current = true;
    ++listSequence.current;
    try {
      const result = await request<ExhibitionMirrorList>(`/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision }),
      });
      setData(result); setError('');
      return result;
    } finally { ++listSequence.current; mutating.current = false; }
  }, [request]);
  return { data, error, refresh, save, remove };
}
export type MirrorRegistry = ReturnType<typeof useMirrors>;
