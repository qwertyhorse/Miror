import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Kiosk } from '../src/exhibition/ExhibitionApp';
import { enabledLooksForMode, exhibitionLooks, lookById } from '../src/exhibition/catalog';
import type { ExhibitionState } from '../shared/exhibition';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';
function fixture(): ExhibitionState {
  return { mirrorId: 'default', revision: 1, phase: 'idle', selectedLookId: 'commute', displayedLookId: null, enabledLookIds: ['city', 'commute'], looks: structuredClone(exhibitionLooks),
    experienceMode: 'clothx', categories: ['通勤', '休闲', '礼服'], tags: ['简约', '日常', '优雅'], sessionNumber: 0, generationNumber: 0, updatedAt: 0, generationReadyAt: null,
    settings: { autoReturnSeconds: 90, uploadLimits: { maxFileSizeMB: 10, minWidth: 512, maxWidth: 4096, minHeight: 512, maxHeight: 4096 } }, providerMode: 'demo', live: null, logs: [] };
}
describe('mode-scoped mirror screen', () => {
  it('uses the current skin for terminal, preview and empty states', () => {
    const state = fixture();
    expect(renderToStaticMarkup(createElement(Kiosk, { state }))).toContain('data-skin="crystal"');
    state.settings.uiSkinPreset = 'brand';
    for (const passive of [false, true]) {
      const html = renderToStaticMarkup(createElement(Kiosk, { state, passive }));
      expect(html).toContain('data-skin="brand"'); expect(html).toContain('openbuy-ai-logo-rgb.png');
    }
    state.looks = []; state.enabledLookIds = []; state.selectedLookId = null;
    expect(renderToStaticMarkup(createElement(Kiosk, { state, passive: true }))).toContain('data-skin="brand"');
    state.settings.uiSkin = { image: '/api/exhibition/mirrors/default/skin/custom', width: 1080, height: 1920, bytes: 1000 };
    const custom = renderToStaticMarkup(createElement(Kiosk, { state }));
    expect(custom).toContain('data-skin="custom"'); expect(custom).toContain('background-image:url(');
  });
  it('preserves enabled order while filtering the current mode', () => {
    const state = fixture(); state.looks.find(look => look.id === 'city')!.mode = 'charx';
    expect(enabledLooksForMode(state).map(look => look.id)).toEqual(['commute']);
    state.experienceMode = 'charx'; expect(enabledLooksForMode(state).map(look => look.id)).toEqual(['city']);
    expect(lookById(state, 'does-not-exist')).toBeUndefined();
  });
  it('shows an empty state with disabled start, rather than another mode material', () => {
    const state = fixture(); state.experienceMode = 'charx'; state.selectedLookId = null;
    const html = renderToStaticMarkup(createElement(Kiosk, { state }));
    expect(html).toContain('暂无可用素材'); expect(html).toContain('CharX'); expect(html).toContain('disabled=""');
    expect(html).not.toContain('commute-cutout.png'); expect(html).not.toContain('city-cutout.png');
  });
  it('does not display an out-of-mode selected item from a stale snapshot', () => {
    const state = fixture(); state.experienceMode = 'charx'; state.looks.find(look => look.id === 'city')!.mode = 'charx';
    const html = renderToStaticMarkup(createElement(Kiosk, { state }));
    expect(html).toContain('暂无可用素材'); expect(html).not.toContain('commute-cutout.png');
  });
  it('only renders current mode options on the welcome screen', () => {
    const state = fixture(); state.looks.find(look => look.id === 'city')!.mode = 'charx';
    const html = renderToStaticMarkup(createElement(Kiosk, { state }));
    expect(html).toContain('commute-cutout.png'); expect(html).not.toContain('city-cutout.png'); expect(html).toContain('ClothX');
  });
  it('keeps an empty whole catalogue renderable', () => {
    const state = fixture(); state.looks = []; state.enabledLookIds = []; state.selectedLookId = null;
    expect(renderToStaticMarkup(createElement(Kiosk, { state, passive: true }))).toContain('暂无可用素材');
  });
  it.each(['idle', 'showcase'] as const)('keeps the display cover on the %s demo screen', phase => {
    const state = fixture(); state.phase = phase;
    state.looks.find(look => look.id === 'commute')!.referenceImage = '/generation-reference.png';
    const html = renderToStaticMarkup(createElement(Kiosk, { state }));
    expect(html).toContain('commute-cutout.png'); expect(html).not.toContain('generation-reference.png');
  });
});

