import { fromNodeHeaders } from "better-auth/node";
import { authSessionEvents, type AuthInstance } from "./auth.js";
import { findCharacter, formatConversationPreview } from "./characters.js";
import type { ChatModel } from "./model.js";
import type { ChatMessage, ChatTask, ConversationSummary } from "@let-us-talk/shared";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import type { Server as HttpServer } from "node:http";
import { ChatService, ChatServiceError } from "./chat-service.js";
import type { ChatStore } from "./store.js";
import type { ConversationEventBus } from "./conversation-events.js";

interface RealtimeDependencies {
  auth: AuthInstance;
  chatModel: ChatModel;
  store: ChatStore;
  chatService?: ChatService;
  conversationEvents?: ConversationEventBus;
}

const chatCommandSchema = z.object({
  characterId: z.string().min(1),
  conversationId: z.string().uuid(),
  content: z.string().trim().min(1).max(4000),
  messageId: z.string().uuid().optional(),
});
const retryCommandSchema = z.object({
  characterId: z.string().min(1),
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
});

type ChatAcknowledgment =
  | { ok: true; userMessage: ChatMessage; task?: ChatTask }
  | { ok: false; error: string };
type JoinAcknowledgment = { ok: true } | { ok: false; error: string };
type ChatCommand = z.infer<typeof chatCommandSchema>;
type RetryCommand = z.infer<typeof retryCommandSchema>;

function conversationRoom(conversationId: string) { return `conversation:${conversationId}`; }
function userRoom(userId: string) { return `user:${userId}`; }

function summaryForUser(store: ChatStore, userId: string, conversationId: string): ConversationSummary | undefined {
  const summary = store.listConversations(userId).find((item) => item.id === conversationId);
  if (!summary) return undefined;
  const character = findCharacter(summary.characterId);
  if (!character) return undefined;
  const { systemPrompt: _systemPrompt, ...publicCharacter } = character;
  const { lastMessageRole: _lastMessageRole, ...publicSummary } = summary;
  return { ...publicSummary, character: publicCharacter, lastMessagePreview: formatConversationPreview(character.name, summary.lastMessageRole, summary.lastMessagePreview) };
}

function socketHeaders(socket: Socket) { return fromNodeHeaders(socket.handshake.headers as Record<string, string | undefined>); }

