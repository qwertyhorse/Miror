import { useEffect, useRef } from 'react';

export type PresenterDirection = -1 | 1;

function directionFor(key: string): PresenterDirection | null {
  if (['PageUp', 'ArrowLeft', 'ArrowUp'].includes(key)) return -1;
  if (['PageDown', 'ArrowRight', 'ArrowDown'].includes(key)) return 1;
  return null;
}

const editingTarget = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="dialog"], [role="alertdialog"]';

/** HID presenters reach the foreground browser as keyboard events on Linux. */
export function usePresenterKeys({ enabled, scope, onStep }: {
  enabled: boolean; scope: string; onStep: (direction: PresenterDirection) => void;
}) {
  const callback = useRef(onStep);
  callback.current = onStep;
  useEffect(() => {
    if (!enabled) return;
    const held = new Set<string>();
    const release = (event: KeyboardEvent) => { held.delete(event.code || event.key); };
    const reset = () => held.clear();
    const press = (event: KeyboardEvent) => {
      const direction = directionFor(event.key) ?? directionFor(event.code);
      if (!direction || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
        || document.hidden || [event.target, ...event.composedPath(), document.activeElement].some(target =>
          typeof (target as Element | null)?.closest === 'function' && (target as Element).closest(editingTarget))) return;
      // Consume blocked presses too, so they cannot scroll the mirror or move focus.
      event.preventDefault();
      event.stopPropagation();
      const key = event.code || event.key;
      if (event.repeat || held.has(key)) return;
      held.add(key);
      callback.current(direction);
    };
    window.addEventListener('keydown', press, true);
    window.addEventListener('keyup', release, true);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      reset();
      window.removeEventListener('keydown', press, true);
      window.removeEventListener('keyup', release, true);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [enabled, scope]);
}
