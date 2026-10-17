import { exhibitionProviderRejection } from '../../shared/exhibitionProviderFailure';
export { exhibitionProviderRejection } from '../../shared/exhibitionProviderFailure';

const diagnosticFields = [
  'reason_code', 'failure_stage', 'business_code', 'http_status', 'rtc_error_code',
  'connection_state', 'connection_reason', 'server_close_reason', 'failure_type', 'network_online',
] as const;

export function safeExhibitionErrorMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(?:dct_|ek_)[A-Za-z0-9_.-]+/gi, '[凭证已隐藏]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[凭证已隐藏]')
    .replace(/(?:tk|uk|sk)-[A-Za-z0-9_-]+/gi, '[凭证已隐藏]')
    .replace(/(?:https?|wss?):\/\/\S+/gi, '[连接地址]')
    .trim().slice(0, 300);
}

function diagnosticValue(value: unknown): string {
  if (typeof value === 'string') return safeExhibitionErrorMessage(value).slice(0, 64);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}


export function exhibitionLiveFailure(cause: unknown, fallbackMessage: string): { message: string; diagnostic: string } {
  const error = cause && typeof cause === 'object' ? cause as Record<string, unknown> : undefined;
  const details = error?.details && typeof error.details === 'object'
    ? error.details as Record<string, unknown> : undefined;
  const code = typeof error?.code === 'string' ? error.code : '';
  const reason = typeof details?.reason_code === 'string' ? details.reason_code : '';
  const rejection = exhibitionProviderRejection(cause);
  let message = safeExhibitionErrorMessage(fallbackMessage);
  if (rejection === 'balance') message = 'XMAX 积分不足，请联系工作人员。';
  else if (code === 'MATERIAL_VERSION_CHANGED') message = '素材已更新，请重新选择。';
  else if (code === 'MATERIAL_NOT_READY' || code === 'REFERENCE_NOT_READY') message = '素材处理中，请稍后重试。';
  else if (code === 'PROVIDER_REJECTED') message = '换装服务拒绝请求，请检查服务配置。';
  else if (code === 'BACKEND_UNAVAILABLE' || code === 'NETWORK_UNAVAILABLE') message = '连接中断，请检查网络后重试。';
  else if (code === 'INVALID_API_KEY') message = 'XMAX 凭证无效，请检查后台配置。';
  else if (details?.business_code === 500 || (typeof details?.http_status === 'number' && details.http_status >= 500))
    message = 'XMAX 生成服务暂时异常，请稍后重试。';
  else if (reason === 'remote_first_frame_timeout') message = '生成画面等待超时，请检查镜端网络后重试。';
  else if (reason === 'local_outbound_track_ended') message = '摄像头已断开，请重新开启。';
  else if (reason === 'local_publish_failed') message = '视频推流启动失败，请重新连接。';
  else if (['local_outbound_zero_sent_frame_rate', 'local_outbound_not_ready', 'local_outbound_track_muted'].includes(reason))
    message = '摄像头画面未能上传，请检查镜端网络后重试。';
  else if (['rtc_reconnect_timeout', 'rtc_async_error'].includes(reason))
    message = '实时视频连接失败，请检查镜端网络后重试。';

  if (!code && !details) return { message, diagnostic: '' };
  const fields: string[] = [];
  const safeCode = diagnosticValue(code);
  if (safeCode) fields.push(`code=${safeCode}`);
  for (const field of diagnosticFields) {
    const value = diagnosticValue(details?.[field]);
    if (value) fields.push(`${field}=${value}`);
  }
  if (typeof error?.message === 'string') {
    const detailMessage = safeExhibitionErrorMessage(error.message);
    if (detailMessage) fields.push(`message=${detailMessage}`);
  }
  return { message, diagnostic: fields.join('; ').slice(0, 230) };
}
