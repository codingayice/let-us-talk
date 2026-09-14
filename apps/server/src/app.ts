import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type { ChatRequest, ConversationSummary, PublicCharacter } from "@let-us-talk/shared";
import { type AuthInstance } from "./auth.js";
import { characters, findCharacter, formatConversationPreview } from "./characters.js";
import { chatModel as defaultChatModel, modelErrorResponse, toModelError, validateModelConfig, withModelTimeout, type ChatModel } from "./model.js";
import { config } from "./config.js";
import { createStore, type ChatStore } from "./store.js";
import { ChatService, ChatServiceError } from "./chat-service.js";
import type { ConversationEventBus } from "./conversation-events.js";

interface AppDependencies { chatModel?: ChatModel; store: ChatStore; auth: AuthInstance; chatService?: ChatService; conversationEvents?: ConversationEventBus }

export function buildApp(dependencies: Partial<AppDependencies> = {}): FastifyInstance {
  const store = dependencies.store ?? createStore();
  const chatModel = dependencies.chatModel ?? defaultChatModel;
  const authInstance = dependencies.auth;
  if (!authInstance) throw new Error("An auth instance is required");
  const auth = authInstance;
  const chatService = dependencies.chatService ?? new ChatService(store, chatModel);

  const app = Fastify({ logger: true });
  void app.register(cors, { origin: true, credentials: true });
  void app.register(cookie);

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const headers = fromNodeHeaders(request.headers);
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      const authRequest = new Request(url, {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(authRequest);
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      const setCookies = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : response.headers.get("set-cookie");
      if (setCookies) reply.header("set-cookie", setCookies);
      const body = await response.text();
      return reply.code(response.status).send(body || undefined);
    },
  });

  async function currentSession(request: { headers: Record<string, string | string[] | undefined> }) {
    return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  }

  async function requireUser(request: { headers: Record<string, string | string[] | undefined> }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
    const session = await currentSession(request);
    if (!session) {
      reply.code(401).send({ error: "请先登录" });
      return null;
    }
    return session.user;
  }

  function publicCharacter(characterId: string): PublicCharacter | undefined {
    const character = findCharacter(characterId);
    if (!character) return undefined;
    const { systemPrompt: _, ...result } = character;
    return result;
  }

  app.get("/health", async () => ({ ok: true }));
  app.get("/api/characters", async () => characters.flatMap((character) => {
    const publicValue = publicCharacter(character.id);
    return publicValue ? [publicValue] : [];
  }));

  app.get("/api/conversations", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const conversations = store.listConversations(user.id).flatMap((summary): ConversationSummary[] => {
      const character = publicCharacter(summary.characterId);
      if (!character) return [];
      return [{
        id: summary.id,
        character,
        lastMessagePreview: formatConversationPreview(character.name, summary.lastMessageRole, summary.lastMessagePreview),
        lastMessageAt: summary.lastMessageAt,
        status: summary.status,
        unread: summary.unread,
      }];
    });
    return { conversations };
  });

  app.get<{ Params: { characterId: string } }>("/api/conversations/:characterId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (!findCharacter(request.params.characterId)) return reply.code(404).send({ error: "Character not found" });
    return store.getConversation(user.id, request.params.characterId);
  });

  app.get<{ Params: { conversationId: string } }>("/api/conversations/by-id/:conversationId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const conversation = store.getConversationById(user.id, request.params.conversationId);
    if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
    return conversation;
  });

  app.delete<{ Params: { characterId: string } }>("/api/conversations/:characterId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (!findCharacter(request.params.characterId)) return reply.code(404).send({ error: "Character not found" });
    store.clearConversation(user.id, request.params.characterId);
    return { ok: true };
  });

  app.post<{ Params: { characterId: string } }>("/api/conversations/:characterId/hide", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (!findCharacter(request.params.characterId)) return reply.code(404).send({ error: "Character not found" });
    const conversation = store.getConversation(user.id, request.params.characterId);
    store.hideConversation(user.id, conversation.conversation.id);
    return { ok: true };
  });

  app.post<{ Params: { characterId: string } }>("/api/conversations/:characterId/restore", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (!findCharacter(request.params.characterId)) return reply.code(404).send({ error: "Character not found" });
    const conversation = store.getConversation(user.id, request.params.characterId);
    store.restoreConversation(user.id, conversation.conversation.id);
    return { ok: true };
  });

  app.post<{ Params: { characterId: string } }>("/api/conversations/:characterId/read", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (!findCharacter(request.params.characterId)) return reply.code(404).send({ error: "Character not found" });
    const conversation = store.getConversation(user.id, request.params.characterId);
    store.markConversationRead(user.id, conversation.conversation.id);
    return { ok: true };
  });

  app.post<{ Params: { conversationId: string } }>("/api/conversations/by-id/:conversationId/read", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (!store.getConversationById(user.id, request.params.conversationId)) return reply.code(404).send({ error: "Conversation not found" });
    store.markConversationRead(user.id, request.params.conversationId);
    return { ok: true };
  });

  const chatSchema = z.object({ characterId: z.string().min(1), conversationId: z.string().uuid().optional(), content: z.string().trim().min(1).max(4000), messageId: z.string().uuid().optional(), modelConfig: z.unknown().optional() });
  app.post<{ Body: ChatRequest }>("/api/chat", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid chat request" });
    const character = findCharacter(parsed.data.characterId);
    if (!character) return reply.code(404).send({ error: "Character not found" });
    let modelConfig: ChatRequest["modelConfig"];
    try {
      modelConfig = validateModelConfig(parsed.data.modelConfig);
    } catch (error) {
      return reply.code(400).send(modelErrorResponse(error));
    }
    const conversationDetails = parsed.data.conversationId
      ? store.getConversationById(user.id, parsed.data.conversationId)
      : store.getConversation(user.id, character.id);
    if (!conversationDetails || conversationDetails.conversation.characterId !== character.id) return reply.code(404).send({ error: "Conversation not found" });
    const clientMessageId = parsed.data.messageId ?? crypto.randomUUID();
    try {
      const response = await chatService.submit({
        userId: user.id,
        characterId: character.id,
        conversationId: conversationDetails.conversation.id,
        content: parsed.data.content,
        clientMessageId,
        systemPrompt: character.systemPrompt,
        modelConfig,
      });
      dependencies.conversationEvents?.publishCompleted({ userId: user.id, conversationId: conversationDetails.conversation.id });
      return response;
    } catch (error) {
      const statusCode = error instanceof ChatServiceError ? error.statusCode : 502;
      request.log.warn({ category: error instanceof ChatServiceError ? error.category : toModelError(error).category }, "chat model request failed");
      return reply.code(statusCode).send(error instanceof ChatServiceError ? { error: error.message, code: error.category, category: error.category } : modelErrorResponse(error));
    }
  });

  app.post("/api/model/test", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const body = request.body as { config?: unknown } | undefined;
    let modelConfig: ChatRequest["modelConfig"];
    try {
      modelConfig = validateModelConfig(body?.config);
    } catch (error) {
      return reply.code(400).send(modelErrorResponse(error));
    }
    const startedAt = performance.now();
    try {
      const text = await withModelTimeout(chatModel.reply({
        systemPrompt: "你是连接测试助手。请用一个简短词语确认连接。",
        messages: [{ role: "user", content: "请回复：连接成功" }],
        modelConfig,
      }), config.llmTimeoutMs);
      if (!text.trim()) throw new Error("empty model response");
      return { ok: true, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) };
    } catch (error) {
      const safeError = modelErrorResponse(error);
      request.log.warn({ category: safeError.category }, "model connection test failed");
      return reply.code(safeError.category === "timeout" ? 504 : 502).send(safeError);
    }
  });

  return app;
}
