import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, Monitor, Pencil, Play, Plus, RotateCcw, Settings, Image, SkipBack, SkipForward, Square, Wifi, WifiOff, X } from 'lucide-react';
import { isExhibitionLocallyEnded, type ExhibitionMirrorSummary } from '../../shared/exhibition';
import type { ExhibitionController } from './useExhibition';
import type { ExhibitionLiveController } from './useExhibitionLive';
import type { MirrorRegistry } from './useMirrors';
import { exhibitionUrl } from './mirrorApi';
import { exhibitionCameraUrl } from './cameraEntry';
import { enabledLooksForMode, phaseLabel } from './catalog';
import { ExperienceModeChips, experienceModeLabel } from './ExperienceModeChips';
import { WardrobePanel } from './WardrobePanel';
import { UploadLimitsSettings } from './UploadLimitsSettings';
import { MirrorDeviceBinding } from './MirrorDeviceBinding';
import { OutfitSwitchSettings } from './OutfitSwitchSettings';
import { MirrorUiSkinSettings } from './MirrorUiSkinSettings';
import { MirrorCredentialSettings } from './MirrorCredentialSettings';
import { CustomSelect } from '../components/SelectionControls';

function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const focus = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement | HTMLSelectElement>('input:not([type="checkbox"]), select')?.focus({ preventScroll: true });
    return () => { dialog?.close(); if (focus instanceof HTMLElement && focus.isConnected) focus.focus({ preventScroll: true }); };
  }, []);
  return ref;
}

