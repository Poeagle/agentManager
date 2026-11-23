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

export interface LegacySendGuardPolicy {
  enabled: boolean;
  reminder_enabled?: boolean;
  conditions: SendGuardGroup;
  automatic_rules?: AutomaticSendGuardRule[];
}

export const MAX_REMINDER_SEND_RULES = 20;
export const MAX_SEND_GUARD_PROVIDERS = 32;
export type SendGuardRule = Omit<AutomaticSendGuardRule,'action'> & {
  action: SendGuardAction | 'remind';
  /** Omitted means all Providers, including sessions without a confirmed binding. */
  provider_ids?: string[];
};

export interface SendGuardPolicy {
  enabled: boolean;
  reminder_enabled?: boolean;
  rules: SendGuardRule[];
}

export function normalizeSendGuardPolicy(policy: LegacySendGuardPolicy | SendGuardPolicy): SendGuardPolicy {
  if('rules' in policy)return policy;
  return {
    enabled:policy.enabled,
    ...(policy.reminder_enabled!==undefined?{reminder_enabled:policy.reminder_enabled}:{}),
    rules:[...(policy.automatic_rules??[]),{action:'remind',conditions:policy.conditions}],
  };
}

/** Agent IDs qualify Provider IDs from their management catalog. */
export function sendGuardProviderKey(agentId:string,providerId:string):string {
  return `${agentId}:${providerId}`;
}
