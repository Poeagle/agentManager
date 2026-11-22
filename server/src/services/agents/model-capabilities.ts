import type {StoredProvider} from './management-store.js';

export interface ModelCapabilities {
  context_window?: number;
  input_modalities?: string[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseModelCapabilities(value: unknown): ModelCapabilities {
  const row = object(value);
  const window = [row.context_window,row.context_length,object(row.top_provider).context_length].find(
    (size): size is number => typeof size === 'number' && Number.isSafeInteger(size) && size > 0 && size <= 10_000_000,
  );
  const inputs = row.input_modalities ?? object(row.architecture).input_modalities;
  const image = object(object(row.capabilities).image_input).supported;
  const modalities = Array.isArray(inputs) && inputs.length <= 12 && inputs.every(
    input => typeof input === 'string' && /^[a-z][a-z_]{0,29}$/.test(input),
  ) ? [...new Set<string>(inputs)] : typeof image === 'boolean' ? image ? ['text','image'] : ['text'] : undefined;
  return {...window ? {context_window:window} : {}, ...modalities ? {input_modalities:modalities} : {}};
}

export function storedModelCapabilities(value: unknown): Record<string, ModelCapabilities> {
  if (typeof value !== 'string' || value.length > 64_000) return {};
  try {
    return Object.fromEntries(Object.entries(object(JSON.parse(value))).slice(0,256).flatMap(([model, row]) => {
      const caps = parseModelCapabilities(row);
      return model.length <= 200 && Object.keys(caps).length ? [[model,caps]] : [];
    }));
  } catch { return {}; }
}

export function saveModelCapabilities(next:StoredProvider['fields'], previous?:StoredProvider['fields'], supplied?:unknown) {
  const prior = next.baseUrl === previous?.baseUrl ? storedModelCapabilities(previous?.modelCapabilities) : {};
  const observed = storedModelCapabilities(supplied);
  const models = Array.isArray(next.models) ? next.models : [];
  const entries = models.flatMap(model => {
    const caps = {...(Object.hasOwn(prior,model)?prior[model]:{}),...(Object.hasOwn(observed,model)?observed[model]:{})};
    return Object.keys(caps).length ? [[model,caps]] : [];
  });
  delete next.modelCapabilities;
  if (entries.length) next.modelCapabilities = JSON.stringify(Object.fromEntries(entries));
}
