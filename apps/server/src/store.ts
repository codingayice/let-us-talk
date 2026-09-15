import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, ChatTask, Conversation, ConversationStatus, ConversationSummary } from "@let-us-talk/shared";
import { config } from "./config.js";

export interface ConversationDetails {
  conversation: Conversation;
  messages: ChatMessage[];
  tasks: ChatTask[];
}

export interface PreparedChat {
  conversationId: string;
  userMessage: ChatMessage;
  task: ChatTask;
  isNewMessage: boolean;
}

export interface ChatStore {
  getConversation(userId: string, characterId: string): ConversationDetails;
  getConversationById(userId: string, conversationId: string): ConversationDetails | undefined;
  listConversations(userId: string): Array<Pick<ConversationSummary, "id" | "lastMessagePreview" | "lastMessageAt" | "status" | "unread"> & { characterId: string; lastMessageRole: ChatMessage["role"] }>;
  prepareChat(userId: string, characterId: string, content: string, clientMessageId: string, conversationId?: string): PreparedChat;
  saveMessage(userId: string, characterId: string, message: ChatMessage, conversationId?: string, clientMessageId?: string): void;
  findUserMessage(userId: string, clientMessageId: string): { conversationId: string; characterId: string; message: ChatMessage } | undefined;
  getTaskByUserMessage(userId: string, userMessageId: string): ChatTask | undefined;
  createTask(userId: string, conversationId: string, userMessageId: string): ChatTask;
  updateTask(userId: string, taskId: string, update: { status?: ChatTask["status"]; attempts?: number; error?: string }): ChatTask;
  updateMessageStatus(userId: string, messageId: string, status: ChatMessage["status"]): ChatMessage;
  countActiveTasks(conversationId: string): number;
  markConversationRead(userId: string, conversationId: string): void;
  hideConversation(userId: string, conversationId: string): void;
  restoreConversation(userId: string, conversationId: string): void;
  clearConversationById(userId: string, conversationId: string): void;
  clearConversation(userId: string, characterId: string): void;
  close(): void;
}

interface ConversationRow { id: string; character_id: string; created_at: string; updated_at: string; hidden_at: string | null; last_read_sequence: number; }
interface MessageRow { id: string; client_message_id: string | null; role: ChatMessage["role"]; content: string; created_at: string; status: ChatMessage["status"]; }
interface UserMessageRow extends MessageRow { conversation_id: string; character_id: string; }
interface TaskRow { id: string; conversation_id: string; user_message_id: string; status: ChatTask["status"]; attempts: number; error: string | null; created_at: string; updated_at: string; }
interface ConversationSummaryRow { id: string; character_id: string; content: string; role: ChatMessage["role"]; created_at: string; hidden_at: string | null; unread: number; }

function taskFromRow(row: TaskRow): ChatTask {
  return { id: row.id, conversationId: row.conversation_id, userMessageId: row.user_message_id, status: row.status, attempts: row.attempts, ...(row.error ? { error: row.error } : {}), createdAt: row.created_at, updatedAt: row.updated_at };
}

