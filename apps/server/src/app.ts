import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type { ChatRequest, ChatResponse } from "@let-us-talk/shared";
import { type AuthInstance } from "./auth.js";
import { characters, findCharacter } from "./characters.js";
import { type ChatModel } from "./model.js";
import { createStore, type ChatStore } from "./store.js";

interface AppDependencies { chatModel: ChatModel; store: ChatStore; auth: AuthInstance }

export function buildApp(dependencies: Partial<AppDependencies> = {}): FastifyInstance {
  const store = dependencies.store ?? createStore();
  const chatModel = dependencies.chatModel;
  const authInstance = dependencies.auth;
  if (!chatModel) throw new Error("A chat model is required");
  if (!authInstance) throw new Error("An auth instance is required");
  const auth = authInstance;

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

  app.get("/health", async () => ({ ok: true }));
  app.get("/api/characters", async () => characters.map(({ systemPrompt: _, ...character }) => character));

  app.get<{ Params: { characterId: string } }>("/api/conversations/:characterId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (!findCharacter(request.params.characterId)) return reply.code(404).send({ error: "Character not found" });
    return { messages: store.getConversation(user.id, request.params.characterId) };
  });

  app.delete<{ Params: { characterId: string } }>("/api/conversations/:characterId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (!findCharacter(request.params.characterId)) return reply.code(404).send({ error: "Character not found" });
    store.clearConversation(user.id, request.params.characterId);
    return { ok: true };
  });

  const chatSchema = z.object({ characterId: z.string().min(1), content: z.string().trim().min(1).max(4000), messageId: z.string().uuid().optional() });
  app.post<{ Body: ChatRequest }>("/api/chat", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid chat request" });
    const character = findCharacter(parsed.data.characterId);
    if (!character) return reply.code(404).send({ error: "Character not found" });
    const conversation = store.getConversation(user.id, character.id);
    const messageId = parsed.data.messageId ?? crypto.randomUUID();
    const existingUserIndex = conversation.findIndex((message) => message.id === messageId);
    const existingUserMessage = conversation[existingUserIndex];
    const existingAssistantMessage = conversation[existingUserIndex + 1];
    if (existingUserMessage?.role === "user" && existingAssistantMessage?.role === "assistant") return { userMessage: existingUserMessage, assistantMessage: existingAssistantMessage };
    const userMessage = { id: messageId, role: "user" as const, content: parsed.data.content, createdAt: new Date().toISOString() };
    try {
      const assistantContent = (await chatModel.reply({ systemPrompt: character.systemPrompt, messages: [...conversation, userMessage] })).trim();
      if (!assistantContent) throw new Error("Chat model returned an empty response");
      store.saveMessage(user.id, character.id, userMessage);
      const assistantMessage = { id: crypto.randomUUID(), role: "assistant" as const, content: assistantContent, createdAt: new Date().toISOString() };
      store.saveMessage(user.id, character.id, assistantMessage);
      const response: ChatResponse = { userMessage, assistantMessage };
      return response;
    } catch (error) {
      request.log.error(error, "chat model request failed");
      return reply.code(502).send({ error: "AI 暂时不可用，请稍后再试" });
    }
  });

  return app;
}
