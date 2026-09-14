import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type ModelMessage } from "ai";
import { z } from "zod";
import type { ChatMessage, ModelConfig } from "@let-us-talk/shared";

export interface ChatModel {
  reply(input: {
    systemPrompt: string;
    messages: Array<Pick<ChatMessage, "role" | "content">>;
    modelConfig?: ModelConfig;
  }): Promise<string>;
}

export const modelConfigSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048),
  apiKey: z.string().min(1).max(4096),
  model: z.string().trim().min(1).max(512),
}).strict();

export type ModelErrorCategory =
  | "config_missing"
  | "config_invalid"
  | "authentication_failed"
  | "model_not_found"
  | "service_unavailable"
  | "timeout"
  | "provider_request_failed";

const modelErrorMessages: Record<ModelErrorCategory, string> = {
  config_missing: "请先配置模型",
  config_invalid: "模型配置无效",
  authentication_failed: "模型认证失败，请检查 API Key",
  model_not_found: "模型不存在，请检查 Model",
  service_unavailable: "模型服务不可达，请检查 Base URL",
  timeout: "模型请求超时，请稍后重试",
  provider_request_failed: "模型服务请求失败，请稍后重试",
};

export class ModelError extends Error {
  constructor(public readonly category: ModelErrorCategory) {
    super(modelErrorMessages[category]);
    this.name = "ModelError";
  }
}

export function validateModelConfig(value: unknown): ModelConfig {
  if (value === undefined || value === null) throw new ModelError("config_missing");
  const parsed = modelConfigSchema.safeParse(value);
  if (!parsed.success) throw new ModelError("config_invalid");
  let url: URL;
  try {
    url = new URL(parsed.data.baseUrl);
  } catch {
    throw new ModelError("config_invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ModelError("config_invalid");
  if (url.username || url.password) throw new ModelError("config_invalid");
  return { baseUrl: parsed.data.baseUrl, apiKey: parsed.data.apiKey, model: parsed.data.model };
}

export function modelErrorResponse(error: unknown) {
  const safeError = toModelError(error);
  return { error: safeError.message, code: safeError.category, category: safeError.category };
}

function statusFromError(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  if ("statusCode" in error) return Number(error.statusCode);
  if ("status" in error) return Number(error.status);
  return undefined;
}

export function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof Error && (error.name === "ModelTimeoutError" || error.name === "ChatTimeoutError" || error.name === "TimeoutError")) {
    return new ModelError("timeout");
  }
  const status = statusFromError(error);
  if (status === 401 || status === 403) return new ModelError("authentication_failed");
  if (status === 404) return new ModelError("model_not_found");
  if (status === 408 || status === 504) return new ModelError("timeout");
  if (error instanceof TypeError || (error instanceof Error && ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH"].some((code) => error.message.includes(code)))) {
    return new ModelError("service_unavailable");
  }
  return new ModelError("provider_request_failed");
}

export function withModelTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Model request timed out");
      error.name = "ModelTimeoutError";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createConfiguredModel(modelConfig: ModelConfig): ChatModel {
  const provider = createOpenAICompatible({
    name: "configured-provider",
    baseURL: modelConfig.baseUrl,
    apiKey: modelConfig.apiKey,
  });
  return {
    async reply({ systemPrompt, messages }) {
      const modelMessages: ModelMessage[] = messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));
      const result = await generateText({
        model: provider(modelConfig.model),
        system: systemPrompt,
        messages: modelMessages,
        temperature: 0.8,
      });
      return result.text;
    },
  };
}

export const chatModel: ChatModel = {
  async reply(input) {
    const modelConfig = validateModelConfig(input.modelConfig);
    return createConfiguredModel(modelConfig).reply(input);
  },
};
