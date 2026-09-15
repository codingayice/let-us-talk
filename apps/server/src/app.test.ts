import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@let-us-talk/shared";
import { buildApp } from "./app.js";
import { createAuth, devResetTokens } from "./auth.js";
import type { ChatModel } from "./model.js";
import { createStore } from "./store.js";

const testModelConfig = { baseUrl: "https://provider.example/v1", apiKey: "test-secret", model: "test-model" };

function createFakeModel(): ChatModel {
  return { async reply(input) { return `Fake reply to: ${input.messages.at(-1)?.content}`; } };
}

async function setup() {
  const store = createStore(":memory:");
  const auth = await createAuth(":memory:");
  const app = buildApp({ store, auth, chatModel: createFakeModel() });
  return { app, store };
}

async function register(app: Awaited<ReturnType<typeof setup>>["app"], email = `user-${crypto.randomUUID()}@example.com`) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: "http://localhost:3001" },
    payload: { email, password: "password123", name: "测试用户" },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { email, cookie: cookiesFrom(response), body: JSON.parse(response.body) as { user: { id: string } } };
}

function cookiesFrom(response: { headers: { "set-cookie"?: string | string[] } }) {
  const value = response.headers["set-cookie"];
  assert.ok(value, "expected Better Auth session cookie");
  return (Array.isArray(value) ? value : [value]).map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function authHeaders(cookie?: string) {
  return { origin: "http://localhost:3001", ...(cookie ? { cookie } : {}) };
}

test("unauthenticated users cannot access conversations or chat", async () => {
  const { app, store } = await setup();
  try {
    const characters = await app.inject({ method: "GET", url: "/api/characters" });
    assert.equal(characters.statusCode, 200);
    assert.equal((JSON.parse(characters.body) as Array<{ id: string; systemPrompt?: string }>).length, 3);
    assert.equal((JSON.parse(characters.body) as Array<{ systemPrompt?: string }>).some((character) => character.systemPrompt), false);
    assert.equal((await app.inject({ method: "GET", url: "/api/conversations" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/conversations/momo" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/chat", payload: { characterId: "momo", content: "你好" } })).statusCode, 401);
  } finally { await app.close(); store.close(); }
});

test("registration, session lookup, logout and profile update work", async () => {
  const { app, store } = await setup();
  try {
    const account = await register(app);
    const me = await app.inject({ method: "GET", url: "/api/auth/get-session", headers: { cookie: account.cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(JSON.parse(me.body).user.email, account.email);

    const tokenResponse = await app.inject({ method: "GET", url: "/api/auth/token", headers: { cookie: account.cookie } });
    assert.equal(tokenResponse.statusCode, 200);
    const accessToken = (JSON.parse(tokenResponse.body) as { token: string }).token;
    assert.match(accessToken, /^eyJ/);

    const updated = await app.inject({ method: "POST", url: "/api/auth/update-user", headers: authHeaders(account.cookie), payload: { name: "新昵称", image: "https://example.com/avatar.png" } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(JSON.parse(updated.body), { status: true });
    const updatedSession = await app.inject({ method: "GET", url: "/api/auth/get-session", headers: { cookie: account.cookie } });
    assert.equal(JSON.parse(updatedSession.body).user.name, "新昵称");

    const loggedOut = await app.inject({ method: "POST", url: "/api/auth/sign-out", headers: authHeaders(account.cookie) });
    assert.equal(loggedOut.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/get-session", headers: { cookie: account.cookie } })).body, "null");
  } finally { await app.close(); store.close(); }
});

test("a new login revokes the previous device session", async () => {
  const { app, store } = await setup();
  try {
    const first = await register(app);
    const secondResponse = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: authHeaders(), payload: { email: first.email, password: "password123" } });
    assert.equal(secondResponse.statusCode, 200, secondResponse.body);
    const secondCookie = cookiesFrom(secondResponse);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/get-session", headers: { cookie: first.cookie } })).body, "null");
    assert.notEqual((await app.inject({ method: "GET", url: "/api/auth/get-session", headers: { cookie: secondCookie } })).body, "null");
  } finally { await app.close(); store.close(); }
});

test("password reset changes the password and revokes sessions", async () => {
  const { app, store } = await setup();
  try {
    const account = await register(app);
    const requested = await app.inject({ method: "POST", url: "/api/auth/request-password-reset", headers: authHeaders(), payload: { email: account.email, redirectTo: "http://localhost:5173" } });
    assert.equal(requested.statusCode, 200, requested.body);
    const token = devResetTokens.get(account.email);
    assert.ok(token);
    const reset = await app.inject({ method: "POST", url: "/api/auth/reset-password", headers: authHeaders(), payload: { token, newPassword: "new-password123" } });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: authHeaders(), payload: { email: account.email, password: "password123" } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: authHeaders(), payload: { email: account.email, password: "new-password123" } })).statusCode, 200);
  } finally { await app.close(); store.close(); }
});

test("authenticated conversations remain isolated by formal user id", async () => {
  const { app, store } = await setup();
  try {
    const first = await register(app);
    const second = await register(app);
    for (const [cookie, content] of [[first.cookie, "属于第一个"], [second.cookie, "属于第二个"]]) {
      const response = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie }, payload: { characterId: "momo", content, modelConfig: testModelConfig } });
      assert.equal(response.statusCode, 200, response.body);
    }
    const firstHistory = JSON.parse((await app.inject({ method: "GET", url: "/api/conversations/momo", headers: { cookie: first.cookie } })).body).messages as ChatMessage[];
    const secondHistory = JSON.parse((await app.inject({ method: "GET", url: "/api/conversations/momo", headers: { cookie: second.cookie } })).body).messages as ChatMessage[];
    assert.deepEqual(firstHistory.map((message) => message.content), ["属于第一个", "Fake reply to: 属于第一个"]);
    assert.deepEqual(secondHistory.map((message) => message.content), ["属于第二个", "Fake reply to: 属于第二个"]);
  } finally { await app.close(); store.close(); }
});

