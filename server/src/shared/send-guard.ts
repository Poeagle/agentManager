export type SendGuardCondition = {type: 'context_percent' | 'context_tokens' | 'idle_minutes' | 'account_remaining_percent'; value: number};
export interface SendGuardGroup {
  operator: 'and' | 'or';
  conditions: Array<SendGuardCondition | SendGuardGroup>;
}

export const SEND_GUARD_ACTION_LABELS = {
  new: '新开会话',
  brief: '简要压缩',
  compact: '原生压缩',
} as const;
export type SendGuardAction = keyof typeof SEND_GUARD_ACTION_LABELS;
export const MAX_AUTOMATIC_SEND_RULES = 8;

export interface AutomaticSendGuardRule {
  action: SendGuardAction;
  target?: 'available_account';
  conditions: SendGuardGroup;
}

export interface SendGuardPolicy {
  enabled: boolean;
  reminder_enabled?: boolean;
  conditions: SendGuardGroup;
  automatic_rules?: AutomaticSendGuardRule[];
}
