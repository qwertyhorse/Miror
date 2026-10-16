import type { ExhibitionState } from '../shared/exhibition.ts';
import type { ReferencePreparationStatus } from '../shared/referencePreparation.ts';

export interface ReferencePreparationMirror {
  id: string;
  state: Pick<ExhibitionState, 'looks' | 'selectedLookId' | 'enabledLookIds' | 'live'>;
  configured: boolean;
  status: (lookId: string) => ReferencePreparationStatus;
  prepare: (lookId: string) => Promise<unknown>;
}

/** Rebuild priority from current selection each tick; rotate mirrors after each attempt. */
export class ReferencePreparationQueue {
  private running = false;
  private lastMirrorId?: string;
  private readonly lastLookByPriority = new Map<string, string>();

  constructor(private readonly mirrors: () => ReferencePreparationMirror[], private readonly now = Date.now) {}

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const mirrors = this.mirrors().filter(mirror => mirror.configured);
      const previous = mirrors.findIndex(mirror => mirror.id === this.lastMirrorId);
      const ordered = previous < 0 ? mirrors : [...mirrors.slice(previous + 1), ...mirrors.slice(0, previous + 1)];
      const candidates = ordered.map(mirror => ({ mirror, enabled: new Set(mirror.state.enabledLookIds) }));
      let retry: { mirror: ReferencePreparationMirror; lookId: string; cursorKey: string } | undefined;
      // All selected references precede enabled references, then the rest of the catalog.
      for (let priority = 0; priority < 3; priority++) {
        for (const { mirror, enabled } of candidates) {
          const looks = mirror.state.looks.filter(look => {
            const rank = look.id === mirror.state.selectedLookId ? 0 : enabled.has(look.id) ? 1 : 2;
            return look.referenceKind !== 'none' && rank === priority;
          });
          const cursorKey = `${priority}:${mirror.id}`;
          const lastLook = looks.findIndex(look => look.id === this.lastLookByPriority.get(cursorKey));
          const orderedLooks = lastLook < 0 ? looks : [...looks.slice(lastLook + 1), ...looks.slice(0, lastLook + 1)];
          for (const look of orderedLooks) {
            const status = mirror.status(look.id);
            if (status.refreshState === 'preparing' || (status.retryAt ?? 0) > this.now() || status.state === 'preparing' || status.state === 'unconfigured' || status.state === 'not_required'
              || status.state === 'ready'
              || (status.state === 'failed' && (status.retryAt ?? 0) > this.now())) continue;
            if (status.state === 'failed') {
              if (!Number.isFinite(status.retryAt)) continue; // Permanent failure or exhausted automatic attempts.
              retry ??= { mirror, lookId: look.id, cursorKey };
              continue;
            }
            await this.attempt(mirror, look.id, cursorKey);
            return;
          }
        }
      }
      // Repeated timeouts on selected materials must not starve new work on any mirror.
      if (retry) await this.attempt(retry.mirror, retry.lookId, retry.cursorKey);
    } finally { this.running = false; }
  }

  private async attempt(mirror: ReferencePreparationMirror, lookId: string, cursorKey: string) {
    this.lastMirrorId = mirror.id;
    this.lastLookByPriority.set(cursorKey, lookId);
    // Preparation records its safe failure status and cooldown for the staff UI.
    try { await mirror.prepare(lookId); } catch { /* Next tick can serve another eligible reference. */ }
  }
}
