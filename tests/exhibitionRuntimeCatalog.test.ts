import { expect, it } from 'vitest';
import { enabledLooksForMode, lookById, looksFor } from '../src/exhibition/catalog';
import type { ExhibitionState } from '../shared/exhibition';
it('uses frozen published display/reference versions for realtime and preserves draft catalog in demo and administration', () => {
  const published = { id:'a', name:'已发布', mode:'clothx', image:'/published.jpg', referenceImage:'/published-reference.jpg' };
  const draft = { ...published, name:'草稿', image:'/draft.jpg', referenceImage:'/draft-reference.jpg' };
  const state = { providerMode:'xmax', experienceMode:'clothx', looks:[draft], enabledLookIds:[], publication:{ looks:[published] } } as unknown as ExhibitionState;
  expect(enabledLooksForMode(state)).toEqual([published]); expect(lookById(state,'a')).toEqual(published);
  expect(looksFor(state)).toEqual([draft]);
  const demo = { ...state, providerMode:'demo', enabledLookIds:['a'] } as ExhibitionState;
  expect(enabledLooksForMode(demo)).toEqual([draft]); expect(lookById(demo,'a')).toEqual(draft);
  expect(enabledLooksForMode({ ...demo, enabledLookIds:[] })).toEqual([]);
});
