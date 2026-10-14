import { useEffect, useRef, useState } from 'react';
import { Camera, Check, ChevronDown, LoaderCircle } from 'lucide-react';
import type { ExhibitionDeviceBinding } from '../../shared/exhibition';
import type { ExhibitionCameraStatus } from '../../shared/exhibitionCamera';
import { appUrl } from '../versionScope';
import './mirror-camera-settings.css';

const stateLabel: Record<ExhibitionCameraStatus['state'], string> = {
  unbound: '未绑定镜端', offline: '镜端离线', unsupported: '请更新镜端', idle: '尚未检测',
  requested: '等待镜端打开', expired: '检测请求已过期', ready: '检测完成', scanning: '正在检测',
  preview: '镜端预览中', error: '检测失败', 'permission-required': '请在镜端允许摄像头', busy: '镜端正在体验', closed: '检测已结束',
};

interface Props {
  mirrorId: string;
  binding: ExhibitionDeviceBinding;
  connected: boolean;
  editable: boolean;
  disabled?: boolean;
  refresh: () => Promise<void>;
}

export function MirrorCameraSettings(props: Props) {
  return <CameraSettings key={`${props.mirrorId}:${props.binding.terminalId}:${props.binding.boundAt}`} {...props} />;
}

function CameraSettings({ mirrorId, binding, connected, editable, disabled, refresh }: Props) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sentRequest, setSentRequest] = useState<{ id: string; expiresAt: number } | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const camera = binding.camera;
  const state = !binding.online ? 'offline' : !camera?.supported ? 'unsupported' : camera.state;
  const detecting = ['requested', 'scanning', 'ready', 'preview', 'permission-required'].includes(state) && !!camera?.request;
  const selected = camera?.devices.find(device => device.id === (camera.activeDeviceId ?? camera.selectedDeviceId));
  const available = connected && editable && binding.online && !!camera?.supported && !disabled && !detecting;
  const reason = !connected ? '后台连接中断' : !binding.online ? stateLabel.offline : !camera?.supported ? stateLabel.unsupported
    : !editable ? '停止体验后可检测' : stateLabel[state];
  const current = useRef({ available }); current.current = { available };

  useEffect(() => {
    generation.current++;
    return () => { generation.current++; request.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!sentRequest) return;
    const remaining = sentRequest.expiresAt - Date.now();
    if (camera?.request?.id === sentRequest.id || !binding.online || !camera?.supported || remaining <= 0) {
      setSentRequest(null); return;
    }
    // A failed registry refresh must not leave an invitation to an expired
    // terminal request visible indefinitely. Changing scope clears this timer.
    const timer = setTimeout(() => setSentRequest(previous => previous === sentRequest ? null : previous), remaining);
    return () => clearTimeout(timer);
  }, [sentRequest, camera?.request?.id, binding.online, camera?.supported]);

  async function open() {
    if (!current.current.available || request.current) return;
    const abort = new AbortController(); request.current = abort;
    const epoch = generation.current;
    const timer = setTimeout(() => abort.abort(), 10000);
    setSending(true); setError(''); setSentRequest(null);
    try {
      const response = await fetch(appUrl(`/api/exhibition/mirrors/${encodeURIComponent(mirrorId)}/camera`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: abort.signal,
        body: JSON.stringify({ terminalId: binding.terminalId, action: 'open' }),
      });
      const result = await response.json() as ExhibitionCameraStatus & { message?: string };
      if (epoch !== generation.current) return;
      if (abort.signal.aborted) throw new DOMException('Request timed out', 'AbortError');
      if (!response.ok) throw new Error(result.message ?? '检测请求未完成，请重试。');
      setSentRequest(result.request && Number.isFinite(result.request.expiresAt)
        ? { id: result.request.id, expiresAt: result.request.expiresAt } : null);
      await refresh();
    } catch (cause) {
      if (epoch === generation.current) setError(cause instanceof DOMException && cause.name === 'AbortError'
        ? '请求超时，请核对镜端状态后重试。' : cause instanceof Error ? cause.message : '检测请求未完成，请重试。');
    } finally {
      clearTimeout(timer);
      if (request.current === abort) request.current = null;
      if (epoch === generation.current) setSending(false);
    }
  }

  return <section className="ex-mirror-camera" aria-label="镜端摄像头">
    <div className="ex-mirror-camera-row">
      <Camera size={18} aria-hidden="true" />
      <div className="ex-mirror-camera-current"><strong>{selected?.label || '摄像头'}</strong><span>{reason}</span></div>
      <button type="button" className="ex-button" disabled={!available || sending} onClick={() => void open()}>
        {sending || detecting ? <LoaderCircle size={14} className="ex-camera-pending" aria-hidden="true" /> : <Camera size={14} aria-hidden="true" />}
        切换摄像头
      </button>
    </div>
    {camera?.devices.length ? <details className="ex-mirror-camera-devices"><summary><ChevronDown size={13} aria-hidden="true" />检测到 {camera.devices.length} 个摄像头</summary>
      <ul>{camera.devices.map(device => <li key={device.id}><span>{device.label}</span>{device.id === camera.selectedDeviceId ? <span className="ex-camera-selected"><Check size={12} aria-hidden="true" />已选择</span> : device.id === camera.activeDeviceId ? <span className="ex-camera-selected">使用中</span> : null}</li>)}</ul>
    </details> : null}
    {(detecting || (sentRequest && camera?.request?.id !== sentRequest.id)) && binding.online && <p className="ex-mirror-camera-notice" role="status">请在镜端选择并预览摄像头</p>}
    {(error || camera?.error) && <p className="ex-field-error" role="alert">{error || camera?.error}</p>}
  </section>;
}
