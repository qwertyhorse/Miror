import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Link2, Monitor, Unlink, Wifi, WifiOff, X } from 'lucide-react';
import type { ExhibitionDeviceBinding, ExhibitionMirrorSummary } from '../../shared/exhibition';
import { appUrl } from '../versionScope';
import type { ExhibitionController } from './useExhibition';
import type { MirrorRegistry } from './useMirrors';
import { MirrorCameraSettings } from './MirrorCameraSettings';
import './device-binding.css';

function lastSeen(time: number) {
  return new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function BindingDialog({ mirror, binding, available, unavailableMessage, registry, refreshState, close, saved }: {
  mirror: ExhibitionMirrorSummary; binding: ExhibitionDeviceBinding | null; available: boolean; registry: MirrorRegistry;
  unavailableMessage: string; refreshState: () => Promise<void>; close: () => void; saved: (message: string) => void;
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
    if (request.current || !available || (!binding && !/^\d{4}$/.test(code))) return;
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
      if (abort.signal.aborted) throw new DOMException('Request timed out', 'AbortError');
      if (!response.ok) throw new Error(result.message ?? '设备绑定未完成，请重试。');
      await Promise.allSettled([registry.refresh(), refreshState()]);
      if (epoch === generation.current) saved(binding ? '镜端设备已解绑。' : '镜端设备已绑定，镜端将自动连接这台智能镜。');
    } catch (cause) {
      if (epoch === generation.current) {
        setError(cause instanceof DOMException && cause.name === 'AbortError' ? '请求超时，请核对绑定状态后重试。' : cause instanceof Error ? cause.message : '设备绑定未完成，请重试。');
        void Promise.allSettled([registry.refresh(), refreshState()]);
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
        <p className="ex-mirror-help">确认解绑「{mirror.name}」？这将结束当前体验，下次使用需重新绑定。</p>
      </> : <>
        <p className="ex-binding-guide">在镜端大屏点击「绑定设备」，查看 4 位绑定码。安卓客户端未绑定时会自动显示绑定码。</p>
        <label className="ex-mirror-field">镜端显示的绑定码<input className="ex-binding-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4}" minLength={4} maxLength={4} placeholder="0000" required value={code} disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))} /></label>
        <p className="ex-mirror-help">将这台镜端绑定到「{mirror.name}」。绑定码过期后，请在镜端获取新码。</p>
      </>}
      {!available && <p className="ex-field-error" role="alert">{unavailableMessage}</p>}
      {error && <p className="ex-field-error" role="alert">{error}</p>}
      <footer><button type="button" className="ex-button" autoFocus={!!binding} disabled={busy} onClick={close}>取消</button><button className={`ex-button ${binding ? 'ex-binding-unbind' : 'ex-primary'}`} disabled={busy || !available || (!binding && !/^\d{4}$/.test(code))}>{busy ? '正在处理…' : binding ? '确认解绑' : '确认绑定'}</button></footer>
    </form>
  </dialog>;
}

interface MirrorDeviceBindingProps {
  mirror: ExhibitionMirrorSummary; controller: ExhibitionController; registry: MirrorRegistry;
}

export function MirrorDeviceBinding(props: MirrorDeviceBindingProps) {
  return <MirrorDeviceBindingContent key={props.mirror.id} {...props} />;
}

function MirrorDeviceBindingContent({ mirror, controller, registry }: MirrorDeviceBindingProps) {
  const [modal, setModal] = useState<{ binding: ExhibitionDeviceBinding | null } | null>(null);
  const [notice, setNotice] = useState('');
  const binding = mirror.binding ?? null;
  const canRequest = controller.connected && !controller.pending;
  const canBind = canRequest && !!controller.state && ['idle', 'select'].includes(controller.state.phase) && !controller.state.live;
  const available = binding ? canRequest : canBind;
  const unavailableMessage = !controller.connected ? '等待后台重新连接。' : controller.pending ? '正在处理其他操作。' : '请先结束体验，再绑定设备。';
  return <section className="ex-device-binding" aria-label="镜端设备">
    <div className="ex-binding-heading"><h3><Monitor size={17} />镜端设备</h3><span className={`ex-binding-status${binding?.online ? ' is-online' : ''}`}>{binding ? <>{binding.online ? <Wifi size={12} /> : <WifiOff size={12} />}{binding.online ? '在线' : '离线'}</> : '未绑定'}</span></div>
    {binding ? <>
      <div className="ex-binding-summary"><div><strong>{binding.label}</strong><p>{binding.platform === 'android' ? '安卓客户端' : '浏览器镜端'} · <span title={binding.terminalId}>设备 {binding.terminalId.slice(-4)}</span></p></div><button type="button" className="ex-button ex-binding-unbind" disabled={!available || !!modal} onClick={() => { if (!available || modal) return; setNotice(''); setModal({ binding: { ...binding } }); }}><Unlink size={14} />解绑</button></div>
      <p className="ex-binding-last-seen">{binding.lastSeenAt > 0 ? `最近连接：${lastSeen(binding.lastSeenAt)}` : '等待镜端重新连接。'}</p>
      <MirrorCameraSettings mirrorId={mirror.id} binding={binding} connected={controller.connected} editable={canBind} disabled={!!modal || controller.stopPending} refresh={registry.refresh} />
    </> : <div className="ex-binding-empty"><p>绑定一台镜端，自动连接当前智能镜的大屏。</p><button type="button" className="ex-button ex-primary" disabled={!available || !!modal} onClick={() => { if (!available || modal) return; setNotice(''); setModal({ binding: null }); }}><Link2 size={15} />绑定镜端设备</button><p className="ex-binding-instructions">镜端点击「绑定设备」获取绑定码，安卓客户端未绑定时自动显示。</p></div>}
    {!available && <p className="ex-binding-last-seen">{unavailableMessage}</p>}
    {notice && <p className="ex-binding-notice" role="status"><Check size={14} />{notice}</p>}
    {modal && <BindingDialog mirror={mirror} binding={modal.binding} available={modal.binding ? canRequest : canBind} unavailableMessage={unavailableMessage} registry={registry} refreshState={controller.refresh} close={() => setModal(null)} saved={message => { setNotice(message); setModal(null); }} />}
  </section>;
}
