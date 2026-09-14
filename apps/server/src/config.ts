import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3001),
  llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "gpt-4o-mini",
  databasePath: process.env.DATABASE_PATH ?? "data/let-us-talk.sqlite",
  authSecret: process.env.BETTER_AUTH_SECRET ?? "let-us-talk-development-secret-change-me",
  authBaseUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === "true",
};
