import { ReferencePreparationQueue } from './referencePreparationQueue.ts';
import type { ExhibitionMirrors } from './exhibitionMirrors.ts';
import type { TryOnService } from './service.ts';

/** Automatically prepare every configured provider without changing the active provider. */
export function createMaterialPreparationQueue(exhibition: ExhibitionMirrors, service: TryOnService, now = Date.now) {
  return new ReferencePreparationQueue(() => exhibition.list().mirrors.flatMap(mirror => {
    const current = exhibition.getMirror(mirror.id); const state = current.get();
    const settings = service.providerSettings(mirror.id);
    const targets: ('xmax' | 'decart' | undefined)[] = settings
      ? (['xmax', 'decart'] as const).filter(provider => settings.accounts[provider].configured)
      : [undefined];
    return targets.map(target => ({ id: `${mirror.id}:${target ?? 'active'}`,
      state: { looks: state.looks.filter(look => target !== 'decart' || look.mode === 'clothx'), selectedLookId: state.selectedLookId, enabledLookIds: state.enabledLookIds, live: state.live },
      configured: target !== undefined || service.providerDescriptor(mirror.id).configured,
      status: (lookId: string) => current.referencePreparationStatus(lookId, false, target),
      prepare: (lookId: string) => current.prepareReference(lookId, target) }));
  }), now);
}
