import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "@let-us-talk/shared";
import { buildApp, USER_COOKIE_NAME } from "./app.js";
import type { ChatModel } from "./model.js";
import { createStore } from "./store.js";

function createFakeModel() {
  const calls: Array<{ systemPrompt: string; messages: Array<Pick<ChatMessage, "role" | "content">> }> = [];
  const model: ChatModel = {
    async reply(input) {
      calls.push(input);
      return `Fake reply to: ${input.messages.at(-1)?.content}`;
    },
  };
  return { calls, model };
}

function createFlakyModel() {
  let shouldFail = true;
  const calls: string[] = [];
  const model: ChatModel = {
    async reply(input) {
      calls.push(input.messages.at(-1)?.content ?? "");
      if (shouldFail) {
        shouldFail = false;
        throw new Error("model unavailable");
      }
      return `Recovered reply to: ${input.messages.at(-1)?.content}`;
    },
  };
  return { calls, model };
}

function sessionCookie(response: { headers: { "set-cookie"?: unknown } }) {
  const value = response.headers["set-cookie"];
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string") {
    throw new Error("Expected an anonymous user cookie");
  }
  assert.match(header, new RegExp(`^${USER_COOKIE_NAME}=`));
  return header.split(";", 1)[0];
}

test("chat API returns and persists a complete ordered conversation", async () => {
  const store = createStore(":memory:");
  const { model, calls } = createFakeModel();
  const app = buildApp({ store, chatModel: model });

  try {
    const initial = await app.inject({ method: "GET", url: "/api/conversations/momo" });
    assert.equal(initial.statusCode, 200);
    const cookie = sessionCookie(initial);
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { cookie },
      payload: { characterId: "momo", content: "  你好  " },
    });

    assert.equal(response.statusCode, 200);
    const responseBody = JSON.parse(response.body);
    assert.equal(responseBody.userMessage.role, "user");
    assert.equal(responseBody.userMessage.content, "你好");
    assert.match(responseBody.userMessage.id, /^[0-9a-f-]{36}$/);
    assert.match(responseBody.userMessage.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(responseBody.assistantMessage.role, "assistant");
    assert.equal(responseBody.assistantMessage.content, "Fake reply to: 你好");
    assert.match(responseBody.assistantMessage.id, /^[0-9a-f-]{36}$/);
    assert.match(responseBody.assistantMessage.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "你好" },
    ]);

    const history = await app.inject({
      method: "GET",
      url: "/api/conversations/momo",
      headers: { cookie },
    });
    assert.equal(history.headers["set-cookie"], undefined);
    const historyMessages = JSON.parse(history.body).messages as ChatMessage[];
    assert.deepEqual(historyMessages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "你好" },
      { role: "assistant", content: "Fake reply to: 你好" },
    ]);
  } finally {
    await app.close();
    store.close();
  }
});

test("health check reports that the service is available", async () => {
  const store = createStore(":memory:");
  const app = buildApp({ store, chatModel: createFakeModel().model });

  try {
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true });
  } finally {
    await app.close();
    store.close();
  }
});

test("clearing one conversation preserves another contact's history", async () => {
  const store = createStore(":memory:");
  const { model } = createFakeModel();
  const app = buildApp({ store, chatModel: model });

  try {
    const cookie = sessionCookie(await app.inject({ method: "GET", url: "/api/conversations/momo" }));
    for (const [characterId, content] of [["momo", "只清除我"], ["loki", "保留我"]]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { cookie },
        payload: { characterId, content },
      });
      assert.equal(response.statusCode, 200);
    }

    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/conversations/momo",
      headers: { cookie },
    });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(JSON.parse(cleared.body), { ok: true });

    const momoHistory = await app.inject({
      method: "GET",
      url: "/api/conversations/momo",
      headers: { cookie },
    });
    const lokiHistory = await app.inject({
      method: "GET",
      url: "/api/conversations/loki",
      headers: { cookie },
    });
    assert.deepEqual(JSON.parse(momoHistory.body).messages, []);
    assert.equal(JSON.parse(lokiHistory.body).messages.length, 2);
  } finally {
    await app.close();
    store.close();
  }
});

test("a failed model request is not persisted and can be retried without duplicates", async () => {
  const store = createStore(":memory:");
  const { model, calls } = createFlakyModel();
  const app = buildApp({ store, chatModel: model });

  try {
    const cookie = sessionCookie(await app.inject({ method: "GET", url: "/api/conversations/momo" }));
    const failed = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { cookie },
      payload: { characterId: "momo", content: "请再试一次" },
    });
    assert.equal(failed.statusCode, 502);

    const retried = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { cookie },
      payload: { characterId: "momo", content: "请再试一次" },
    });
    assert.equal(retried.statusCode, 200);
    assert.deepEqual(calls, ["请再试一次", "请再试一次"]);

    const history = await app.inject({
      method: "GET",
      url: "/api/conversations/momo",
      headers: { cookie },
    });
    assert.deepEqual(
      JSON.parse(history.body).messages.map(({ role, content }: ChatMessage) => ({ role, content })),
      [
        { role: "user", content: "请再试一次" },
        { role: "assistant", content: "Recovered reply to: 请再试一次" },
      ],
    );
  } finally {
    await app.close();
    store.close();
  }
});

