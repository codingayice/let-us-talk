export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface StoredModelConfig {
  version: 1;
  config: ModelConfig;
}

export const MODEL_CONFIG_STORAGE_KEY = "let-us-talk:model-config:v1";

export function readModelConfig(): ModelConfig | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_CONFIG_STORAGE_KEY) ?? "null") as Partial<StoredModelConfig> | null;
    if (parsed?.version !== 1 || !parsed.config || typeof parsed.config !== "object") return null;
    const { baseUrl, apiKey, model } = parsed.config;
    if (typeof baseUrl !== "string" || typeof apiKey !== "string" || typeof model !== "string") return null;
    return { baseUrl, apiKey, model };
  } catch {
    return null;
  }
}

export function writeModelConfig(config: ModelConfig) {
  localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify({ version: 1, config } satisfies StoredModelConfig));
}

export function clearModelConfig() {
  localStorage.removeItem(MODEL_CONFIG_STORAGE_KEY);
}

export function validateModelConfig(config: ModelConfig): string {
  if (!config.baseUrl.trim()) return "请输入 Base URL";
  if (!config.apiKey.trim()) return "请输入 API Key";
  if (!config.model.trim()) return "请输入 Model";
  try {
    const url = new URL(config.baseUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Base URL 仅支持 http 或 https";
  } catch {
    return "请输入有效的 Base URL";
  }
  return "";
}
