import type {
  ChatAcceptedEvent,
  ChatCompletedEvent,
  ChatFailedEvent,
  ChatMessage,
  ChatProcessingEvent,
  ChatTask,
  ChatTypingEvent,
  ConversationSnapshot,
  ConversationSummary,
} from "@let-us-talk/shared";

export type ConnectionState = "offline" | "connecting" | "connected" | "error";

export interface ConversationState {
  conversationId: string;
  characterId: string;
  messages: ChatMessage[];
  tasks: ChatTask[];
  typing: boolean;
  pendingMessageIds: string[];
  error?: string;
}

export interface ChatStoreState {
  activeConversationId: string | null;
  conversations: Record<string, ConversationState>;
  summaries: ConversationSummary[];
  connection: ConnectionState;
  connectionError?: string;
}

export type ChatEventPayload =
  | ChatAcceptedEvent
  | ChatProcessingEvent
  | ChatCompletedEvent
  | ChatFailedEvent
  | ChatTypingEvent;

export interface ChatStateStore {
  getSnapshot(): ChatStoreState;
  subscribe(listener: () => void): () => void;
  setActiveConversation(conversationId: string | null): void;
  setSummaries(summaries: ConversationSummary[]): void;
  applySnapshot(snapshot: ConversationSnapshot): void;
  addPendingMessage(conversationId: string, message: ChatMessage): void;
  setConversationError(conversationId: string, error: string, messageId?: string): void;
  applyEvent(eventName: keyof {
    "chat:accepted": unknown;
    "chat:processing": unknown;
    "chat:completed": unknown;
    "chat:failed": unknown;
    "chat:typing": unknown;
  }, event: ChatEventPayload): void;
  removeConversation(conversationId: string): void;
  clearConversation(conversationId: string): void;
  setConnection(connection: ConnectionState, error?: string): void;
}

function byActivity(left: ConversationSummary, right: ConversationSummary) {
  const activity = right.lastMessageAt.localeCompare(left.lastMessageAt);
  return activity || right.id.localeCompare(left.id);
}

function mergeMessage(messages: ChatMessage[], next: ChatMessage) {
  const index = messages.findIndex((message) => message.id === next.id || (next.clientMessageId && message.clientMessageId === next.clientMessageId));
  if (index < 0) return [...messages, next];
  const copy = [...messages];
  copy[index] = { ...copy[index], ...next };
  return copy;
}

function mergeTask(tasks: ChatTask[], next: ChatTask) {
  const index = tasks.findIndex((task) => task.id === next.id || task.userMessageId === next.userMessageId);
  if (index < 0) return [...tasks, next];
  const copy = [...tasks];
  copy[index] = { ...copy[index], ...next };
  return copy;
}

function stateFromSnapshot(snapshot: ConversationSnapshot): ConversationState {
  return {
    conversationId: snapshot.conversation.id,
    characterId: snapshot.conversation.characterId,
    messages: snapshot.messages ?? [],
    tasks: snapshot.tasks ?? [],
    typing: (snapshot.tasks ?? []).some((task) => task.status === "waiting" || task.status === "processing"),
    pendingMessageIds: [],
  };
}

export function createChatStore(): ChatStateStore {
  let state: ChatStoreState = {
    activeConversationId: null,
    conversations: {},
    summaries: [],
    connection: "offline",
  };
  const listeners = new Set<() => void>();
  const publish = (next: ChatStoreState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const updateConversation = (conversationId: string, update: (current: ConversationState) => ConversationState) => {
    const current = state.conversations[conversationId] ?? { conversationId, characterId: "", messages: [], tasks: [], typing: false, pendingMessageIds: [] };
    publish({ ...state, conversations: { ...state.conversations, [conversationId]: update(current) } });
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setActiveConversation(conversationId) {
      publish({ ...state, activeConversationId: conversationId });
    },
    setSummaries(summaries) {
      publish({ ...state, summaries: [...summaries].sort(byActivity) });
    },
    applySnapshot(snapshot) {
      const conversation = stateFromSnapshot(snapshot);
      const summaries = snapshot.summary.lastMessagePreview
        ? [...state.summaries.filter((summary) => summary.id !== snapshot.summary.id), snapshot.summary].sort(byActivity)
        : state.summaries;
      publish({
        ...state,
        activeConversationId: snapshot.conversation.id,
        conversations: { ...state.conversations, [snapshot.conversation.id]: conversation },
        summaries,
      });
    },
    addPendingMessage(conversationId, message) {
      updateConversation(conversationId, (current) => ({
        ...current,
        messages: mergeMessage(current.messages, message),
        pendingMessageIds: current.pendingMessageIds.includes(message.id) ? current.pendingMessageIds : [...current.pendingMessageIds, message.id],
        error: undefined,
      }));
    },
    setConversationError(conversationId, error, messageId) {
      updateConversation(conversationId, (current) => ({
        ...current,
        error,
        pendingMessageIds: messageId ? current.pendingMessageIds.filter((id) => id !== messageId) : current.pendingMessageIds,
        messages: messageId ? current.messages.map((message) => message.id === messageId || message.clientMessageId === messageId ? { ...message, status: "failed" } : message) : current.messages,
      }));
    },
    applyEvent(eventName, event) {
      if (eventName === "chat:typing") {
        const typingEvent = event as ChatTypingEvent;
        updateConversation(typingEvent.conversationId, (current) => ({ ...current, typing: typingEvent.typing }));
        return;
      }
      updateConversation(event.conversationId, (current) => {
        if (eventName === "chat:accepted") {
          const accepted = event as ChatAcceptedEvent;
          return { ...current, messages: mergeMessage(current.messages, accepted.userMessage), tasks: mergeTask(current.tasks, accepted.task), pendingMessageIds: current.pendingMessageIds.filter((id) => id !== accepted.messageId && id !== accepted.userMessage.id) };
        }
        if (eventName === "chat:processing") {
          const processing = event as ChatProcessingEvent;
          return { ...current, tasks: mergeTask(current.tasks, processing.task), typing: true };
        }
        if (eventName === "chat:completed") {
          const completed = event as ChatCompletedEvent;
          return {
            ...current,
            messages: mergeMessage(mergeMessage(current.messages, completed.userMessage), completed.assistantMessage),
            tasks: mergeTask(current.tasks, completed.task),
            pendingMessageIds: current.pendingMessageIds.filter((id) => id !== completed.messageId && id !== completed.userMessage.id),
            typing: false,
            error: undefined,
          };
        }
        const failed = event as ChatFailedEvent;
        return {
          ...current,
          messages: mergeMessage(current.messages, failed.userMessage),
          tasks: mergeTask(current.tasks, failed.task),
          pendingMessageIds: current.pendingMessageIds.filter((id) => id !== failed.messageId && id !== failed.userMessage.id),
          typing: false,
          error: failed.error,
        };
      });
    },
    removeConversation(conversationId) {
      const conversations = { ...state.conversations };
      delete conversations[conversationId];
      publish({
        ...state,
        activeConversationId: state.activeConversationId === conversationId ? null : state.activeConversationId,
        conversations,
        summaries: state.summaries.filter((summary) => summary.id !== conversationId),
      });
    },
    clearConversation(conversationId) {
      updateConversation(conversationId, (current) => ({ ...current, messages: [], tasks: [], typing: false, pendingMessageIds: [], error: undefined }));
    },
    setConnection(connection, error) {
      publish({ ...state, connection, connectionError: error });
    },
  };
}
