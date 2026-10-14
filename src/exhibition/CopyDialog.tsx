import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { EXHIBITION_FREE_PROMPT_MAX_LENGTH, type ExhibitionExperienceMode, type ExhibitionLook, type ExhibitionMirrorSummary } from '../../shared/exhibition';
import { appUrl } from '../versionScope';
import { ExperienceModeChips, experienceModeLabel } from './ExperienceModeChips';
import { useExhibition } from './useExhibition';
import type { MirrorRegistry } from './useMirrors';
import './copy-dialog.css';

type CopyDialogProps = {
  source: Pick<ExhibitionMirrorSummary, 'id' | 'name'>;
  registry: MirrorRegistry;
  look?: ExhibitionLook;
  close: () => void;
  copied: (targetId: string, message: string) => void;
};

/** Each destination owns its client and revision. Responses never replace the source controller. */
export function CopyDialog({ source, registry, look, close, copied }: CopyDialogProps) {
  const targets = (registry.data?.mirrors ?? []).filter(item => !!look || item.id !== source.id);
  const [targetId, setTargetId] = useState(() => targets.find(item => item.id !== source.id)?.id ?? targets[0]?.id ?? '');
  const [mode, setMode] = useState<ExhibitionExperienceMode>(look?.mode ?? 'clothx');
  const [prompt, setPrompt] = useState(look?.mode === 'free' ? look.prompt ?? '' : '');
  const [copyLooks, setCopyLooks] = useState(true);
  const [copySettings, setCopySettings] = useState(true);
  const [reload, setReload] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const focus = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (focus instanceof HTMLElement && focus.isConnected && !focus.matches(':disabled')) focus.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="ex-mirror-dialog ex-copy-dialog" aria-label={look ? '复制素材到' : '复制设备数据到'} onCancel={event => { event.preventDefault(); if (!inFlight.current) close(); }}>
    <CopyForm key={`${targetId}:${reload}`} source={source} registry={registry} look={look} close={close} copied={copied} targets={targets} targetId={targetId} setTargetId={setTargetId}
      mode={mode} setMode={setMode} prompt={prompt} setPrompt={setPrompt} copyLooks={copyLooks} setCopyLooks={setCopyLooks} copySettings={copySettings} setCopySettings={setCopySettings}
      inFlight={inFlight} refresh={() => setReload(value => value + 1)} />
  </dialog>;
}

type CopyFormProps = CopyDialogProps & {
  targets: ExhibitionMirrorSummary[]; targetId: string; setTargetId: (id: string) => void;
  mode: ExhibitionExperienceMode; setMode: (mode: ExhibitionExperienceMode) => void;
  prompt: string; setPrompt: (value: string) => void;
  copyLooks: boolean; setCopyLooks: (value: boolean) => void;
  copySettings: boolean; setCopySettings: (value: boolean) => void;
  inFlight: RefObject<boolean>; refresh: () => void;
};

