import type { ChatMessage, ChatResponse, ChatTask } from "@let-us-talk/shared";
import { ModelError, type ModelErrorCategory, toModelError, withModelTimeout, type ChatModel } from "./model.js";
import type { ChatStore, PreparedChat } from "./store.js";
import { config } from "./config.js";

export class ChatServiceError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly category?: ModelErrorCategory) {
    super(message);
  }
}

export interface ChatJob {
  userId: string;
  characterId: string;
  conversationId: string;
  content: string;
  clientMessageId: string;
  systemPrompt: string;
  modelConfig?: Parameters<ChatModel["reply"]>[0]["modelConfig"];
}

export interface ChatJobCallbacks {
  accepted?: (message: ChatMessage, task: ChatTask) => void;
  processing?: (message: ChatMessage, task: ChatTask) => void;
  completed?: (response: ChatResponse, task: ChatTask) => void;
  failed?: (message: ChatMessage, task: ChatTask, error: string, category?: ModelErrorCategory) => void;
}

function isRetryable(error: unknown) {
  if (error instanceof ModelError && error.category === "timeout") return false;
  if (error instanceof Error && (error.name === "ModelTimeoutError" || error.name === "ChatTimeoutError" || error.name === "TimeoutError")) return false;
  const status = typeof error === "object" && error !== null
    ? "status" in error ? Number(error.status) : "statusCode" in error ? Number(error.statusCode) : 500
    : 500;
  return !Number.isFinite(status) || status >= 500;
}

export class ChatService {
  private readonly queues = new Map<string, Promise<ChatResponse>>();
  private readonly queueDepths = new Map<string, number>();

  constructor(private readonly store: ChatStore, private readonly chatModel: ChatModel) {}

  submit(job: ChatJob, callbacks: ChatJobCallbacks = {}) {
    const requestJob = { ...job, modelConfig: job.modelConfig ? { ...job.modelConfig } : undefined };
    const existing = this.store.findUserMessage(requestJob.userId, requestJob.clientMessageId);
    const queueDepth = this.queueDepths.get(requestJob.conversationId) ?? 0;
    if (Math.max(queueDepth, this.store.countActiveTasks(requestJob.conversationId)) >= config.maxQueuedTasksPerConversation && !existing) {
      return Promise.reject(new ChatServiceError(429, "当前会话消息较多，请稍后重试"));
    }
    this.queueDepths.set(requestJob.conversationId, queueDepth + 1);
    const previous = this.queues.get(requestJob.conversationId) ?? Promise.resolve(undefined as unknown as ChatResponse);
    const current = previous.catch(() => undefined as unknown as ChatResponse).then(() => this.process(requestJob, callbacks));
    this.queues.set(requestJob.conversationId, current);
    void current.then(
      () => this.releaseQueueSlot(requestJob.conversationId, current),
      () => this.releaseQueueSlot(requestJob.conversationId, current),
    );
    return current;
  }

  private releaseQueueSlot(conversationId: string, current: Promise<ChatResponse>) {
    if (this.queues.get(conversationId) === current) this.queues.delete(conversationId);
    const depth = (this.queueDepths.get(conversationId) ?? 1) - 1;
    if (depth > 0) this.queueDepths.set(conversationId, depth);
    else this.queueDepths.delete(conversationId);
  }

  private async process(job: ChatJob, callbacks: ChatJobCallbacks): Promise<ChatResponse> {
    let prepared: PreparedChat;
    try {
      prepared = this.store.prepareChat(job.userId, job.characterId, job.content, job.clientMessageId, job.conversationId);
    } catch (error) {
      throw new ChatServiceError(404, error instanceof Error ? error.message : "Conversation not found");
    }
    if (prepared.conversationId !== job.conversationId) throw new ChatServiceError(409, "Message id belongs to another conversation");

    let task = prepared.task;
    const details = this.store.getConversationById(job.userId, job.conversationId);
    if (!details) throw new ChatServiceError(404, "Conversation not found");
    const userIndex = details.messages.findIndex((message) => message.id === prepared.userMessage.id);
    const existingAssistant = details.messages[userIndex + 1];
    if (task.status === "completed" && existingAssistant?.role === "assistant") {
      callbacks.accepted?.(prepared.userMessage, task);
      const response = { userMessage: prepared.userMessage, assistantMessage: existingAssistant };
      callbacks.completed?.(response, task);
      return response;
    }
    if (task.status === "processing") throw new ChatServiceError(409, "消息正在处理中，请稍后恢复会话");
    if (task.status === "failed") task = this.store.updateTask(job.userId, task.id, { status: "waiting", error: "" });

    callbacks.accepted?.(prepared.userMessage, task);
    const processingMessage = this.store.updateMessageStatus(job.userId, prepared.userMessage.id, "accepted");
    task = this.store.updateTask(job.userId, task.id, { status: "processing", error: "" });
    callbacks.processing?.(processingMessage, task);
    const context = this.buildContext(details.messages, prepared.userMessage);

    let assistantContent = "";
    let lastError: unknown;
    const finalAttempt = task.attempts + 2;
    for (let attempt = task.attempts + 1; attempt <= finalAttempt; attempt += 1) {
      task = this.store.updateTask(job.userId, task.id, { status: "processing", attempts: attempt, error: "" });
      try {
        assistantContent = (await withModelTimeout(this.chatModel.reply({ systemPrompt: job.systemPrompt, messages: context, modelConfig: job.modelConfig }), config.llmTimeoutMs)).trim();
        if (!assistantContent) throw new Error("Chat model returned an empty response");
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= finalAttempt || !isRetryable(error)) break;
      }
    }

    if (lastError || !assistantContent) {
      const modelError = toModelError(lastError);
      const message = modelError.message;
      task = this.store.updateTask(job.userId, task.id, { status: "failed", error: message });
      const userMessage = this.store.updateMessageStatus(job.userId, prepared.userMessage.id, "sent");
      callbacks.failed?.(userMessage, task, message, modelError.category);
      const statusCode = modelError.category === "config_missing" || modelError.category === "config_invalid" ? 400 : modelError.category === "timeout" ? 504 : 502;
      throw new ChatServiceError(statusCode, message, modelError.category);
    }

    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: assistantContent, createdAt: new Date().toISOString(), status: "completed" };
    this.store.saveMessage(job.userId, job.characterId, assistantMessage, job.conversationId);
    const userMessage = this.store.updateMessageStatus(job.userId, prepared.userMessage.id, "sent");
    task = this.store.updateTask(job.userId, task.id, { status: "completed", error: "" });
    const response = { userMessage, assistantMessage };
    callbacks.completed?.(response, task);
    return response;
  }

  private buildContext(messages: ChatMessage[], current: ChatMessage): Array<Pick<ChatMessage, "role" | "content">> {
    const completed = messages.filter((message) => message.status === "sent" || message.status === "completed");
    const withoutCurrent = completed.filter((message) => message.id !== current.id);
    const selected = [...withoutCurrent, current].slice(-config.maxContextMessages);
    let total = 0;
    const bounded: Array<Pick<ChatMessage, "role" | "content">> = [];
    for (const message of [...selected].reverse()) {
      if (total + message.content.length > config.maxContextCharacters && bounded.length > 0) break;
      bounded.unshift({ role: message.role, content: message.content });
      total += message.content.length;
    }
    return bounded;
  }
}
