import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis, Pencil, Trash2 } from 'lucide-react';
import './material-actions-menu.css';

type MaterialActionsMenuProps = {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  disabled?: boolean;
};

export function MaterialActionsMenu({ name, open, onOpenChange, onEdit, onDelete, disabled = false }: MaterialActionsMenuProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocus = useRef(0);
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  const visible = open && !disabled;

  function restoreFocus() {
    const button = trigger.current;
    if (button?.isConnected && !button.disabled) button.focus({ preventScroll: true });
  }
  function close(restore = false) {
    if (restore) restoreFocus();
    change.current(false);
  }
  function openAt(index: number) {
    if (disabled) return;
    initialFocus.current = index;
    if (visible) items.current[index]?.focus({ preventScroll: true });
    else change.current(true);
  }
  function activate(action: () => void) {
    if (!visible) return;
    // The existing edit/confirmation dialog records the focused trigger so it can
    // return there when dismissed, even though this portaled menu has unmounted.
    close(true);
    action();
  }
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const current = items.current.findIndex(item => item === document.activeElement);
    let target: number | undefined;
    if (event.key === 'ArrowDown') target = (current + 1) % 2;
    if (event.key === 'ArrowUp') target = (current + 1 + 2) % 2;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = 1;
    if (target !== undefined) {
      event.preventDefault();
      items.current[target]?.focus({ preventScroll: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      // Let the browser continue from the trigger in normal document order.
      close(true);
    }
  }

  useEffect(() => { if (open && disabled) change.current(false); }, [open, disabled]);

  useLayoutEffect(() => {
    if (!visible) return;
    const anchor = trigger.current;
    const menu = panel.current;
    if (!anchor || !menu) return;
    const position = () => {
      if (!anchor.isConnected) { change.current(false); return; }
      const bounds = anchor.getBoundingClientRect();
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const offsetLeft = window.visualViewport?.offsetLeft ?? 0;
      const offsetTop = window.visualViewport?.offsetTop ?? 0;
      const width = Math.min(176, viewportWidth - 24);
      menu.style.width = `${width}px`;
      const height = menu.getBoundingClientRect().height;
      const below = bounds.bottom + 6;
      const above = bounds.top - height - 6;
      menu.style.left = `${Math.max(offsetLeft + 12, Math.min(bounds.right - width, offsetLeft + viewportWidth - width - 12))}px`;
      menu.style.top = `${Math.max(offsetTop + 12, Math.min(below + height <= offsetTop + viewportHeight - 12 ? below : above, offsetTop + viewportHeight - height - 12))}px`;
    };
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && !menu.contains(target) && !anchor.contains(target)) change.current(false);
    };
    position();
    items.current[initialFocus.current]?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      if (menu.contains(document.activeElement) && anchor.isConnected && !anchor.disabled) anchor.focus({ preventScroll: true });
    };
  }, [visible]);

  return <>
    <button ref={trigger} type="button" className="ex-material-actions-trigger" aria-label={`${name}的更多操作`} aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined} disabled={disabled}
      onClick={() => { if (!disabled) visible ? close(true) : openAt(0); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          openAt(event.key === 'ArrowUp' || event.key === 'End' ? 1 : 0);
        } else if (event.key === 'Escape' && visible) { event.preventDefault(); close(true); }
      }}><Ellipsis size={19} aria-hidden="true" /></button>
    {visible && createPortal(<div ref={panel} id={id} role="menu" aria-label={`${name}的素材操作`} className="ex-material-actions-menu" onKeyDown={navigate}>
      <button ref={element => { items.current[0] = element; }} type="button" role="menuitem" tabIndex={-1} onClick={() => activate(onEdit)}><Pencil size={15} aria-hidden="true" />编辑素材</button>
      <button ref={element => { items.current[1] = element; }} type="button" role="menuitem" tabIndex={-1} className="ex-material-actions-delete" onClick={() => activate(onDelete)}><Trash2 size={15} aria-hidden="true" />删除素材</button>
    </div>, document.body)}
  </>;
}
