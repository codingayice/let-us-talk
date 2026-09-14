import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type { ChatRequest, ConversationSummary, PublicCharacter } from "@let-us-talk/shared";
import { type AuthInstance } from "./auth.js";
import { characters, findCharacter } from "./characters.js";
import { type ChatModel } from "./model.js";
import { createStore, type ChatStore } from "./store.js";
import { ChatService, ChatServiceError } from "./chat-service.js";

interface AppDependencies { chatModel: ChatModel; store: ChatStore; auth: AuthInstance; chatService?: ChatService }

export function buildApp(dependencies: Partial<AppDependencies> = {}): FastifyInstance {
  const store = dependencies.store ?? createStore();
  const chatModel = dependencies.chatModel;
  const authInstance = dependencies.auth;
  if (!chatModel) throw new Error("A chat model is required");
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
        lastMessagePreview: summary.lastMessagePreview,
        lastMessageAt: summary.lastMessageAt,
        status: summary.status,
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

  const chatSchema = z.object({ characterId: z.string().min(1), conversationId: z.string().uuid().optional(), content: z.string().trim().min(1).max(4000), messageId: z.string().uuid().optional() });
  app.post<{ Body: ChatRequest }>("/api/chat", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid chat request" });
    const character = findCharacter(parsed.data.characterId);
    if (!character) return reply.code(404).send({ error: "Character not found" });
    const conversationDetails = parsed.data.conversationId
      ? store.getConversationById(user.id, parsed.data.conversationId)
      : store.getConversation(user.id, character.id);
    if (!conversationDetails || conversationDetails.conversation.characterId !== character.id) return reply.code(404).send({ error: "Conversation not found" });
    const clientMessageId = parsed.data.messageId ?? crypto.randomUUID();
    try {
      return await chatService.submit({
        userId: user.id,
        characterId: character.id,
        conversationId: conversationDetails.conversation.id,
        content: parsed.data.content,
        clientMessageId,
        systemPrompt: character.systemPrompt,
      });
    } catch (error) {
      request.log.error(error, "chat model request failed");
      const statusCode = error instanceof ChatServiceError ? error.statusCode : 502;
      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "AI 暂时不可用，请稍后再试" });
    }
  });

  return app;
}