function CopyForm({ source, registry, look, close, copied, targets, targetId, setTargetId, mode, setMode, prompt, setPrompt, copyLooks, setCopyLooks, copySettings, setCopySettings, inFlight, refresh }: CopyFormProps) {
  const controller = useExhibition(targetId);
  const [baseline, setBaseline] = useState<number>();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const select = useRef<HTMLSelectElement>(null);
  const target = targets.find(item => item.id === targetId);
  const { state, connected, pending } = controller;
  const revision = state?.revision;
  useEffect(() => { if (baseline === undefined && revision !== undefined) setBaseline(revision); }, [revision, baseline]);
  useEffect(() => {
    alive.current = true;
    select.current?.focus({ preventScroll: true });
    return () => { alive.current = false; };
  }, []);
  const busy = saving || pending;
  const stale = baseline !== undefined && !!state && baseline !== state.revision;
  const available = !!state && ['idle', 'select'].includes(state.phase) && !state.live;
  const valid = look ? (mode !== 'free' || !!prompt.trim()) && (look.referenceKind !== 'none' || mode === 'free') : copyLooks || copySettings;
  const blocked = !target ? '这台智能镜已被删除。' : state && !available ? '请先结束目标智能镜的体验，等待实时会话停止。' : '';
  const feedback = blocked || error || controller.error || (stale ? '目标数据已更新，请刷新后重试。' : '');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || busy || !target || !available || !connected || baseline === undefined || stale || !valid) return;
    if (!look && !confirming) { setConfirming(true); return; }
    inFlight.current = true; setSaving(true); setError('');
    try {
      const result = look
        ? await controller.copyLook({ sourceMirrorId: source.id, sourceLookId: look.id, mode, expectedRevision: baseline, ...(mode === 'free' ? { prompt: prompt.trim() } : {}) })
        : await controller.copyData({ sourceMirrorId: source.id, expectedRevision: baseline, copyLooks, copySettings });
      if (result && alive.current) {
        copied(target.id, `已复制到「${target.name}${look ? ` · ${experienceModeLabel(mode)}` : ''}」`);
        close(); void registry.refresh();
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '复制失败，请重试。');
    } finally { inFlight.current = false; if (alive.current) setSaving(false); }
  }
  return <form onSubmit={event => void submit(event)}>
    <header><h2>{confirming ? '确认替换并复制' : look ? '复制素材到…' : '复制到…'}</h2><button type="button" className="ex-icon-button" aria-label="关闭复制弹窗" disabled={busy} onClick={close}><X size={18} /></button></header>
    {look && <div className="ex-copy-material"><img src={appUrl(look.image)} alt={`${look.name}素材`} /><div><strong>{look.name}</strong><span>{source.name} · {experienceModeLabel(look.mode)}</span></div></div>}
    {confirming ? <>
      <div className="ex-copy-direction"><strong>{source.name}</strong><ArrowRight size={20} aria-label="复制到" /><strong>{target?.name ?? '设备已删除'}</strong></div>
      <div className="ex-copy-replace"><span>替换内容</span>{copyLooks && <strong>素材资料</strong>}{copySettings && <strong>设备设置</strong>}</div>
    </> : <>
      <label className="ex-mirror-field">目标智能镜<select ref={select} value={targetId} onChange={event => setTargetId(event.target.value)} disabled={busy} required>
        {!target && <option value={targetId} disabled>{targetId ? '设备已删除' : '暂无目标智能镜'}</option>}
        {targets.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === source.id ? '（当前）' : ''}</option>)}
      </select></label>
      {look ? <div className="ex-copy-material-fields">
        <ExperienceModeChips label="目标分组" value={mode} onChange={setMode} disabled={busy} allowedModes={look.referenceKind === 'none' ? ['free'] : undefined} />
        {mode === 'free' && <label className="ex-mirror-field">Free 提示词<textarea required maxLength={EXHIBITION_FREE_PROMPT_MAX_LENGTH} rows={4} value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} /></label>}
      </div> : <fieldset className="ex-copy-options" disabled={busy}><legend>替换内容</legend>
        <label><input type="checkbox" checked={copyLooks} onChange={event => setCopyLooks(event.target.checked)} /><strong>素材资料</strong></label>
        <label><input type="checkbox" checked={copySettings} onChange={event => setCopySettings(event.target.checked)} /><strong>设备设置</strong></label>
      </fieldset>}
    </>}
    {feedback ? <div className="ex-copy-feedback"><p className="ex-field-error" role="alert">{feedback}</p><button type="button" className="ex-reset-setting" disabled={busy} onClick={refresh}>刷新目标</button></div>
      : !state ? <p className="ex-copy-loading" role="status">正在读取目标…</p> : null}
    <footer><button type="button" className="ex-button" disabled={busy} onClick={() => confirming ? setConfirming(false) : close()}>{confirming ? '返回修改' : '取消'}</button><button className="ex-button ex-primary" disabled={busy || !target || !available || !connected || baseline === undefined || stale || !valid}>{busy ? '正在复制…' : confirming ? '确认替换并复制' : look ? '复制' : '下一步'}</button></footer>
  </form>;
}
