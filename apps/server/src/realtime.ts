import { fromNodeHeaders } from "better-auth/node";
import type { AuthInstance } from "./auth.js";
import { findCharacter } from "./characters.js";
import type { ChatModel } from "./model.js";
import type { ChatMessage, ChatTask, ConversationSummary } from "@let-us-talk/shared";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import type { Server as HttpServer } from "node:http";
import { ChatService, ChatServiceError } from "./chat-service.js";
import type { ChatStore } from "./store.js";

interface RealtimeDependencies {
  auth: AuthInstance;
  chatModel: ChatModel;
  store: ChatStore;
  chatService?: ChatService;
}

const chatCommandSchema = z.object({
  characterId: z.string().min(1),
  conversationId: z.string().uuid(),
  content: z.string().trim().min(1).max(4000),
  messageId: z.string().uuid().optional(),
});

type ChatAcknowledgment =
  | { ok: true; userMessage: ChatMessage; task?: ChatTask }
  | { ok: false; error: string };
type JoinAcknowledgment = { ok: true } | { ok: false; error: string };
type ChatCommand = z.infer<typeof chatCommandSchema>;

function conversationRoom(conversationId: string) { return `conversation:${conversationId}`; }

function summaryForUser(store: ChatStore, userId: string, conversationId: string): ConversationSummary | undefined {
  const summary = store.listConversations(userId).find((item) => item.id === conversationId);
  if (!summary) return undefined;
  const character = findCharacter(summary.characterId);
  if (!character) return undefined;
  const { systemPrompt: _, ...publicCharacter } = character;
  return { ...summary, character: publicCharacter };
}

function socketHeaders(socket: Socket) { return fromNodeHeaders(socket.handshake.headers as Record<string, string | undefined>); }

export function attachRealtimeChat(httpServer: HttpServer, dependencies: RealtimeDependencies) {
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  const chatService = dependencies.chatService ?? new ChatService(dependencies.store, dependencies.chatModel);

  function emitEvent(room: string, event: string, payload: Record<string, unknown>) {
    io.to(room).emit(event, { eventId: crypto.randomUUID(), ...payload });
  }

  io.use(async (socket, next) => {
    try {
      const session = await dependencies.auth.api.getSession({ headers: socketHeaders(socket) });
      if (!session) return next(new Error("请先登录"));
      socket.data.userId = session.user.id;
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
  });

  return io;
}
