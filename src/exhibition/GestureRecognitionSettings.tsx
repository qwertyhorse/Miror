import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, Hand } from 'lucide-react';
import { isExhibitionGestureSettings, resolveExhibitionGestureSettings, type ExhibitionGestureKind, type ExhibitionGestureSettings } from '../../shared/exhibitionGestures';
import type { ExhibitionController } from './useExhibition';
import { CustomSelect } from '../components/SelectionControls';
import './gesture-settings.css';

type NumericField = Exclude<keyof ExhibitionGestureSettings, 'gestures' | 'inputLongEdge'>;
const fields: { key: NumericField; label: string; min: number; max: number; step: number }[] = [
  { key: 'minHandDetectionConfidence', label: '手部检测置信度', min: 0.1, max: 0.9, step: 0.01 },
  { key: 'minHandPresenceConfidence', label: '手部存在置信度', min: 0.1, max: 0.9, step: 0.01 },
  { key: 'minTrackingConfidence', label: '框跟踪阈值（IoU）', min: 0.1, max: 0.9, step: 0.01 },
  { key: 'palmConfirmMs', label: '手掌确认时长（毫秒）', min: 150, max: 1000, step: 1 },
  { key: 'palmReleaseMs', label: '收手间隔（毫秒）', min: 300, max: 1500, step: 1 },
  { key: 'maxFps', label: '识别帧率上限（FPS）', min: 5, max: 30, step: 1 },
];
const choices: { value: ExhibitionGestureKind; label: string }[] = [
  { value: 'open_palm', label: '手掌识别' }, { value: 'wave', label: '左右挥手' },
];
type Draft = { gestures: ExhibitionGestureKind[]; values: Record<NumericField, string>; inputLongEdge: string; original: string };
function makeDraft(settings: ExhibitionGestureSettings, original: string): Draft {
  return { gestures: [...settings.gestures], values: Object.fromEntries(fields.map(field => [field.key, String(settings[field.key])])) as Draft['values'], inputLongEdge: String(settings.inputLongEdge), original };
}

export function GestureRecognitionSettings({ controller }: { controller: ExhibitionController }) {
  const { state, pending, connected, send } = controller;
  const id = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!state) return null;
  const current = resolveExhibitionGestureSettings(state.settings.gestureRecognition);
  const currentKey = JSON.stringify(current);
  const displayed = draft ?? makeDraft(current, currentKey);
  const candidate = { gestures: displayed.gestures, ...Object.fromEntries(fields.map(field => [field.key, displayed.values[field.key].trim() === '' ? NaN : Number(displayed.values[field.key])])), inputLongEdge: Number(displayed.inputLongEdge) };
  const valid = isExhibitionGestureSettings(candidate);
  const stale = !!draft && draft.original !== currentKey;
  const changed = !!draft && (!valid || JSON.stringify(resolveExhibitionGestureSettings(candidate)) !== currentKey);
  const configurable = ['idle', 'select'].includes(state.phase) && !state.live;
  const disabled = pending || controller.stopPending || saving || !connected || !configurable;
  function edit(change: (value: Draft) => Draft) {
    if (disabled || inFlight.current) return;
    setDraft(previous => change(previous ?? makeDraft(current, currentKey)));
    setMessage(''); setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!state || disabled || inFlight.current || !valid || stale || !changed) return;
    inFlight.current = true; setSaving(true); setMessage(''); setError('');
    try {
      const saved = await send({ action: 'configure', gestureRecognition: resolveExhibitionGestureSettings(candidate), expectedRevision: state.revision });
      if (alive.current) {
        if (saved) { setDraft(null); setMessage('已保存'); }
        else setError('识别设置未保存，请重试。');
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '识别设置未保存，请重试。');
    } finally { inFlight.current = false; if (alive.current) setSaving(false); }
  }
  return <form className="ex-gesture-settings" aria-label="手势识别设置" onSubmit={event => void save(event)}>
    <div className="ex-gesture-heading"><Hand size={16} aria-hidden="true" /><h4>手势识别</h4>{!displayed.gestures.length && <span>已关闭</span>}</div>
    <fieldset className="ex-gesture-choices" disabled={disabled}>
      <legend className="ex-gesture-sr">识别手势</legend>
      {choices.map(choice => <label key={choice.value}><input type="checkbox" checked={displayed.gestures.includes(choice.value)} onChange={event => { const checked = event.target.checked; edit(value => ({ ...value, gestures: choices.filter(item => item.value === choice.value ? checked : value.gestures.includes(item.value)).map(item => item.value) })); }} /><span>{choice.label}</span></label>)}
    </fieldset>
    <details className="ex-gesture-parameters"><summary>识别参数</summary>
      <div className="ex-gesture-parameter-grid">{fields.map(field => <label key={field.key} htmlFor={`${id}-${field.key}`}><span>{field.label}</span><input id={`${id}-${field.key}`} name={field.key} type="number" inputMode="decimal" required min={field.min} max={field.max} step={field.step} value={displayed.values[field.key]} disabled={disabled} onChange={event => { const input = event.target.value; edit(value => ({ ...value, values: { ...value.values, [field.key]: input } })); }} /></label>)}
        <div className="ex-gesture-resolution"><span>识别分辨率（长边）</span><CustomSelect label="识别分辨率（长边）" value={displayed.inputLongEdge} disabled={disabled} options={[480, 720, 960].map(size => ({ value: String(size), label: `${size} px` }))} onChange={inputLongEdge => edit(value => ({ ...value, inputLongEdge }))} /></div>
      </div>
    </details>
    <div className="ex-gesture-settings-actions">
      <button className="ex-button ex-primary" type="submit" disabled={disabled || !valid || stale || !changed}>{saving ? '保存中…' : '保存识别设置'}</button>
      <button className="ex-button" type="button" disabled={disabled} onClick={() => edit(() => makeDraft(resolveExhibitionGestureSettings(), currentKey))}>恢复默认</button>
      {draft && <button className="ex-reset-setting" type="button" disabled={disabled} onClick={() => { if (disabled || inFlight.current) return; setDraft(null); setMessage(''); setError(''); controller.clearError(); }}>取消修改</button>}
      {message && <span className="ex-gesture-saved" role="status"><Check size={13} aria-hidden="true" />{message}</span>}
    </div>
    {stale ? <p className="ex-field-error" role="alert">识别设置已在其他页面更新，请取消修改后重试。</p>
      : changed && !valid ? <p className="ex-field-error" role="alert">参数超出范围，请检查输入。</p> : null}
    {error && <p className="ex-field-error" role="alert">{controller.error || error}</p>}
    {!connected && <p className="ex-field-error" role="status">连接已断开</p>}
  </form>;
}
