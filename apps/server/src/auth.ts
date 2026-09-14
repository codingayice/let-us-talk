import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import type { Auth, BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { bearer, jwt } from "better-auth/plugins";
import { config } from "./config.js";

export type AuthInstance = Auth<BetterAuthOptions>;
export const devResetTokens = new Map<string, string>();

export async function createAuth(databasePath = config.databasePath): Promise<AuthInstance> {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  const options = {
    database,
    baseURL: config.authBaseUrl,
    trustedOrigins: [config.authBaseUrl, "http://localhost:5173", "http://localhost:80"],
    secret: config.authSecret,
    telemetry: { enabled: false },
    rateLimit: { enabled: false },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      requireEmailVerification: config.requireEmailVerification,
      sendResetPassword: async ({ user, url, token }: { user: { email: string }; url: string; token: string }) => {
        if (!config.requireEmailVerification) devResetTokens.set(user.email, token);
        console.info(`Password reset requested for ${user.email}: ${url}`);
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        console.info(`Email verification requested for ${user.email}: ${url}`);
      },
      sendOnSignUp: config.requireEmailVerification,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    plugins: [bearer(), jwt()],
    databaseHooks: {
      session: {
        create: {
          after: async (session: { id: string; userId: string }) => {
            // This product intentionally permits one active device per account.
            database.prepare("DELETE FROM session WHERE userId = ? AND id <> ?").run(session.userId, session.id);
          },
        },
      },
    },
  };
  const migrations = await getMigrations(options);
  await migrations.runMigrations();
  return betterAuth(options) as unknown as AuthInstance;
}