test("conversation and contact entries resolve to one persistent conversation resource", async () => {
  const { app, store } = await setup();
  try {
    const account = await register(app);
    const fromContact = await app.inject({ method: "GET", url: "/api/conversations/momo", headers: { cookie: account.cookie } });
    assert.equal(fromContact.statusCode, 200, fromContact.body);
    const contactData = JSON.parse(fromContact.body) as { conversation: { id: string; characterId: string; status: string }; messages: ChatMessage[] };
    assert.equal(contactData.conversation.characterId, "momo");
    assert.equal(contactData.conversation.status, "active");
    assert.match(contactData.conversation.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(contactData.messages, []);

    const repeatedContact = await app.inject({ method: "GET", url: "/api/conversations/momo", headers: { cookie: account.cookie } });
    assert.equal(JSON.parse(repeatedContact.body).conversation.id, contactData.conversation.id);

    const fromId = await app.inject({ method: "GET", url: `/api/conversations/by-id/${contactData.conversation.id}`, headers: { cookie: account.cookie } });
    assert.equal(fromId.statusCode, 200, fromId.body);
    assert.equal(JSON.parse(fromId.body).conversation.id, contactData.conversation.id);

    const initiallyEmpty = await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: account.cookie } });
    assert.deepEqual(JSON.parse(initiallyEmpty.body), { conversations: [] });

    const chat = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { cookie: account.cookie },
      payload: { characterId: "momo", conversationId: contactData.conversation.id, content: "你好", modelConfig: testModelConfig },
    });
    assert.equal(chat.statusCode, 200, chat.body);

    const list = await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: account.cookie } });
    const listData = JSON.parse(list.body) as { conversations: Array<{ id: string; character: { id: string; name: string; systemPrompt?: string }; lastMessagePreview: string; lastMessageAt: string; status: string }> };
    assert.equal(listData.conversations.length, 1);
    assert.equal(listData.conversations[0].id, contactData.conversation.id);
    assert.deepEqual(listData.conversations[0].character, { id: "momo", name: "Momo", avatar: "🌙", tagline: "温柔、细腻，喜欢听你慢慢说" });
    assert.equal(listData.conversations[0].lastMessagePreview, "Momo：Fake reply to: 你好");
    assert.equal(listData.conversations[0].status, "active");
    assert.ok(listData.conversations[0].lastMessageAt);

    const hidden = await app.inject({ method: "POST", url: "/api/conversations/momo/hide", headers: { cookie: account.cookie } });
    assert.equal(hidden.statusCode, 200, hidden.body);
    const hiddenList = await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: account.cookie } });
    assert.deepEqual(JSON.parse(hiddenList.body), { conversations: [] });
    const hiddenDetails = await app.inject({ method: "GET", url: `/api/conversations/by-id/${contactData.conversation.id}`, headers: { cookie: account.cookie } });
    assert.equal(JSON.parse(hiddenDetails.body).conversation.status, "hidden");

    const restoredById = await app.inject({ method: "POST", url: `/api/conversations/by-id/${contactData.conversation.id}/restore`, headers: { cookie: account.cookie } });
    assert.equal(restoredById.statusCode, 200, restoredById.body);
    assert.equal(JSON.parse((await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: account.cookie } })).body).conversations.length, 1);

    const restored = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { cookie: account.cookie },
      payload: { characterId: "momo", conversationId: contactData.conversation.id, content: "再次见面", modelConfig: testModelConfig },
    });
    assert.equal(restored.statusCode, 200, restored.body);
    const restoredList = await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: account.cookie } });
    assert.equal(JSON.parse(restoredList.body).conversations[0].id, contactData.conversation.id);
    const cleared = await app.inject({ method: "DELETE", url: `/api/conversations/by-id/${contactData.conversation.id}`, headers: { cookie: account.cookie } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    const afterClear = JSON.parse((await app.inject({ method: "GET", url: `/api/conversations/by-id/${contactData.conversation.id}`, headers: { cookie: account.cookie } })).body) as { conversation: { id: string; status: string }; messages: ChatMessage[] };
    assert.equal(afterClear.conversation.id, contactData.conversation.id);
    assert.equal(afterClear.conversation.status, "active");
    assert.deepEqual(afterClear.messages, []);
  } finally { await app.close(); store.close(); }
});

