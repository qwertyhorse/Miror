import { useEffect, useRef, useState } from 'react';
import { CustomSelect } from '../components/SelectionControls';
import { api } from '../api';
import { exhibitionApiPath } from './mirrorApi';
import { isRealtimeProvider, providerLabel, type ProviderSettings, type RealtimeProvider } from '../../shared/providers';

function settings(value: ProviderSettings): ProviderSettings {
  if (!value || !Number.isSafeInteger(value.revision) || !isRealtimeProvider(value.active) || !isRealtimeProvider(value.desired)
    || typeof value.accounts?.xmax?.configured !== 'boolean' || typeof value.accounts?.decart?.configured !== 'boolean') throw new Error('服务配置读取失败。');
  return value;
}
export function ProviderSettingsForm({ mirrorId, onSaved }: { mirrorId: string; onSaved: () => void }) {
  const path = exhibitionApiPath('provider-settings', mirrorId);
  const [status, setStatus] = useState<ProviderSettings>();
  const [target, setTarget] = useState<{ ready: number; unavailable: number }>();
  const [provider, setProvider] = useState<RealtimeProvider>('xmax');
  const [key, setKey] = useState(''); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const epoch = useRef(0); const dirty = useRef(false); const revision = useRef<number | undefined>(undefined); const alive = useRef(true); const working = useRef(false);
  useEffect(() => {
    alive.current = true; const request = new AbortController();
    const refresh = async () => {
      if (working.current) return;
      const current = ++epoch.current;
      try {
        const value = settings(await api<ProviderSettings>(path, 'GET', undefined, request.signal));
        if (!alive.current || current !== epoch.current) return;
        if (revision.current !== undefined && revision.current !== value.revision && dirty.current) { setKey(''); dirty.current = false; setError('配置已变化，请重新选择。'); }
        revision.current = value.revision; setStatus(value);
        const readiness = await api<{ targetReadyLookIds: string[]; targetUnavailableLookIds: string[] }>(exhibitionApiPath('publication', mirrorId), 'GET', undefined, request.signal);
        if (!alive.current || current !== epoch.current) return;
        setTarget({ ready: readiness.targetReadyLookIds.length, unavailable: readiness.targetUnavailableLookIds.length });
        if (!dirty.current) setProvider(value.desired);
      } catch { if (alive.current && current === epoch.current && !request.signal.aborted) setError('服务配置读取失败。'); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { alive.current = false; ++epoch.current; request.abort(); clearInterval(timer); };
  }, [path]);
  async function run(action: 'save' | 'verify' | 'apply' | 'prepare' = 'save') {
    if (!status || working.current) return;
    working.current = true; ++epoch.current; setBusy(true); setError(''); setMessage('');
    const request = new AbortController(); const timeout = setTimeout(() => request.abort(), 20_000);
    try {
      if (action === 'prepare') {
        const publicationPath = exhibitionApiPath('publication', mirrorId);
        const publication = await api<{ stateRevision: number }>(publicationPath, 'GET', undefined, request.signal);
        await api(`${publicationPath}/prepare`, 'POST', { expectedRevision: publication.stateRevision, provider: status.desired }, request.signal);
        if (alive.current) setMessage('目标服务素材准备中');
      }
      else if (action === 'verify') { await api(`${path}/verify`, 'POST', {}, request.signal); if (alive.current) setMessage('鉴权通过'); }
      else if (action === 'apply') {
        const value = settings(await api<ProviderSettings>(`${path}/apply`, 'POST', { expectedRevision: status.revision }, request.signal));
        if (!alive.current) return;
        setStatus(value); revision.current = value.revision; dirty.current = false; setProvider(value.desired);
        setMessage(value.pending ? '正在释放连接，完成后切换' : '已切换'); onSaved();
      } else {
        const input = { provider, expectedRevision: status.revision, ...(key.trim() ? { apiKey: key.trim() } : {}) };
        setKey('');
        const value = settings(await api<ProviderSettings>(path, 'PUT', input, request.signal));
        if (!alive.current) return;
        setStatus(value); setTarget(undefined); revision.current = value.revision; dirty.current = false;
        setMessage(value.pending ? '已保存，等待目标素材就绪' : '已生效'); onSaved();
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); }
    finally { clearTimeout(timeout); working.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="ex-provider-settings" aria-label="换装服务设置">
    <div className="ex-credential-heading"><strong>换装服务</strong><span className="ex-credential-status">{status ? `当前：${providerLabel(status.active)}` : '读取中…'}</span></div>
    <form onSubmit={event => { event.preventDefault(); void run(); }}>
      <CustomSelect label="换装服务" value={provider} disabled={busy || !status} options={[{ value: 'xmax', label: 'XMAX' }, { value: 'decart', label: 'Decart · Lucy VTON 3.6' }]} onChange={value => { setProvider(value as RealtimeProvider); setKey(''); dirty.current = true; setMessage(''); setError(''); }} />
      {provider === 'decart' && <span className="ex-credential-status">标准速度 · 连续体验</span>}
      {provider === 'decart' && <input aria-label="Decart API Key" type="password" autoComplete="new-password" spellCheck={false} maxLength={512} value={key} disabled={busy} placeholder={status?.accounts.decart.configured ? '已配置，留空保留' : '输入 Decart API Key'} onChange={event => { setKey(event.target.value); dirty.current = true; setMessage(''); }} />}
      <div className="ex-provider-actions"><button type="submit" className="ex-button" disabled={busy || !status || (!status.accounts[provider].configured && !key.trim())}>{busy ? '处理中…' : '保存服务'}</button>
      {provider === 'decart' && <button type="button" className="ex-button" disabled={busy || !status?.accounts.decart.configured || !!key} onClick={() => void run('verify')}>验证连接</button>}</div>
    </form>
    {status?.pending && <div><p role="status">待生效：{providerLabel(status.desired)} · {status.applyAfterStop ? '释放后切换' : target ? `已就绪 ${target.ready} 件 · 待准备 ${target.unavailable} 件` : '检查素材中'}</p><button type="button" className="ex-button" disabled={busy} onClick={() => void run('prepare')}>准备目标服务素材</button><button type="button" className="ex-button" disabled={busy || status.applyAfterStop || !target || target.unavailable > 0 || target.ready === 0} onClick={() => void run('apply')}>切换服务</button></div>}
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="ex-field-error">{error}</p>}
  </section>;
}
