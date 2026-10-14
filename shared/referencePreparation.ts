export type ReferencePreparationStage = 'credentials' | 'upload' | 'check' | 'availability';

/** Safe, URL-free progress for the staff material library. */
export interface ReferencePreparationStatus {
  state: 'queued' | 'preparing' | 'ready' | 'failed' | 'unconfigured' | 'not_required';
  message?: string;
  retryAt?: number;
  updatedAt?: number;
  freshUntil?: number;
  stage?: ReferencePreparationStage;
}