function MirrorNameDialog({ mirror, registry, close, created }: {
  mirror?: ExhibitionMirrorSummary; registry: MirrorRegistry; close: () => void; created: (id: string) => void;
}) {
  const dialog = useModal();
  const alive = useRef(true);
  const [name, setName] = useState(mirror?.name ?? `智能镜 ${(registry.data?.mirrors.length ?? 0) + 1}`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); if (saving) return;
    setSaving(true); setError('');
    try {
      const result = await registry.save(name.trim(), mirror?.id);
      if (alive.current) { close(); if (!mirror) created(result.id); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
    finally { if (alive.current) setSaving(false); }
  }
  return <dialog ref={dialog} className="ex-mirror-dialog" aria-label={mirror ? '修改设备名称' : '新增设备'} onCancel={event => { event.preventDefault(); if (!saving) close(); }}>
    <form onSubmit={event => void save(event)}>
      <header><h2>{mirror ? '修改设备名称' : '新增设备'}</h2><button type="button" className="ex-icon-button" aria-label="关闭设备名称弹窗" disabled={saving} onClick={close}><X size={18} /></button></header>
      <label className="ex-mirror-field">设备名称<input autoFocus required maxLength={40} value={name} onChange={event => setName(event.target.value)} disabled={saving} /></label>
      {!mirror && <p className="ex-mirror-help">新设备使用 ClothX 示例素材，以交互演示方式待机。创建后可从其他设备复制数据。</p>}
      {error && <p className="ex-field-error" role="alert">{error}</p>}
      <footer><button type="button" className="ex-button" disabled={saving} onClick={close}>取消</button><button className="ex-button ex-primary" disabled={saving || !name.trim()}>{saving ? '正在保存…' : mirror ? '保存名称' : '创建设备'}</button></footer>
    </form>
  </dialog>;
}

function CopyDialog({ mirror, registry, controller, close }: {
  mirror: ExhibitionMirrorSummary; registry: MirrorRegistry; controller: ExhibitionController; close: () => void;
}) {
  const dialog = useModal();
  const sources = registry.data!.mirrors.filter(item => item.id !== mirror.id);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [copyLooks, setCopyLooks] = useState(true);
  const [copySettings, setCopySettings] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [baseline] = useState(controller.state!.revision);
  const source = sources.find(item => item.id === sourceId);
  const busy = controller.pending;
  const available = !!controller.state && ['idle', 'select'].includes(controller.state.phase) && !controller.state.live;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!available || !source || (!copyLooks && !copySettings) || busy) return;
    if (!confirming) { setConfirming(true); return; }
    if (await controller.copyData({ sourceMirrorId: source.id, expectedRevision: baseline, copyLooks, copySettings })) { close(); void registry.refresh(); }
  }
  return <dialog ref={dialog} className="ex-mirror-dialog" aria-label="复制设备数据" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2>{confirming ? '确认替换设备数据' : '复制数据'}</h2><button type="button" className="ex-icon-button" aria-label="关闭复制弹窗" disabled={busy} onClick={close}><X size={18} /></button></header>
      {confirming ? <>
        <div className="ex-copy-summary"><span>来源设备<strong>{source?.name}</strong></span><span>目标设备<strong>{mirror.name}</strong></span></div>
        <p className="ex-mirror-help">将替换「{mirror.name}」的以下内容：</p>
        <ul className="ex-copy-ranges">{copyLooks && <li>素材资料：全部素材、图片、所属模式、Free 提示词、排列顺序与启用状态。</li>}{copySettings && <li>设备设置：当前体验模式、换装方式与间隔、待机时间、运行方式与上传限制。</li>}</ul>
        <p className="ex-mirror-help">{!copyLooks ? '目标素材资料保留。' : !copySettings ? '目标当前体验模式及设备设置保留。' : ''}复制后两台独立修改，目标设备回到待机。当前模式没有启用素材时，大屏显示待补充素材。设备名称、身份、日志和实时会话不会复制。</p>
      </> : <>
        <label className="ex-mirror-field">从哪台设备复制<select value={sourceId} onChange={event => setSourceId(event.target.value)} disabled={busy} required>{sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <fieldset className="ex-copy-options" disabled={busy}><legend>替换「{mirror.name}」的内容</legend>
          <label><input type="checkbox" checked={copyLooks} onChange={event => setCopyLooks(event.target.checked)} /><span><strong>素材资料</strong><small>素材、图片、所属模式、Free 提示词、排列顺序与启用状态</small></span></label>
          <label><input type="checkbox" checked={copySettings} onChange={event => setCopySettings(event.target.checked)} /><span><strong>设备设置</strong><small>当前体验模式、换装方式与间隔、待机时间、运行方式与上传限制</small></span></label>
        </fieldset>
        <p className="ex-mirror-help">所选内容将完整替换目标数据。复制是一次性快照，之后两台设备独立修改。</p>
      </>}
      {!available && <p className="ex-field-error" role="alert">请先结束目标设备的体验，并等待实时会话停止后再复制。</p>}
      {controller.error && <p className="ex-field-error" role="alert">{controller.error}</p>}
      <footer><button type="button" className="ex-button" disabled={busy} onClick={() => confirming ? setConfirming(false) : close()}>{confirming ? '返回修改' : '取消'}</button><button className="ex-button ex-primary" disabled={busy || !controller.connected || !available || !source || (!copyLooks && !copySettings)}>{busy ? '正在复制…' : confirming ? '确认替换并复制' : '下一步'}</button></footer>
    </form>
  </dialog>;
}

