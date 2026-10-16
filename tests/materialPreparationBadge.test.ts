import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ReferencePreparationBadge } from '../src/exhibition/ReferencePreparationBadge';
import type { ReferencePreparationStatus } from '../shared/referencePreparation';

const badge = (status: ReferencePreparationStatus) => renderToStaticMarkup(createElement(ReferencePreparationBadge,
  { name: '衬衣', status, unavailable: false, retrying: false, now: 999999, onRetry: () => {} }));
it('keeps a persistent ready reference available after historical freshness time', () => {
  const html = badge({ state: 'ready', freshUntil: 1 });
  expect(html).toContain('衬衣：可用'); expect(html).not.toContain('重新上传');
});
it.each([
  ['preparing', '可用 · 更新处理中'], ['failed', '可用 · 更新失败'],
] as const)('shows an old usable version separately from %s update status', (refreshState, text) => {
  expect(badge({ state: 'ready', refreshState, message: '更新失败' })).toContain(text);
});
it.each(['queued', 'preparing', 'failed', 'unconfigured', 'not_required'] as const)('uses the three-state vocabulary for %s', state => {
  expect(badge({ state })).toContain(state === 'not_required' ? '衬衣：可用' : state === 'queued' || state === 'preparing' ? '衬衣：处理中' : '衬衣：需处理');
});
