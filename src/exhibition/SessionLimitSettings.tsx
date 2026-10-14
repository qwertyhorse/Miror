import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, Timer } from 'lucide-react';
import { CONTINUOUS_MIN_EXPIRY_SECONDS, DEFAULT_CREDENTIAL_LIMITS, DEFAULT_SESSION_LIMITS, SESSION_CREDIT_MAX, SESSION_EXPIRY_MAX, isSessionLimits, resolveSessionLimits,
  type ExhibitionSessionLimits } from '../../shared/sessionLimits';
import type { ExhibitionController } from './useExhibition';
import './session-limit-settings.css';

interface Draft { unlimited: boolean; credits: string; expireSeconds: string; original: string; }
function makeDraft(limits: ExhibitionSessionLimits, original: string): Draft {
  return { unlimited: limits.credits === null, credits: String(limits.credits ?? DEFAULT_CREDENTIAL_LIMITS.credits),
    expireSeconds: String(limits.expireSeconds), original };
}
const numberValue = (value: string) => value.trim() === '' ? NaN : Number(value);

export function SessionLimitSettings({ controller }: { controller: ExhibitionController }) {
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
  const current = resolveSessionLimits(state.settings.sessionLimits);
  const currentKey = JSON.stringify(current);
  const displayed = draft ?? makeDraft(current, currentKey);
  const candidate = { credits: displayed.unlimited ? null : numberValue(displayed.credits), expireSeconds: numberValue(displayed.expireSeconds) };
  const valid = isSessionLimits(candidate);
  const minimumExpiry = displayed.unlimited ? CONTINUOUS_MIN_EXPIRY_SECONDS : 1;
  const expiryLabel = displayed.unlimited ? '每段有效期（秒）' : '凭证有效期（秒）';
  const invalidCredits = candidate.credits !== null && (!Number.isSafeInteger(candidate.credits)
    || candidate.credits < 1 || candidate.credits > SESSION_CREDIT_MAX);
  const rangeError = invalidCredits ? `积分额度须为 1–${SESSION_CREDIT_MAX.toLocaleString('zh-CN')} 的整数。`
    : `${displayed.unlimited ? '每段有效期' : '凭证有效期'}须为 ${minimumExpiry}–${SESSION_EXPIRY_MAX.toLocaleString('zh-CN')} 秒的整数。`;
  const stale = !!draft && draft.original !== currentKey;
  const changed = !!draft && (!valid || JSON.stringify(candidate) !== currentKey);
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
      const saved = await send({ action: 'configure', sessionLimits: candidate, expectedRevision: state.revision });
      if (alive.current) {
        if (saved) { setDraft(null); setMessage('已保存'); }
        else setError('会话额度未保存，请重试。');
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '会话额度未保存，请重试。');
    } finally { inFlight.current = false; if (alive.current) setSaving(false); }
  }
  return <form className="ex-session-limits" aria-label="会话额度设置" onSubmit={event => void save(event)}>
    <div className="ex-session-limit-heading"><Timer size={16} aria-hidden="true" /><h4>会话额度</h4></div>
    <fieldset className="ex-session-limit-choices" disabled={disabled} aria-describedby={displayed.unlimited ? `${id}-unlimited-note` : undefined}>
      <legend>单次积分上限</legend>
      <label><input type="radio" name={`${id}-credit-mode`} value="unlimited" checked={displayed.unlimited} onChange={() => edit(value => ({ ...value, unlimited: true }))} /><span>无限制（自动续接）</span></label>
      <label><input type="radio" name={`${id}-credit-mode`} value="limited" checked={!displayed.unlimited} onChange={() => edit(value => ({ ...value, unlimited: false }))} /><span>指定额度</span></label>
    </fieldset>
    <div className="ex-session-limit-grid">
      {!displayed.unlimited && <label htmlFor={`${id}-credits`}><span>积分额度</span><input id={`${id}-credits`} name="credits" type="number" inputMode="numeric" min={1} max={SESSION_CREDIT_MAX} step={1} required value={displayed.credits} disabled={disabled} onChange={event => { const credits = event.target.value; edit(value => ({ ...value, credits })); }} /></label>}
      <label htmlFor={`${id}-expiry`}><span>{expiryLabel}</span><input id={`${id}-expiry`} name="expireSeconds" type="number" inputMode="numeric" min={minimumExpiry} max={SESSION_EXPIRY_MAX} step={1} required value={displayed.expireSeconds} disabled={disabled} onChange={event => { const expireSeconds = event.target.value; edit(value => ({ ...value, expireSeconds })); }} /></label>
    </div>
    {displayed.unlimited && <p id={`${id}-unlimited-note`} className="ex-session-limit-note">每段使用独立临时凭证，到期自动续接；可随时结束体验。续接可能短暂停顿，仍受所选服务的余额限制。</p>}
    <div className="ex-session-limit-actions">
      <button className="ex-button ex-primary" type="submit" disabled={disabled || !valid || stale || !changed}>{saving ? '保存中…' : '保存会话额度'}</button>
      <button className="ex-button" type="button" disabled={disabled} onClick={() => edit(() => makeDraft(DEFAULT_SESSION_LIMITS, currentKey))}>恢复默认</button>
      {draft && <button className="ex-reset-setting" type="button" disabled={disabled} onClick={() => { if (disabled || inFlight.current) return; setDraft(null); setMessage(''); setError(''); controller.clearError(); }}>取消修改</button>}
      {message && <span className="ex-session-limit-saved" role="status"><Check size={13} aria-hidden="true" />{message}</span>}
    </div>
    {stale ? <p className="ex-field-error" role="alert">会话额度已在其他页面更新，请取消修改后重试。</p>
      : changed && !valid ? <p className="ex-field-error" role="alert">{rangeError}</p> : null}
    {error && <p className="ex-field-error" role="alert">{controller.error || error}</p>}
    {!connected && <p className="ex-field-error" role="status">连接已断开</p>}
  </form>;
}