function DeviceSettings({ controller, live, mirrorId }: { controller: ExhibitionController; live: ExhibitionLiveController; mirrorId: string }) {
  const { state, send, pending, connected } = controller;
  const [timeout, setTimeoutValue] = useState(String(state!.settings.autoReturnSeconds));
  const [baseline, setBaseline] = useState<number>();
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (baseline === undefined) setTimeoutValue(String(state!.settings.autoReturnSeconds)); }, [state?.settings.autoReturnSeconds, baseline]);
  const configurable = !!state && ['select', 'idle'].includes(state.phase) && !state.live;
  const disabled = pending || controller.stopPending || !connected || !configurable;
  const screenUrl = exhibitionCameraUrl(mirrorId);
  const controlUrl = new URL(exhibitionUrl('/exhibition/control', mirrorId),
    typeof window !== 'undefined' && window.location.protocol === 'http:' ? window.location.href : 'http://xuminghong.local:10200/').toString();
  return <div className="ex-device-settings">
    <div className="ex-settings-title"><Settings size={17} /><h3>设备设置</h3>{!configurable && <small>{isExhibitionLocallyEnded(state!) ? '云端状态待确认' : '结束体验后可修改'}</small>}</div>
    <div className="ex-device-setting-grid">
      <div className="ex-device-setting"><span className="ex-device-setting-label">无操作返回待机</span><div className="ex-form-row"><CustomSelect className="ex-device-select" label="无操作返回待机" value={timeout} disabled={disabled} onChange={value => { if (baseline === undefined) setBaseline(state!.revision); setTimeoutValue(value); setSaved(false); }} options={[{ value: '0', label: '关闭自动返回' }, ...[30, 60, 90, 180, 300, ...(![0, 30, 60, 90, 180, 300].includes(Number(timeout)) ? [Number(timeout)] : [])].sort((a, b) => a - b).map(seconds => ({ value: String(seconds), label: seconds < 180 ? `${seconds} 秒` : `${seconds / 60} 分钟` }))]} /><button className="ex-button" disabled={disabled} onClick={async () => { if (await send({ action: 'configure', autoReturnSeconds: Number(timeout), expectedRevision: baseline })) { setBaseline(undefined); setSaved(true); } }}>保存</button>{saved && <span className="ex-saved" role="status"><Check size={14} />已保存</span>}</div>{baseline !== undefined && <button type="button" className="ex-reset-setting" disabled={pending} onClick={() => { setBaseline(undefined); setTimeoutValue(String(state!.settings.autoReturnSeconds)); setSaved(false); controller.clearError(); }}>放弃修改，读取最新设置</button>}</div>
      <div className="ex-device-setting"><span className="ex-device-setting-label">运行方式</span><CustomSelect className="ex-device-select" label="运行方式" value={state!.providerMode} disabled={disabled} onChange={value => void send({ action: 'configure', providerMode: value as 'demo' | 'xmax' })} options={[{ value: 'demo', label: '交互演示' }, { value: 'xmax', label: 'XMAX 实时生成' }]} /></div>
    </div>
    <MirrorCredentialSettings key={`credentials-${mirrorId}`} controller={controller} live={live} />
    <MirrorUiSkinSettings key={`skin-${mirrorId}`} controller={controller} />
    <details className="ex-device-details"><summary>素材上传限制<span>文件大小与图片尺寸</span></summary><UploadLimitsSettings controller={controller} /></details>
    <details className="ex-device-details"><summary>设备入口<span>镜端与后台地址</span></summary><div className="ex-device-links">
      {[{ name: '镜端入口', url: screenUrl }, { name: '工作人员后台', url: controlUrl }].map(entry => <div key={entry.name}><strong>{entry.name}</strong><a href={entry.url} target="_blank" rel="noreferrer">{entry.url}<ExternalLink size={14} /></a></div>)}
    </div></details>
  </div>;
}

interface MirrorConsoleProps {
  controller: ExhibitionController; live: ExhibitionLiveController; mirror: ExhibitionMirrorSummary; registry: MirrorRegistry;
  selectMirror: (id: string) => void; preview: ReactNode; compact?: boolean;
}

export function MirrorConsole(props: MirrorConsoleProps) {
  return <MirrorConsoleContent key={props.mirror.id} {...props} />;
}

