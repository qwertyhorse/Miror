import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ExhibitionLook } from '../../shared/exhibition';
import { appUrl } from '../versionScope';

export function MirrorMaterialDrawer({ looks, selectedId, disabled, passive, title, onSelect, onBusyChange }: {
  looks: ExhibitionLook[]; selectedId: string | null; disabled: boolean; passive: boolean; title: string;
  onSelect: (id: string) => Promise<boolean>; onBusyChange: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const toggle = useRef<HTMLButtonElement>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; onBusyChange(false); };
  }, [onBusyChange]);
  useEffect(() => {
    if (open) selected.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, selectedId]);
  async function choose(id: string) {
    if (disabled || passive || inFlight.current || id === selectedId || !looks.some(look => look.id === id)) return;
    inFlight.current = true; setBusy(true); onBusyChange(true);
    try { await onSelect(id); }
    catch { /* The controller displays command failures. */ }
    finally { inFlight.current = false; if (alive.current) { setBusy(false); onBusyChange(false); } }
  }
  return <div className={`ex-mirror-drawer${open ? ' is-open' : ''}`} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); toggle.current?.focus(); }
  }}>
    {open && <div id={panelId} className="ex-mirror-drawer-panel">
      <strong>{title}</strong>
      <div className="ex-mirror-drawer-grid" role="group" aria-label={title} aria-busy={busy}>
        {looks.map(look => <button key={look.id} ref={look.id === selectedId ? selected : undefined} type="button"
          className={`ex-mirror-drawer-item${look.id === selectedId ? ' is-selected' : ''}`} title={look.name}
          aria-label={`选择${look.name}`} aria-pressed={look.id === selectedId} disabled={disabled || passive || busy}
          onClick={() => void choose(look.id)}>
          <img src={appUrl(look.image)} alt="" draggable={false} loading="lazy" />
          {look.id === selectedId && <span className="ex-mirror-drawer-check" aria-hidden="true"><Check /></span>}
        </button>)}
      </div>
    </div>}
    <button ref={toggle} type="button" className="ex-mirror-drawer-toggle" disabled={passive}
      aria-label={open ? '收起素材选择' : title} aria-expanded={open} aria-controls={panelId}
      onClick={() => setOpen(value => !value)}>{open ? <ChevronLeft /> : <ChevronRight />}</button>
  </div>;
}
