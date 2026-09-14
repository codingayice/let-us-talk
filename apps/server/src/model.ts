import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type ModelMessage } from "ai";
import type { ChatMessage } from "@let-us-talk/shared";
import { config } from "./config.js";

export interface ChatModel {
  reply(input: {
    systemPrompt: string;
    messages: Array<Pick<ChatMessage, "role" | "content">>;
  }): Promise<string>;
}

const provider = createOpenAICompatible({
  name: "configured-provider",
  baseURL: config.llmBaseUrl,
  apiKey: config.llmApiKey,
});

export const chatModel: ChatModel = {
  async reply({ systemPrompt, messages }) {
    const modelMessages: ModelMessage[] = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const result = await generateText({
      model: provider(config.llmModel),
      system: systemPrompt,
      messages: modelMessages,
      temperature: 0.8,
    });

    return result.text;
  },
};