function MirrorConsoleContent({ controller, live, mirror, registry, selectMirror, preview, compact = false }: MirrorConsoleProps) {
  const { state, send, pending, connected } = controller;
  const [tab, setTab] = useState<'live' | 'looks'>('live');
  const [modal, setModal] = useState<'create' | 'rename' | 'copy' | null>(null);
  if (!state) return null;
  const configurable = ['select', 'idle'].includes(state.phase) && !state.live;
  const realtime = state.providerMode === 'xmax';
  const locallyEnded = isExhibitionLocallyEnded(state);
  const enabledLooks = enabledLooksForMode(state);
  const look = enabledLooks.find(item => item.id === state.selectedLookId);
  const disabled = pending || controller.stopPending || !connected;
  const canStop = pending || (!!state.live && !locallyEnded) || !['idle', 'select'].includes(state.phase);
  const canNavigate = !!look && enabledLooks.length > 1 && (configurable || state.phase === 'showcase');
  const primary = locallyEnded ? { label: '恢复操作', action: 'recover' as const }
    : state.phase === 'positioning' ? { label: '开始体验', action: 'confirm' as const }
    : state.phase === 'showcase' ? { label: '体验进行中', action: 'next' as const }
    : state.phase === 'paused' ? { label: '重新开始体验', action: 'resume' as const }
    : state.phase === 'generating' ? { label: realtime ? '正在连接 XMAX…' : '正在切换示例…', action: 'confirm' as const }
    : { label: '开始体验', action: 'begin' as const };
  function navigate(direction: 'previous' | 'next') {
    if (disabled || !canNavigate || !look) return;
    if (configurable) {
      const index = enabledLooks.findIndex(item => item.id === look.id);
      const offset = direction === 'next' ? 1 : -1;
      const target = enabledLooks[(index + offset + enabledLooks.length) % enabledLooks.length];
      void send({ action: 'select', lookId: target.id });
    } else void send({ action: direction });
  }
  return <section className={`ex-console ex-mirror-console ex-console-tab-${tab}${compact ? ' ex-console-compact' : ''}`} aria-label="工作人员控制台">
    <div className="ex-console-layout">
      <nav className="ex-console-nav ex-mirror-nav" aria-label="智能镜设备">
        <div className="ex-mirror-list">{registry.data?.mirrors.map(item => <button key={item.id} className={mirror.id === item.id ? 'is-active' : ''} aria-current={mirror.id === item.id ? 'page' : undefined} onClick={() => selectMirror(item.id)}><Monitor size={19} /><span><strong>{item.name}</strong><small><i className={`ex-mirror-status ex-mirror-status-${item.id === mirror.id ? state.phase : item.phase}`} />{phaseLabel[item.id === mirror.id ? state.phase : item.phase]}</small><small className={`ex-terminal-nav-status${item.binding?.online ? ' is-online' : ''}`}>{item.binding ? item.binding.online ? '镜端在线' : '镜端离线' : '镜端未绑定'}</small></span></button>)}</div>
        <button className="ex-add-mirror" onClick={() => setModal('create')}><Plus size={17} />新增设备</button>
        {registry.error && <p className="ex-mirror-list-error" role="status">设备列表连接中断</p>}
      </nav>
      <div className="ex-console-main">
        <header className="ex-mirror-heading"><div className="ex-mirror-name"><h1>{mirror.name}</h1><button className="ex-icon-button" aria-label="修改设备名称" onClick={() => setModal('rename')}><Pencil size={16} /></button></div><div className="ex-mirror-actions"><button className="ex-button" disabled={disabled || !configurable || !!state.live || (registry.data?.mirrors.length ?? 0) < 2} title={(registry.data?.mirrors.length ?? 0) < 2 ? '新增另一台设备后可复制数据' : !configurable || state.live ? '结束体验并停止实时会话后可复制' : undefined} onClick={() => { controller.clearError(); setModal('copy'); }}><Copy size={16} />复制数据</button><a className="ex-button ex-primary" href={exhibitionCameraUrl(mirror.id)} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开大屏</a></div></header>
        <div className="ex-mirror-tabs" role="tablist" aria-label="设备功能">{([{ id: 'live', label: '控制与设置', icon: Settings }, { id: 'looks', label: '素材管理', icon: Image }] as const).map(item => <button key={item.id} id={`mirror-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls="mirror-tab-panel" tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'live' : event.key === 'End' ? 'looks' : tab === 'live' ? 'looks' : 'live'; setTab(next); document.getElementById(`mirror-tab-${next}`)?.focus(); } }}><item.icon size={17} />{item.label}</button>)}</div>
        <div id="mirror-tab-panel" className="ex-mirror-tab-panel" role="tabpanel" aria-labelledby={`mirror-tab-${tab}`}>
          {tab === 'looks' ? <WardrobePanel key={mirror.id} controller={controller} /> : <>
            <div className="ex-live-layout"><div className="ex-preview-column">{preview}
              <div className="ex-command-area ex-preview-command-area" role="toolbar" aria-label="镜端操作">
                <button className="ex-button ex-primary ex-wide" aria-label={pending ? '正在同步…' : primary.label} title={pending ? '正在同步…' : primary.label} onClick={() => void send({ action: primary.action })} disabled={disabled || (!locallyEnded && (!look || state.phase === 'generating' || state.phase === 'showcase' || (!!state.live && ['idle', 'select', 'paused'].includes(state.phase))))}>{locallyEnded ? <RotateCcw size={14} /> : <Play size={14} fill="currentColor" />}<span>{pending ? '正在同步…' : primary.label}</span></button>
                <div className="ex-secondary-commands"><button className="ex-button" aria-label="上一份" title="上一份" onClick={() => navigate('previous')} disabled={disabled || !canNavigate}><SkipBack size={14} /><span className="ex-preview-step-label">上一份</span></button><button className="ex-button" aria-label="下一份" title="下一份" onClick={() => navigate('next')} disabled={disabled || !canNavigate}><SkipForward size={14} /><span className="ex-preview-step-label">下一份</span></button><button className="ex-button" aria-label={controller.stopPending ? '正在停止…' : '停止生成'} title={controller.stopPending ? '正在停止…' : '停止生成'} onClick={() => { if (!controller.stopPending && canStop) void controller.stopExperience(); }} disabled={!!controller.stopPending || !canStop}><Square size={12} fill="currentColor" /><span>{controller.stopPending ? '正在停止…' : '停止生成'}</span></button></div>
              </div>
            </div>
              <div className="ex-operations">
                <div className="ex-real-control-heading"><Monitor size={15} />真机控制</div>
                <div className="ex-experience-setting"><ExperienceModeChips label="当前体验模式" value={state.experienceMode} disabled={disabled || !configurable} onChange={experienceMode => { if (experienceMode !== state.experienceMode) void send({ action: 'configure', experienceMode }); }} /></div>
                <OutfitSwitchSettings controller={controller} />
                {!look && <p className="ex-no-mode-material" role="status">请在素材管理中为 {experienceModeLabel(state.experienceMode)} 上传并启用素材后再开始体验。</p>}
                <MirrorDeviceBinding key={mirror.id} mirror={mirror} controller={controller} registry={registry} />
                <DeviceSettings controller={controller} live={live} mirrorId={mirror.id} />
                <details className="ex-device-log"><summary><span>最近操作</span><strong>{state.logs[0]?.message ?? '等待开始体验'}</strong></summary><ol>{state.logs.map(log => <li key={log.id}><time>{new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{log.message}</span></li>)}</ol></details>
              </div>
            </div>
          </>}
        </div>
      </div>
    </div>
    <footer className="ex-console-footer"><span className={connected ? 'ex-connected' : 'ex-disconnected'}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}{connected ? '状态同步已连接' : '状态同步已断开'}</span><span>{mirror.name}</span><span className="ex-footer-brand">OpenBuy.AI · 发现更好的自己</span></footer>
    {(modal === 'create' || modal === 'rename') && <MirrorNameDialog mirror={modal === 'rename' ? mirror : undefined} registry={registry} close={() => setModal(null)} created={selectMirror} />}
    {modal === 'copy' && <CopyDialog mirror={mirror} registry={registry} controller={controller} close={() => setModal(null)} />}
  </section>;
}
