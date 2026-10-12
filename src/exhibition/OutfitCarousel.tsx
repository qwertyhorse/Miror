import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, Shirt } from 'lucide-react';
import type { ExhibitionLook } from '../../shared/exhibition';
import { appUrl } from '../versionScope';
import './outfit-carousel.css';

interface OutfitCarouselProps {
  looks: ExhibitionLook[];
  selectedId: string | null;
  disabled: boolean;
  passive?: boolean;
  compact?: boolean;
  hideDetails?: boolean;
  queueSelections?: boolean;
  onSelect: (id: string) => Promise<boolean>;
  onBusyChange?: (busy: boolean) => void;
}

interface PointerGesture {
  id: number;
  type: string;
  startX: number;
  startScroll: number;
  moved: boolean;
}

function centeredScrollLeft(element: HTMLElement, card: HTMLElement) {
  const left = card.offsetLeft + card.offsetWidth / 2 - element.clientWidth / 2;
  return Math.max(0, Math.min(left, element.scrollWidth - element.clientWidth));
}

export function OutfitCarousel({ looks, selectedId, disabled, passive = false, compact = false, hideDetails = compact, queueSelections = true, onSelect, onBusyChange }: OutfitCarouselProps) {
  const optionId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const props = useRef({ looks, selectedId, disabled, passive, queueSelections, onSelect, onBusyChange });
  const alive = useRef(true);
  const inFlight = useRef(false);
  const queued = useRef<string | null>(null);
  const confirmed = useRef(selectedId);
  const desired = useRef(selectedId && looks.some(look => look.id === selectedId) ? selectedId : looks[0]?.id ?? '');
  const pointer = useRef<PointerGesture | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScroll = useRef(false);
  const ignoreClickUntil = useRef(0);
  const [activeId, setActiveId] = useState(desired.current);
  const [dragging, setDragging] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const ids = looks.map(look => look.id).join('\u0000');
  const activeIndex = looks.findIndex(look => look.id === activeId);
  const selectedLook = looks.find(look => look.id === selectedId);
  // Selection screens can queue their final choice while a request is pending.
  // Result screens lock immediately because each choice starts a generation.
  const blocked = passive || (disabled && (!submitting || !queueSelections)) || (!queueSelections && submitting);

  useLayoutEffect(() => {
    props.current = { looks, selectedId, disabled, passive, queueSelections, onSelect, onBusyChange };
  }, [looks, selectedId, disabled, passive, queueSelections, onSelect, onBusyChange]);

  const align = useCallback((id: string, smooth = false) => {
    const element = viewport.current;
    const index = props.current.looks.findIndex(look => look.id === id);
    const card = element?.children.item(index) as HTMLElement | null;
    if (!element || !card || index < 0) return;
    const left = centeredScrollLeft(element, card);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollTo({ left, behavior: smooth && !reducedMotion ? 'smooth' : 'instant' });
  }, []);

  const show = useCallback((id: string, smooth = false) => {
    desired.current = id;
    setActiveId(id);
    align(id, smooth);
  }, [align]);

  const flush = useCallback(function flushQueue() {
    const current = props.current;
    if (!alive.current || inFlight.current || current.disabled || current.passive) return;
    const id = queued.current;
    if (!id || !current.looks.some(look => look.id === id)) {
      queued.current = null;
      setSubmitting(false);
      return;
    }
    queued.current = null;
    if (id === confirmed.current) {
      setSubmitting(false);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    void Promise.resolve().then(() => current.onSelect(id)).catch(() => false).then(success => {
      if (!alive.current) return;
      inFlight.current = false;
      const latest = props.current;
      if (success && latest.looks.some(look => look.id === id)) confirmed.current = id;
      else confirmed.current = latest.selectedId;
      if (queued.current && !latest.looks.some(look => look.id === queued.current)) queued.current = null;
      if (queued.current === confirmed.current) queued.current = null;
      if (!queued.current) {
        const fallback = latest.looks.find(look => look.id === confirmed.current) ?? latest.looks[0];
        if (!pointer.current?.moved && !userScroll.current) show(fallback?.id ?? '', !success);
        setSubmitting(false);
      } else {
        // The parent may still be committing pending=false. Its effect also
        // calls flush, so a final swipe made during a request is never dropped.
        flushQueue();
      }
    });
  }, [show]);

  const choose = useCallback((id: string, smooth = true) => {
    const current = props.current;
    if (!current.queueSelections && (current.disabled || inFlight.current)) return;
    if (current.passive || (current.disabled && !inFlight.current && !queued.current)) return;
    if (!current.looks.some(look => look.id === id)) return;
    show(id, smooth);
    queued.current = id;
    setSubmitting(true);
    flush();
  }, [flush, show]);

  const settle = useCallback(() => {
    if (pointer.current?.moved) return;
    const element = viewport.current;
    if (!element) return;
    const distances = Array.from(element.children, child =>
      Math.abs(centeredScrollLeft(element, child as HTMLElement) - element.scrollLeft));
    const distance = Math.min(...distances);
    const candidates = distances.flatMap((value, index) => value <= distance + 1 ? [index] : []);
    const current = props.current;
    const desiredIndex = current.looks.findIndex(look => look.id === desired.current);
    // Several visible cards share the same clamped target at either edge.
    // Preserve an explicit selection there, rather than replacing it with the
    // card nearest the viewport center after a click or native scroll snap.
    const nearest = candidates.includes(desiredIndex) ? desiredIndex
      : element.scrollWidth - element.clientWidth - element.scrollLeft <= 1 ? candidates[candidates.length - 1]
      : candidates[0];
    const look = current.looks[nearest];
    if (userScroll.current && look) {
      userScroll.current = false;
      choose(look.id);
    }
    setScrolling(false);
  }, [choose]);

  const scheduleSettle = useCallback(() => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(settle, 160);
  }, [settle]);

  useLayoutEffect(() => {
    confirmed.current = selectedId;
    if (queued.current && !looks.some(look => look.id === queued.current)) queued.current = null;
    const localSelectionExists = looks.some(look => look.id === desired.current);
    const browsing = pointer.current?.moved || userScroll.current;
    if (!localSelectionExists || (!inFlight.current && !queued.current && !browsing)) {
      const next = looks.find(look => look.id === selectedId) ?? looks[0];
      show(next?.id ?? '');
      if (!inFlight.current && !queued.current) setSubmitting(false);
    } else if (!browsing) {
      align(desired.current);
    }
    // Completing a request also rechecks the server-owned selection: a true
    // result can acknowledge an older response that the parent has discarded.
    // Fresh catalogue arrays alone should not reposition the scroll track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, selectedId, submitting, align, show]);

  useEffect(() => { flush(); }, [disabled, passive, ids, flush]);

  useLayoutEffect(() => {
    if (blocked) {
      const gesture = pointer.current;
      pointer.current = null;
      if (gesture && viewport.current?.hasPointerCapture(gesture.id)) viewport.current.releasePointerCapture(gesture.id);
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      scrollTimer.current = null;
      userScroll.current = false;
      setDragging(false);
      setScrolling(false);
      if (gesture?.moved) ignoreClickUntil.current = Date.now() + 350;
      if (props.current.passive || !props.current.queueSelections) queued.current = null;
      const next = props.current.looks.find(look => look.id === props.current.selectedId) ?? props.current.looks[0];
      show(next?.id ?? '');
    } else if (!inFlight.current && !queued.current) {
      const next = props.current.looks.find(look => look.id === props.current.selectedId) ?? props.current.looks[0];
      show(next?.id ?? '');
    }
  }, [blocked, show]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (!pointer.current?.moved) align(desired.current);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [align, looks.length]);

  useEffect(() => { onBusyChange?.(dragging || scrolling || submitting); }, [dragging, scrolling, submitting, onBusyChange]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      props.current.onBusyChange?.(false);
    };
  }, []);

  const startPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (blocked || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointer.current = { id: event.pointerId, type: event.pointerType, startX: event.clientX, startScroll: event.currentTarget.scrollLeft, moved: false };
  };

  const movePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointer.current;
    if (blocked || !gesture || gesture.id !== event.pointerId) return;
    const delta = event.clientX - gesture.startX;
    if (Math.abs(delta) > 6) {
      gesture.moved = true;
      userScroll.current = true;
      setDragging(true);
      setScrolling(true);
    }
    if (!gesture.moved || gesture.type === 'touch') return;
    event.preventDefault();
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.scrollLeft = gesture.startScroll - delta;
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointer.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    // Native touch panning may cancel pointer delivery before React receives a
    // move. A plain tap, in contrast, must not leave a browsing intent behind.
    const nativePan = gesture.type === 'touch' && event.type === 'pointercancel';
    if (gesture.moved || nativePan) {
      userScroll.current = true;
      setScrolling(true);
      ignoreClickUntil.current = Date.now() + 350;
      // Mouse dragging has no native momentum. Center its nearest card now;
      // touch scrolling keeps native momentum and settles after it stops.
      if (gesture.type !== 'touch') settle();
      else scheduleSettle();
    } else if (gesture.type === 'touch') {
      userScroll.current = false;
      if (!inFlight.current && !queued.current) {
        const current = props.current;
        const next = current.looks.find(look => look.id === current.selectedId) ?? current.looks[0];
        show(next?.id ?? '');
      }
    }
  };

  if (!looks.length) return <div className="ex-outfit-empty"><Shirt /><span>暂时没有可选套装</span></div>;

  return <div className={`ex-outfit-carousel${compact ? ' ex-outfit-carousel-compact' : ''}`} data-blocked={blocked || undefined} data-dragging={dragging || undefined}>
    <div
      ref={viewport}
      className="ex-outfit-track"
      role="listbox"
      aria-label="选择套装，左右滑动或使用方向键切换"
      aria-orientation="horizontal"
      aria-activedescendant={activeIndex >= 0 ? `${optionId}-${activeIndex}` : undefined}
      aria-disabled={blocked}
      aria-busy={submitting}
      tabIndex={passive ? -1 : 0}
      onPointerDown={startPointer}
      onPointerMove={movePointer}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onWheel={() => { if (!blocked) { userScroll.current = true; scheduleSettle(); } }}
      onScroll={() => { if (!blocked) { setScrolling(true); scheduleSettle(); } }}
      onKeyDown={event => {
        if (blocked) return;
        let index: number | undefined;
        if (event.key === 'ArrowLeft') index = Math.max(0, activeIndex - 1);
        if (event.key === 'ArrowRight') index = Math.min(looks.length - 1, activeIndex + 1);
        if (event.key === 'Home') index = 0;
        if (event.key === 'End') index = looks.length - 1;
        if (index === undefined) return;
        event.preventDefault();
        userScroll.current = false;
        choose(looks[index].id);
      }}
    >
      {looks.map((look, index) => {
        const centered = look.id === activeId;
        const selected = look.id === selectedId;
        return <button
          id={`${optionId}-${index}`}
          key={look.id}
          type="button"
          role="option"
          aria-selected={selected}
          aria-pressed={selected}
          aria-label={`选择${look.name}`}
          tabIndex={-1}
          disabled={blocked}
          className={`ex-outfit-card${centered ? ' is-centered' : ''}${selected ? ' is-selected' : ''}${index < activeIndex ? ' is-before' : index > activeIndex ? ' is-after' : ''}`}
          onClick={() => {
            if (Date.now() < ignoreClickUntil.current) return;
            userScroll.current = false;
            choose(look.id);
          }}
        >
          <span className="ex-outfit-photo">
            <img src={appUrl(look.image)} alt={look.name} draggable={false} loading={Math.abs(index - activeIndex) <= 3 ? 'eager' : 'lazy'} />
            {selected && <span className="ex-outfit-check" aria-hidden="true"><Check /></span>}
          </span>
        </button>;
      })}
    </div>
    {selectedLook && !hideDetails && <div className="ex-outfit-selection">
      <strong>{selectedLook.name}</strong>
      {selectedLook.description && <small>{selectedLook.description}</small>}
    </div>}
    <div className="ex-outfit-navigation">
      <button type="button" aria-label="上一套" disabled={blocked || activeIndex <= 0} onClick={() => { userScroll.current = false; choose(looks[activeIndex - 1].id); }}><ChevronLeft /></button>
      <span className={hideDetails ? 'ex-sr-only' : undefined}>{looks.length > 1 ? `${looks.length} 套穿搭 · 左右滑动${queueSelections ? '选择' : '换装'}` : compact ? '当前仅有这一套穿搭' : '选好这一套，开始体验'}</span>
      <button type="button" aria-label="下一套" disabled={blocked || activeIndex >= looks.length - 1} onClick={() => { userScroll.current = false; choose(looks[activeIndex + 1].id); }}><ChevronRight /></button>
    </div>
    <span className="ex-sr-only" role="status" aria-live="polite">{selectedLook ? `已选择${selectedLook.name}` : ''}</span>
  </div>;
}