describe('mirror video state labels', () => {
  const camera = {} as MediaStream;
  const output = {} as MediaStream;
  function live(overrides: Partial<ExhibitionLiveController> = {}): ExhibitionLiveController {
    return { cameraStream: camera, outputStream: null, interaction: null, presentation: null, status: 'preview', error: '', opening: false,
      deviceId: 'screen-fixture', cameras: [], selectedCameraId: '', mirrored: true, setMirrored: () => {}, startCamera: async () => true,
      stopCamera: () => {}, retry: async () => true, reportFirstFrame: () => {}, secure: true, liveStatus: null, refreshStatus: async () => {}, ...overrides };
  }
  function screen(phase: ExhibitionState['phase'], controller = live(), passive = false, overrides: Partial<ExhibitionState> = {}) {
    const state = { ...fixture(), providerMode: 'xmax' as const, phase, ...overrides };
    return renderToStaticMarkup(createElement(Kiosk, { state, live: controller, passive }));
  }
  function badgeText(html: string) {
    return html.match(/<div class="ex-visual-status"[^>]*>(.*?)<\/div>/)?.[1].replace(/<[^>]+>/g, '') ?? '';
  }

  it('keeps camera capture accessible without a visible local capture badge', () => {
    expect(badgeText(screen('idle'))).toBe('');
    expect(badgeText(screen('select'))).toBe('');
    expect(badgeText(screen('positioning'))).toBe('');
    expect(badgeText(screen('generating', live({ status: 'preparing' })))).toBe('准备素材');
    expect(screen('positioning')).toContain('aria-label="本地取景"');
  });

  it.each(['clothx', 'charx', 'free'] as const)('keeps local capture visible before publishing %s materials without enabling generation', experienceMode => {
    const controller = live({ cameraStream: { getVideoTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream });
    for (const phase of ['idle', 'select'] as const) {
      const html = screen(phase, controller, false, { experienceMode, selectedLookId: null,
        publication: { revision: 1, publishedAt: 1, legacy: false, looks: [] } });
      expect(html).toContain('aria-label="本地取景"');
      expect(html).toContain('暂无可用素材');
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?开始体验<\/button>/);
      expect(html).not.toContain('commute-cutout.png');
      expect(html).not.toContain('生成结果');
    }
  });

  it('keeps local capture visible when the whole material catalogue is empty', () => {
    const controller = live({ cameraStream: { getVideoTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream });
    const html = screen('idle', controller, false, { looks: [], enabledLookIds: [], selectedLookId: null });
    expect(html).toContain('aria-label="本地取景"');
    expect(html).toContain('暂无可用素材');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?开始体验<\/button>/);
  });

  it.each(['passive', 'remote', 'mox', 'foreign'] as const)('does not show local capture in an empty %s screen', scenario => {
    const state: ExhibitionState = { ...fixture(), providerMode: 'xmax', selectedLookId: null,
      experienceMode: scenario === 'mox' ? 'mox' : 'clothx',
      publication: { revision: 1, publishedAt: 1, legacy: false, looks: [] },
      live: scenario === 'foreign' ? { deviceId: 'another-screen' } as ExhibitionState['live'] : null };
    const controller = live({ cameraStream: { getVideoTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream });
    const html = renderToStaticMarkup(createElement(Kiosk, { state, live: controller,
      passive: scenario === 'passive', presentation: scenario === 'remote' ? 'remote' : 'terminal' }));
    expect(html).toContain('暂无可用素材');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('aria-label="本地取景"');
  });

  it('waits for confirmed output instead of treating an allocated stream as a result', () => {
    const connecting = screen('generating', live({ outputStream: output, status: 'connecting' }));
    expect(badgeText(connecting)).toBe('连接实时服务');
    expect(connecting).not.toContain('生成结果');
    expect(badgeText(screen('showcase', live({ outputStream: output, status: 'running' })))).toBe('生成结果');
  });

  it('does not label a previous running stream as the result of a newly selected material', () => {
    expect(badgeText(screen('generating', live({ outputStream: output, status: 'running' })))).toBe('等待生成画面');
  });

  it('does not call a missing camera local capture', () => {
    expect(badgeText(screen('generating', live({ cameraStream: null, status: 'opening' })))).toBe('开启摄像头');
  });

  it.each(['off', 'preview'] as const)('does not claim generation has started while %s', status => {
    const html = screen('generating', live({ status }));
    expect(badgeText(html)).toBe('等待连接');
    expect(html).not.toContain('正在生成');
  });

  it('shows server-side stop failures instead of claiming a new round is generating', () => {
    const html = screen('generating', live(), false, { live: { deviceId: 'screen-fixture', status: 'error', generationNumber: 0, lookId: 'commute' } as ExhibitionState['live'] });
    expect(html).toContain('连接暂未恢复');
    expect(html).toContain('换装连接状态未确认，请联系工作人员。');
    expect(badgeText(html)).toBe('');
    expect(html).not.toContain('重试</button>');
  });

  it('retains concise server failure feedback after a refresh on the selection screen', () => {
    const html = screen('select', live(), false, { live: { deviceId: 'screen-fixture', status: 'error', generationNumber: 0, lookId: 'commute', error: 'technical diagnostic code=INTERNAL_ERROR' } as ExhibitionState['live'] });
    expect(html).toContain('换装连接状态未确认，请联系工作人员。');
    expect(html).not.toContain('technical diagnostic');
    expect(html).not.toContain('code=');
    expect(badgeText(html)).toBe('');
  });

  it('keeps camera capture clear after pausing without retaining a stale generating status', () => {
    expect(badgeText(screen('paused', live({ status: 'connecting' })))).toBe('');
    const failed = screen('generating', live({ error: '连接已断开', status: 'error' }));
    expect(badgeText(failed)).toBe('');
    expect(failed).toContain('画面暂未连接');
  });

  it('keeps backend previews explicit about receiving state instead of video', () => {
    const html = screen('generating', live({ outputStream: output, status: 'running' }), true);
    expect(html).toContain('aria-label="镜端状态预览"');
    expect(html).toContain('仅同步状态，未回传镜端视频');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('class="ex-loading-state"');
    expect(badgeText(html)).toBe('');
  });

  it('does not claim another display video is local capture', () => {
    const html = screen('generating', live(), false, { live: { deviceId: 'another-screen' } as ExhibitionState['live'] });
    expect(html).not.toContain('<video');
    expect(badgeText(html)).toBe('');
    expect(html).toContain('当前页面未接收镜端视频');
  });

  it('distinguishes a MoX input image from generated output even with a running stream', () => {
    const state = fixture();
    state.looks.find(look => look.id === 'commute')!.mode = 'mox';
    const controller = live({ outputStream: output, status: 'running', presentation: { showInputImage: true, inputImageUrl: '/input.png' } as ExhibitionLiveController['presentation'] });
    const html = screen('showcase', controller, false, { experienceMode: 'mox', looks: state.looks });
    expect(badgeText(html)).toBe('素材预览');
    expect(html).toContain('src="/input.png"');
    expect(html).not.toContain('生成结果');
    expect(badgeText(screen('showcase', { ...controller, presentation: null }, false, { experienceMode: 'mox', looks: state.looks }))).toBe('生成结果');
  });
  it('uses the MoX reference for its interactive fallback and the display cover before the experience', () => {
    const state = fixture();
    Object.assign(state.looks.find(look => look.id === 'commute')!, { mode: 'mox', referenceImage: '/generation-reference.png' });
    const options = { experienceMode: 'mox' as const, looks: state.looks };
    const controller = live({ cameraStream: null, status: 'connecting' });
    const welcome = screen('idle', controller, false, options);
    expect(welcome).toContain('commute-cutout.png'); expect(welcome).not.toContain('generation-reference.png');
    const active = screen('generating', controller, false, options);
    expect(active).toContain('class="mox-drag-image" src="/generation-reference.png"');
    const presented = screen('showcase', live({ outputStream: output, presentation: { showInputImage: true, inputImageUrl: '/sdk-input.png' } as ExhibitionLiveController['presentation'] }), false, options);
    expect(presented).toContain('class="mox-drag-image" src="/sdk-input.png"');
    expect(presented).not.toContain('generation-reference.png');
  });
});
