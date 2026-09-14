import { test, expect, type Page } from "@playwright/test";

const characters = [
  { id: "momo", name: "Momo", avatar: "🌙", tagline: "温柔、细腻，喜欢听你慢慢说" },
  { id: "loki", name: "Loki", avatar: "🦊", tagline: "有点毒舌，但总是站在你这边" },
  { id: "nora", name: "Nora", avatar: "☕", tagline: "理性又好奇，什么都愿意聊" },
];

function message(characterId: string, role: "user" | "assistant", content: string) {
  return {
    id: `${characterId}-${role}`,
    role,
    content,
    createdAt: "2026-01-01T12:00:00.000Z",
  };
}

async function mockChatApi(page: Page) {
  const histories: Record<string, ReturnType<typeof message>[]> = {
    momo: [message("momo", "assistant", "Momo 历史消息")],
    loki: [message("loki", "assistant", "Loki 历史消息")],
    nora: [],
  };

  await page.route("**/api/characters", (route) => route.fulfill({ json: characters }));
  await page.route("**/api/conversations/*", (route) => {
    const characterId = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    return route.fulfill({ json: { messages: histories[characterId] ?? [] } });
  });
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as { characterId: string; content: string };
    const response = [
      message(body.characterId, "user", body.content),
      message(body.characterId, "assistant", `${body.characterId} 回复`),
    ];
    histories[body.characterId] = [...histories[body.characterId], ...response];
    await route.fulfill({ json: { userMessage: response[0], assistantMessage: response[1] } });
  });
}

test("switching contacts restores the selected contact history", async ({ page }) => {
  await mockChatApi(page);
  await page.goto("/");

  await expect(page.locator("[data-character-id]")).toHaveCount(3);
  await page.locator('[data-character-id="loki"]').click();
  await expect(page.getByText("Loki 历史消息")).toBeVisible();
  await expect(page.getByText("Momo 历史消息")).toHaveCount(0);

  await page.locator('[data-character-id="momo"]').click();
  await expect(page.getByText("Momo 历史消息")).toBeVisible();
  await expect(page.getByText("Loki 历史消息")).toHaveCount(0);
});

test("a late response from another contact does not leak into the current chat", async ({ page }) => {
  let releaseMomoResponse!: () => void;
  const momoResponseReady = new Promise<void>((resolve) => {
    releaseMomoResponse = resolve;
  });
  await mockChatApi(page);
  await page.unroute("**/api/chat");
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as { characterId: string; content: string };
    const response = [
      message(body.characterId, "user", body.content),
      message(body.characterId, "assistant", "Momo 延迟回复"),
    ];
    await momoResponseReady;
    await route.fulfill({ json: { userMessage: response[0], assistantMessage: response[1] } });
  });
  await page.goto("/");

  const editor = page.locator('[contenteditable="true"]');
  await editor.fill("只给 Momo 的消息");
  await page.locator(".cs-button--send").click();
  await page.locator('[data-character-id="loki"]').click();
  await expect(page.getByText("Momo 延迟回复")).toHaveCount(0);

  const responsePromise = page.waitForResponse("**/api/chat");
  releaseMomoResponse();
  await responsePromise;
  await expect(page.getByText("Momo 延迟回复")).toHaveCount(0);
});
