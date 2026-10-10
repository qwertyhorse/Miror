import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { mapMoXPoint, MoXDragController, type MoXInteraction } from './moxDrag';
import './mox-drag.css';

export type { MoXInteraction } from './moxDrag';

interface MoXDragSurfaceProps {
  interaction: MoXInteraction | null;
  disabled?: boolean;
  imageUrl?: string;
  children?: ReactNode;
  className?: string;
  onError?: (error: unknown) => void;
}

export function MoXDragSurface({ interaction, disabled = false, imageUrl, children, className = '', onError }: MoXDragSurfaceProps) {
  const surface = useRef<HTMLDivElement>(null);
  const controller = useRef<MoXDragController | null>(null);
  const activePointer = useRef<number | null>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const [marker, setMarker] = useState<{ x: number; y: number } | null>(null);
  const enabled = !disabled && interaction !== null && Number.isFinite(interaction.width) && Number.isFinite(interaction.height)
    && interaction.width >= 1 && interaction.height >= 1;

  function releasePointer() {
    const pointer = activePointer.current;
    activePointer.current = null;
    if (pointer !== null && surface.current?.hasPointerCapture(pointer)) surface.current.releasePointerCapture(pointer);
  }

  function finish(pointerId?: number) {
    if (!controller.current?.end(pointerId)) return;
    releasePointer();
    setMarker(null);
  }

  useLayoutEffect(() => {
    setMarker(null);
    const element = surface.current;
    if (!enabled || !interaction || !element) return;
    const current = new MoXDragController(interaction, error => errorHandler.current?.(error));
    controller.current = current;
    let { width, height } = element.getBoundingClientRect();
    const cancel = () => {
      current.end();
      releasePointer();
      setMarker(null);
    };
    const resize = () => {
      const next = element.getBoundingClientRect();
      if (next.width !== width || next.height !== height) cancel();
      width = next.width;
      height = next.height;
    };
    const visibility = () => { if (document.hidden) cancel(); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(element);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', visibility);
      current.dispose();
      controller.current = null;
      releasePointer();
    };
  }, [enabled, interaction, interaction?.width, interaction?.height]);

  function position(event: PointerEvent<HTMLDivElement>) {
    if (!interaction) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = mapMoXPoint(event.clientX, event.clientY, bounds, interaction.width, interaction.height);
    return point ? { point, marker: { x: event.clientX - bounds.left, y: event.clientY - bounds.top } } : null;
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const next = position(event);
    if (!next || !controller.current?.start(event.pointerId, next.point)) return;
    activePointer.current = event.pointerId;
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch { finish(event.pointerId); return; }
    event.preventDefault();
    setMarker(next.marker);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (activePointer.current !== event.pointerId) return;
    const next = position(event);
    if (!next) { finish(event.pointerId); return; }
    if (controller.current?.move(event.pointerId, next.point)) {
      event.preventDefault();
      setMarker(next.marker);
    }
  }

  return <div className={`mox-drag-surface ${className}`}>
    <div className="mox-drag-media">{children}</div>
    {imageUrl && <img className="mox-drag-image" src={imageUrl} alt="动作控制素材" draggable={false} />}
    <div ref={surface} className="mox-drag-input" data-enabled={enabled ? '' : undefined} data-dragging={marker ? '' : undefined}
      aria-hidden="true" onPointerDown={pointerDown} onPointerMove={pointerMove}
      onPointerUp={event => finish(event.pointerId)} onPointerCancel={event => finish(event.pointerId)}
      onLostPointerCapture={event => finish(event.pointerId)} onContextMenu={event => { if (enabled) event.preventDefault(); }}>
      {marker && <span className="mox-drag-marker" style={{ left: marker.x, top: marker.y }} />}
    </div>
  </div>;
}
