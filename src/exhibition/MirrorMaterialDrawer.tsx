import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ExhibitionLook } from '../../shared/exhibition';
import { appUrl } from '../versionScope';

export function MirrorMaterialDrawer({ looks, selectedId, disabled, passive, title, columns = 2, open: controlledOpen, onOpenChange, onSelect, onBusyChange }: {
  looks: ExhibitionLook[]; selectedId: string | null; disabled: boolean; passive: boolean; title: string;
  columns?: 1 | 2; open?: boolean; onOpenChange?: (open: boolean) => void;
  onSelect: (id: string) => Promise<boolean>; onBusyChange: (busy: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(value);
    onOpenChange?.(value);
  };
  const [busy, setBusy] = useState(false);
  const [optimisticId, setOptimisticId] = useState<string | null>(null);
  const intent = useRef<string | null>(null);
  const requests = useRef({ epoch: 0, latest: 0, acknowledged: 0, count: 0 });
  const current = useRef({ looks, selectedId, disabled, passive, onSelect });
  current.current = { looks, selectedId, disabled, passive, onSelect };
  const alive = useRef(true);
  const toggle = useRef<HTMLButtonElement>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; requests.current.epoch++; onBusyChange(false); };
  }, [onBusyChange]);
  useEffect(() => {
    if (open) selected.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, selectedId, optimisticId]);
  useEffect(() => {
    if (!disabled && !passive) return;
    requests.current.epoch++; requests.current.count = 0;
    intent.current = null; setOptimisticId(null); setBusy(false); onBusyChange(false);
  }, [disabled, passive, onBusyChange]);
  useEffect(() => {
    if (intent.current && ((requests.current.acknowledged === requests.current.latest && selectedId === intent.current)
      || !looks.some(look => look.id === intent.current))) {
      intent.current = null; setOptimisticId(null);
    }
  }, [selectedId, looks]);
  async function choose(id: string) {
    const latest = current.current;
    if (latest.disabled || latest.passive || id === (intent.current ?? latest.selectedId) || !latest.looks.some(look => look.id === id)) return;
    const epoch = requests.current.epoch;
    const request = ++requests.current.latest;
    requests.current.count++;
    intent.current = id; setOptimisticId(id); setBusy(true); onBusyChange(true);
    let accepted = false;
    try { accepted = await latest.onSelect(id); }
    catch { /* The controller displays command failures. */ }
    finally {
      if (alive.current && requests.current.epoch === epoch) {
        requests.current.count--;
        const pending = requests.current.count > 0;
        setBusy(pending); onBusyChange(pending);
        if (request === requests.current.latest) {
          if (accepted) requests.current.acknowledged = request;
          if (!accepted || current.current.selectedId === id) { intent.current = null; setOptimisticId(null); }
        }
      }
    }
  }
  const highlightedId = optimisticId ?? selectedId;
  return <div className={`ex-mirror-drawer${open ? ' is-open' : ''}`} data-columns={columns} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); toggle.current?.focus(); }
  }}>
    {open && <div id={panelId} className="ex-mirror-drawer-panel">
      <strong>{title}</strong>
      <div className="ex-mirror-drawer-grid" role="group" aria-label={title} aria-busy={busy}>
        {looks.map(look => <button key={look.id} ref={look.id === highlightedId ? selected : undefined} type="button"
          className={`ex-mirror-drawer-item${look.id === highlightedId ? ' is-selected' : ''}`} title={look.name}
          aria-label={`选择${look.name}`} aria-pressed={look.id === highlightedId} disabled={disabled || passive}
          onClick={() => void choose(look.id)}>
          <img src={appUrl(look.image)} alt="" draggable={false} loading="lazy" />
          {look.id === highlightedId && <span className="ex-mirror-drawer-check" aria-hidden="true"><Check /></span>}
        </button>)}
      </div>
    </div>}
    <button ref={toggle} type="button" className="ex-mirror-drawer-toggle" disabled={passive}
      aria-label={open ? '收起素材选择' : title} aria-expanded={open} aria-controls={panelId}
      onClick={() => setOpen(!open)}>{open ? <ChevronLeft /> : <ChevronRight />}</button>
  </div>;
}
