export type ChatRole = "user" | "assistant";

export type UserMessageStatus = "pending" | "confirmed" | "sent" | "failed";
export type AssistantMessageStatus = "waiting" | "processing" | "completed" | "failed";
export type ChatMessageStatus = UserMessageStatus | AssistantMessageStatus;

export interface ChatMessage {
  id: string;
  clientMessageId?: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  status: ChatMessageStatus;
}

export interface ChatTask {
  id: string;
  conversationId: string;
  userMessageId: string;
  status: AssistantMessageStatus;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
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
  modelConfig?: ModelConfig;
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
  unread: boolean;
}

export interface ConversationDetails {
  conversation: Conversation;
  messages: ChatMessage[];
  tasks: ChatTask[];
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}
