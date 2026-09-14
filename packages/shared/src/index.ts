export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface Character {
  id: string;
  name: string;
  avatar: string;
  tagline: string;
  systemPrompt: string;
}

export interface ChatRequest {
  characterId: string;
  content: string;
}

export interface ChatResponse {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}
