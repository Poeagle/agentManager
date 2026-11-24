export const HARNESS_URL_SETTING = 'deepseek_harness_url';
export const HARNESS_MODEL_SETTING = 'deepseek_harness_model';
export const HARNESS_BRIDGE = 'octoally:dsh/1';
export const HARNESS_PROVIDER_BRIDGE = 'octoally:dsh-providers/1';

export interface HarnessModelSelection {
  provider: string;
  model: string;
}

export interface HarnessProvider {
  id: string;
  name: string;
  baseUrl?: string;
  protocol?: string;
  models: Array<{ id: string; name?: string; available: boolean }>;
  editable: boolean;
}

export interface HarnessProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  protocol: string;
  models: string[];
  apiKey: string;
}

export function harnessModelSelection(settings?: Record<string, string>): HarnessModelSelection | undefined {
  try {
    const { url, provider, model } = JSON.parse(settings?.[HARNESS_MODEL_SETTING] || 'null');
    if (url === settings?.[HARNESS_URL_SETTING] && typeof provider === 'string' && typeof model === 'string') {
      return { provider, model };
    }
  } catch { /* No saved model. */ }
}
