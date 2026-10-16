import { CheckCircle2, CircleAlert, LoaderCircle, RotateCw } from 'lucide-react';
import type { ReferencePreparationStatus } from '../../shared/referencePreparation';
import './referencePreparation.css';

export function ReferencePreparationBadge({ name, status, unavailable, retrying, retryError, now, onRetry }: {
  name: string; status?: ReferencePreparationStatus; unavailable: boolean; retrying: boolean; retryError?: string; now: number; onRetry: () => void;
}) {
  const ready = status?.state === 'ready' || status?.state === 'not_required';
  const updating = status?.refreshState === 'preparing';
  const failedUpdate = status?.refreshState === 'failed';
  const failed = ['failed', 'unconfigured'].includes(status?.state ?? '');
  const label = ready ? `可用${updating ? ' · 更新处理中' : failedUpdate ? ' · 更新失败' : ''}` : failed || unavailable ? '需处理' : '处理中';
  const seconds = Math.max(0, Math.ceil(((status?.retryAt ?? 0) - now) / 1000));
  const busy = retrying || updating || status?.state === 'preparing';
  const Icon = ready ? CheckCircle2 : failed || unavailable ? CircleAlert : LoaderCircle;
  return <div className={`ex-reference-preparation ex-reference-${ready ? 'ready' : failed || unavailable ? 'failed' : 'preparing'}`}>
    <div className="ex-reference-status-row"><span className="ex-reference-state" aria-label={`${name}：${label}`}><span className={!ready && !failed && !unavailable ? 'ex-reference-spinner' : undefined}><Icon size={13} aria-hidden="true" /></span>{label}</span>
      {(status?.state === 'failed' || failedUpdate) && <button type="button" className="ex-reference-retry" disabled={busy || seconds > 0} onClick={onRetry} aria-label={`重试${name}`}><RotateCw size={12} aria-hidden="true" />{retrying ? '提交中' : seconds > 0 ? `${seconds}秒后重试` : '重试'}</button>}
    </div>
    {(failed || failedUpdate) && status?.message && <p className="ex-reference-error">{status.message}</p>}
    {retryError && <p className="ex-reference-error" role="alert">{retryError}</p>}
  </div>;
}
