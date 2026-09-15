import type {
  ChatMessage,
  ChatTask,
  ConversationSnapshot,
  ConversationSummary,
  ModelConfig,
} from "@let-us-talk/shared";
import { createChatStore, type ChatStateStore } from "./chat-store.js";
import { SocketIoRealtimeChatClient, type RealtimeChatClient, type RealtimeEvent } from "./realtime-client.js";

export interface ConversationApi {
  list(): Promise<ConversationSummary[]>;
  snapshotById(conversationId: string): Promise<ConversationSnapshot>;
  snapshotByCharacter(characterId: string): Promise<ConversationSnapshot>;
  markRead(conversationId: string): Promise<void>;
  hide(conversationId: string): Promise<void>;
  restore(conversationId: string): Promise<void>;
  clear(conversationId: string): Promise<void>;
}

export interface ConversationRuntime {
  readonly store: ChatStateStore;
  start(): Promise<void>;
  selectConversation(conversationId: string): Promise<void>;
  selectCharacter(characterId: string): Promise<void>;
  send(content: string, modelConfig: ModelConfig, messageId?: string): Promise<void>;
  retry(task: ChatTask, modelConfig: ModelConfig): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  hide(conversationId: string): Promise<void>;
  clear(conversationId: string): Promise<void>;
  stop(): void;
}

function jsonRequest(fetchImpl: typeof fetch, url: string, init?: RequestInit) {
  return fetchImpl(url, init).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "请求失败，请稍后重试");
    return body;
  });
}

export function createConversationApi(fetchImpl: typeof fetch = fetch): ConversationApi {
  return {
    async list() {
      const data = await jsonRequest(fetchImpl, "/api/conversations") as { conversations?: ConversationSummary[] };
      return data.conversations ?? [];
    },
    snapshotById(conversationId) {
      return jsonRequest(fetchImpl, `/api/conversations/by-id/${conversationId}`) as Promise<ConversationSnapshot>;
    },
    snapshotByCharacter(characterId) {
      return jsonRequest(fetchImpl, `/api/conversations/${characterId}`) as Promise<ConversationSnapshot>;
    },
    async markRead(conversationId) {
      await jsonRequest(fetchImpl, `/api/conversations/by-id/${conversationId}/read`, { method: "POST" });
    },
    async hide(conversationId) {
      await jsonRequest(fetchImpl, `/api/conversations/by-id/${conversationId}/hide`, { method: "POST" });
    },
    async restore(conversationId) {
      await jsonRequest(fetchImpl, `/api/conversations/by-id/${conversationId}/restore`, { method: "POST" });
    },
    async clear(conversationId) {
      await jsonRequest(fetchImpl, `/api/conversations/by-id/${conversationId}`, { method: "DELETE" });
    },
  };
}

