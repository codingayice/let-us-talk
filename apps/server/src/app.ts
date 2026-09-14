import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import type { ChatRequest, ChatResponse } from "@let-us-talk/shared";
import { characters, findCharacter } from "./characters.js";
import { type ChatModel } from "./model.js";
import { createStore, type ChatStore } from "./store.js";

export const USER_COOKIE_NAME = "let_us_talk_user_id";

interface AppDependencies {
  chatModel: ChatModel;
  store: ChatStore;
}

function isUserId(value: string | undefined): value is string {
  return value !== undefined && z.string().uuid().safeParse(value).success;
}

export function buildApp(dependencies: Partial<AppDependencies> = {}): FastifyInstance {
  const store = dependencies.store ?? createStore();
  const chatModel = dependencies.chatModel;
  if (!chatModel) {
    throw new Error("A chat model is required");
  }

  const app = Fastify({ logger: true });
  void app.register(cors, { origin: true, credentials: true });
  void app.register(cookie);

  function getUserId(
    request: { cookies: Record<string, string | undefined> },
    reply: FastifyReply,
  ) {
    const userId = request.cookies[USER_COOKIE_NAME];
    if (isUserId(userId)) {
      return userId;
    }

    const newUserId = crypto.randomUUID();
    reply.setCookie(USER_COOKIE_NAME, newUserId, {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 365 * 10,
      path: "/",
      sameSite: "lax",
    });
    return newUserId;
  }

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/characters", async () => characters.map(({ systemPrompt: _, ...character }) => character));

  app.get<{ Params: { characterId: string } }>(
    "/api/conversations/:characterId",
    async (request, reply) => {
      if (!findCharacter(request.params.characterId)) {
        return reply.code(404).send({ error: "Character not found" });
      }
      return { messages: store.getConversation(getUserId(request, reply), request.params.characterId) };
    },
  );

  app.delete<{ Params: { characterId: string } }>(
    "/api/conversations/:characterId",
    async (request, reply) => {
      if (!findCharacter(request.params.characterId)) {
        return reply.code(404).send({ error: "Character not found" });
      }
      store.clearConversation(getUserId(request, reply), request.params.characterId);
      return { ok: true };
    },
  );

  const chatSchema = z.object({
    characterId: z.string().min(1),
    content: z.string().trim().min(1).max(4000),
  });

  app.post<{ Body: ChatRequest }>("/api/chat", async (request, reply) => {
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid chat request" });
    }

    const character = findCharacter(parsed.data.characterId);
    if (!character) {
      return reply.code(404).send({ error: "Character not found" });
    }

    const userId = getUserId(request, reply);
    const userMessage = {
      id: crypto.randomUUID(),
      role: "user" as const,
      content: parsed.data.content,
      createdAt: new Date().toISOString(),
    };
    const history = [...store.getConversation(userId, character.id), userMessage];
    store.saveMessage(userId, character.id, userMessage);

    try {
      const assistantContent = (await chatModel.reply({
        systemPrompt: character.systemPrompt,
        messages: history,
      })).trim();
      if (!assistantContent) {
        throw new Error("Chat model returned an empty response");
      }

      const assistantMessage = {
        id: crypto.randomUUID(),
        role: "assistant" as const,
        content: assistantContent,
        createdAt: new Date().toISOString(),
      };
      store.saveMessage(userId, character.id, assistantMessage);

      const response: ChatResponse = { userMessage, assistantMessage };
      return response;
    } catch (error) {
      request.log.error(error, "chat model request failed");
      return reply.code(502).send({ error: "AI 暂时不可用，请稍后再试" });
    }
  });

  return app;
}
