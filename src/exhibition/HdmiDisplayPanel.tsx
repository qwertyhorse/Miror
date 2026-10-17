import { Maximize2, Monitor, RefreshCw, X } from 'lucide-react';
import { hdmiScreenName, type HdmiPresentation } from './useHdmiPresentation';
import './hdmi-display.css';

export function HdmiDisplayPanel({ presentation: p }: { presentation: HdmiPresentation }) {
  return <>
    <button className="ex-fullscreen" type="button" aria-label="选择显示器" aria-expanded={p.open}
      onClick={() => p.setOpen(!p.open)}><Monitor size={18} /></button>
    {p.open && <section className="ex-hdmi-panel" aria-label="HDMI 大屏">
      <header><h2><Monitor size={20} />HDMI 大屏</h2><button type="button" className="ex-icon-button" aria-label="关闭选屏"
        onClick={() => p.setOpen(false)}><X size={18} /></button></header>
      <button className="ex-button ex-primary" type="button" disabled={p.busy || p.needsStop}
        onClick={() => void p.discover()}><RefreshCw size={16} />{p.busy ? '正在连接…' : p.screens.length ? '刷新显示器' : '选择显示器'}</button>
      {p.screens.length > 0 && <div className="ex-hdmi-screens">
        {p.screens.map((screen, index) => <button type="button" className="ex-hdmi-screen" key={index}
          disabled={p.busy || p.needsStop} onClick={() => void p.present(screen)}>
          <Monitor size={24} /><span><strong>{hdmiScreenName(screen, index)}</strong><small>{screen.width} × {screen.height}{screen.isInternal ? ' · 内置' : ' · 外接'}</small></span><Maximize2 size={16} />
        </button>)}
      </div>}
      {(p.message || !p.supported) && <p role="status">{p.message || '此浏览器不支持选屏，请移动窗口后全屏。'}</p>}
      {p.stopping && <p role="status">正在停止体验…</p>}
      {p.stopError && <div role="alert" className="ex-hdmi-stop-error"><span>{p.stopError}</span><button type="button" className="ex-button" disabled={p.stopping} onClick={() => void p.retryStop()}>重试停止</button></div>}
      <footer><button type="button" className="ex-button" disabled={p.busy || p.needsStop}
        onClick={() => void p.present()}><Maximize2 size={16} />当前窗口全屏</button>
        {(p.manual || !p.supported) && <button type="button" className="ex-button" disabled={p.busy || p.needsStop}
          onClick={p.useWindow}>使用当前窗口</button>}</footer>
    </section>}
  </>;
}