export function createConversationRuntime(options: { api?: ConversationApi; realtime?: RealtimeChatClient; fetch?: typeof fetch; onSessionInvalidated?: () => void }): ConversationRuntime {
  const store = createChatStore();
  const api = options.api ?? createConversationApi(options.fetch);
  const realtime = options.realtime ?? new SocketIoRealtimeChatClient();
  let stopped = false;
  let started = false;
  let hasConnected = false;
  let selectionVersion = 0;

  function applyEvent(event: RealtimeEvent) {
    if (event.name === "conversation:updated") {
      const summaries = store.getSnapshot().summaries.filter((summary) => summary.id !== event.payload.conversationId);
      const summary = event.payload.conversationId === store.getSnapshot().activeConversationId ? { ...event.payload.summary, unread: false } : event.payload.summary;
      store.setSummaries(summary.status === "hidden" ? summaries : [summary, ...summaries]);
      if (summary.id === store.getSnapshot().activeConversationId) void api.markRead(summary.id).catch(() => undefined);
      return;
    }
    store.applyEvent(event.name, event.payload);
  }

  function connect() {
    realtime.connect({
      onEvent: applyEvent,
      onConnection: (connection, error) => {
        store.setConnection(connection, error);
        if (connection === "connected") {
          const active = store.getSnapshot().activeConversationId;
          const activeState = active ? store.getSnapshot().conversations[active] : undefined;
          if (active && activeState) {
            void realtime.join(active, activeState.characterId);
            if (hasConnected) {
              const recoveryVersion = selectionVersion;
              void api.snapshotById(active).then((snapshot) => {
                if (recoveryVersion === selectionVersion && store.getSnapshot().activeConversationId === active) {
                  store.applySnapshot(snapshot);
                  void api.markRead(active).catch(() => undefined);
                }
              }).catch(() => undefined);
            }
          }
          hasConnected = true;
        }
      },
      onSessionInvalidated: () => {
        store.setConnection("error", "登录状态已失效，请重新登录");
        options.onSessionInvalidated?.();
      },
    });
  }

  async function loadAndActivateConversation(snapshotPromise: Promise<ConversationSnapshot>) {
    const version = ++selectionVersion;
    const snapshot = await snapshotPromise;
    if (stopped || version !== selectionVersion) return;
    if (snapshot.conversation.status === "hidden") {
      await api.restore(snapshot.conversation.id);
      if (stopped || version !== selectionVersion) return;
      const restored = await api.snapshotById(snapshot.conversation.id);
      if (stopped || version !== selectionVersion) return;
      store.applySnapshot(restored);
    } else {
      store.applySnapshot(snapshot);
    }
    const active = store.getSnapshot().activeConversationId;
    if (active && store.getSnapshot().connection === "connected") {
      await realtime.join(active, store.getSnapshot().conversations[active].characterId);
    }
    if (stopped || version !== selectionVersion) return;
    const summaries = store.getSnapshot().summaries.map((summary) => summary.id === active ? { ...summary, unread: false } : summary);
    store.setSummaries(summaries);
    await api.markRead(active!);
  }

  const runtime: ConversationRuntime = {
    store,
    async start() {
      if (started) return;
      stopped = false;
      started = true;
      connect();
      const summaries = await api.list();
      if (stopped) return;
      store.setSummaries(summaries);
      if (selectionVersion === 0 && !store.getSnapshot().activeConversationId) await runtime.selectCharacter("momo");
    },
    async selectConversation(conversationId) {
      await loadAndActivateConversation(api.snapshotById(conversationId));
    },
    async selectCharacter(characterId) {
      await loadAndActivateConversation(api.snapshotByCharacter(characterId));
    },
    async send(content, modelConfig, messageId = crypto.randomUUID()) {
      const active = store.getSnapshot().activeConversationId;
      const conversation = active ? store.getSnapshot().conversations[active] : undefined;
      if (!active || !conversation) throw new Error("请先打开一个会话");
      const message: ChatMessage = { id: messageId, clientMessageId: messageId, role: "user", content: content.trim(), createdAt: new Date().toISOString(), status: "pending" };
      store.addPendingMessage(active, message);
      try {
        const accepted = await realtime.send({ characterId: conversation.characterId, conversationId: active, content: message.content, messageId, modelConfig });
        store.applyEvent("chat:accepted", accepted);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "实时聊天连接失败，请稍后重试";
        store.setConversationError(active, messageText, messageId);
        throw error;
      }
    },
    async retry(task, modelConfig) {
      const active = store.getSnapshot().activeConversationId;
      const conversation = active ? store.getSnapshot().conversations[active] : undefined;
      if (!active || !conversation) throw new Error("请先打开一个会话");
      const message = conversation.messages.find((item) => item.id === task.userMessageId);
      if (!message) throw new Error("原始消息不可用，请重新打开会话");
      try {
        const accepted = await realtime.retry({ characterId: conversation.characterId, conversationId: active, messageId: message.clientMessageId ?? message.id, modelConfig });
        store.applyEvent("chat:accepted", accepted);
      } catch (error) {
        store.setConversationError(active, error instanceof Error ? error.message : "AI 回复重试失败，请稍后重试");
        throw error;
      }
    },
    async markRead(conversationId) {
      const summaries = store.getSnapshot().summaries.map((summary) => summary.id === conversationId ? { ...summary, unread: false } : summary);
      store.setSummaries(summaries);
      await api.markRead(conversationId);
    },
    async hide(conversationId) {
      await api.hide(conversationId);
      store.removeConversation(conversationId);
    },
    async clear(conversationId) {
      await api.clear(conversationId);
      store.clearConversation(conversationId);
      const summaries = await api.list();
      store.setSummaries(summaries);
    },
    stop() {
      stopped = true;
      started = false;
      realtime.close();
      store.setConnection("offline");
    },
  };
  return runtime;
}
