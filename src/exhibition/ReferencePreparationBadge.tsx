import { CheckCircle2, CircleAlert, Clock3, LoaderCircle, RotateCw } from 'lucide-react';
import type { ReferencePreparationStatus } from '../../shared/referencePreparation';
import './referencePreparation.css';

const labels = { queued: '待准备', preparing: '准备中', ready: '已就绪', failed: '准备失败', unconfigured: '待配置', not_required: '无需准备' };

export function ReferencePreparationBadge({ name, status, unavailable, retrying, retryError, now, onRetry }: {
  name: string; status?: ReferencePreparationStatus; unavailable: boolean; retrying: boolean; retryError?: string; now: number; onRetry: () => void;
}) {
  const expired = status?.state === 'ready' && (status.freshUntil ?? 0) <= now;
  const state = unavailable ? 'unknown' : expired ? 'queued' : status?.state ?? 'loading';
  const label = state === 'unknown' ? '状态不可用' : state === 'loading' ? '查询中' : labels[state];
  const seconds = Math.max(0, Math.ceil(((status?.retryAt ?? 0) - now) / 1000));
  const busy = retrying || status?.refreshState === 'preparing' || state === 'preparing' || state === 'loading';
  const Icon = busy ? LoaderCircle : state === 'ready' ? CheckCircle2 : state === 'failed' || state === 'unknown' ? CircleAlert : Clock3;
  return <div className={`ex-reference-preparation ex-reference-${state}`}>
    <div className="ex-reference-status-row"><span className="ex-reference-state" aria-label={`${name}：${label}`}><span className={busy ? 'ex-reference-spinner' : undefined}><Icon size={13} aria-hidden="true" /></span>{label}</span>
      {(state === 'failed' || state === 'ready') && <button type="button" className="ex-reference-retry" disabled={busy || seconds > 0} onClick={onRetry} aria-label={`重新准备${name}`}><RotateCw size={12} aria-hidden="true" />{retrying ? '提交中' : seconds > 0 ? `${seconds}秒后重试` : state === 'ready' ? '重新上传' : '重试'}</button>}
    </div>
    {(state === 'failed' || status?.refreshState === 'failed') && status?.message && <p className="ex-reference-error">{status.message}</p>}
    {retryError && <p className="ex-reference-error" role="alert">{retryError}</p>}
  </div>;
}
