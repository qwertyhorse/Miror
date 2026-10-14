import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, RefreshCw, ExternalLink } from 'lucide-react';
import { appUrl } from '../versionScope';
import { exhibitionUrl } from './mirrorApi';
import type { ExhibitionLiveController } from './useExhibitionLive';
import './live-camera.css';

/** Owns only the element binding, never the underlying capture or SDK tracks. */
export function attachExhibitionStream(video: HTMLVideoElement, stream: MediaStream | null, onFrame: (stream: MediaStream) => void, onPlayBlocked: () => void) {
  let disposed = false;
  let reported = false;
  let frameId: number | undefined;
  const report = () => {
    if (disposed || reported || !stream || video.srcObject !== stream || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    reported = true; onFrame(stream);
  };
  video.srcObject = stream;
  if (stream) {
    // Custom SDK rendering needs our own decoded-frame signal. loadeddata also supports older WebViews.
    video.addEventListener('loadeddata', report);
    if (typeof video.requestVideoFrameCallback === 'function') frameId = video.requestVideoFrameCallback(report);
    void video.play().catch(() => { if (!disposed) onPlayBlocked(); });
  }
  return () => {
    disposed = true;
    if (frameId !== undefined) video.cancelVideoFrameCallback(frameId);
    video.removeEventListener('loadeddata', report);
    video.pause(); video.srcObject = null;
  };
}

/** Local video never reports a generated frame. Pass onFirstFrame only for XMAX output. */
export function StreamVideo({ stream, mirrored = false, className = '', label = '摄像头本地预览', onFirstFrame }: {
  stream: MediaStream | null; mirrored?: boolean; className?: string; label?: string; onFirstFrame?: (stream: MediaStream) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const frameCallback = useRef(onFirstFrame);
  frameCallback.current = onFirstFrame;
  const [needsPlay, setNeedsPlay] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setNeedsPlay(false);
    return attachExhibitionStream(video, stream, boundStream => frameCallback.current?.(boundStream), () => setNeedsPlay(true));
  }, [stream]);
  return <div className={`ex-stream-video ${className}`}>
    <video ref={ref} autoPlay muted playsInline aria-label={label} style={{ transform: mirrored ? 'scaleX(-1)' : undefined }} />
    {needsPlay && <button type="button" className="ex-video-play" onClick={() => void ref.current?.play().then(() => setNeedsPlay(false)).catch(() => setNeedsPlay(true))}>点击播放画面</button>}
  </div>;
}

const statusLabel: Record<ExhibitionLiveController['status'], string> = {
  off: '摄像头未开启', opening: '等待摄像头权限', preview: '本地预览已开启', preparing: '正在准备服装素材',
  connecting: '正在连接换装服务', running: '实时换装中', stopping: '正在停止换装', error: '需要检查连接', 'other-device': '另一台大屏正在体验',
};
export function LiveCameraPanel({ live, compact = false, mirrorId = 'default' }: { live: ExhibitionLiveController; compact?: boolean; mirrorId?: string }) {
  const cameraHost = window.location.hostname;
  const cameraUrl = `https://${cameraHost}:10202${exhibitionUrl('/exhibition/screen', mirrorId)}`;
  const ownsGeneration = ['preparing', 'connecting', 'running', 'stopping'].includes(live.status);
  return <section className={`ex-camera-panel${compact ? ' ex-camera-panel-compact' : ''}`} aria-label="摄像头设置">
    <div className="ex-camera-panel-heading"><Camera size={19} /><strong>摄像头与实时换装</strong><span role="status">{statusLabel[live.status]}</span></div>
    {!live.secure ? <div className="ex-camera-note">
      <p>这个 HTTP 页面可以选衣和控制大屏；浏览器调用摄像头需要可信的 HTTPS 连接。</p>
      <a className="ex-camera-link" href={appUrl('/openbuy-local-ca.crt')} download="OpenBuy-Local-CA.crt">下载局域网证书 <ExternalLink size={14} /></a>
      <a className="ex-camera-link" href={cameraUrl} target="_blank" rel="noreferrer">打开摄像头专用入口 <ExternalLink size={14} /></a>
      <small>首次使用：先在设备设置中安装并信任局域网证书，再打开摄像头入口。进入后点击“开启摄像头”，允许权限，并选择外接摄像头。</small>
    </div> : <>
      <p className="ex-camera-disclosure">开启后先在本机预览；选择 XMAX 模式并开始体验后，摄像头画面和服装素材会发送给 XMAX 进行换装。只采集视频，不采集声音。</p>
      <div className="ex-camera-controls">
        {live.cameraStream ? <button type="button" className="ex-camera-button" onClick={live.stopCamera}><CameraOff size={17} />关闭摄像头{ownsGeneration ? '并停止' : ''}</button>
          : <button type="button" className="ex-camera-button ex-camera-primary" disabled={live.opening || live.status === 'other-device'} onClick={() => void live.startCamera()}><Camera size={17} />{live.opening ? '等待授权…' : '开启摄像头'}</button>}
        {live.opening && <button type="button" className="ex-camera-button" onClick={live.stopCamera}>取消等待</button>}
        {live.cameras.length > 0 && <label className="ex-camera-select">摄像头<select value={live.selectedCameraId} disabled={live.opening || ownsGeneration} onChange={event => void live.startCamera(event.target.value)}>
          {live.cameras.map((camera, index) => <option key={camera.deviceId || index} value={camera.deviceId}>{camera.label || `摄像头 ${index + 1}`}</option>)}
        </select></label>}
        <label className="ex-camera-mirror"><input type="checkbox" checked={live.mirrored} onChange={event => live.setMirrored(event.target.checked)} />镜像显示</label>
      </div>
      {live.cameraStream && !ownsGeneration && <small>当前仅本地预览。选好服装后，用户点击开始即可自动换装。</small>}
    </>}
    {live.error && <div className="ex-camera-error" role="alert"><span>{live.error}</span>{live.secure && !live.opening && !ownsGeneration && <button type="button" onClick={live.retry}><RefreshCw size={14} />重新检查摄像头</button>}</div>}
  </section>;
}
