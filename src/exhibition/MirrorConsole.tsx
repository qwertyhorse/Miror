import { exhibitionApiPath } from './mirrorApi';
import { appUrl } from '../versionScope';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, Monitor, Pencil, Play, Plus, RotateCcw, Settings, Image, SkipBack, SkipForward, Square, Trash2, Wifi, WifiOff, X } from 'lucide-react';
import { isExhibitionLocallyEnded, type ExhibitionMirrorSummary } from '../../shared/exhibition';
import type { ExhibitionController } from './useExhibition';
import type { ExhibitionLiveController } from './useExhibitionLive';
import type { MirrorRegistry } from './useMirrors';
import { exhibitionUrl } from './mirrorApi';
import { exhibitionBrowserTestUrl, exhibitionCameraUrl } from './cameraEntry';
import { enabledLooksForMode, phaseLabel } from './catalog';
import { ExperienceModeChips, experienceModeLabel } from './ExperienceModeChips';
import { WardrobePanel } from './WardrobePanel';
import { CopyDialog } from './CopyDialog';
import { UploadLimitsSettings } from './UploadLimitsSettings';
import { MirrorDeviceBinding } from './MirrorDeviceBinding';
import { OutfitSwitchSettings } from './OutfitSwitchSettings';
import { MirrorUiSkinSettings } from './MirrorUiSkinSettings';
import { MirrorCredentialSettings } from './MirrorCredentialSettings';
import { GestureRecognitionSettings } from './GestureRecognitionSettings';
import { SessionLimitSettings } from './SessionLimitSettings';
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