export function createStore(databasePath = config.databasePath): ChatStore {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, hidden_at TEXT,
      last_read_sequence INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, character_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      client_message_id TEXT, role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_tasks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('waiting', 'processing', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  const conversationColumns = database.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  if (!conversationColumns.some((column) => column.name === "hidden_at")) database.exec("ALTER TABLE conversations ADD COLUMN hidden_at TEXT");
  if (!conversationColumns.some((column) => column.name === "last_read_sequence")) database.exec("ALTER TABLE conversations ADD COLUMN last_read_sequence INTEGER NOT NULL DEFAULT 0");
  const messageColumns = database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === "user_id")) database.exec("ALTER TABLE messages ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE");
  if (!messageColumns.some((column) => column.name === "client_message_id")) database.exec("ALTER TABLE messages ADD COLUMN client_message_id TEXT");
  if (!messageColumns.some((column) => column.name === "status")) database.exec("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
  database.exec(`
    UPDATE messages SET user_id = (SELECT user_id FROM conversations WHERE conversations.id = messages.conversation_id) WHERE user_id IS NULL;
    UPDATE messages SET client_message_id = id WHERE role = 'user' AND client_message_id IS NULL;
    UPDATE messages SET status = CASE role WHEN 'user' THEN 'sent' ELSE 'completed' END WHERE status = 'completed';
    UPDATE messages SET status = 'accepted' WHERE status = 'confirmed';
    CREATE UNIQUE INDEX IF NOT EXISTS messages_user_client_message_id ON messages(user_id, client_message_id) WHERE client_message_id IS NOT NULL;
  `);
  // A process crash must not leave a task looking permanently active after restart.
  database.prepare("UPDATE chat_tasks SET status = 'failed', error = ?, updated_at = ? WHERE status IN ('waiting', 'processing')").run("服务重启，中断的 AI 回复可以重试", new Date().toISOString());

  const ensureUserStatement = database.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)");
  const ensureConversationStatement = database.prepare("INSERT OR IGNORE INTO conversations (id, user_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  const findConversationStatement = database.prepare("SELECT id, character_id, created_at, updated_at, hidden_at, last_read_sequence FROM conversations WHERE user_id = ? AND character_id = ?");
  const findConversationByIdStatement = database.prepare("SELECT id, character_id, created_at, updated_at, hidden_at, last_read_sequence FROM conversations WHERE user_id = ? AND id = ?");
  const updateConversationStatement = database.prepare("UPDATE conversations SET updated_at = ?, hidden_at = NULL WHERE id = ?");
  const hideConversationByIdStatement = database.prepare("UPDATE conversations SET hidden_at = ? WHERE user_id = ? AND id = ?");
  const restoreConversationStatement = database.prepare("UPDATE conversations SET hidden_at = NULL WHERE user_id = ? AND id = ?");
  const deleteMessagesStatement = database.prepare("DELETE FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE user_id = ? AND character_id = ?)");
  const deleteMessagesByIdStatement = database.prepare("DELETE FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE user_id = ? AND id = ?)");
  const resetReadSequenceStatement = database.prepare("UPDATE conversations SET last_read_sequence = 0 WHERE user_id = ? AND character_id = ?");
  const markConversationReadStatement = database.prepare("UPDATE conversations SET last_read_sequence = COALESCE((SELECT MAX(sequence) FROM messages WHERE conversation_id = conversations.id), 0) WHERE user_id = ? AND id = ?");
  const insertMessageStatement = database.prepare("INSERT INTO messages (id, user_id, conversation_id, client_message_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const getMessagesStatement = database.prepare("SELECT id, client_message_id, role, content, created_at, status FROM messages WHERE conversation_id = ? ORDER BY sequence ASC");
  const getTasksStatement = database.prepare("SELECT id, conversation_id, user_message_id, status, attempts, error, created_at, updated_at FROM chat_tasks WHERE conversation_id = ? ORDER BY created_at ASC");
  const findUserMessageStatement = database.prepare(`SELECT messages.id, messages.client_message_id, messages.role, messages.content, messages.created_at, messages.status, messages.conversation_id, conversations.character_id FROM messages INNER JOIN conversations ON conversations.id = messages.conversation_id WHERE messages.user_id = ? AND messages.client_message_id = ? AND messages.role = 'user'`);
  const findTaskStatement = database.prepare("SELECT id, conversation_id, user_message_id, status, attempts, error, created_at, updated_at FROM chat_tasks WHERE user_id = ? AND user_message_id = ?");
  const findTaskByIdStatement = database.prepare("SELECT id, conversation_id, user_message_id, status, attempts, error, created_at, updated_at FROM chat_tasks WHERE user_id = ? AND id = ?");
  const insertTaskStatement = database.prepare("INSERT INTO chat_tasks (id, user_id, conversation_id, user_message_id, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'waiting', 0, ?, ?)");
  const updateTaskStatement = database.prepare("UPDATE chat_tasks SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE user_id = ? AND id = ?");
  const updateMessageStatusStatement = database.prepare("UPDATE messages SET status = ? WHERE user_id = ? AND id = ?");
  const getMessageStatement = database.prepare("SELECT id, client_message_id, role, content, created_at, status FROM messages WHERE user_id = ? AND id = ?");
  const countActiveTasksStatement = database.prepare("SELECT COUNT(*) AS count FROM chat_tasks WHERE conversation_id = ? AND status IN ('waiting', 'processing')");
  const listConversationsStatement = database.prepare(`SELECT conversations.id, conversations.character_id, messages.content, messages.role, messages.created_at, conversations.hidden_at, EXISTS (SELECT 1 FROM messages AS unread_message WHERE unread_message.conversation_id = conversations.id AND unread_message.role = 'assistant' AND unread_message.status = 'completed' AND unread_message.sequence > conversations.last_read_sequence) AS unread FROM conversations INNER JOIN messages ON messages.conversation_id = conversations.id WHERE conversations.user_id = ? AND conversations.hidden_at IS NULL AND messages.sequence = (SELECT MAX(last_message.sequence) FROM messages AS last_message WHERE last_message.conversation_id = conversations.id) ORDER BY conversations.updated_at DESC, conversations.id DESC`);

  function ensureConversation(userId: string, characterId: string) {
    const now = new Date().toISOString();
    ensureUserStatement.run(userId, now);
    ensureConversationStatement.run(crypto.randomUUID(), userId, characterId, now, now);
    const conversation = findConversationStatement.get(userId, characterId) as unknown as ConversationRow | undefined;
    if (!conversation) throw new Error("Conversation could not be created");
    return conversation;
  }
  function toConversation(row: ConversationRow): Conversation {
    return { id: row.id, characterId: row.character_id, createdAt: row.created_at, updatedAt: row.updated_at, status: row.hidden_at ? "hidden" : "active" };
  }
  function toMessage(row: MessageRow): ChatMessage {
    return { id: row.id, ...(row.client_message_id ? { clientMessageId: row.client_message_id } : {}), role: row.role, content: row.content, createdAt: row.created_at, status: row.status };
  }
  function toDetails(row: ConversationRow): ConversationDetails {
    const messages = getMessagesStatement.all(row.id) as unknown as MessageRow[];
    const tasks = getTasksStatement.all(row.id) as unknown as TaskRow[];
    return { conversation: toConversation(row), messages: messages.map(toMessage), tasks: tasks.map(taskFromRow) };
  }

  return {
    getConversation(userId, characterId) { return toDetails(ensureConversation(userId, characterId)); },
    getConversationById(userId, conversationId) {
      const row = findConversationByIdStatement.get(userId, conversationId) as unknown as ConversationRow | undefined;
      return row ? toDetails(row) : undefined;
    },
    listConversations(userId) {
      const rows = listConversationsStatement.all(userId) as unknown as ConversationSummaryRow[];
      return rows.map(({ id, character_id: characterId, content, role: lastMessageRole, created_at: lastMessageAt, hidden_at: hiddenAt, unread }) => ({ id, characterId, lastMessagePreview: content, lastMessageAt, lastMessageRole, unread: Boolean(unread), status: hiddenAt ? "hidden" as const : "active" as const }));
    },
    prepareChat(userId, characterId, content, clientMessageId, conversationId) {
      const existing = findUserMessageStatement.get(userId, clientMessageId) as unknown as UserMessageRow | undefined;
      if (existing) {
        const task = findTaskStatement.get(userId, existing.id) as unknown as TaskRow | undefined;
        if (!task) throw new Error("Message has no task");
        return { conversationId: existing.conversation_id, userMessage: toMessage(existing), task: taskFromRow(task), isNewMessage: false };
      }
      const conversation = conversationId ? findConversationByIdStatement.get(userId, conversationId) as unknown as ConversationRow | undefined : ensureConversation(userId, characterId);
      if (!conversation || conversation.character_id !== characterId) throw new Error("Conversation not found");
      const now = new Date().toISOString();
      const userMessage: ChatMessage = { id: crypto.randomUUID(), clientMessageId, role: "user", content, createdAt: now, status: "accepted" };
      insertMessageStatement.run(userMessage.id, userId, conversation.id, clientMessageId, "user", content, "accepted", now);
      updateConversationStatement.run(now, conversation.id);
      const taskId = crypto.randomUUID();
      insertTaskStatement.run(taskId, userId, conversation.id, userMessage.id, now, now);
      const task = findTaskByIdStatement.get(userId, taskId) as unknown as TaskRow;
      return { conversationId: conversation.id, userMessage, task: taskFromRow(task), isNewMessage: true };
    },
    saveMessage(userId, characterId, message, conversationId, clientMessageId) {
      const conversation = conversationId ? findConversationByIdStatement.get(userId, conversationId) as unknown as ConversationRow | undefined : ensureConversation(userId, characterId);
      if (!conversation || conversation.character_id !== characterId) throw new Error("Conversation not found");
      insertMessageStatement.run(message.id, userId, conversation.id, message.role === "user" ? clientMessageId ?? message.clientMessageId ?? message.id : null, message.role, message.content, message.status, message.createdAt);
      updateConversationStatement.run(message.createdAt, conversation.id);
    },
    findUserMessage(userId, clientMessageId) {
      const row = findUserMessageStatement.get(userId, clientMessageId) as unknown as UserMessageRow | undefined;
      return row ? { conversationId: row.conversation_id, characterId: row.character_id, message: toMessage(row) } : undefined;
    },
    getTaskByUserMessage(userId, userMessageId) {
      const row = findTaskStatement.get(userId, userMessageId) as unknown as TaskRow | undefined;
      return row ? taskFromRow(row) : undefined;
    },
    createTask(userId, conversationId, userMessageId) {
      const existing = findTaskStatement.get(userId, userMessageId) as unknown as TaskRow | undefined;
      if (existing) return taskFromRow(existing);
      const now = new Date().toISOString();
      const taskId = crypto.randomUUID();
      insertTaskStatement.run(taskId, userId, conversationId, userMessageId, now, now);
      return taskFromRow(findTaskByIdStatement.get(userId, taskId) as unknown as TaskRow);
    },
    updateTask(userId, taskId, update) {
      const current = findTaskByIdStatement.get(userId, taskId) as unknown as TaskRow | undefined;
      if (!current) throw new Error("Task not found");
      updateTaskStatement.run(update.status ?? current.status, update.attempts ?? current.attempts, update.error ?? null, new Date().toISOString(), userId, taskId);
      return taskFromRow(findTaskByIdStatement.get(userId, taskId) as unknown as TaskRow);
    },
    updateMessageStatus(userId, messageId, status) {
      updateMessageStatusStatement.run(status, userId, messageId);
      const row = getMessageStatement.get(userId, messageId) as unknown as MessageRow | undefined;
      if (!row) throw new Error("Message not found");
      return toMessage(row);
    },
    countActiveTasks(conversationId) { return Number((countActiveTasksStatement.get(conversationId) as unknown as { count: number | bigint }).count); },
    markConversationRead(userId, conversationId) { markConversationReadStatement.run(userId, conversationId); },
    hideConversation(userId, conversationId) { hideConversationByIdStatement.run(new Date().toISOString(), userId, conversationId); },
    restoreConversation(userId, conversationId) { restoreConversationStatement.run(userId, conversationId); },
    clearConversationById(userId, conversationId) { deleteMessagesByIdStatement.run(userId, conversationId); },
    clearConversation(userId, characterId) {
      deleteMessagesStatement.run(userId, characterId);
      resetReadSequenceStatement.run(userId, characterId);
    },
    close() { database.close(); },
  };
}
