import { useEffect, useRef, useState, type RefObject } from 'react';

interface RegionTrack extends MediaStreamTrack { cropTo?(target: unknown): Promise<void> }
interface RegionWindow extends Window { CropTarget?: { fromElement(element: Element): Promise<unknown> } }

/** Captures only this page's complete kiosk. Camera and cloud tracks remain borrowed. */
export function useWirelessPresentation(enabled: boolean, target: RefObject<HTMLDivElement | null>, onStop: () => Promise<boolean>) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [needsStop, setNeedsStop] = useState(false);
  const [message, setMessage] = useState('');
  const current = useRef<MediaStream | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);
  const selecting = useRef(false);
  const mustStop = useRef(false);
  const stopRequest = useRef<Promise<void> | null>(null);
  const stopAction = useRef(onStop); stopAction.current = onStop;
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
    && !!(window as RegionWindow).CropTarget?.fromElement;
  const release = () => { current.current?.getTracks().forEach(track => track.stop()); current.current = null; };

  const stop = (feedback = '投屏已停止') => {
    ++revision.current; selecting.current = false; release();
    if (!mounted.current) return Promise.resolve();
    setStream(null); setBusy(false); setMessage(feedback);
    mustStop.current = true; setNeedsStop(true);
    if (stopRequest.current) return stopRequest.current;
    setStopping(true);
    const request = Promise.resolve().then(() => stopAction.current()).catch(() => false).then(confirmed => {
      if (!mounted.current) return;
      mustStop.current = !confirmed; setNeedsStop(!confirmed);
      if (!confirmed) setMessage('停止未确认，请重试。');
    }).finally(() => {
      stopRequest.current = null;
      if (mounted.current) setStopping(false);
    });
    stopRequest.current = request;
    return request;
  };
  const latestStop = useRef(stop); latestStop.current = stop;

  useEffect(() => {
    mounted.current = enabled;
    const leave = () => { ++revision.current; selecting.current = false; release(); };
    if (enabled) window.addEventListener('pagehide', leave);
    return () => { mounted.current = false; leave(); window.removeEventListener('pagehide', leave); };
  }, [enabled]);

  const start = async () => {
    if (!enabled || !mounted.current || selecting.current || current.current || mustStop.current) return;
    if (!supported || !target.current) { setMessage('请使用新版 Chrome 打开无线投屏。'); return; }
    const id = ++revision.current;
    selecting.current = true; setBusy(true); setMessage('');
    let captured: MediaStream | null = null;
    try {
      // Invoke directly in the click handler; awaiting another operation first can
      // consume Chrome's transient user activation and suppress the picker.
      captured = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: { ideal: 30, max: 30 } }, audio: false,
        preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude',
      } as DisplayMediaStreamOptions);
      const active = () => mounted.current && revision.current === id;
      if (!active()) return;
      const track = captured.getVideoTracks()[0] as RegionTrack | undefined;
      if (!track?.cropTo || track.getSettings().displaySurface !== 'browser') throw new Error('请在共享窗口选择当前试衣标签页。');
      const crop = await (window as RegionWindow).CropTarget!.fromElement(target.current!);
      if (!active()) return;
      try { await track.cropTo(crop); }
      catch { throw new Error('请在共享窗口选择当前试衣标签页。'); }
      if (!active() || track.readyState !== 'live') return;
      // Static posters otherwise enter Chrome's sparse screen-capture cadence.
      // Keep hardware decoders fed before the first camera/generation animation.
      track.contentHint = 'motion';
      await track.applyConstraints({ frameRate: { min: 15, ideal: 30, max: 30 } });
      if (!active() || track.readyState !== 'live') return;
      current.current = captured;
      track.addEventListener('ended', () => { if (current.current === captured) void latestStop.current('共享已结束'); }, { once: true });
      // Once cropTo resolves, no full desktop or unrelated tab frame can be sent.
      setStream(captured); setMessage('');
    } catch (error) {
      if (mounted.current && revision.current === id) {
        const denied = error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name);
        setMessage(denied ? '未开始共享，请重试并允许屏幕录制。' : error instanceof Error ? error.message : '投屏未启动，请重试。');
      }
    } finally {
      if (captured !== current.current) captured?.getTracks().forEach(track => track.stop());
      if (mounted.current && revision.current === id) { selecting.current = false; setBusy(false); }
    }
  };
  return { stream, busy, stopping, needsStop, message, supported, ready: !!stream && !needsStop,
    start, stop, retryStop: () => stop('正在停止体验…') };
}
