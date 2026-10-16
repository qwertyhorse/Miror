import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { EXHIBITION_AUTO_SWITCH_DEFAULT_SECONDS, EXHIBITION_AUTO_SWITCH_MIN_SECONDS, EXHIBITION_AUTO_SWITCH_MAX_SECONDS } from '../../shared/exhibition';
import { enabledLooksForMode } from './catalog';
import type { ExhibitionController } from './useExhibition';

/** Rotation settings remain available during an experience so staff can stop it. */
export function OutfitSwitchSettings({ controller }: { controller: ExhibitionController }) {
  const { state, send, pending, connected } = controller;
  const id = useId();
  const [draft, setDraft] = useState<{ value: string; original: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!state) return null;
  const mode = state.settings.switchMode ?? 'manual';
  const seconds = state.settings.autoSwitchSeconds ?? EXHIBITION_AUTO_SWITCH_DEFAULT_SECONDS;
  const value = draft?.value ?? String(seconds);
  const numeric = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(numeric) && numeric >= EXHIBITION_AUTO_SWITCH_MIN_SECONDS && numeric <= EXHIBITION_AUTO_SWITCH_MAX_SECONDS;
  const stale = !!draft && draft.original !== seconds;
  const disabled = pending || saving || !connected;
  const count = enabledLooksForMode(state).length;
  const hint = mode === 'manual' ? '由工作人员选择素材或点击上一份／下一份切换。'
    : count < 2 ? '当前模式至少有 2 份可用素材后才能自动换装。'
    : state.phase === 'paused' ? '体验已暂停，恢复后继续自动换装。'
    : `开始体验并显示生成结果后，每 ${seconds} 秒按素材顺序切换。`;

  async function configure(command: Parameters<ExhibitionController['send']>[0], success: string, clearDraft = false) {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setSaving(true); setMessage(''); setError('');
    try {
      const saved = await send(command);
      if (alive.current) {
        if (saved) { if (clearDraft) setDraft(null); setMessage(success); }
        else setError('设置未保存，请核对最新状态后重试。');
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '设置未保存，请重试。');
    } finally {
      inFlight.current = false;
      if (alive.current) setSaving(false);
    }
  }
  function saveInterval(event: FormEvent) {
    event.preventDefault();
    if (!state || !valid || stale || !draft) return;
    void configure({ action: 'configure', autoSwitchSeconds: numeric, expectedRevision: state.revision }, '切换间隔已保存', true);
  }
  return <div className="ex-outfit-switch-settings">
    <div className="ex-outfit-switch-row">
      <fieldset className="ex-switch-mode-choices" disabled={disabled}>
        <legend>换装方式</legend>
        <div className="ex-mode-chips">{(['manual', 'auto'] as const).map(option => <label key={option}>
          <input type="radio" name={`${id}-mode`} value={option} checked={mode === option} onChange={() => { if (option !== mode) void configure({ action: 'configure', switchMode: option }, option === 'auto' ? '已开启自动换装' : '已切换为手动换装'); }} />
          <span>{mode === option && <Check size={12} aria-hidden="true" />}{option === 'manual' ? '手动换装' : '自动换装'}</span>
        </label>)}</div>
      </fieldset>
      {mode === 'auto' && <form className="ex-auto-switch-form" onSubmit={saveInterval}>
        <label htmlFor={`${id}-seconds`}>切换间隔</label>
        <div className="ex-auto-switch-input-row"><input id={`${id}-seconds`} type="number" inputMode="numeric" required min={EXHIBITION_AUTO_SWITCH_MIN_SECONDS} max={EXHIBITION_AUTO_SWITCH_MAX_SECONDS} step={1} value={value} disabled={disabled} aria-describedby={`${id}-interval-note`} onChange={event => { setDraft(previous => ({ value: event.target.value, original: previous?.original ?? seconds })); setMessage(''); setError(''); }} /><span>秒</span>
          <button className="ex-button" disabled={disabled || !draft || !valid || stale}>{saving ? '保存中…' : '保存间隔'}</button>
        </div>
      </form>}
    </div>
    <p className="ex-outfit-switch-hint">{hint}{mode === 'auto' && <span id={`${id}-interval-note`}>可设 {EXHIBITION_AUTO_SWITCH_MIN_SECONDS}–{EXHIBITION_AUTO_SWITCH_MAX_SECONDS} 秒。</span>}</p>
    {mode === 'auto' && draft && <div className="ex-auto-switch-draft">{stale && <span role="status">间隔已在其他页面更新，请读取最新设置。</span>}{!stale && !valid && <span role="status">请输入 {EXHIBITION_AUTO_SWITCH_MIN_SECONDS}–{EXHIBITION_AUTO_SWITCH_MAX_SECONDS} 的整数秒。</span>}<button type="button" className="ex-reset-setting" disabled={disabled} onClick={() => { setDraft(null); setError(''); setMessage(''); controller.clearError(); }}>放弃修改，读取最新间隔</button></div>}
    {!connected && <p className="ex-outfit-switch-feedback" role="status">状态同步断开，恢复连接后可修改换装方式。</p>}
    {error && <p className="ex-field-error" role="alert">{controller.error || error}</p>}
    {message && <p className="ex-outfit-switch-feedback" role="status"><Check size={12} aria-hidden="true" />{message}</p>}
  </div>;
}
