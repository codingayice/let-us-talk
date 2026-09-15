import type {
  ChatAcceptedEvent,
  ChatCompletedEvent,
  ChatFailedEvent,
  ChatProcessingEvent,
  ChatTypingEvent,
  ChatTask,
  ChatMessage,
  ConversationSummary,
  ModelConfig,
} from "@let-us-talk/shared";
import { io, type Socket } from "socket.io-client";
import type { ConnectionState } from "./chat-store.js";

export type RealtimeEvent =
  | { name: "chat:accepted"; payload: ChatAcceptedEvent }
  | { name: "chat:processing"; payload: ChatProcessingEvent }
  | { name: "chat:completed"; payload: ChatCompletedEvent }
  | { name: "chat:failed"; payload: ChatFailedEvent }
  | { name: "chat:typing"; payload: ChatTypingEvent }
  | { name: "conversation:updated"; payload: { eventId: string; conversationId: string; summary: import("@let-us-talk/shared").ConversationSummary } };

export interface RealtimeChatClient {
  connect(handlers: { onEvent: (event: RealtimeEvent) => void; onConnection: (state: ConnectionState, error?: string) => void; onSessionInvalidated: () => void }): void;
  join(conversationId: string, characterId: string): Promise<void>;
  send(command: { characterId: string; conversationId: string; content: string; messageId: string; modelConfig: ModelConfig }): Promise<ChatAcceptedEvent>;
  retry(command: { characterId: string; conversationId: string; messageId: string; modelConfig: ModelConfig }): Promise<ChatAcceptedEvent>;
  close(): void;
}

type Acknowledgment = { ok: boolean; error?: string } & Partial<ChatAcceptedEvent>;

export class SocketIoRealtimeChatClient implements RealtimeChatClient {
  private socket: Socket | null = null;
  private removeListeners: (() => void) | null = null;

  connect(handlers: { onEvent: (event: RealtimeEvent) => void; onConnection: (state: ConnectionState, error?: string) => void; onSessionInvalidated: () => void }) {
    const socket = io({ withCredentials: true, autoConnect: true });
    this.socket = socket;
    const eventNames = ["chat:accepted", "chat:processing", "chat:completed", "chat:failed", "chat:typing", "conversation:updated"] as const;
    const listeners = eventNames.map((name) => {
      const listener = (payload: unknown) => handlers.onEvent({ name, payload } as RealtimeEvent);
      socket.on(name, listener);
      return () => socket.off(name, listener);
    });
    const onConnect = () => handlers.onConnection("connected");
    const onDisconnect = () => handlers.onConnection("offline");
    const onConnectError = (error: Error) => handlers.onConnection("error", error.message.includes("请先登录") ? "实时聊天需要登录" : "实时聊天连接失败，请稍后重试");
    const onInvalidated = () => handlers.onSessionInvalidated();
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("auth:session-invalidated", onInvalidated);
    handlers.onConnection("connecting");
    this.removeListeners = () => {
      listeners.forEach((remove) => remove());
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("auth:session-invalidated", onInvalidated);
    };
  }

  private emit(command: "chat:send" | "chat:retry", payload: object) {
    if (!this.socket?.connected) return Promise.reject(new Error("实时聊天连接不可用，请稍后重试"));
    return new Promise<ChatAcceptedEvent>((resolve, reject) => {
      this.socket!.emit(command, payload, (ack: Acknowledgment) => {
        if (!ack.ok) {
          reject(new Error(ack.error ?? "聊天请求失败"));
          return;
        }
        if (!ack.userMessage || !ack.task) {
          reject(new Error("聊天服务未返回受理结果"));
          return;
        }
        resolve({ eventId: "ack", conversationId: (payload as { conversationId: string }).conversationId, messageId: ack.userMessage.clientMessageId ?? ack.userMessage.id, userMessage: ack.userMessage, task: ack.task });
      });
    });
  }

  join(conversationId: string, characterId: string) {
    if (!this.socket?.connected) return Promise.reject(new Error("实时聊天连接不可用，请稍后重试"));
    return new Promise<void>((resolve, reject) => {
      this.socket!.emit("conversation:join", { conversationId, characterId }, (ack: { ok: boolean; error?: string }) => ack.ok ? resolve() : reject(new Error(ack.error ?? "会话订阅失败")));
    });
  }

