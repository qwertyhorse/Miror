import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MirrorDeviceBinding } from '../src/exhibition/MirrorDeviceBinding';
import type { ExhibitionDeviceBinding, ExhibitionMirrorSummary, ExhibitionState } from '../shared/exhibition';
import type { ExhibitionController } from '../src/exhibition/useExhibition';
import type { MirrorRegistry } from '../src/exhibition/useMirrors';

const binding: ExhibitionDeviceBinding = { terminalId: 'terminal-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: '入口安卓镜端', platform: 'android', boundAt: 1_800_000_000_000, lastSeenAt: 1_800_000_000_000, online: true };
const mirror: ExhibitionMirrorSummary = { id: 'default', name: '智能镜 1', phase: 'idle', revision: 1, providerMode: 'demo', updatedAt: 1_800_000_000_000, binding: null };
function render(device: ExhibitionDeviceBinding | null, options: { phase?: ExhibitionState['phase']; live?: ExhibitionState['live']; connected?: boolean; pending?: boolean } = {}) {
  const controller = { state: { phase: options.phase ?? 'idle', live: options.live ?? null }, connected: options.connected ?? true, pending: options.pending ?? false } as ExhibitionController;
  const registry = { data: { defaultMirrorId: 'default', mirrors: [{ ...mirror, binding: device }] }, error: '', refresh: async () => {} } as unknown as MirrorRegistry;
  return renderToStaticMarkup(createElement(MirrorDeviceBinding, { mirror: { ...mirror, binding: device }, controller, registry }));
}

describe('staff terminal binding presentation', () => {
  it('explains where to obtain a six-digit code before pairing a device', () => {
    const html = render(null);
    expect(html).toContain('镜端设备'); expect(html).toContain('未绑定'); expect(html).toContain('绑定镜端设备');
    expect(html).toContain('镜端点击「绑定设备」获取绑定码，安卓客户端未绑定时自动显示。');
    expect(html).not.toContain('disabled=""');
  });

  it('shows only public online device details, even when unexpected secret fields are present', () => {
    const html = render({ ...binding, token: 'do-not-render-terminal-secret', tokenHash: 'do-not-render-hash', code: '654321' } as ExhibitionDeviceBinding);
    expect(html).toContain('入口安卓镜端'); expect(html).toContain('在线'); expect(html).toContain('安卓客户端'); expect(html).toContain('最近连接：');
    expect(html).not.toContain('do-not-render'); expect(html).not.toContain('654321');
  });

  it('shows offline state after restart without rendering an epoch date as a recent connection', () => {
    const html = render({ ...binding, online: false, lastSeenAt: 0 });
    expect(html).toContain('离线'); expect(html).toContain('等待镜端重新连接。');
    expect(html).not.toContain('最近连接：'); expect(html).not.toContain('1970');
  });

  it('disables both bind and unbind while a session is active or synchronization is unavailable', () => {
    for (const device of [null, binding]) {
      for (const options of [{ phase: 'generating' as const }, { live: { sessionId: 'live-session' } as ExhibitionState['live'] }, { connected: false }, { pending: true }]) {
        expect(render(device, options)).toContain('disabled=""');
      }
    }
  });
});
