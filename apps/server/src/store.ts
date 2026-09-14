import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, Conversation, ConversationStatus, ConversationSummary } from "@let-us-talk/shared";
import { config } from "./config.js";

export interface ConversationDetails {
  conversation: Conversation;
  messages: ChatMessage[];
}

export interface ChatStore {
  getConversation(userId: string, characterId: string): ConversationDetails;
  getConversationById(userId: string, conversationId: string): ConversationDetails | undefined;
  listConversations(userId: string): Array<Pick<ConversationSummary, "id" | "lastMessagePreview" | "lastMessageAt" | "status"> & { characterId: string }>;
  saveMessage(userId: string, characterId: string, message: ChatMessage, conversationId?: string): void;
  clearConversation(userId: string, characterId: string): void;
  close(): void;
}

interface ConversationRow {
  id: string;
  character_id: string;
  created_at: string;
  updated_at: string;
  hidden_at: string | null;
}

interface MessageRow {
  id: string;
  role: ChatMessage["role"];
  content: string;
  created_at: string;
}

interface ConversationSummaryRow {
  id: string;
  character_id: string;
  content: string;
  created_at: string;
  hidden_at: string | null;
}

export function createStore(databasePath = config.databasePath): ChatStore {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      hidden_at TEXT,
      UNIQUE(user_id, character_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const conversationColumns = database.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  if (!conversationColumns.some((column) => column.name === "hidden_at")) {
    database.exec("ALTER TABLE conversations ADD COLUMN hidden_at TEXT");
  }

  const ensureUserStatement = database.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)");
  const ensureConversationStatement = database.prepare("INSERT OR IGNORE INTO conversations (id, user_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  const findConversationStatement = database.prepare("SELECT id, character_id, created_at, updated_at, hidden_at FROM conversations WHERE user_id = ? AND character_id = ?");
  const findConversationByIdStatement = database.prepare("SELECT id, character_id, created_at, updated_at, hidden_at FROM conversations WHERE user_id = ? AND id = ?");
  const updateConversationStatement = database.prepare("UPDATE conversations SET updated_at = ?, hidden_at = NULL WHERE id = ?");
  const hideConversationStatement = database.prepare("UPDATE conversations SET hidden_at = ?, updated_at = ? WHERE user_id = ? AND character_id = ?");
  const deleteMessagesStatement = database.prepare("DELETE FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE user_id = ? AND character_id = ?)");
  const insertMessageStatement = database.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)");
  const getMessagesStatement = database.prepare("SELECT messages.id, messages.role, messages.content, messages.created_at FROM messages WHERE messages.conversation_id = ? ORDER BY messages.sequence ASC");
  const listConversationsStatement = database.prepare(`
    SELECT conversations.id, conversations.character_id, messages.content, messages.created_at, conversations.hidden_at
    FROM conversations
    INNER JOIN messages ON messages.conversation_id = conversations.id
    WHERE conversations.user_id = ?
      AND conversations.hidden_at IS NULL
      AND messages.sequence = (
        SELECT MAX(last_message.sequence) FROM messages AS last_message WHERE last_message.conversation_id = conversations.id
      )
    ORDER BY conversations.updated_at DESC
  `);

  function ensureConversation(userId: string, characterId: string) {
    const now = new Date().toISOString();
    ensureUserStatement.run(userId, now);
    ensureConversationStatement.run(crypto.randomUUID(), userId, characterId, now, now);
    const conversation = findConversationStatement.get(userId, characterId) as unknown as ConversationRow | undefined;
    if (!conversation) throw new Error("Conversation could not be created");
    return conversation;
  }

  function toConversation(row: ConversationRow): Conversation {
    const status: ConversationStatus = row.hidden_at ? "hidden" : "active";
    return {
      id: row.id,
      characterId: row.character_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status,
    };
  }

  function toDetails(row: ConversationRow): ConversationDetails {
    const rows = getMessagesStatement.all(row.id) as unknown as MessageRow[];
    return {
      conversation: toConversation(row),
      messages: rows.map(({ id, role, content, created_at: createdAt }) => ({ id, role, content, createdAt })),
    };
  }

  return {
    getConversation(userId, characterId) {
      return toDetails(ensureConversation(userId, characterId));
    },
    getConversationById(userId, conversationId) {
      const row = findConversationByIdStatement.get(userId, conversationId) as unknown as ConversationRow | undefined;
      return row ? toDetails(row) : undefined;
    },
    listConversations(userId) {
      const rows = listConversationsStatement.all(userId) as unknown as ConversationSummaryRow[];
      return rows.map(({ id, character_id: characterId, content, created_at: lastMessageAt, hidden_at: hiddenAt }) => ({
        id,
        characterId,
        lastMessagePreview: content,
        lastMessageAt,
        status: hiddenAt ? "hidden" as const : "active" as const,
      }));
    },
    saveMessage(userId, characterId, message, conversationId) {
      const conversation = conversationId
        ? (findConversationByIdStatement.get(userId, conversationId) as unknown as ConversationRow | undefined)
        : ensureConversation(userId, characterId);
      if (!conversation || conversation.character_id !== characterId) throw new Error("Conversation not found");
      insertMessageStatement.run(message.id, conversation.id, message.role, message.content, message.createdAt);
      updateConversationStatement.run(message.createdAt, conversation.id);
    },
    clearConversation(userId, characterId) {
      const now = new Date().toISOString();
      deleteMessagesStatement.run(userId, characterId);
      hideConversationStatement.run(now, now, userId, characterId);
    },
    close() { database.close(); },
  };
}
