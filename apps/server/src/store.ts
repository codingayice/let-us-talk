import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage } from "@let-us-talk/shared";
import { config } from "./config.js";

export interface ChatStore {
  getConversation(userId: string, characterId: string): ChatMessage[];
  saveMessage(userId: string, characterId: string, message: ChatMessage): void;
  clearConversation(userId: string, characterId: string): void;
  close(): void;
}

interface MessageRow {
  id: string;
  role: ChatMessage["role"];
  content: string;
  created_at: string;
}

export function createStore(databasePath = config.databasePath): ChatStore {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

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

  const ensureUserStatement = database.prepare(
    "INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)",
  );
  const ensureConversationStatement = database.prepare(`
    INSERT OR IGNORE INTO conversations (id, user_id, character_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const findConversationStatement = database.prepare(
    "SELECT id FROM conversations WHERE user_id = ? AND character_id = ?",
  );
  const updateConversationStatement = database.prepare(
    "UPDATE conversations SET updated_at = ? WHERE id = ?",
  );
  const insertMessageStatement = database.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getMessagesStatement = database.prepare(`
    SELECT messages.id, messages.role, messages.content, messages.created_at
    FROM messages
    INNER JOIN conversations ON conversations.id = messages.conversation_id
    WHERE conversations.user_id = ? AND conversations.character_id = ?
    ORDER BY messages.sequence ASC
  `);
  const deleteConversationStatement = database.prepare(
    "DELETE FROM conversations WHERE user_id = ? AND character_id = ?",
  );

  function ensureConversation(userId: string, characterId: string) {
    const now = new Date().toISOString();
    ensureUserStatement.run(userId, now);
    ensureConversationStatement.run(crypto.randomUUID(), userId, characterId, now, now);
    const conversation = findConversationStatement.get(userId, characterId) as { id: string } | undefined;
    if (!conversation) {
      throw new Error("Conversation could not be created");
    }
    return conversation.id;
  }

  return {
    getConversation(userId, characterId) {
      ensureUserStatement.run(userId, new Date().toISOString());
      const rows = getMessagesStatement.all(userId, characterId) as unknown as MessageRow[];
      return rows.map(({ id, role, content, created_at: createdAt }) => ({
        id,
        role,
        content,
        createdAt,
      }));
    },

    saveMessage(userId, characterId, message) {
      const conversationId = ensureConversation(userId, characterId);
      insertMessageStatement.run(
        message.id,
        conversationId,
        message.role,
        message.content,
        message.createdAt,
      );
      updateConversationStatement.run(message.createdAt, conversationId);
    },

    clearConversation(userId, characterId) {
      deleteConversationStatement.run(userId, characterId);
    },

    close() {
      database.close();
    },
  };
}
