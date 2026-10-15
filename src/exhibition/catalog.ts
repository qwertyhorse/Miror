import type { ExhibitionLook, ExhibitionPhase, ExhibitionState } from '../../shared/exhibition';

export const exhibitionLooks: ExhibitionLook[] = [
  { id: 'commute', name: '轻盈通勤', description: '自然有型，从容出发', image: '/assets/exhibition/commute-cutout.png', palette: '奶油白 · 燕麦色', category: '通勤', tags: ['简约'], mode: 'clothx', source: 'sample' },
  { id: 'city', name: '都市休闲', description: '日常灵感，时髦百搭', image: '/assets/exhibition/city-cutout.png', palette: '可可棕 · 牛仔蓝', category: '休闲', tags: ['日常'], mode: 'clothx', source: 'sample' },
  { id: 'evening', name: '优雅礼服', description: '气场加持，重要时刻', image: '/assets/exhibition/evening-cutout.png', palette: '经典黑 · 象牙白', category: '礼服', tags: ['优雅'], mode: 'clothx', source: 'sample' },
];
export const looksFor = (state: ExhibitionState) => state.looks ?? exhibitionLooks;
export const runtimeLooksFor = (state: ExhibitionState) => state.providerMode === 'xmax' && state.publication ? state.publication.looks : looksFor(state);
export const lookById = (state: ExhibitionState, id: string | null) => runtimeLooksFor(state).find(look => look.id === id);
export const enabledLooksForMode = (state: ExhibitionState) => (state.providerMode === 'xmax' && state.publication ? state.publication.looks.map(look => look.id) : state.enabledLookIds).flatMap(id => {
  const look = runtimeLooksFor(state).find(item => item.id === id);
  return look && (look.mode ?? 'clothx') === (state.experienceMode ?? 'clothx') ? [look] : [];
});
export const phaseLabel: Record<ExhibitionPhase, string> = {
  idle: '待机展示', select: '正在选素材', positioning: '正在准备画面', generating: '正在准备画面', showcase: '正在展示', paused: '体验已暂停',
};
