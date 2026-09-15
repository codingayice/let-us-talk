import { test, expect } from "@playwright/test";

test("the conversation boundary survives a real Socket.IO switch and late reply", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("let-us-talk:model-config:v1", JSON.stringify({
      version: 1,
      config: { baseUrl: "https://provider.example/v1", apiKey: "test-secret", model: "test-model" },
    }));
  });
  await page.goto("/?realtime=socket");

  await expect(page.getByText("Momo 历史消息")).toBeVisible();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill("只给 Momo 的消息");
  await page.locator(".cs-button--send").click();
  await page.locator('[data-character-id="loki"]').click();
  await expect(page.getByText("Loki 历史消息")).toBeVisible();
  await expect(page.getByText("momo 延迟回复")).toHaveCount(0);

  await page.getByRole("button", { name: "会话", exact: true }).click();
  const momoConversation = page.locator('[data-conversation-id="00000000-0000-4000-8000-000000000001"]');
  await expect(momoConversation).toContainText("Momo：momo 延迟回复");
  await expect(momoConversation.locator('[aria-label="未读消息"]')).toBeVisible();
  await momoConversation.click();
  await expect(page.getByText("momo 延迟回复")).toBeVisible();
});
