import { fromNodeHeaders } from "better-auth/node";
import type { AuthInstance } from "./auth.js";
import { findCharacter } from "./characters.js";
import type { ChatModel } from "./model.js";
import type { ChatStore } from "./store.js";
import type { ChatMessage, ConversationSummary } from "@let-us-talk/shared";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import type { Server as HttpServer } from "node:http";

interface RealtimeDependencies {
  auth: AuthInstance;
  chatModel: ChatModel;
  store: ChatStore;
}

const chatCommandSchema = z.object({
  characterId: z.string().min(1),
  conversationId: z.string().uuid(),
  content: z.string().trim().min(1).max(4000),
  messageId: z.string().uuid().optional(),
});

type ChatAcknowledgment =
  | { ok: true; userMessage: ChatMessage }
  | { ok: false; error: string };

type JoinAcknowledgment = { ok: true } | { ok: false; error: string };

type ChatCommand = z.infer<typeof chatCommandSchema>;

function conversationRoom(conversationId: string) {
  return `conversation:${conversationId}`;
}

function summaryForUser(store: ChatStore, userId: string, conversationId: string): ConversationSummary | undefined {
  const summary = store.listConversations(userId).find((item) => item.id === conversationId);
  if (!summary) return undefined;
  const character = findCharacter(summary.characterId);
  if (!character) return undefined;
  const { systemPrompt: _, ...publicCharacter } = character;
  return { ...summary, character: publicCharacter };
}

function socketHeaders(socket: Socket) {
  return fromNodeHeaders(socket.handshake.headers as Record<string, string | undefined>);
}

export function attachRealtimeChat(httpServer: HttpServer, dependencies: RealtimeDependencies) {
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  const queues = new Map<string, Promise<void>>();

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
    if (!character) {
      acknowledge({ ok: false, error: "Character not found" });
      return;
    }
    const details = dependencies.store.getConversationById(userId, command.conversationId);
    if (!details || details.conversation.characterId !== character.id) {
      acknowledge({ ok: false, error: "Conversation not found" });
      return;
    }

    socket.join(conversationRoom(command.conversationId));
    const existingIndex = details.messages.findIndex((message) => message.id === command.messageId);
    const existingUserMessage = details.messages[existingIndex];
    const existingAssistantMessage = details.messages[existingIndex + 1];
    if (command.messageId && existingUserMessage && existingUserMessage.role !== "user") {
      acknowledge({ ok: false, error: "Message id already belongs to another message" });
      return;
    }
    if (existingUserMessage?.role === "user" && existingAssistantMessage?.role === "assistant") {
      acknowledge({ ok: true, userMessage: existingUserMessage });
      socket.emit("chat:completed", {
        conversationId: command.conversationId,
        messageId: existingUserMessage.id,
        userMessage: existingUserMessage,
        assistantMessage: existingAssistantMessage,
        summary: summaryForUser(dependencies.store, userId, command.conversationId),
      });
      return;
    }

    const userMessage = existingUserMessage?.role === "user"
      ? existingUserMessage
      : {
          id: command.messageId ?? crypto.randomUUID(),
          role: "user" as const,
          content: command.content,
          createdAt: new Date().toISOString(),
        };
    if (!existingUserMessage) {
      try {
        dependencies.store.saveMessage(userId, character.id, userMessage, command.conversationId);
      } catch {
        acknowledge({ ok: false, error: "Message could not be saved" });
        return;
      }
    }

    acknowledge({ ok: true, userMessage });
    io.to(conversationRoom(command.conversationId)).emit("chat:typing", {
      conversationId: command.conversationId,
      messageId: userMessage.id,
      typing: true,
    });

    try {
      const assistantContent = (await dependencies.chatModel.reply({
        systemPrompt: character.systemPrompt,
        messages: [...details.messages.filter((message) => message.id !== userMessage.id), userMessage],
      })).trim();
      if (!assistantContent) throw new Error("Chat model returned an empty response");
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: assistantContent,
        createdAt: new Date().toISOString(),
      };
      dependencies.store.saveMessage(userId, character.id, assistantMessage, command.conversationId);
      io.to(conversationRoom(command.conversationId)).emit("chat:completed", {
        conversationId: command.conversationId,
        messageId: userMessage.id,
        userMessage,
        assistantMessage,
        summary: summaryForUser(dependencies.store, userId, command.conversationId),
      });
    } catch {
      io.to(conversationRoom(command.conversationId)).emit("chat:failed", {
        conversationId: command.conversationId,
        messageId: userMessage.id,
        userMessage,
        error: "AI 暂时不可用，请稍后再试",
      });
    } finally {
      io.to(conversationRoom(command.conversationId)).emit("chat:typing", {
        conversationId: command.conversationId,
        messageId: userMessage.id,
        typing: false,
      });
    }
  }

  io.on("connection", (socket) => {
    socket.on("conversation:join", (rawCommand: unknown, acknowledge?: (value: JoinAcknowledgment) => void) => {
      const parsed = z.object({ conversationId: z.string().uuid(), characterId: z.string().min(1) }).safeParse(rawCommand);
      if (!parsed.success) {
        acknowledge?.({ ok: false, error: "Invalid conversation command" });
        return;
      }
      const details = dependencies.store.getConversationById(socket.data.userId as string, parsed.data.conversationId);
      if (!details || details.conversation.characterId !== parsed.data.characterId) {
        acknowledge?.({ ok: false, error: "Conversation not found" });
        return;
      }
      socket.join(conversationRoom(parsed.data.conversationId));
      acknowledge?.({ ok: true });
    });

    socket.on("chat:send", (rawCommand: unknown, acknowledge?: (value: ChatAcknowledgment) => void) => {
      const respond = acknowledge ?? (() => undefined);
      const parsed = chatCommandSchema.safeParse(rawCommand);
      if (!parsed.success) {
        respond({ ok: false, error: "Invalid chat request" });
        return;
      }
      const conversationId = parsed.data.conversationId;
      const previous = queues.get(conversationId) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => handleChat(socket, parsed.data, respond));
      queues.set(conversationId, current);
      void current.finally(() => {
        if (queues.get(conversationId) === current) queues.delete(conversationId);
      });
    });
  });

  return io;
}
