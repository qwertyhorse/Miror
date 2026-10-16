import type { ExhibitionState } from '../../shared/exhibition';

/** Explicit server response fixture for scenarios whose listed materials are prepared. */
export function materialCatalogFixture(state: ExhibitionState): ExhibitionState {
  const enabled = new Set(state.enabledLookIds);
  const looks = (state.looks ?? []).filter(look => enabled.has(look.id) && (look.mode ?? 'clothx') === (state.experienceMode ?? 'clothx'));
  return { ...state, catalog: state.catalog ?? { revision: state.revision, providerId: 'xmax', looks, availableLookIds: looks.map(look => look.id) } };
}
