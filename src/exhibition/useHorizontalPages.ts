import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { HTMLAttributes, PointerEvent as ReactPointerEvent } from 'react';

interface HorizontalPagesOptions {
  page: number;
  pageCount: number;
  contentKey: string;
  onPageChange: (page: number) => void;
}

interface MouseGesture {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  startScroll: number;
  startPage: number;
  moved: boolean;
}

/** Each direct child of the viewport occupies one full-width page, without a gap. */
export function useHorizontalPages(options: HorizontalPagesOptions) {
  const viewport = useRef<HTMLDivElement>(null);
  const latest = useRef(options);
  const previous = useRef<HorizontalPagesOptions | null>(null);
  const reportedPage = useRef<number | null>(null);
  const navigationTarget = useRef<number | null>(null);
  const pointer = useRef<MouseGesture | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ignoreClickUntil = useRef(0);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => { latest.current = options; });

  const boundPage = useCallback((page: number) => Math.max(0, Math.min(page, Math.max(1, latest.current.pageCount) - 1)), []);

  const reportPage = useCallback((page: number) => {
    const next = boundPage(page);
    if (next === latest.current.page || next === reportedPage.current) return;
    reportedPage.current = next;
    latest.current.onPageChange(next);
  }, [boundPage]);

  const clearSettle = useCallback(() => {
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = null;
  }, []);

  const scheduleSettle = useCallback(() => {
    clearSettle();
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      const element = viewport.current;
      if (!element || !element.clientWidth || pointer.current?.moved) return;
      navigationTarget.current = null;
      reportPage(Math.round(element.scrollLeft / element.clientWidth));
    }, 160);
  }, [clearSettle, reportPage]);

  const align = useCallback((page: number, smooth: boolean) => {
    const element = viewport.current;
    if (!element || !element.clientWidth) return;
    const next = boundPage(page);
    const left = next * element.clientWidth;
    const animate = smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    navigationTarget.current = animate && Math.abs(element.scrollLeft - left) > 1 ? next : null;
    element.scrollTo({ left, behavior: animate ? 'smooth' : 'instant' });
    if (navigationTarget.current !== null) scheduleSettle();
  }, [boundPage, scheduleSettle]);

  const releasePointer = useCallback(() => {
    const gesture = pointer.current;
    pointer.current = null;
    const element = viewport.current;
    if (gesture && element?.hasPointerCapture(gesture.id)) element.releasePointerCapture(gesture.id);
    if (element) delete element.dataset.dragging;
    setDragging(false);
    return gesture;
  }, []);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = options;
    const contentChanged = !before || before.contentKey !== options.contentKey || before.pageCount !== options.pageCount;
    const next = boundPage(options.page);
    const fromScroll = reportedPage.current === next;
    reportedPage.current = null;
    if (contentChanged) {
      const gesture = releasePointer();
      if (gesture?.moved) ignoreClickUntil.current = Date.now() + 400;
      clearSettle();
      align(next, false);
    } else if (before.page !== options.page && !fromScroll) {
      align(next, true);
    }
    if (next !== options.page) reportPage(next);
  }, [options.page, options.pageCount, options.contentKey, align, boundPage, clearSettle, releasePointer, reportPage]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (Math.abs(element.clientWidth - width) < 0.5) return;
      width = element.clientWidth;
      const gesture = releasePointer();
      if (gesture?.moved) ignoreClickUntil.current = Date.now() + 400;
      clearSettle();
      align(latest.current.page, false);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      clearSettle();
      const gesture = pointer.current;
      pointer.current = null;
      if (gesture && element.hasPointerCapture(gesture.id)) element.releasePointerCapture(gesture.id);
    };
  }, [options.contentKey, align, clearSettle, releasePointer]);

  const startPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    // A fresh press is intentional; only the click belonging to the preceding
    // drag needs suppression. Touch keeps the browser's native panning.
    ignoreClickUntil.current = 0;
    if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
    const element = event.currentTarget;
    pointer.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      startScroll: element.scrollLeft,
      startPage: boundPage(Math.round(element.scrollLeft / Math.max(1, element.clientWidth))),
      moved: false,
    };
  };

  const movePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointer.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    if (!(event.buttons & 1)) { releasePointer(); return; }
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.moved) {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 7) return;
      // Preserve ordinary vertical movement and avoid interpreting it as a swipe.
      if (Math.abs(deltaY) >= Math.abs(deltaX)) { pointer.current = null; return; }
      gesture.moved = true;
      navigationTarget.current = null;
      clearSettle();
      // Disable snapping before assigning scrollLeft; React commits its state
      // only after this event handler completes.
      event.currentTarget.dataset.dragging = 'true';
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.scrollTo({ left: gesture.startScroll, behavior: 'instant' });
    }
    gesture.lastX = event.clientX;
    event.preventDefault();
    event.currentTarget.scrollLeft = gesture.startScroll - deltaX;
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    const element = event.currentTarget;
    const endScroll = element.scrollLeft;
    const gesture = releasePointer();
    if (!gesture?.moved) return;
    ignoreClickUntil.current = Date.now() + 400;
    const width = Math.max(1, element.clientWidth);
    let next = boundPage(Math.round(endScroll / width));
    const distance = gesture.startX - gesture.lastX;
    const threshold = Math.max(36, Math.min(120, width * 0.2));
    // A deliberate shorter drag can advance one page without requiring the
    // user to drag more than half of a wide desktop viewport.
    if (event.type === 'pointerup' && next === gesture.startPage && Math.abs(distance) >= threshold) {
      next = boundPage(gesture.startPage + Math.sign(distance));
    }
    reportPage(next);
    align(next, true);
  };

  const trackProps: HTMLAttributes<HTMLDivElement> & { 'data-dragging'?: true } = {
    'data-dragging': dragging ? true : undefined,
    onPointerDown: startPointer,
    onPointerMove: movePointer,
    onPointerUp: endPointer,
    onPointerCancel: endPointer,
    onLostPointerCapture: endPointer,
    onPointerLeave: () => { if (!pointer.current?.moved) pointer.current = null; },
    onDragStart: event => event.preventDefault(),
    onClickCapture: event => {
      if (event.detail > 0 && Date.now() < ignoreClickUntil.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onWheel: event => {
      if (!event.deltaX && !event.shiftKey) return;
      if (navigationTarget.current !== null) {
        event.currentTarget.scrollTo({ left: event.currentTarget.scrollLeft, behavior: 'instant' });
        navigationTarget.current = null;
      }
    },
    onScroll: event => {
      const element = event.currentTarget;
      if (!element.clientWidth) return;
      if (navigationTarget.current === null) reportPage(Math.round(element.scrollLeft / element.clientWidth));
      scheduleSettle();
    },
    onKeyDown: event => {
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
      let next: number;
      if (event.key === 'ArrowLeft') next = latest.current.page - 1;
      else if (event.key === 'ArrowRight') next = latest.current.page + 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = latest.current.pageCount - 1;
      else return;
      event.preventDefault();
      next = boundPage(next);
      reportPage(next);
      align(next, true);
    },
  };

  return { viewport, trackProps };
}
