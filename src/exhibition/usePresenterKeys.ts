import { useEffect, useRef } from 'react';

export type PresenterDirection = -1 | 1;
export type PresenterAction = 'experience' | 'menu';
export interface PresenterActionKey { code: string; key?: string; minHoldMs?: number }

function directionFor(key: string): PresenterDirection | null {
  if (['PageUp', 'ArrowLeft', 'ArrowUp'].includes(key)) return -1;
  if (['PageDown', 'ArrowRight', 'ArrowDown'].includes(key)) return 1;
  return null;
}

const editingTarget = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], dialog, [role="dialog"], [role="alertdialog"]';

function editing(event: Event) {
  return [event.target, ...event.composedPath(), document.activeElement].some(target =>
    typeof (target as Element | null)?.closest === 'function' && (target as Element).closest(editingTarget));
}

function blocked(event: KeyboardEvent) {
  return event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
    || document.hidden || editing(event);
}

function pressToken(event: KeyboardEvent) {
  return event.code && event.code !== 'Unidentified' ? `code:${event.code}` : `key:${event.key}`;
}

function normalizedBindings(keys: Partial<Record<PresenterAction, PresenterActionKey>> | undefined) {
  return (['experience', 'menu'] as const).flatMap(action => {
    const value = keys?.[action];
    if (!value) return [];
    const code = value.code && value.code !== 'Unidentified' ? value.code : '';
    const key = value.key && value.key !== 'Unidentified' ? value.key : '';
    const minHoldMs = value.minHoldMs ?? 0;
    if ((!code && !key) || directionFor(code) || directionFor(key) || !Number.isFinite(minHoldMs) || minHoldMs < 0) return [];
    return [{ action, code, key, minHoldMs }];
  });
}

/** HID presenters reach the foreground browser as keyboard events on Linux. */
export function usePresenterKeys({ enabled, scope, onStep, actionKeys, onActionPress }: {
  enabled: boolean; scope: string; onStep: (direction: PresenterDirection) => void;
  actionKeys?: Partial<Record<PresenterAction, PresenterActionKey>>;
  onActionPress?: (action: PresenterAction) => (() => void) | null;
}) {
  const callback = useRef(onStep);
  const actionCallback = useRef(onActionPress);
  callback.current = onStep;
  actionCallback.current = onActionPress;
  const bindings = normalizedBindings(actionKeys);
  // Inline mapping objects are common; only a changed mapping cancels a press.
  const bindingSignature = JSON.stringify(bindings);
  useEffect(() => {
    if (!enabled) return;
    const held = new Set<string>();
    const actions = new Map<string, { startedAt: number; minHoldMs: number; commit: (() => void) | null }>();
    const reset = () => { held.clear(); actions.clear(); };
    const focus = (event: Event) => { if (editing(event)) reset(); };
    const release = (event: KeyboardEvent) => {
      const key = pressToken(event);
      held.delete(key);
      const action = actions.get(key);
      actions.delete(key);
      if (!action || blocked(event)) return;
      event.preventDefault();
      event.stopPropagation();
      // Commit only on a matching release: a lost keyup can never start a session.
      if (performance.now() - action.startedAt >= action.minHoldMs) action.commit?.();
    };
    const press = (event: KeyboardEvent) => {
      const direction = directionFor(event.key) ?? directionFor(event.code);
      if (blocked(event)) { actions.clear(); return; }
      const matching = bindings.filter(binding => binding.code ? binding.code === event.code : binding.key === event.key);
      // Direction keys retain their existing meaning; ambiguous action mappings do nothing.
      const action = !direction && matching.length === 1 ? matching[0] : undefined;
      if (!direction && !action) return;
      // Consume blocked presses too, so they cannot scroll the mirror or move focus.
      event.preventDefault();
      event.stopPropagation();
      const key = pressToken(event);
      if (event.repeat || held.has(key)) return;
      held.add(key);
      if (direction) callback.current(direction);
      else if (action) actions.set(key, { startedAt: performance.now(), minHoldMs: action.minHoldMs,
        commit: actionCallback.current?.(action.action) ?? null });
    };
    window.addEventListener('keydown', press, true);
    window.addEventListener('keyup', release, true);
    window.addEventListener('blur', reset);
    window.addEventListener('focusin', focus);
    document.addEventListener('visibilitychange', reset);
    return () => {
      reset();
      window.removeEventListener('keydown', press, true);
      window.removeEventListener('keyup', release, true);
      window.removeEventListener('blur', reset);
      window.removeEventListener('focusin', focus);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [enabled, scope, bindingSignature]);
}
