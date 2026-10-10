import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Link2, Monitor, Unlink, Wifi, WifiOff, X } from 'lucide-react';
import type { ExhibitionDeviceBinding, ExhibitionMirrorSummary } from '../../shared/exhibition';
import { appUrl } from '../versionScope';
import type { ExhibitionController } from './useExhibition';
import type { MirrorRegistry } from './useMirrors';
import './device-binding.css';

function lastSeen(time: number) {
  return new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function BindingDialog({ mirror, binding, available, registry, close, saved }: {
  mirror: ExhibitionMirrorSummary; binding: ExhibitionDeviceBinding | null; available: boolean; registry: MirrorRegistry;
  close: () => void; saved: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    generation.current++;
    const previousFocus = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    if (!binding) element?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    return () => {
      generation.current++; request.current?.abort(); element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [binding]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (request.current || !available || (!binding && !/^\d{6}$/.test(code))) return;
    const abort = new AbortController(); request.current = abort;
    const epoch = generation.current;
    const timer = window.setTimeout(() => abort.abort(), 10000);
    setBusy(true); setError('');
    try {
      const response = await fetch(appUrl(`/api/exhibition/mirrors/${encodeURIComponent(mirror.id)}/binding`), {
        method: binding ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: abort.signal,
        body: JSON.stringify(binding ? { terminalId: binding.terminalId } : { code }),
      });
      const result = await response.json();
      if (epoch !== generation.current) return;
      if (!response.ok) throw new Error(result.message ?? '设备绑定未完成，请重试。');
      await registry.refresh();
      if (epoch === generation.current) saved(binding ? '镜端设备已解绑。' : '镜端设备已绑定，镜端将自动连接这台智能镜。');
    } catch (cause) {
      if (epoch === generation.current) {
        setError(cause instanceof DOMException && cause.name === 'AbortError' ? '请求超时，请核对绑定状态后重试。' : cause instanceof Error ? cause.message : '设备绑定未完成，请重试。');
        void registry.refresh();
      }
    } finally {
      clearTimeout(timer);
      if (request.current === abort) request.current = null;
      if (epoch === generation.current) setBusy(false);
    }
  }
  return <dialog ref={dialog} className="ex-mirror-dialog ex-binding-dialog" aria-label={binding ? '解绑镜端设备' : '绑定镜端设备'} onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2>{binding ? '解绑镜端设备' : '绑定镜端设备'}</h2><button type="button" className="ex-icon-button" aria-label="关闭镜端绑定弹窗" disabled={busy} onClick={close}><X size={18} /></button></header>
      {binding ? <>
        <div className="ex-binding-target"><Monitor size={25} /><div><strong>{binding.label}</strong><span>{binding.terminalId}</span></div></div>
        <p className="ex-mirror-help">确认解除这台镜端与「{mirror.name}」的绑定？解绑后，镜端将返回绑定页面；再次使用时需重新绑定。</p>
      </> : <>
        <p className="ex-binding-guide">在镜端大屏点击「绑定设备」，查看 6 位绑定码。安卓客户端未绑定时会自动显示绑定码。</p>
        <label className="ex-mirror-field">镜端显示的绑定码<input className="ex-binding-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="000000" required value={code} disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
        <p className="ex-mirror-help">将这台镜端绑定到「{mirror.name}」。绑定码过期后，请在镜端获取新码。</p>
      </>}
      {!available && <p className="ex-field-error" role="alert">请先结束体验，并等待实时会话停止后再操作。</p>}
      {error && <p className="ex-field-error" role="alert">{error}</p>}
      <footer><button type="button" className="ex-button" autoFocus={!!binding} disabled={busy} onClick={close}>取消</button><button className={`ex-button ${binding ? 'ex-binding-unbind' : 'ex-primary'}`} disabled={busy || !available || (!binding && !/^\d{6}$/.test(code))}>{busy ? '正在处理…' : binding ? '确认解绑' : '确认绑定'}</button></footer>
    </form>
  </dialog>;
}

export function MirrorDeviceBinding({ mirror, controller, registry }: {
  mirror: ExhibitionMirrorSummary; controller: ExhibitionController; registry: MirrorRegistry;
}) {
  const [modal, setModal] = useState<{ binding: ExhibitionDeviceBinding | null } | null>(null);
  const [notice, setNotice] = useState('');
  const binding = mirror.binding ?? null;
  const available = !!controller.state && ['idle', 'select'].includes(controller.state.phase) && !controller.state.live && controller.connected && !controller.pending;
  return <section className="ex-device-binding" aria-label="镜端设备">
    <div className="ex-binding-heading"><h3><Monitor size={17} />镜端设备</h3><span className={`ex-binding-status${binding?.online ? ' is-online' : ''}`}>{binding ? <>{binding.online ? <Wifi size={12} /> : <WifiOff size={12} />}{binding.online ? '在线' : '离线'}</> : '未绑定'}</span></div>
    {binding ? <>
      <div className="ex-binding-summary"><div><strong>{binding.label}</strong><p>{binding.platform === 'android' ? '安卓客户端' : '浏览器镜端'} · <span title={binding.terminalId}>设备 {binding.terminalId.slice(-8)}</span></p></div><button type="button" className="ex-button ex-binding-unbind" disabled={!available} onClick={() => { setNotice(''); setModal({ binding: { ...binding } }); }}><Unlink size={14} />解绑</button></div>
      <p className="ex-binding-last-seen">{binding.lastSeenAt > 0 ? `最近连接：${lastSeen(binding.lastSeenAt)}` : '等待镜端重新连接。'}</p>
    </> : <div className="ex-binding-empty"><p>绑定一台镜端，自动连接当前智能镜的大屏。</p><button type="button" className="ex-button ex-primary" disabled={!available} onClick={() => { setNotice(''); setModal({ binding: null }); }}><Link2 size={15} />绑定镜端设备</button><p className="ex-binding-instructions">镜端点击「绑定设备」获取绑定码，安卓客户端未绑定时自动显示。</p></div>}
    {!available && <p className="ex-binding-last-seen">{controller.connected ? '结束体验并停止实时会话后，可绑定或解绑。' : '等待后台重新连接。'}</p>}
    {notice && <p className="ex-binding-notice" role="status"><Check size={14} />{notice}</p>}
    {modal && <BindingDialog mirror={mirror} binding={modal.binding} available={available} registry={registry} close={() => setModal(null)} saved={message => { setNotice(message); setModal(null); }} />}
  </section>;
}
