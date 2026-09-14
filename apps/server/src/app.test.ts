import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@let-us-talk/shared";
import { buildApp } from "./app.js";
import { createAuth, devResetTokens } from "./auth.js";
import type { ChatModel } from "./model.js";
import { createStore } from "./store.js";

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
      const response = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie }, payload: { characterId: "momo", content } });
      assert.equal(response.statusCode, 200, response.body);
    }
    const firstHistory = JSON.parse((await app.inject({ method: "GET", url: "/api/conversations/momo", headers: { cookie: first.cookie } })).body).messages as ChatMessage[];
    const secondHistory = JSON.parse((await app.inject({ method: "GET", url: "/api/conversations/momo", headers: { cookie: second.cookie } })).body).messages as ChatMessage[];
    assert.deepEqual(firstHistory.map((message) => message.content), ["属于第一个", "Fake reply to: 属于第一个"]);
    assert.deepEqual(secondHistory.map((message) => message.content), ["属于第二个", "Fake reply to: 属于第二个"]);
  } finally { await app.close(); store.close(); }
});