  send(command: { characterId: string; conversationId: string; content: string; messageId: string; modelConfig: ModelConfig }) {
    return this.emit("chat:send", command);
  }

  retry(command: { characterId: string; conversationId: string; messageId: string; modelConfig: ModelConfig }) {
    return this.emit("chat:retry", command);
  }

  close() {
    this.removeListeners?.();
    this.removeListeners = null;
    this.socket?.close();
    this.socket = null;
  }
}

/**
 * Adapter used only by the mocked browser contract tests. Production always
 * uses SocketIoRealtimeChatClient; keeping this behind the adapter boundary
 * lets the UI tests exercise the same runtime event contract without a model.
 */
export class HttpMockRealtimeChatClient implements RealtimeChatClient {
  private handlers: { onEvent: (event: RealtimeEvent) => void; onConnection: (state: ConnectionState, error?: string) => void; onSessionInvalidated: () => void } | null = null;
  private contents = new Map<string, string>();

  connect(handlers: { onEvent: (event: RealtimeEvent) => void; onConnection: (state: ConnectionState, error?: string) => void; onSessionInvalidated: () => void }) {
    this.handlers = handlers;
    handlers.onConnection("connected");
  }

  join() {
    return Promise.resolve();
  }

  send(command: { characterId: string; conversationId: string; content: string; messageId: string; modelConfig: ModelConfig }) {
    this.contents.set(command.messageId, command.content);
    return this.startMockRequest(command, false);
  }

  retry(command: { characterId: string; conversationId: string; messageId: string; modelConfig: ModelConfig }) {
    return this.startMockRequest({ ...command, content: this.contents.get(command.messageId) ?? "" }, true);
  }

  close() {
    this.handlers = null;
  }

  private startMockRequest(command: { characterId: string; conversationId: string; content: string; messageId: string; modelConfig: ModelConfig }, retry: boolean) {
    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: command.messageId, clientMessageId: command.messageId, role: "user", content: command.content, createdAt: now, status: "accepted" };
    const task: ChatTask = { id: `mock-task-${command.messageId}`, conversationId: command.conversationId, userMessageId: command.messageId, status: "processing", attempts: retry ? 2 : 1, createdAt: now, updatedAt: now };
    const accepted: ChatAcceptedEvent = { eventId: crypto.randomUUID(), conversationId: command.conversationId, messageId: command.messageId, userMessage, task };
    this.handlers?.onEvent({ name: "chat:accepted", payload: accepted });
    void fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: command.characterId, conversationId: command.conversationId, content: command.content, messageId: command.messageId, modelConfig: command.modelConfig }) })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { userMessage?: ChatMessage; assistantMessage?: ChatMessage; error?: string };
        if (!response.ok || !data.assistantMessage) throw new Error(data.error ?? "请求失败");
        const completedTask: ChatTask = { ...task, status: "completed", updatedAt: new Date().toISOString() };
        const completedUserMessage = data.userMessage ? { ...data.userMessage, clientMessageId: data.userMessage.clientMessageId ?? command.messageId } : userMessage;
        this.handlers?.onEvent({ name: "chat:completed", payload: { eventId: crypto.randomUUID(), conversationId: command.conversationId, messageId: command.messageId, userMessage: completedUserMessage, assistantMessage: data.assistantMessage, task: completedTask } });
        const characterNames: Record<string, string> = { momo: "Momo", loki: "Loki", nora: "Nora" };
        const summary: ConversationSummary = { id: command.conversationId, character: { id: command.characterId, name: characterNames[command.characterId] ?? command.characterId, avatar: "", tagline: "" }, lastMessagePreview: `${characterNames[command.characterId] ?? command.characterId}：${data.assistantMessage.content}`, lastMessageAt: new Date().toISOString(), status: "active", unread: false };
        this.handlers?.onEvent({ name: "conversation:updated", payload: { eventId: crypto.randomUUID(), conversationId: command.conversationId, summary } });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error && error.name === "TypeError" ? "网络连接失败，请稍后重试" : error instanceof Error ? error.message : "请求失败";
        this.handlers?.onEvent({ name: "chat:failed", payload: { eventId: crypto.randomUUID(), conversationId: command.conversationId, messageId: command.messageId, userMessage: { ...userMessage, status: "failed" }, task: { ...task, status: "failed", error: message, updatedAt: new Date().toISOString() }, error: message } });
      });
    return Promise.resolve(accepted);
  }
}
