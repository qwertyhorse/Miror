import { describe, expect, it } from 'vitest';
import { exhibitionLiveFailure, safeExhibitionErrorMessage } from '../src/exhibition/liveFailure';

const fallback = '换装服务连接失败，请由工作人员重试。';

describe('exhibition live failure', () => {
  it.each([
    ['remote_first_frame_timeout', '生成画面等待超时，请检查镜端网络后重试。'],
    ['local_outbound_zero_sent_frame_rate', '摄像头画面未能上传，请检查镜端网络后重试。'],
    ['local_outbound_not_ready', '摄像头画面未能上传，请检查镜端网络后重试。'],
    ['local_publish_failed', '摄像头画面未能上传，请检查镜端网络后重试。'],
    ['local_outbound_track_muted', '摄像头画面未能上传，请检查镜端网络后重试。'],
    ['local_outbound_track_ended', '摄像头已断开，请重新开启。'],
    ['rtc_reconnect_timeout', '实时视频连接失败，请检查镜端网络后重试。'],
    ['rtc_async_error', '实时视频连接失败，请检查镜端网络后重试。'],
  ])('uses explicit SDK reason %s to select concise mirror feedback', (reason, message) => {
    const cause = Object.assign(new Error('provider detail'), { code: 'WEB_RTC_ERROR', details: { reason_code: reason } });

    const failure = exhibitionLiveFailure(cause, fallback);

    expect(failure.message).toBe(message);
    expect(failure.diagnostic).toContain(`reason_code=${reason}`);
    expect(failure.diagnostic).toContain('message=provider detail');
  });

  it('identifies an explicit credential error without inferring it from HTTP status alone', () => {
    expect(exhibitionLiveFailure({ code: 'INVALID_API_KEY', message: 'invalid key' }, fallback).message)
      .toBe('XMAX 凭证无效，请检查后台配置。');
    expect(exhibitionLiveFailure({ code: 'API_ERROR', details: { http_status: 403 } }, fallback).message)
      .toBe(fallback);
  });

  it('keeps ordinary errors and unstructured failures on their supplied fallback', () => {
    for (const cause of [new Error('request timeout'), null, undefined, 'request timeout', { message: 'request timeout' }]) {
      expect(exhibitionLiveFailure(cause, fallback)).toEqual({ message: fallback, diagnostic: '' });
    }
    expect(exhibitionLiveFailure({ code: 'UNKNOWN_ERROR', message: 'request timeout' }, fallback))
      .toEqual({ message: fallback, diagnostic: 'code=UNKNOWN_ERROR; message=request timeout' });
  });

  it('retains only scalar allowlisted diagnostic fields in a stable order', () => {
    const cause = {
      code: 'API_ERROR', message: 'supplier unavailable', apiKey: 'private-value',
      details: {
        network_online: false, rtc_error_code: '1091', http_status: 502, business_code: '46007',
        failure_stage: 'session_api', secret: 'private-value', token: 'private-value',
        session_id: 'private-session', stack: 'private-stack', connection_state: { value: 'invalid' },
      },
    };

    expect(exhibitionLiveFailure(cause, fallback)).toEqual({
      message: fallback,
      diagnostic: 'code=API_ERROR; failure_stage=session_api; business_code=46007; http_status=502; rtc_error_code=1091; network_online=false; message=supplier unavailable',
    });
  });

  it('redacts SDK message and diagnostic values before limiting the report length', () => {
    const cause = {
      code: 'UNKNOWN_ERROR', message: 'sk-private_secret https://provider.example/private?token=tk-hidden',
      details: { failure_stage: 'uk-private_secret', connection_reason: 'wss://provider.example/private', network_online: true },
    };
    const failure = exhibitionLiveFailure(cause, fallback);

    expect(failure.diagnostic).toContain('failure_stage=[凭证已隐藏]');
    expect(failure.diagnostic).toContain('connection_reason=[连接地址]');
    expect(failure.diagnostic).toContain('message=[凭证已隐藏] [连接地址]');
    expect(failure.diagnostic).not.toContain('private');
    expect(exhibitionLiveFailure({ ...cause, message: 'x'.repeat(500) }, fallback).diagnostic.length).toBeLessThanOrEqual(230);
  });

  it('normalizes control characters and caps sanitized display messages', () => {
    expect(safeExhibitionErrorMessage(' \u0000SK-secret\nTK-secret\rUK-secret\tHTTPS://example.test/path\u007f '))
      .toBe('[凭证已隐藏] [凭证已隐藏] [凭证已隐藏] [连接地址]');
    expect(safeExhibitionErrorMessage('x'.repeat(400))).toHaveLength(300);
    expect(exhibitionLiveFailure(null, 'sk-secret https://example.test/path').message)
      .toBe('[凭证已隐藏] [连接地址]');
  });
});
