import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3001),
  llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "gpt-4o-mini",
  databasePath: process.env.DATABASE_PATH ?? "data/let-us-talk.sqlite",
};
