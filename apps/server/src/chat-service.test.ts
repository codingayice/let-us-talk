import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatModel } from "./model.js";
import { ChatService } from "./chat-service.js";
import { createStore } from "./store.js";

function setup(model: ChatModel) {
  const store = createStore(":memory:");
  const service = new ChatService(store, model);
  const momo = store.getConversation("user-1", "momo").conversation.id;
  const loki = store.getConversation("user-1", "loki").conversation.id;
  return { store, service, momo, loki };
}

function job(characterId: string, conversationId: string, messageId: string, content = "你好") {
  return { userId: "user-1", characterId, conversationId, content, clientMessageId: messageId, systemPrompt: "你是一个测试角色" };
}

test("the same client message id is idempotent and does not call the model twice", async () => {
  let calls = 0;
  const { store, service, momo } = setup({ async reply() { calls += 1; return "回复"; } });
  try {
    const first = await service.submit(job("momo", momo, "00000000-0000-4000-8000-000000000001"));
    const second = await service.submit(job("momo", momo, "00000000-0000-4000-8000-000000000001"));
    assert.equal(calls, 1);
    assert.equal(first.userMessage.id, second.userMessage.id);
    const snapshot = store.getConversationById("user-1", momo);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.messages.map(({ role, status, content }) => ({ role, status, content })), [
      { role: "user", status: "sent", content: "你好" },
      { role: "assistant", status: "completed", content: "回复" },
    ]);
    assert.equal(snapshot.tasks[0].status, "completed");
  } finally { store.close(); }
});

test("a transient model failure is retried once automatically", async () => {
  let calls = 0;
  const { store, service, momo } = setup({ async reply() { calls += 1; if (calls === 1) throw new Error("temporary"); return "重试成功"; } });
  try {
    const response = await service.submit(job("momo", momo, "00000000-0000-4000-8000-000000000002"));
    assert.equal(calls, 2);
    assert.equal(response.assistantMessage.content, "重试成功");
  } finally { store.close(); }
});

test("an AI failure keeps the user message and an explicit retry reuses its client id", async () => {
  let calls = 0;
  const { store, service, momo } = setup({ async reply() { calls += 1; if (calls <= 2) throw new Error("down"); return "恢复"; } });
  const messageId = "00000000-0000-4000-8000-000000000003";
  try {
    await assert.rejects(service.submit(job("momo", momo, messageId)), /模型服务请求失败/);
    const failed = store.getConversationById("user-1", momo);
    assert.ok(failed);
    assert.equal(failed.messages.length, 1);
    assert.equal(failed.messages[0].status, "sent");
    assert.equal(failed.tasks[0].status, "failed");

    const recovered = await service.submit(job("momo", momo, messageId));
    const final = store.getConversationById("user-1", momo);
    assert.ok(final);
    assert.equal(recovered.userMessage.id, final.messages[0].id);
    assert.deepEqual(final.messages.map((message) => message.content), ["你好", "恢复"]);
    assert.equal(final.tasks[0].status, "completed");
  } finally { store.close(); }
});

test("different conversations can process in parallel while one conversation remains ordered", async () => {
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const { store, service, momo, loki } = setup({
    async reply(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return `回复 ${input.messages.at(-1)?.content}`;
    },
  });
  try {
    const first = service.submit(job("momo", momo, "00000000-0000-4000-8000-000000000004", "Momo"));
    const second = service.submit(job("loki", loki, "00000000-0000-4000-8000-000000000005", "Loki"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(maxActive, 2);
    releases.splice(0).forEach((release) => release());
    await Promise.all([first, second]);
    assert.equal(maxActive, 2);
  } finally { releases.splice(0).forEach((release) => release()); store.close(); }
});

test("clearing a conversation invalidates an in-flight reply", async () => {
  let release!: () => void;
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  const modelReleased = new Promise<void>((resolve) => { release = resolve; });
  const { store, service, momo } = setup({
    async reply() {
      started();
      await modelReleased;
      return "不应写入已清空会话";
    },
  });
  const messageId = "00000000-0000-4000-8000-000000000007";
  try {
    const request = service.submit(job("momo", momo, messageId));
    await modelStarted;
    service.invalidateConversation(momo);
    store.clearConversationById("user-1", momo);
    release();
    await assert.rejects(request, /会话已清空/);
    const snapshot = store.getConversationById("user-1", momo);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.messages, []);
    assert.deepEqual(snapshot.tasks, []);
  } finally {
    release();
    store.close();
  }
});

test("reopening a store converts interrupted tasks into retryable failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "let-us-talk-"));
  const databasePath = join(directory, "messages.sqlite");
  const firstStore = createStore(databasePath);
  const conversationId = firstStore.getConversation("user-1", "momo").conversation.id;
  firstStore.prepareChat("user-1", "momo", "未完成", "00000000-0000-4000-8000-000000000006", conversationId);
  firstStore.close();
  const reopened = createStore(databasePath);
  try {
    const snapshot = reopened.getConversationById("user-1", conversationId);
    assert.ok(snapshot);
    assert.equal(snapshot.tasks[0].status, "failed");
    assert.match(snapshot.tasks[0].error ?? "", /重启/);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