test("repeating a completed request with the same message id is idempotent", async () => {
  const store = createStore(":memory:");
  const { model, calls } = createFakeModel();
  const app = buildApp({ store, chatModel: model });

  try {
    const cookie = sessionCookie(await app.inject({ method: "GET", url: "/api/conversations/momo" }));
    const payload = { characterId: "momo", content: "只保存一次", messageId: crypto.randomUUID() };
    const first = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie }, payload });
    const second = await app.inject({ method: "POST", url: "/api/chat", headers: { cookie }, payload });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
    assert.equal(calls.length, 1);

    const history = await app.inject({ method: "GET", url: "/api/conversations/momo", headers: { cookie } });
    assert.equal(JSON.parse(history.body).messages.length, 2);
  } finally {
    await app.close();
    store.close();
  }
});

test("conversation data survives a service restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "let-us-talk-"));
  const databasePath = join(directory, "chat.sqlite");
  const firstStore = createStore(databasePath);
  const firstApp = buildApp({ store: firstStore, chatModel: createFakeModel().model });
  let cookie: string;

  try {
    cookie = sessionCookie(await firstApp.inject({ method: "GET", url: "/api/conversations/momo" }));
    const response = await firstApp.inject({
      method: "POST",
      url: "/api/chat",
      headers: { cookie },
      payload: { characterId: "momo", content: "请记住这句话" },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    await firstApp.close();
    firstStore.close();
  }

  const restartedStore = createStore(databasePath);
  const restartedApp = buildApp({ store: restartedStore, chatModel: createFakeModel().model });
  try {
    const response = await restartedApp.inject({
      method: "GET",
      url: "/api/conversations/momo",
      headers: { cookie: cookie! },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).messages.length, 2);
  } finally {
    await restartedApp.close();
    restartedStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("different anonymous users cannot see each other's messages", async () => {
  const store = createStore(":memory:");
  const { model } = createFakeModel();
  const app = buildApp({ store, chatModel: model });

  try {
    const firstCookie = sessionCookie(await app.inject({ method: "GET", url: "/api/conversations/momo" }));
    const secondCookie = sessionCookie(await app.inject({ method: "GET", url: "/api/conversations/momo" }));
    assert.notEqual(firstCookie, secondCookie);

    await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { cookie: firstCookie },
      payload: { characterId: "momo", content: "只属于第一个用户" },
    });

    const firstHistory = await app.inject({
      method: "GET",
      url: "/api/conversations/momo",
      headers: { cookie: firstCookie },
    });
    const secondHistory = await app.inject({
      method: "GET",
      url: "/api/conversations/momo",
      headers: { cookie: secondCookie },
    });
    assert.equal(JSON.parse(firstHistory.body).messages.length, 2);
    assert.deepEqual(JSON.parse(secondHistory.body).messages, []);
  } finally {
    await app.close();
    store.close();
  }
});

test("lists the fixed AI contacts and keeps each contact history isolated", async () => {
  const store = createStore(":memory:");
  const { model, calls } = createFakeModel();
  const app = buildApp({ store, chatModel: model });

  try {
    const contacts = await app.inject({ method: "GET", url: "/api/characters" });
    assert.equal(contacts.statusCode, 200);
    const contactBody = JSON.parse(contacts.body) as Array<{ id: string; name: string; avatar: string; systemPrompt?: string }>;
    assert.deepEqual(
      contactBody.map(({ id, name, avatar }) => ({ id, name, avatar })),
      [
        { id: "momo", name: "Momo", avatar: "🌙" },
        { id: "loki", name: "Loki", avatar: "🦊" },
        { id: "nora", name: "Nora", avatar: "☕" },
      ],
    );
    assert.equal(contactBody.some((character) => "systemPrompt" in character), false);

    const cookie = sessionCookie(await app.inject({ method: "GET", url: "/api/conversations/momo" }));
    await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { cookie },
      payload: { characterId: "momo", content: "月亮" },
    });
    await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { cookie },
      payload: { characterId: "loki", content: "狐狸" },
    });

    const momoHistory = await app.inject({
      method: "GET",
      url: "/api/conversations/momo",
      headers: { cookie },
    });
    const lokiHistory = await app.inject({
      method: "GET",
      url: "/api/conversations/loki",
      headers: { cookie },
    });
    assert.deepEqual(
      JSON.parse(momoHistory.body).messages.map(({ content }: ChatMessage) => content),
      ["月亮", "Fake reply to: 月亮"],
    );
    assert.deepEqual(
      JSON.parse(lokiHistory.body).messages.map(({ content }: ChatMessage) => content),
      ["狐狸", "Fake reply to: 狐狸"],
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].systemPrompt.includes("Momo"), true);
    assert.equal(calls[1].systemPrompt.includes("Loki"), true);
    assert.deepEqual(calls[1].messages.map(({ content }) => content), ["狐狸"]);
  } finally {
    await app.close();
    store.close();
  }
});
