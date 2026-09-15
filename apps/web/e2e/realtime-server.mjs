import { createServer } from "node:http";
import { createRequire } from "node:module";

const { Server } = createRequire(new URL("../../../apps/server/package.json", import.meta.url))("socket.io");

const port = Number(process.env.REALTIME_TEST_PORT ?? 3001);
const characters = [
  { id: "momo", name: "Momo", avatar: "🌙", tagline: "温柔、细腻，喜欢听你慢慢说" },
  { id: "loki", name: "Loki", avatar: "🦊", tagline: "有点毒舌，但总是站在你这边" },
  { id: "nora", name: "Nora", avatar: "☕", tagline: "理性又好奇，什么都愿意聊" },
];
const conversationIds = {
  momo: "00000000-0000-4000-8000-000000000001",
  loki: "00000000-0000-4000-8000-000000000002",
  nora: "00000000-0000-4000-8000-000000000003",
};
const histories = {
  momo: [{ id: "momo-history", role: "assistant", content: "Momo 历史消息", createdAt: "2026-01-01T12:00:00.000Z", status: "completed" }],
  loki: [{ id: "loki-history", role: "assistant", content: "Loki 历史消息", createdAt: "2026-01-01T12:00:00.000Z", status: "completed" }],
  nora: [],
};
const tasks = new Map();
const readCharacters = new Set();

function characterFor(characterId) {
  return characters.find((character) => character.id === characterId);
}

function characterIdFor(conversationId) {
  return Object.entries(conversationIds).find(([, id]) => id === conversationId)?.[0];
}

function summaryFor(characterId) {
  const character = characterFor(characterId);
  const messages = histories[characterId];
  const lastMessage = messages.at(-1);
  return {
    id: conversationIds[characterId],
    character,
    lastMessagePreview: lastMessage ? `${character.name}：${lastMessage.content}` : "",
    lastMessageAt: lastMessage?.createdAt ?? "2026-01-01T00:00:00.000Z",
    status: "active",
    unread: messages.some((message) => message.role === "assistant") && !readCharacters.has(characterId),
  };
}

function snapshotFor(characterId) {
  return {
    conversation: { id: conversationIds[characterId], characterId, status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: summaryFor(characterId).lastMessageAt },
    summary: summaryFor(characterId),
    messages: histories[characterId],
    tasks: tasks.get(characterId) ? [tasks.get(characterId)] : [],
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") return sendJson(response, 200, { ok: true });
  if (url.pathname === "/api/auth/get-session") return sendJson(response, 200, { session: { id: "test-session" }, user: { id: "test-user", email: "test@example.com", name: "测试用户", image: null } });
  if (url.pathname === "/api/characters") return sendJson(response, 200, characters);
  if (url.pathname === "/api/model/test") return sendJson(response, 200, { ok: true, latencyMs: 1 });
  if (url.pathname === "/api/conversations" && request.method === "GET") {
    return sendJson(response, 200, { conversations: Object.keys(histories).filter((id) => histories[id].length > 0).map(summaryFor) });
  }
  const byId = url.pathname.match(/^\/api\/conversations\/by-id\/([^/]+)$/);
  const byCharacter = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (byId && request.method === "GET") {
    const characterId = characterIdFor(byId[1]);
    return characterId ? sendJson(response, 200, snapshotFor(characterId)) : sendJson(response, 404, { error: "Conversation not found" });
  }
  if (byCharacter && request.method === "GET") {
    return characterFor(byCharacter[1]) ? sendJson(response, 200, snapshotFor(byCharacter[1])) : sendJson(response, 404, { error: "Character not found" });
  }
  if (url.pathname.endsWith("/read") && request.method === "POST") {
    const characterId = url.pathname.split("/").at(-2);
    if (characterFor(characterId)) readCharacters.add(characterId);
    return sendJson(response, 200, { ok: true });
  }
  return sendJson(response, 404, { error: "Not found" });
});

const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
const roomFor = (conversationId) => `conversation:${conversationId}`;

io.on("connection", (socket) => {
  socket.join("user:test-user");
  socket.on("conversation:join", (command, acknowledge) => {
    const characterId = characterIdFor(command?.conversationId);
    if (!characterId || characterId !== command?.characterId) return acknowledge?.({ ok: false, error: "Conversation not found" });
    if (socket.data.activeConversationId) socket.leave(roomFor(socket.data.activeConversationId));
    socket.join(roomFor(command.conversationId));
    socket.data.activeConversationId = command.conversationId;
    acknowledge?.({ ok: true });
  });
  socket.on("chat:send", (command, acknowledge) => {
    const characterId = characterIdFor(command?.conversationId);
    if (!characterId || characterId !== command?.characterId) return acknowledge?.({ ok: false, error: "Conversation not found" });
    const now = new Date().toISOString();
    const messageId = command.messageId;
    const task = { id: `task-${messageId}`, conversationId: command.conversationId, userMessageId: messageId, status: "processing", attempts: 1, createdAt: now, updatedAt: now };
    const userMessage = { id: messageId, clientMessageId: messageId, role: "user", content: command.content, createdAt: now, status: "accepted" };
    histories[characterId].push(userMessage);
    tasks.set(characterId, task);
    const accepted = { eventId: crypto.randomUUID(), conversationId: command.conversationId, messageId, userMessage, task };
    acknowledge?.({ ok: true, userMessage, task });
    io.to(roomFor(command.conversationId)).emit("chat:accepted", accepted);
    io.to(roomFor(command.conversationId)).emit("chat:processing", { eventId: crypto.randomUUID(), conversationId: command.conversationId, messageId, task });
    io.to(roomFor(command.conversationId)).emit("chat:typing", { eventId: crypto.randomUUID(), conversationId: command.conversationId, messageId, typing: true });
    setTimeout(() => {
      const assistantMessage = { id: crypto.randomUUID(), role: "assistant", content: `${characterId} 延迟回复`, createdAt: new Date().toISOString(), status: "completed" };
      const completedTask = { ...task, status: "completed", updatedAt: assistantMessage.createdAt };
      histories[characterId].push(assistantMessage);
      tasks.set(characterId, completedTask);
      if (socket.data.activeConversationId === command.conversationId) readCharacters.add(characterId);
      else readCharacters.delete(characterId);
      io.to(roomFor(command.conversationId)).emit("chat:completed", { eventId: crypto.randomUUID(), conversationId: command.conversationId, messageId, userMessage: { ...userMessage, status: "sent" }, assistantMessage, task: completedTask, summary: summaryFor(characterId) });
      io.to(roomFor(command.conversationId)).emit("chat:typing", { eventId: crypto.randomUUID(), conversationId: command.conversationId, messageId, typing: false });
      io.to("user:test-user").emit("conversation:updated", { eventId: crypto.randomUUID(), conversationId: command.conversationId, summary: summaryFor(characterId) });
    }, 250);
  });
});

httpServer.listen(port, "127.0.0.1");
process.on("SIGTERM", () => io.close(() => httpServer.close(() => process.exit(0))));