function DeleteMirrorDialog({ mirror, registry, blockedReason, close, deleted }: {
  mirror: ExhibitionMirrorSummary; registry: MirrorRegistry; blockedReason: string;
  close: () => void; deleted: (defaultMirrorId: string) => void;
}) {
  const dialog = useModal();
  const alive = useRef(true);
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || blockedReason) return;
    inFlight.current = true; setSaving(true); setError('');
    try {
      const result = await registry.remove(mirror.id, mirror.revision);
      if (alive.current) { close(); deleted(result.defaultMirrorId); }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '删除失败，请重试。');
    } finally { inFlight.current = false; if (alive.current) setSaving(false); }
  }
  return <dialog ref={dialog} className="ex-mirror-dialog ex-delete-mirror-dialog" aria-labelledby="delete-mirror-title" aria-describedby="delete-mirror-description" onCancel={event => { event.preventDefault(); if (!saving) close(); }}>
    <form onSubmit={event => void remove(event)}>
      <header><h2 id="delete-mirror-title">删除「{mirror.name}」？</h2><button type="button" className="ex-icon-button" aria-label="关闭删除弹窗" disabled={saving} onClick={close}><X size={18} /></button></header>
      <p id="delete-mirror-description" className="ex-mirror-help">将从设备列表移除，并解除镜端绑定。</p>
      {(blockedReason || error) && <p className="ex-field-error" role="alert">{blockedReason || error}</p>}
      <footer><button type="button" className="ex-button" autoFocus disabled={saving} onClick={close}>取消</button><button className="ex-button ex-mirror-delete-confirm" disabled={saving || !!blockedReason}>{saving ? '正在删除…' : '删除智能镜'}</button></footer>
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
      <div className="ex-device-setting"><span className="ex-device-setting-label">素材栏列数</span><CustomSelect className="ex-device-select" label="素材栏列数" value={String(state!.settings.materialDrawerColumns ?? 2)} disabled={disabled} onChange={value => {
        if (disabled || (value !== '1' && value !== '2') || Number(value) === (state!.settings.materialDrawerColumns ?? 2)) return;
        void send({ action: 'configure', materialDrawerColumns: value === '1' ? 1 : 2, expectedRevision: state!.revision });
      }} options={[{ value: '1', label: '一列' }, { value: '2', label: '两列' }]} /></div>
    </div>
    <GestureRecognitionSettings key={`gestures-${mirrorId}`} controller={controller} />
    <MirrorCredentialSettings key={`credentials-${mirrorId}`} controller={controller} live={live} />
    <SessionLimitSettings key={`session-limits-${mirrorId}`} controller={controller} />
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
  const [copyNotice, setCopyNotice] = useState('');
  const [deletingMirror, setDeletingMirror] = useState<ExhibitionMirrorSummary | null>(null);
  if (!state) return null;
  const configurable = ['select', 'idle'].includes(state.phase) && !state.live;
  const realtime = state.providerMode === 'xmax';
  const locallyEnded = isExhibitionLocallyEnded(state);
  const enabledLooks = enabledLooksForMode(state);
  const look = enabledLooks.find(item => item.id === state.selectedLookId);
  const disabled = pending || controller.stopPending || !connected;
  const canStop = pending || (!!state.live && !locallyEnded) || !['idle', 'select'].includes(state.phase);
  const canNavigate = !!look && enabledLooks.length > 1 && (configurable || state.phase === 'showcase');
  const latestDeletingMirror = registry.data?.mirrors.find(item => item.id === deletingMirror?.id);
  const deletePhase = deletingMirror?.id === mirror.id ? state.phase : latestDeletingMirror?.phase;
  const deleteBlockedReason = !latestDeletingMirror ? '这台智能镜已被删除。'
    : !['idle', 'select'].includes(deletePhase ?? '') || (deletingMirror?.id === mirror.id && !!state.live)
      ? '请先停止生成，待云端会话结束后再删除。' : '';
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
        <div className="ex-mirror-list">{registry.data?.mirrors.map(item => <div key={item.id} className={`ex-mirror-list-item${mirror.id === item.id ? ' is-active' : ''}${item.id !== registry.data?.defaultMirrorId ? ' is-removable' : ''}`}>
          <button className="ex-mirror-select" aria-current={mirror.id === item.id ? 'page' : undefined} onClick={() => selectMirror(item.id)}><Monitor size={19} /><span><strong>{item.name}</strong><small><i className={`ex-mirror-status ex-mirror-status-${item.id === mirror.id ? state.phase : item.phase}`} />{phaseLabel[item.id === mirror.id ? state.phase : item.phase]}</small><small className={`ex-terminal-nav-status${item.binding?.online ? ' is-online' : ''}`}>{item.binding ? item.binding.online ? '镜端在线' : '镜端离线' : '镜端未绑定'}</small></span></button>
          {item.id !== registry.data?.defaultMirrorId && <button className="ex-mirror-delete" type="button" aria-label={`删除${item.name}`} title="删除智能镜" onClick={() => setDeletingMirror({ ...item, revision: item.id === mirror.id ? state.revision : item.revision })}><Trash2 size={15} /></button>}
        </div>)}</div>
        <button className="ex-add-mirror" onClick={() => setModal('create')}><Plus size={17} />新增设备</button>
        {registry.error && <p className="ex-mirror-list-error" role="status">设备列表连接中断</p>}
      </nav>
      <div className="ex-console-main">
        <header className="ex-mirror-heading"><div className="ex-mirror-name"><h1>{mirror.name}</h1><button className="ex-icon-button" aria-label="修改设备名称" onClick={() => setModal('rename')}><Pencil size={16} /></button></div><div className="ex-mirror-actions"><a className="ex-button" href={exhibitionBrowserTestUrl(mirror.id)} target="_blank" rel="noreferrer"><Monitor size={16} />浏览器测试</a><button className="ex-button" disabled={!connected || (registry.data?.mirrors.length ?? 0) < 2} title={(registry.data?.mirrors.length ?? 0) < 2 ? '新增另一台设备后可复制数据' : undefined} onClick={() => { setCopyNotice(''); setModal('copy'); }}><Copy size={16} />复制到…</button><a className="ex-button ex-primary" href={exhibitionCameraUrl(mirror.id)} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开大屏</a></div></header>
        {copyNotice && <p className="ex-library-notice" role="status"><Check size={16} />{copyNotice}</p>}
        <div className="ex-mirror-tabs" role="tablist" aria-label="设备功能">{([{ id: 'live', label: '控制与设置', icon: Settings }, { id: 'looks', label: '素材管理', icon: Image }] as const).map(item => <button key={item.id} id={`mirror-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls="mirror-tab-panel" tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'live' : event.key === 'End' ? 'looks' : tab === 'live' ? 'looks' : 'live'; setTab(next); document.getElementById(`mirror-tab-${next}`)?.focus(); } }}><item.icon size={17} />{item.label}</button>)}</div>
        <div id="mirror-tab-panel" className="ex-mirror-tab-panel" role="tabpanel" aria-labelledby={`mirror-tab-${tab}`}>
          {tab === 'looks' ? <WardrobePanel key={mirror.id} controller={controller} registry={registry} /> : <>
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
                {state.lifecycle?.connection === 'recovering' && <p role="status">正在恢复连接</p>}
                {state.lifecycle?.connection === 'needs_assistance' && <p role="status">请检查设备后继续体验</p>}
                <a className="ex-button" href={appUrl('/api' + exhibitionApiPath('diagnostics', mirror.id))} download={`miror-${mirror.id}-diagnostics.json`}>导出体验诊断</a>
                <details className="ex-device-log"><summary><span>最近操作</span><strong>{state.logs[0]?.message ?? '等待开始体验'}</strong></summary><ol>{state.logs.map(log => <li key={log.id}><time>{new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{log.message}</span></li>)}</ol></details>
              </div>
            </div>
          </>}
        </div>
      </div>
    </div>
    <footer className="ex-console-footer"><span className={connected ? 'ex-connected' : 'ex-disconnected'}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}{connected ? '状态同步已连接' : '状态同步已断开'}</span><span>{mirror.name}</span><span className="ex-footer-brand">OpenBuy.AI · 发现更好的自己</span></footer>
    {(modal === 'create' || modal === 'rename') && <MirrorNameDialog mirror={modal === 'rename' ? mirror : undefined} registry={registry} close={() => setModal(null)} created={selectMirror} />}
    {modal === 'copy' && <CopyDialog source={mirror} registry={registry} close={() => setModal(null)} copied={(_id, message) => setCopyNotice(message)} />}
    {deletingMirror && <DeleteMirrorDialog mirror={deletingMirror} registry={registry} blockedReason={deleteBlockedReason} close={() => setDeletingMirror(null)} deleted={defaultMirrorId => { if (deletingMirror.id === mirror.id) selectMirror(defaultMirrorId); }} />}
  </section>;
}