test("conversation summaries are ordered, labeled, truncated and retain unread state", async () => {
  const { app, store } = await setup();
  try {
    const account = await register(app);
    const longContent = "这是一段非常长的消息".repeat(20);
    await app.inject({ method: "POST", url: "/api/chat", headers: { cookie: account.cookie }, payload: { characterId: "momo", content: longContent, modelConfig: testModelConfig } });
    await app.inject({ method: "POST", url: "/api/chat", headers: { cookie: account.cookie }, payload: { characterId: "loki", content: "Loki 的消息", modelConfig: testModelConfig } });
    const list = JSON.parse((await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: account.cookie } })).body) as { conversations: Array<{ character: { id: string; name: string }; lastMessagePreview: string; unread: boolean }> };
    assert.deepEqual(list.conversations.map((conversation) => conversation.character.id), ["loki", "momo"]);
    assert.equal(list.conversations[0].lastMessagePreview, "Loki：Fake reply to: Loki 的消息");
    assert.match(list.conversations[1].lastMessagePreview, /^Momo：Fake reply to: /);
    assert.ok(list.conversations[1].lastMessagePreview.length <= 86);
    assert.equal(list.conversations.every((conversation) => conversation.unread), true);

    const momoId = list.conversations.find((conversation) => conversation.character.id === "momo")!.character.id;
    const read = await app.inject({ method: "POST", url: `/api/conversations/${momoId}/read`, headers: { cookie: account.cookie } });
    assert.equal(read.statusCode, 200, read.body);
    const afterRead = JSON.parse((await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: account.cookie } })).body) as { conversations: Array<{ character: { id: string }; unread: boolean }> };
    assert.equal(afterRead.conversations.find((conversation) => conversation.character.id === "momo")?.unread, false);
  } finally { await app.close(); store.close(); }
});

