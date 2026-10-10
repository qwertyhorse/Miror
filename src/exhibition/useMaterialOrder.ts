import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { ExhibitionCommand, ExhibitionExperienceMode, ExhibitionLook } from '../../shared/exhibition';
import { insertMaterialAtSlot, materialDropTarget, type MaterialDropTarget, type MaterialRect } from './materialOrderGeometry';

interface DragPreview { id: string; x: number; y: number; width: number; height: number; offsetX: number; offsetY: number }

interface DragSession {
  pointerId: number; element: HTMLDivElement; handle: HTMLButtonElement; id: string; ids: string[]; revision: number; scope: string;
  startX: number; startY: number; x: number; y: number; moved: boolean; ghost: DragPreview; target: MaterialDropTarget | null;
}

function moveId(ids: string[], id: string, index: number) {
  const from = ids.indexOf(id);
  if (from < 0 || index < 0 || index >= ids.length || from === index) return ids;
  const next = [...ids]; next.splice(from, 1); next.splice(index, 0, id); return next;
}

/** Keep the enabled order of other modes while inserting a newly enabled item in its material order. */
export function enableLookInOrder(looks: ExhibitionLook[], enabledIds: string[], look: ExhibitionLook) {
  if (enabledIds.includes(look.id)) return enabledIds;
  const enabled = new Set([...enabledIds, look.id]);
  const modeIds = looks.filter(item => item.mode === look.mode && enabled.has(item.id)).map(item => item.id);
  const oldModeIds = new Set(looks.filter(item => item.mode === look.mode).map(item => item.id));
  const next = [...enabledIds];
  let lastModeIndex = -1;
  for (let index = next.length - 1; index >= 0; index--) if (oldModeIds.has(next[index])) { lastModeIndex = index; break; }
  next.splice(lastModeIndex + 1, 0, look.id);
  let cursor = 0;
  return next.map(id => oldModeIds.has(id) ? modeIds[cursor++] : id);
}

