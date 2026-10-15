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
    return targets.flatMap(target => [true, false].map(published => {
      const looks = published ? state.publication?.looks ?? [] : state.looks;
      const publishedIds = state.publication?.looks.map(look => look.id) ?? [];
      return { id: `${mirror.id}:${published ? 'published' : 'draft'}:${target ?? 'active'}`,
        state: { looks, selectedLookId: state.selectedLookId, enabledLookIds: published ? publishedIds : state.enabledLookIds, live: state.live },
        configured: target !== undefined || service.status(mirror.id).configured,
        status: (lookId: string) => current.referencePreparationStatus(lookId, published, target),
        prepare: (lookId: string) => current.prepareReference(lookId, target, published) };
    }));
  }), now);
}