test("conversation ids cannot be used across accounts", async () => {
  const { app, store } = await setup();
  try {
    const first = await register(app);
    const second = await register(app);
    const created = await app.inject({ method: "GET", url: "/api/conversations/momo", headers: { cookie: first.cookie } });
    const conversationId = (JSON.parse(created.body) as { conversation: { id: string } }).conversation.id;
    const response = await app.inject({ method: "GET", url: `/api/conversations/by-id/${conversationId}`, headers: { cookie: second.cookie } });
    assert.equal(response.statusCode, 404);
    const chat = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie: second.cookie }, payload: { characterId: "momo", conversationId, content: "越权", modelConfig: testModelConfig } });
    assert.equal(chat.statusCode, 404);
  } finally { await app.close(); store.close(); }
});

test("model connection test is authenticated, request-scoped and does not create chat data", async () => {
  const seen: Array<{ baseUrl?: string; apiKey?: string; model?: string; messages: string[] }> = [];
  const { app, store } = await (async () => {
    const store = createStore(":memory:");
    const auth = await createAuth(":memory:");
    const app = buildApp({ store, auth, chatModel: { async reply(input) {
      seen.push({ baseUrl: input.modelConfig?.baseUrl, apiKey: input.modelConfig?.apiKey, model: input.modelConfig?.model, messages: input.messages.map((message) => message.content) });
      return "连接成功";
    } } });
    return { app, store };
  })();
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/model/test", payload: { config: testModelConfig } })).statusCode, 401);
    const account = await register(app);
    const response = await app.inject({ method: "POST", url: "/api/model/test", headers: { cookie: account.cookie }, payload: { config: testModelConfig } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), { ok: true, latencyMs: JSON.parse(response.body).latencyMs });
    assert.deepEqual(seen, [{ baseUrl: testModelConfig.baseUrl, apiKey: testModelConfig.apiKey, model: testModelConfig.model, messages: ["请回复：连接成功"] }]);
    assert.equal(response.body.includes(testModelConfig.apiKey), false);
    assert.deepEqual(JSON.parse((await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: account.cookie } })).body), { conversations: [] });
  } finally { await app.close(); store.close(); }
});

test("missing and invalid model config are rejected before chat persistence", async () => {
  const { app, store } = await setup();
  try {
    const account = await register(app);
    const missing = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie: account.cookie }, payload: { characterId: "momo", content: "不会落库" } });
    assert.equal(missing.statusCode, 400);
    assert.equal(JSON.parse(missing.body).category, "config_missing");
    const invalid = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie: account.cookie }, payload: { characterId: "momo", content: "不会落库", modelConfig: { ...testModelConfig, baseUrl: "ftp://provider.example" } } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(JSON.parse(invalid.body).category, "config_invalid");
    assert.deepEqual(JSON.parse((await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: account.cookie } })).body), { conversations: [] });
  } finally { await app.close(); store.close(); }
});

test("provider authentication errors are categorized and sanitized", async () => {
  const { app, store } = await (async () => {
    const store = createStore(":memory:");
    const auth = await createAuth(":memory:");
    const app = buildApp({ store, auth, chatModel: { async reply() { throw Object.assign(new Error(`provider leaked ${testModelConfig.apiKey}`), { statusCode: 401 }); } } });
    return { app, store };
  })();
  try {
    const account = await register(app);
    const response = await app.inject({ method: "POST", url: "/api/model/test", headers: { cookie: account.cookie }, payload: { config: testModelConfig } });
    const body = JSON.parse(response.body) as { category: string; error: string };
    assert.equal(response.statusCode, 502);
    assert.equal(body.category, "authentication_failed");
    assert.equal(response.body.includes(testModelConfig.apiKey), false);
  } finally { await app.close(); store.close(); }
});