export function useMaterialOrder({ mirrorId, revision, mode, lookIds, disabled, region, send }: {
  mirrorId: string; revision: number; mode: ExhibitionExperienceMode; lookIds: string[]; disabled: boolean;
  region: RefObject<HTMLDivElement | null>; send: (command: ExhibitionCommand) => Promise<boolean>;
}) {
  const scope = JSON.stringify([mirrorId, mode, lookIds]);
  const context = JSON.stringify([mirrorId, mode]);
  const [preview, setPreview] = useState<{ scope: string; ids: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [dropIndicator, setDropIndicator] = useState<Pick<MaterialDropTarget, 'left' | 'top' | 'height'> | null>(null);
  const [message, setMessage] = useState('');
  const drag = useRef<DragSession | null>(null);
  const frame = useRef<number | null>(null);
  const alive = useRef(true);
  const operation = useRef(0);
  const restoreFocus = useRef<{ id: string; context: string; handle: HTMLButtonElement } | null>(null);
  const current = useRef({ scope, context, revision, disabled, saving });
  current.current = { scope, context, revision, disabled, saving };

  function releaseDrag() {
    if (frame.current !== null) { window.cancelAnimationFrame(frame.current); frame.current = null; }
    const active = drag.current; drag.current = null;
    if (active?.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
  }
  function clearDragView() { setDraggedId(null); setDragPreview(null); setDropIndicator(null); }
  function focusDragHandle(active: DragSession | null) {
    if (active && !current.current.disabled && current.current.scope === active.scope && !active.handle.disabled) active.handle.focus({ preventScroll: true });
  }
  function cancelDrag() { const active = drag.current; releaseDrag(); clearDragView(); setPreview(null); focusDragHandle(active); }

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; ++operation.current; releaseDrag(); };
  }, []);
  useEffect(() => {
    if (drag.current && (disabled || drag.current.scope !== scope || drag.current.revision !== revision)) {
      cancelDrag(); setMessage('状态已变化，已取消本次排序。');
    }
  }, [disabled, scope, revision]);
  useEffect(() => { setPreview(null); }, [scope]);
  useEffect(() => { setMessage(''); }, [context]);
  useEffect(() => {
    const target = restoreFocus.current;
    if (!target || saving || disabled) return;
    restoreFocus.current = null;
    if (target.context !== context) return;
    // Saving temporarily disables the focused handle. Restore it after the DOM
    // commit, unless the user moved focus to another operation in the meantime.
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== region.current && focused !== target.handle) return;
    const handle = Array.from(region.current?.querySelectorAll?.<HTMLButtonElement>('[data-material-order-id]') ?? [])
      .find(element => element.dataset.materialOrderId === target.id);
    if (handle && !handle.disabled) handle.focus({ preventScroll: true });
  }, [saving, disabled, scope, context]);

  async function save(ids: string[], baseline: number, orderScope: string, focusTarget: { id: string; handle: HTMLButtonElement }) {
    if (current.current.disabled || current.current.saving || current.current.scope !== orderScope || current.current.revision !== baseline) {
      setPreview(null); setMessage('状态已变化，请按最新素材重新排序。'); return;
    }
    if (ids.every((id, index) => id === lookIds[index])) { setPreview(null); setMessage('素材顺序未改变。'); focusTarget.handle.focus({ preventScroll: true }); return; }
    const request = ++operation.current;
    restoreFocus.current = { ...focusTarget, context };
    current.current.saving = true;
    setPreview({ scope: orderScope, ids }); setSaving(true); setMessage('正在保存素材顺序…');
    try {
      const ok = await send({ action: 'reorder', experienceMode: mode, lookIds: ids, expectedRevision: baseline });
      if (alive.current && request === operation.current && current.current.context === context) {
        setMessage(ok ? '素材顺序已保存，大屏与自动换装将按此顺序切换。' : '顺序未保存，已恢复。请按最新素材重新调整。');
      }
    } catch {
      if (alive.current && request === operation.current && current.current.context === context) setMessage('顺序未保存，已恢复。请重试。');
    } finally {
      if (alive.current && request === operation.current) { setPreview(null); setSaving(false); }
    }
  }

  function targetAtPoint(active: DragSession) {
    const container = region.current;
    if (!container) return;
    const viewport = container.getBoundingClientRect();
    const inside = active.x >= viewport.left && active.x <= viewport.right && active.y >= viewport.top && active.y <= viewport.bottom;
    const rects: MaterialRect[] = inside ? Array.from(container.querySelectorAll<HTMLElement>('[data-material-id]')).flatMap(card => {
      const id = card.dataset.materialId;
      if (!id || !active.ids.includes(id)) return [];
      const rect = card.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? [{ id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }] : [];
    }) : [];
    // All cards remain in their original positions until release. A pointer held
    // still therefore cannot flip between targets after a React layout update.
    active.target = rects.length === active.ids.length ? materialDropTarget(rects, active.x, active.y) : null;
    const target = active.target;
    const top = target ? Math.max(viewport.top, target.top) : 0;
    const bottom = target ? Math.min(viewport.bottom, target.top + target.height) : 0;
    const visible = target && bottom > top && target.left >= viewport.left && target.left <= viewport.right
      ? { left: target.left, top, height: bottom - top } : null;
    setDropIndicator(previous => previous?.left === visible?.left && previous?.top === visible?.top && previous?.height === visible?.height ? previous : visible);
  }
  function scrollWhileDragging() {
    const active = drag.current, container = region.current;
    if (!active?.moved || !container) return;
    const rect = container.getBoundingClientRect();
    if (active.x >= rect.left && active.x <= rect.right && active.y >= rect.top && active.y <= rect.bottom) {
      const distance = active.y < rect.top + 48 ? active.y - rect.top - 48 : active.y > rect.bottom - 48 ? active.y - rect.bottom + 48 : 0;
      if (distance) {
        const before = container.scrollTop;
        container.scrollTop += Math.sign(distance) * Math.min(14, Math.abs(distance) / 3);
        if (container.scrollTop !== before) targetAtPoint(active);
      }
    }
    if (window.requestAnimationFrame) frame.current = window.requestAnimationFrame(scrollWhileDragging);
  }
  function pointerDown(event: PointerEvent<HTMLButtonElement | HTMLDivElement>, id: string, image = false) {
    const container = region.current;
    if (!container || disabled || saving || drag.current || lookIds.length < 2 || !lookIds.includes(id) || event.button !== 0 || !event.isPrimary) return;
    if (image && (event.pointerType !== 'mouse' || (event.target as HTMLElement | undefined)?.closest?.('button,input,a'))) return;
    const handle = image ? Array.from(container.querySelectorAll<HTMLButtonElement>('[data-material-order-id]')).find(element => element.dataset.materialOrderId === id)
      : event.currentTarget as HTMLButtonElement;
    if (!handle || handle.disabled) return;
    event.preventDefault(); handle.focus({ preventScroll: true });
    // Capture on the stable scroll region so the interaction stays valid while
    // scrolling and when the pending saved order moves the source card.
    container.setPointerCapture(event.pointerId);
    const imageElement = image ? event.currentTarget : handle.closest<HTMLElement>('[data-material-drag-image]');
    const rect = (imageElement ?? handle).getBoundingClientRect();
    const scale = Math.min(1, 100 / Math.max(1, rect.width), 140 / Math.max(1, rect.height));
    const ghost = { id, x: event.clientX, y: event.clientY, width: Math.max(1, rect.width * scale), height: Math.max(1, rect.height * scale),
      offsetX: Math.max(0, Math.min(rect.width, event.clientX - rect.left)) * scale,
      offsetY: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) * scale };
    drag.current = { pointerId: event.pointerId, element: container, handle, id, ids: [...lookIds], revision, scope, ghost,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false, target: null };
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.x = event.clientX; active.y = event.clientY;
    if (!active.moved) {
      if (Math.hypot(active.x - active.startX, active.y - active.startY) < 6) return;
      active.moved = true; setDraggedId(active.id); setMessage('正在调整素材顺序，松开保存；Esc 取消。');
      active.element.focus({ preventScroll: true });
      if (window.requestAnimationFrame) frame.current = window.requestAnimationFrame(scrollWhileDragging);
    }
    setDragPreview({ ...active.ghost, x: active.x, y: active.y });
    targetAtPoint(active);
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.x = event.clientX; active.y = event.clientY;
    if (active.moved) targetAtPoint(active);
    releaseDrag(); clearDragView();
    if (active.moved && active.target) void save(insertMaterialAtSlot(active.ids, active.id, active.target.slot), active.revision, active.scope, { id: active.id, handle: active.handle });
    else if (active.moved) { setPreview(null); setMessage('已取消排序。'); focusDragHandle(active); }
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); cancelDrag(); setMessage('已取消排序。'); return; }
    if (disabled || saving || drag.current) return;
    const index = lookIds.indexOf(id);
    const nextIndex = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? index - 1 : ['ArrowRight', 'ArrowDown'].includes(event.key) ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? lookIds.length - 1 : null;
    if (nextIndex === null) return;
    event.preventDefault(); void save(moveId(lookIds, id, nextIndex), revision, scope, { id, handle: event.currentTarget });
  }
  return {
    ids: preview?.scope === scope ? preview.ids : lookIds, draggedId, dragPreview, dropIndicator, saving, message,
    regionProps: {
      onPointerMove: pointerMove, onPointerUp: pointerUp,
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.pointerId === event.pointerId) { cancelDrag(); setMessage('已取消排序。'); } },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        // Touch input can first lose implicit capture on the handle when it is
        // transferred to this region. That bubbled event is not our capture loss.
        if (event.target === event.currentTarget && drag.current?.pointerId === event.pointerId) { cancelDrag(); setMessage('已取消排序。'); }
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); cancelDrag(); setMessage('已取消排序。'); } },
    },
    handleProps: (id: string) => ({
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => pointerDown(event, id),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => keyDown(event, id),
    }),
    imageProps: (id: string) => ({ onPointerDown: (event: PointerEvent<HTMLDivElement>) => pointerDown(event, id, true) }),
  };
}
