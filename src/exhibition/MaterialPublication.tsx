import { useEffect, useState } from 'react';
import { api } from '../api';
import { exhibitionApiPath } from './mirrorApi';
import type { ExhibitionController } from './useExhibition';

interface Publication { revision: number; lookIds: string[]; readyLookIds: string[]; draftReadyLookIds: string[]; unavailableLookIds: string[]; draftChanged: boolean; }
export function MaterialPublication({ controller }: { controller: ExhibitionController }) {
  const [publication, setPublication] = useState<Publication | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [partial, setPartial] = useState(false);
  const path = (suffix = '') => exhibitionApiPath(`publication${suffix}`, controller.mirrorId);
  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => { void api<{ publication: Publication; preparing?: boolean }>(path(), 'GET', undefined, abort.signal).then(result => { setPublication(result.publication); setPreparing(!!result.preparing); setError(''); }).catch(() => { if (!abort.signal.aborted) setError('发布状态获取失败'); }); };
    refresh(); const timer = setInterval(refresh, 3000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [controller.mirrorId, controller.state?.revision]);
  async function act(action: 'prepare' | 'publish', publishReadyOnly = false) {
    if (!controller.state || busy) return;
    setBusy(true); setError('');
    try {
      await api(path(`/${action}`), 'POST', { expectedRevision: controller.state.revision, ...(action === 'publish' && publishReadyOnly ? { allowPartial: true, lookIds: publication?.draftReadyLookIds } : {}) });
      const result = await api<{ publication: Publication; preparing?: boolean }>(path()); setPublication(result.publication); setPreparing(!!result.preparing); await controller.refresh(); setPartial(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <div className="ex-publication" role="group" aria-label="素材发布">
    <span>{publication ? `已发布 ${publication.lookIds.length} 件 · 当前可体验 ${publication.readyLookIds.length} 件${publication.draftChanged ? ' · 草稿已修改' : ''}` : '查询发布状态…'}</span>
    <button className="ex-button" disabled={busy || preparing || !controller.connected} onClick={() => void act('prepare')}>{preparing ? '素材准备中…' : busy ? '处理中…' : '准备已选草稿'}</button>
    <button className="ex-button ex-primary" disabled={busy || !publication || !controller.connected} onClick={() => void act('publish')}>发布已选</button>
    {!!publication?.draftReadyLookIds.length && <button className="ex-button" disabled={busy} onClick={() => setPartial(true)}>仅发布已就绪…</button>}
    {partial && <span role="group" aria-label="确认部分发布">仅发布已就绪的 {publication?.draftReadyLookIds.length} 件？ <button className="ex-button" disabled={busy} onClick={() => void act('publish', true)}>确认发布</button><button className="ex-button" disabled={busy} onClick={() => setPartial(false)}>取消</button></span>}
    {error && <span role="alert" className="ex-field-error">{error}</span>}
  </div>;
}
