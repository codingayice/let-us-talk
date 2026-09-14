import assert from "node:assert/strict";
import test from "node:test";
import { io, type Socket } from "socket.io-client";
import type { ChatMessage } from "@let-us-talk/shared";
import { buildApp } from "./app.js";
import { createAuth } from "./auth.js";
import { type ChatModel } from "./model.js";
import { createStore } from "./store.js";
import { attachRealtimeChat } from "./realtime.js";
import { ConversationEventBus } from "./conversation-events.js";

function waitForEvent<T>(socket: Socket, event: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 2_000);
    socket.once(event, (value: T) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

function createDeferredModel() {
  let release!: () => void;
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  const modelReleased = new Promise<void>((resolve) => { release = resolve; });
  const model: ChatModel = {
    async reply(input) {
      started();
      await modelReleased;
      return `Fake reply to: ${input.messages.at(-1)?.content}`;
    },
  };
  return { model, modelStarted, release };
}

async function setup(chatModel: ChatModel) {
  const store = createStore(":memory:");
  const auth = await createAuth(":memory:");
  const conversationEvents = new ConversationEventBus();
  const app = buildApp({ store, auth, chatModel, conversationEvents });
  const realtime = attachRealtimeChat(app.server, { auth, chatModel, store, conversationEvents });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  return { app, store, realtime, url: `http://127.0.0.1:${address.port}` };
}

test("REST chat publishes a conversation update to the authenticated realtime clients", async () => {
  const chatModel: ChatModel = { async reply(input) { return `REST reply to: ${input.messages.at(-1)?.content}`; } };
  const { app, store, realtime, url } = await setup(chatModel);
  const cookie = await register(app);
  const created = await app.inject({ method: "GET", url: "/api/conversations/momo", headers: { cookie } });
  const conversationId = (JSON.parse(created.body) as { conversation: { id: string } }).conversation.id;
  const socket = await connect(url, cookie);
  try {
    const updated = waitForEvent<{ summary: { id: string; lastMessagePreview: string } }>(socket, "conversation:updated");
    const response = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie }, payload: { conversationId, characterId: "momo", content: "来自 HTTP" } });
    assert.equal(response.statusCode, 200, response.body);
    const event = await updated;
    assert.equal(event.summary.id, conversationId);
    assert.equal(event.summary.lastMessagePreview, "Momo：REST reply to: 来自 HTTP");
  } finally {
    socket.close();
    realtime.close();
    await app.close();
    store.close();
  }
});

async function register(app: Awaited<ReturnType<typeof setup>>["app"]) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: "http://localhost:3001" },
    payload: { email: `user-${crypto.randomUUID()}@example.com`, password: "password123", name: "测试用户" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const value = response.headers["set-cookie"];
  assert.ok(value);
  return (Array.isArray(value) ? value : [value]).map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function connect(url: string, cookie?: string) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = io(url, { extraHeaders: cookie ? { cookie } : undefined });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

test("chat:send confirms persistence before starting the model and emits a complete reply", async () => {
  const deferred = createDeferredModel();
  const { app, store, realtime, url } = await setup(deferred.model);
  const cookie = await register(app);
  const created = await app.inject({ method: "GET", url: "/api/conversations/momo", headers: { cookie } });
  const conversationId = (JSON.parse(created.body) as { conversation: { id: string } }).conversation.id;
  const socket = await connect(url, cookie);
  try {
    const accepted = new Promise<{ ok: boolean; userMessage?: ChatMessage }>((resolve) => {
      socket.emit("chat:send", { conversationId, characterId: "momo", content: "你好", messageId: crypto.randomUUID() }, resolve);
    });
    await deferred.modelStarted;
    const acknowledgment = await accepted;
    assert.equal(acknowledgment.ok, true);
    assert.equal(acknowledgment.userMessage?.content, "你好");
    const beforeReply = JSON.parse((await app.inject({ method: "GET", url: `/api/conversations/by-id/${conversationId}`, headers: { cookie } })).body) as { messages: ChatMessage[] };
    assert.deepEqual(beforeReply.messages.map((message) => message.content), ["你好"]);

    const completed = waitForEvent<{ eventId: string; assistantMessage: ChatMessage }>(socket, "chat:completed");
    deferred.release();
    const result = await completed;
    assert.match(result.eventId, /^[0-9a-f-]{36}$/);
    assert.equal(result.assistantMessage.content, "Fake reply to: 你好");
    const afterReply = JSON.parse((await app.inject({ method: "GET", url: `/api/conversations/by-id/${conversationId}`, headers: { cookie } })).body) as { messages: ChatMessage[] };
    assert.deepEqual(afterReply.messages.map((message) => message.content), ["你好", "Fake reply to: 你好"]);
  } finally {
    socket.close();
    realtime.close();
    await app.close();
    store.close();
  }
});

test("chat:send rejects unauthenticated sockets and persists a user message when the model fails", async () => {
  const model: ChatModel = { async reply() { throw new Error("model unavailable"); } };
  const { app, store, realtime, url } = await setup(model);
  const cookie = await register(app);
  const created = await app.inject({ method: "GET", url: "/api/conversations/loki", headers: { cookie } });
  const conversationId = (JSON.parse(created.body) as { conversation: { id: string } }).conversation.id;
  try {
    await assert.rejects(connect(url), /请先登录/);
    const socket = await connect(url, cookie);
    try {
      const failed = waitForEvent<{ error: string; userMessage: ChatMessage }>(socket, "chat:failed");
      const acknowledgment = await new Promise<{ ok: boolean }>((resolve) => {
        socket.emit("chat:send", { conversationId, characterId: "loki", content: "测试失败" }, resolve);
      });
      assert.equal(acknowledgment.ok, true);
      const result = await failed;
      assert.equal(result.error, "AI 暂时不可用，请稍后再试");
      const history = JSON.parse((await app.inject({ method: "GET", url: `/api/conversations/by-id/${conversationId}`, headers: { cookie } })).body) as { messages: ChatMessage[] };
      assert.deepEqual(history.messages.map((message) => message.content), ["测试失败"]);
    } finally {
      socket.close();
    }
  } finally {
    realtime.close();
    await app.close();
    store.close();
  }
});
