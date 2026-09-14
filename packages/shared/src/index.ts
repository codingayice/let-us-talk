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
  messageId?: string;
  conversationId?: string;
}

export interface ChatResponse {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

export type ConversationStatus = "active" | "hidden";

export interface Conversation {
  id: string;
  characterId: string;
  createdAt: string;
  updatedAt: string;
  status: ConversationStatus;
}

export type PublicCharacter = Omit<Character, "systemPrompt">;

export interface ConversationSummary {
  id: string;
  character: PublicCharacter;
  lastMessagePreview: string;
  lastMessageAt: string;
  status: ConversationStatus;
}

export interface ConversationDetails {
  conversation: Conversation;
  messages: ChatMessage[];
}
