import { describe, expect, it } from 'vitest';
import { enabledLooksForMode, lookById, runtimeLooksFor } from '../src/exhibition/catalog';
import type { ExhibitionLook, ExhibitionState } from '../shared/exhibition';

const garment: ExhibitionLook = { id: 'shirt', name: '衬衣', description: '', image: '/effective.png', mode: 'clothx', contentVersion: 'effective' };
const state = (changes: Partial<ExhibitionState> = {}): ExhibitionState => ({ providerMode: 'xmax', experienceMode: 'clothx',
  looks: [{ ...garment, image: '/editable.png', contentVersion: 'updating' }], enabledLookIds: ['shirt', 'free'],
  catalog: { revision: 2, providerId: 'xmax', looks: [garment], availableLookIds: ['shirt'] }, ...changes } as ExhibitionState);

describe('server projected material catalogue consumers', () => {
  it('counts and selects the current mirror mode/provider catalogue using its effective image', () => {
    const current = state();
    expect(enabledLooksForMode(current)).toEqual([garment]);
    expect(runtimeLooksFor(current)[0].image).toBe('/effective.png');
    expect(lookById(current, 'shirt')?.contentVersion).toBe('effective');
  });
  it('does not reconstruct availability from editable materials or legacy publication', () => {
    const current = state({ catalog: { revision: 3, providerId: 'xmax', looks: [], availableLookIds: [] } });
    expect(enabledLooksForMode(current)).toEqual([]);
    expect(runtimeLooksFor(current)).toEqual([]);
  });
  it('keeps an active version visible when the item is taken off the available list', () => {
    const current = state({ activeLook: garment, catalog: { revision: 3, providerId: 'xmax', looks: [], availableLookIds: [] } });
    expect(enabledLooksForMode(current)).toEqual([]);
    expect(lookById(current, 'shirt')).toBe(garment);
  });
  it('never mixes material modes into the current available count', () => {
    const current = state({ catalog: { revision: 3, providerId: 'decart', looks: [garment, { ...garment, id: 'free', mode: 'free' }], availableLookIds: ['shirt', 'free'] } });
    expect(enabledLooksForMode(current).map(look => look.id)).toEqual(['shirt']);
  });
});
