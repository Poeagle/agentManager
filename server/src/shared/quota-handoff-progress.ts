export interface QuotaHandoffProgress {
  stage: 'checking' | 'preparing' | 'switching' | 'switched' | 'no_account' | 'failed';
  source_account: string | null;
  target_account: string | null;
  failed_turn_id: string | null;
  remaining_ms: number;
}
