import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, ConversationSnapshot, ConversationSummary } from "@let-us-talk/shared";
import { createConversationRuntime, type ConversationApi } from "./conversation-runtime.js";
import type { RealtimeChatClient } from "./realtime-client.js";

function snapshot(messages: ChatMessage[] = []): ConversationSnapshot {
  return {
    conversation: { id: "conversation-momo", characterId: "momo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "active" },
    messages,
    tasks: [],
  };
}

const summary: ConversationSummary = {
  id: "conversation-momo",
  character: { id: "momo", name: "Momo", avatar: "🌙", tagline: "温柔、细腻，喜欢听你慢慢说" },
  lastMessagePreview: "Momo：你好",
  lastMessageAt: "2026-01-01T00:00:00.000Z",
  status: "active",
  unread: false,
};

class FakeRealtime implements RealtimeChatClient {
  private handlers: Parameters<RealtimeChatClient["connect"]>[0] | null = null;
  readonly joined: string[] = [];

  connect(handlers: Parameters<RealtimeChatClient["connect"]>[0]) {
    this.handlers = handlers;
    handlers.onConnection("connected");
  }

  join(conversationId: string) {
    this.joined.push(conversationId);
    return Promise.resolve();
  }

  send() {
    return Promise.reject(new Error("not used"));
  }

  retry() {
    return Promise.reject(new Error("not used"));
  }

  close() {}

  reconnect() {
    this.handlers?.onConnection("offline");
    this.handlers?.onConnection("connected");
  }
}

test("reconnect reloads the active conversation snapshot through the runtime seam", async () => {
  const realtime = new FakeRealtime();
  let current = snapshot([{ id: "message-1", role: "user", content: "第一次", createdAt: "2026-01-01T00:00:00.000Z", status: "sent" }]);
  const api: ConversationApi = {
    async list() { return [summary]; },
    async snapshotById() { return current; },
    async snapshotByCharacter() { return current; },
    async markRead() {},
    async hide() {},
    async restore() {},
    async clear() {},
  };
  const runtime = createConversationRuntime({ api, realtime });

  await runtime.start();
  assert.deepEqual(runtime.store.getSnapshot().conversations["conversation-momo"].messages.map((message) => message.content), ["第一次"]);

  current = snapshot([
    { id: "message-1", role: "user", content: "第一次", createdAt: "2026-01-01T00:00:00.000Z", status: "sent" },
    { id: "message-2", role: "assistant", content: "重连后恢复", createdAt: "2026-01-01T00:01:00.000Z", status: "completed" },
  ]);
  realtime.reconnect();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(runtime.store.getSnapshot().conversations["conversation-momo"].messages.map((message) => message.content), ["第一次", "重连后恢复"]);
  assert.deepEqual(realtime.joined, ["conversation-momo", "conversation-momo"]);
  runtime.stop();
});
