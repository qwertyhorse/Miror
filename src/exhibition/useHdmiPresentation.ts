import { useEffect, useRef, useState } from 'react';

// Kept local: not every browser implements the Window Management API.
export interface HdmiScreen {
  label: string;
  width: number;
  height: number;
  isInternal: boolean;
  isPrimary: boolean;
}
export interface HdmiScreenDetails extends EventTarget {
  screens: readonly HdmiScreen[];
  currentScreen: HdmiScreen;
}
type ScreenWindow = Window & { getScreenDetails?: () => Promise<HdmiScreenDetails> };

export function hdmiScreenName(screen: HdmiScreen, index: number) {
  return screen.label?.trim() || `${screen.isInternal ? '内置屏幕' : '显示器'} ${index + 1}`;
}

export function useHdmiPresentation(enabled: boolean, onDisconnect: () => Promise<boolean>) {
  const [open, setOpen] = useState(enabled);
  const [screens, setScreens] = useState<readonly HdmiScreen[]>([]);
  const [ready, setReady] = useState(!enabled);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [needsStop, setNeedsStop] = useState(false);
  const [message, setMessage] = useState('');
  const [stopError, setStopError] = useState('');
  const [manual, setManual] = useState(false);
  const details = useRef<HdmiScreenDetails | null>(null);
  const target = useRef<HdmiScreen | null>(null);
  const pendingTarget = useRef<HdmiScreen | null>(null);
  const followWindow = useRef(false);
  const observed = useRef(new Set<HdmiScreen>());
  const detach = useRef<() => void>(() => {});
  const alive = useRef(false);
  const operation = useRef(0);
  const requesting = useRef(false);
  const stopInFlight = useRef(false);
  const stopNeeded = useRef(false);
  const latest = useRef(onDisconnect); latest.current = onDisconnect;
  const supported = enabled && typeof (window as ScreenWindow).getScreenDetails === 'function' && window.isSecureContext;

  const retryStop = async () => {
    if (!alive.current || !stopNeeded.current || stopInFlight.current) return;
    stopInFlight.current = true; setStopping(true); setStopError('');
    let confirmed = false;
    try { confirmed = await latest.current(); } catch { /* Keep controls blocked until a confirmed stop. */ }
    if (!alive.current) return;
    stopInFlight.current = false; setStopping(false);
    if (confirmed) { stopNeeded.current = false; setNeedsStop(false); }
    else setStopError('停止未完成，请重试。');
  };

  const syncScreens = () => {
    if (!alive.current || !details.current) return;
    const available = details.current.screens;
    for (const screen of observed.current) {
      if (!available.includes(screen)) {
        if ('removeEventListener' in screen) (screen as HdmiScreen & EventTarget).removeEventListener('change', syncScreens);
        observed.current.delete(screen);
      }
    }
    for (const screen of available) {
      if (!observed.current.has(screen) && 'addEventListener' in screen) {
        (screen as HdmiScreen & EventTarget).addEventListener('change', syncScreens); observed.current.add(screen);
      }
    }
    setScreens([...available]);
    if ((target.current && !available.includes(target.current)) || (pendingTarget.current && !available.includes(pendingTarget.current))) {
      // Invalidate an in-flight fullscreen request too: it must not re-arm after unplug.
      operation.current++; requesting.current = false; setBusy(false);
      target.current = null; pendingTarget.current = null; setReady(false); setOpen(true); setManual(false);
      setMessage('显示器已断开，请重新选择。');
      stopNeeded.current = true; setNeedsStop(true);
      void retryStop();
    }
  };

  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => { alive.current = false; };
    const fullscreenChanged = () => {
      if (!document.fullscreenElement) setOpen(true);
      // Success is accepted by present() only after checking the actual target screen.
    };
    document.addEventListener('fullscreenchange', fullscreenChanged);
    return () => {
      alive.current = false; operation.current++; requesting.current = false;
      detach.current(); detach.current = () => {}; details.current = null; target.current = null; pendingTarget.current = null;
      document.removeEventListener('fullscreenchange', fullscreenChanged);
    };
  }, [enabled]);

  const discover = async () => {
    if (!alive.current || requesting.current || stopNeeded.current) return;
    if (!supported) { setMessage('此浏览器不支持选屏，请移动窗口后全屏。'); setManual(true); return; }
    const request = ++operation.current;
    requesting.current = true; setBusy(true); setMessage('');
    try {
      const next = await (window as ScreenWindow).getScreenDetails!();
      if (!alive.current || request !== operation.current) return;
      detach.current(); details.current = next;
      next.addEventListener('screenschange', syncScreens);
      const moved = () => {
        // Check removal before following the OS moving an unplugged window back.
        syncScreens();
        if (followWindow.current && !requesting.current && !stopNeeded.current) target.current = next.currentScreen;
      };
      next.addEventListener('currentscreenchange', moved);
      detach.current = () => {
        next.removeEventListener('screenschange', syncScreens);
        next.removeEventListener('currentscreenchange', moved);
        for (const screen of observed.current) {
          if ('removeEventListener' in screen) (screen as HdmiScreen & EventTarget).removeEventListener('change', syncScreens);
        }
        observed.current.clear();
      };
      syncScreens();
      if (!next.screens.some(screen => !screen.isInternal)) setMessage('未发现可选外接屏，可移动窗口后全屏。');
      setManual(false);
    } catch {
      if (alive.current && request === operation.current) {
        setMessage('未获得显示器权限，可移动窗口后全屏。'); setManual(true);
      }
    } finally {
      if (alive.current && request === operation.current) { requesting.current = false; setBusy(false); }
    }
  };

  const present = async (screen?: HdmiScreen) => {
    if (!alive.current || requesting.current || stopNeeded.current) return;
    if (screen && !details.current?.screens.includes(screen)) { syncScreens(); return; }
    const request = ++operation.current;
    pendingTarget.current = screen ?? details.current?.currentScreen ?? null;
    requesting.current = true; setBusy(true); setMessage('');
    try {
      // Call synchronously in the screen button's click, before any await loses activation.
      await document.documentElement.requestFullscreen(screen ? { screen } as FullscreenOptions : undefined);
      if (!alive.current || request !== operation.current) return;
      if (!document.fullscreenElement || (screen && details.current?.currentScreen !== screen)) {
        throw new Error('Fullscreen did not reach the requested display');
      }
      target.current = pendingTarget.current; followWindow.current = !screen;
      setReady(true); setOpen(false); setManual(false);
    } catch {
      if (alive.current && request === operation.current) {
        setMessage('未能进入目标屏全屏，请移动窗口后重试。'); setOpen(true); setManual(true);
      }
    } finally {
      if (alive.current && request === operation.current) { requesting.current = false; pendingTarget.current = null; setBusy(false); }
    }
  };

  const useWindow = () => {
    if (!alive.current || requesting.current || stopNeeded.current) return;
    target.current = details.current?.currentScreen ?? null;
    followWindow.current = true;
    setReady(true); setOpen(false); setMessage('');
  };

  return { open, setOpen, screens, ready, busy, stopping, needsStop, message, stopError, manual,
    supported, discover, present, useWindow, retryStop };
}

export type HdmiPresentation = ReturnType<typeof useHdmiPresentation>;
