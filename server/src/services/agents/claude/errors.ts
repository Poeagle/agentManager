export function claudeErrorCode(text: string, nativeCode?: string) {
  if (nativeCode === 'rate_limit' || /\b429\b|rate_limit_error/i.test(text)) return 'rate_limit';
  if (/insufficient_balance|insufficient balance/i.test(text)) return 'insufficient_balance';
  if (/\b503\b|no available accounts|service unavailable|api_error/i.test(text)) return 'provider_unavailable';
  if (/\b400\b|invalid_request_error|requires adaptive thinking/i.test(text)) return 'invalid_request';
  if (nativeCode === 'model_not_found' || /selected model.*(?:does not exist|may not exist|access)/i.test(text)) return 'model_unavailable';
  return nativeCode;
}

export function isClaudeExecutionDiagnostic(text: string) {
  return text.startsWith('[ede_diagnostic] ');
}
