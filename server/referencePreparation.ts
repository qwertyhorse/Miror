import type { ReferencePreparationStage } from '../shared/referencePreparation.ts';

export type PreparationFailure = 'network' | 'timeout' | 'status' | 'malformed' | 'not_found' | 'denied' | 'not_configured' | 'unsafe';

/** Only enumerated failures reach the staff UI; upstream responses may contain secrets. */
export class ReferencePreparationError extends Error {
  constructor(readonly stage: ReferencePreparationStage, readonly failure: PreparationFailure) {
    super('Reference preparation failed');
  }
}

export function preparationFailureMessage(error: unknown): string {
  if (!(error instanceof ReferencePreparationError)) return '准备失败，请稍后重试。';
  if (error.failure === 'not_configured') return '请先配置 XMAX 密钥。';
  if (error.failure === 'network') return '网络连接失败，请稍后重试。';
  if (error.failure === 'timeout') return '连接超时，请稍后重试。';
  if (error.failure === 'unsafe') return '图片未通过检查，请更换图片。';
  if (error.failure === 'denied') return error.stage === 'credentials' ? '密钥无效或无上传权限，请检查配置。' : '云端访问被拒绝，请检查配置。';
  if (error.stage === 'credentials') return '上传凭证获取失败，请稍后重试。';
  if (error.stage === 'check') return '图片检查失败，请稍后重试。';
  if (error.stage === 'availability') return '云端图片暂时无法确认，请稍后重试。';
  return '图片上传失败，请稍后重试。';
}
