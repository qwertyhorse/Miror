import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameraLabels } from '../src/exhibition/cameraLabels';
import { LiveCameraPanel } from '../src/exhibition/LiveCameraPanel';
import type { ExhibitionLiveController } from '../src/exhibition/useExhibitionLive';

afterEach(() => vi.unstubAllGlobals());

describe('camera names for multiple physical devices', () => {
  const cameras = [
    { deviceId: 'camera-b', label: 'Insta360 Link 2 Pro' },
    { deviceId: 'camera-a', label: 'Insta360 Link 2 Pro' },
    { deviceId: 'built-in', label: 'FaceTime HD Camera' },
  ];

  it('keeps distinct numbers for identical names when two pages enumerate in different orders', () => {
    expect(cameraLabels(cameras)).toEqual(['Insta360 Link 2 Pro · 2', 'Insta360 Link 2 Pro · 1', 'FaceTime HD Camera']);
    expect(cameraLabels([...cameras].reverse())).toEqual(['FaceTime HD Camera', 'Insta360 Link 2 Pro · 1', 'Insta360 Link 2 Pro · 2']);
    expect(cameraLabels([{ deviceId: 'hidden', label: '' }])).toEqual(['摄像头 1']);
  });

  it('shows numbered options while preserving exact camera IDs and the current selection', () => {
    vi.stubGlobal('window', { location: { hostname: 'xuminghong.local' } });
    const live = { cameras, selectedCameraId: 'camera-b', secure: true, status: 'preview', cameraStream: null,
      opening: false, mirrored: true, error: '' } as unknown as ExhibitionLiveController;
    const html = renderToStaticMarkup(createElement(LiveCameraPanel, { live }));
    expect(html).toContain('data-value="camera-b"');
    expect(html).toContain('<span>Insta360 Link 2 Pro · 2</span>');
    const unselected = renderToStaticMarkup(createElement(LiveCameraPanel, { live: { ...live, selectedCameraId: '' } }));
    expect(unselected).toContain('<span>选择摄像头</span>');
    expect(unselected).not.toContain('<span>FaceTime HD Camera</span>');
  });
});