export function attachRealtimeChat(httpServer: HttpServer, dependencies: RealtimeDependencies) {
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  const chatService = dependencies.chatService ?? new ChatService(dependencies.store, dependencies.chatModel);

  function disconnectInvalidatedSocket(socket: Socket) {
    socket.emit("auth:session-invalidated", { eventId: crypto.randomUUID(), reason: "登录已在其他设备完成" });
    socket.disconnect(true);
  }

  function disconnectRevokedSessions(userId: string, sessionIds: string[]) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.userId === userId && sessionIds.includes(socket.data.sessionId as string)) disconnectInvalidatedSocket(socket);
    }
  }

  const onSessionRevoked = ({ userId, sessionIds }: { userId: string; sessionIds: string[] }) => {
    disconnectRevokedSessions(userId, sessionIds);
  };
  authSessionEvents.on("revoked", onSessionRevoked);

  function emitEvent(room: string, event: string, payload: Record<string, unknown>) {
    io.to(room).emit(event, { eventId: crypto.randomUUID(), ...payload });
  }

  io.use(async (socket, next) => {
    try {
      const session = await dependencies.auth.api.getSession({ headers: socketHeaders(socket) });
      if (!session) return next(new Error("请先登录"));
      socket.data.userId = session.user.id;
      socket.data.sessionId = session.session.id;
      return next();
    } catch (error) {
      return next(error instanceof Error ? error : new Error("登录状态无效"));
    }
  });

  async function handleChat(socket: Socket, command: ChatCommand, acknowledge: (value: ChatAcknowledgment) => void) {
    const userId = socket.data.userId as string;
    const character = findCharacter(command.characterId);
    if (!character) { acknowledge({ ok: false, error: "Character not found" }); return; }
    const details = dependencies.store.getConversationById(userId, command.conversationId);
    if (!details || details.conversation.characterId !== character.id) { acknowledge({ ok: false, error: "Conversation not found" }); return; }
    const room = conversationRoom(command.conversationId);
    socket.join(room);
    let acknowledged = false;
    try {
      await chatService.submit({
        userId,
        characterId: character.id,
        conversationId: command.conversationId,
        content: command.content,
        clientMessageId: command.messageId ?? crypto.randomUUID(),
        systemPrompt: character.systemPrompt,
      }, {
        accepted: (userMessage, task) => {
          acknowledged = true;
          acknowledge({ ok: true, userMessage, task });
          emitEvent(room, "chat:accepted", { conversationId: command.conversationId, messageId: userMessage.clientMessageId ?? userMessage.id, userMessage, task });
        },
        processing: (userMessage, task) => {
          emitEvent(room, "chat:processing", { conversationId: command.conversationId, messageId: userMessage.clientMessageId ?? userMessage.id, task });
          emitEvent(room, "chat:typing", { conversationId: command.conversationId, messageId: userMessage.clientMessageId ?? userMessage.id, typing: true });
        },
        completed: (response, task) => {
          emitEvent(room, "chat:completed", { conversationId: command.conversationId, messageId: response.userMessage.clientMessageId ?? response.userMessage.id, userMessage: response.userMessage, assistantMessage: response.assistantMessage, task, summary: summaryForUser(dependencies.store, userId, command.conversationId) });
          const summary = summaryForUser(dependencies.store, userId, command.conversationId);
          if (summary) emitEvent(userRoom(userId), "conversation:updated", { summary });
          emitEvent(room, "chat:typing", { conversationId: command.conversationId, messageId: response.userMessage.clientMessageId ?? response.userMessage.id, typing: false });
        },
        failed: (userMessage, task, error) => {
          emitEvent(room, "chat:failed", { conversationId: command.conversationId, messageId: userMessage.clientMessageId ?? userMessage.id, userMessage, task, error });
          emitEvent(room, "chat:typing", { conversationId: command.conversationId, messageId: userMessage.clientMessageId ?? userMessage.id, typing: false });
        },
      });
    } catch (error) {
      if (acknowledged) return;
      const message = error instanceof Error ? error.message : "请求失败";
      acknowledge({ ok: false, error: error instanceof ChatServiceError ? message : "请求失败" });
    }
  }

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    const sessionId = socket.data.sessionId as string;
    for (const peer of io.sockets.sockets.values()) {
      if (peer !== socket && peer.data.userId === userId && peer.data.sessionId !== sessionId) {
        disconnectInvalidatedSocket(peer);
      }
    }
    socket.join(userRoom(userId));
    const sessionCheck = setInterval(() => {
      void dependencies.auth.api.getSession({ headers: socketHeaders(socket) })
        .then((session) => {
          if (!session || session.session.id !== sessionId) disconnectInvalidatedSocket(socket);
        })
        .catch(() => undefined);
    }, 15_000);
    sessionCheck.unref();
    socket.once("disconnect", () => clearInterval(sessionCheck));
    socket.on("conversation:join", (rawCommand: unknown, acknowledge?: (value: JoinAcknowledgment) => void) => {
      const parsed = z.object({ conversationId: z.string().uuid(), characterId: z.string().min(1) }).safeParse(rawCommand);
      if (!parsed.success) { acknowledge?.({ ok: false, error: "Invalid conversation command" }); return; }
      const details = dependencies.store.getConversationById(socket.data.userId as string, parsed.data.conversationId);
      if (!details || details.conversation.characterId !== parsed.data.characterId) { acknowledge?.({ ok: false, error: "Conversation not found" }); return; }
      socket.join(conversationRoom(parsed.data.conversationId));
      acknowledge?.({ ok: true });
    });

    socket.on("chat:send", (rawCommand: unknown, acknowledge?: (value: ChatAcknowledgment) => void) => {
      const respond = acknowledge ?? (() => undefined);
      const parsed = chatCommandSchema.safeParse(rawCommand);
      if (!parsed.success) { respond({ ok: false, error: "Invalid chat request" }); return; }
      void handleChat(socket, parsed.data, respond);
    });

    socket.on("chat:retry", (rawCommand: unknown, acknowledge?: (value: ChatAcknowledgment) => void) => {
      const respond = acknowledge ?? (() => undefined);
      const parsed = retryCommandSchema.safeParse(rawCommand);
      if (!parsed.success) { respond({ ok: false, error: "Invalid retry request" }); return; }
      const retry = parsed.data as RetryCommand;
      const existing = dependencies.store.findUserMessage(userId, retry.messageId);
      if (!existing || existing.conversationId !== retry.conversationId || existing.characterId !== retry.characterId) {
        respond({ ok: false, error: "Message not found" });
        return;
      }
      void handleChat(socket, {
        characterId: retry.characterId,
        conversationId: retry.conversationId,
        content: existing.message.content,
        messageId: existing.message.clientMessageId ?? existing.message.id,
      }, respond);
    });
  });

  if (dependencies.conversationEvents) {
    const onCompleted = ({ userId, conversationId }: { userId: string; conversationId: string }) => {
      const summary = summaryForUser(dependencies.store, userId, conversationId);
      if (summary) emitEvent(userRoom(userId), "conversation:updated", { summary });
    };
    dependencies.conversationEvents.on("completed", onCompleted);
    io.once("close", () => dependencies.conversationEvents?.off("completed", onCompleted));
  }

  io.once("close", () => authSessionEvents.off("revoked", onSessionRevoked));

  return io;
}
