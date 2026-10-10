import { useEffect, useState } from 'react';
import { Link2, Monitor, RefreshCw } from 'lucide-react';
import type { TerminalBinding } from './useTerminalBinding';

export function TerminalPairingScreen({ terminal }: { terminal: TerminalBinding }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const code = terminal.connected && terminal.connection?.code && (terminal.connection.expiresAt ?? 0) > now ? terminal.connection.code : null;
  const remaining = Math.max(0, Math.ceil(((terminal.connection?.expiresAt ?? 0) - now) / 1000));
  return <main className="ex-app ex-terminal-pairing"><section>
    <div className="ex-terminal-pair-icon"><Monitor size={32} /><Link2 size={17} /></div>
    <span className="ex-terminal-eyebrow">OPENBUY.AI · 镜端连接</span>
    <h1>{terminal.identity ? terminal.connection?.mirrorId ? '正在恢复设备连接' : '绑定这台智能镜' : '正在识别镜端设备'}</h1>
    <p>{terminal.identity ? terminal.connection?.mirrorId ? '重新连接后将自动回到已绑定的大屏。' : '在工作人员后台选择智能镜，点击「绑定镜端设备」，输入下面的绑定码。' : '请保持与后台电脑连接在同一网络。'}</p>
    {code ? <><div className="ex-terminal-code" aria-label={`绑定码 ${code}`} role="status">{code.match(/.{1,3}/g)?.join(' ')}</div><div className="ex-terminal-code-expiry">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')} 内有效 · 绑定后自动进入大屏</div></> : <div className="ex-terminal-wait" role="status">{terminal.error ? '连接需要检查' : '正在连接后台…'}</div>}
    {terminal.error && <p className="ex-terminal-error" role="alert">{terminal.error}</p>}
    <button className="ex-button" onClick={() => void terminal.retry()}><RefreshCw size={16} />重新连接</button>
    {terminal.identity && <small>{terminal.identity.label}{terminal.identity.platform === 'browser' ? ' · 绑定保存在当前浏览器入口' : ' · 绑定后重启自动连接'}<br />更换设备时，请先在后台解除原镜端绑定。</small>}
  </section></main>;
}
