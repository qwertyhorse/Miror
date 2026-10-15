import { describe, expect, it } from 'vitest';
import { parseMaterialManifest } from '../src/exhibition/materialManifest';
const header = 'sku,name,mode,category,display_file,reference_file\n';
describe('explicit material manifest', () => {
  it('pairs exact role paths independently of selected file order and preserves quoted names', () => {
    expect(parseMaterialManifest(header + 'SKU-1,"Coat, white",clothx,coat,display/a.jpg,reference/a.png', ['reference/a.png','display/a.jpg'])).toEqual([{ sku:'SKU-1',name:'Coat, white',mode:'clothx',category:'coat',displayFile:'display/a.jpg',referenceFile:'reference/a.png' }]);
  });
  it.each([
    ['A,one,clothx,,a.jpg,b.jpg\nA,two,clothx,,a.jpg,b.jpg', ['a.jpg','b.jpg']],
    ['A,one,clothx,,a.jpg,b.jpg', ['A.jpg','b.jpg']],
    ['A,one,clothx,,a.jpg,b.jpg', ['a.jpg','a.jpg','b.jpg']],
    ['A,one,invalid,,a.jpg,b.jpg', ['a.jpg','b.jpg']],
  ])('rejects duplicate SKU, missing/duplicate exact file and invalid mode before mutation', (rows, files) => { expect(() => parseMaterialManifest(header + rows, files)).toThrow(); });
});
it('accepts all shared modes and requires Free prompt before import', () => {
  for (const mode of ['charx','vibex','dimx']) expect(parseMaterialManifest(header + `A,one,${mode},,a.jpg,b.jpg`,['a.jpg','b.jpg'])[0].mode).toBe(mode);
  expect(() => parseMaterialManifest(header + 'A,one,free,,a.jpg,b.jpg',['a.jpg','b.jpg'])).toThrow('prompt');
  expect(parseMaterialManifest(header.trim() + ',prompt\nA,one,free,,a.jpg,b.jpg,森林场景',['a.jpg','b.jpg'])[0].prompt).toBe('森林场景');
});
it.each([
  'sku,name,mode,category,display_file,reference_file,sku\nA,one,clothx,,a.jpg,b.jpg,A',
  header + 'A,one,clothx,,a.jpg,b.jpg,extra',
  header + 'A,one"bad,clothx,,a.jpg,b.jpg',
  header + 'A,"one"bad,clothx,,a.jpg,b.jpg',
])('rejects malformed CSV before processing any row', text => expect(() => parseMaterialManifest(text,['a.jpg','b.jpg'])).toThrow());
