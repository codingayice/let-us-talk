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
  const conversationIds = { momo: "00000000-0000-4000-8000-000000000001", loki: "00000000-0000-4000-8000-000000000002", nora: "00000000-0000-4000-8000-000000000003" };
  const histories: Record<string, ReturnType<typeof message>[]> = {
    momo: [message("momo", "assistant", "Momo 历史消息")],
    loki: [message("loki", "assistant", "Loki 历史消息")],
    nora: [],
  };
  const readCharacters = new Set<string>();

  await page.addInitScript(() => {
    if (!sessionStorage.getItem("let-us-talk:e2e-config-seeded")) {
      localStorage.setItem("let-us-talk:model-config:v1", JSON.stringify({
        version: 1,
        config: { baseUrl: "https://provider.example/v1", apiKey: "test-secret", model: "test-model" },
      }));
      sessionStorage.setItem("let-us-talk:e2e-config-seeded", "true");
    }
  });

  await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: {
    session: { id: "test-session" },
    user: { id: "test-user", email: "test@example.com", name: "测试用户", image: null },
  } }));
  await page.route("**/api/characters", (route) => route.fulfill({ json: characters }));
  await page.route("**/api/conversations", (route) => {
    const conversations = Object.entries(histories)
      .filter(([, messages]) => messages.length > 0)
      .map(([characterId, messages]) => {
        const character = characters.find((item) => item.id === characterId)!;
        const lastMessage = messages.at(-1)!;
        return {
          id: conversationIds[characterId as keyof typeof conversationIds],
          character,
          lastMessagePreview: lastMessage.content,
          lastMessageAt: lastMessage.createdAt,
          status: "active",
          unread: messages.length > 0 && !readCharacters.has(characterId),
        };
      });
    return route.fulfill({ json: { conversations } });
  });
  await page.route("**/api/conversations/**", (route) => {
    const pathParts = new URL(route.request().url()).pathname.split("/");
    const routeValue = pathParts.at(-1) ?? "";
    const characterId = pathParts.at(-2) === "by-id"
      ? Object.entries(conversationIds).find(([, id]) => id === routeValue)?.[0] ?? ""
      : pathParts.at(-1) === "read" || pathParts.at(-1) === "hide" || pathParts.at(-1) === "restore"
        ? pathParts.at(-2) ?? ""
        : routeValue;
    if (route.request().method() === "POST" && pathParts.at(-1) === "read") readCharacters.add(characterId);
    if (route.request().method() === "DELETE") {
      histories[characterId] = [];
    }
    const character = characters.find((item) => item.id === characterId)!;
    const messages = histories[characterId] ?? [];
    const lastMessage = messages.at(-1);
    return route.fulfill({ json: {
      conversation: { id: conversationIds[characterId as keyof typeof conversationIds], characterId, status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: lastMessage?.createdAt ?? "2026-01-01T00:00:00.000Z" },
      summary: { id: conversationIds[characterId as keyof typeof conversationIds], character, lastMessagePreview: lastMessage?.content ?? "", lastMessageAt: lastMessage?.createdAt ?? "2026-01-01T00:00:00.000Z", status: "active", unread: messages.length > 0 && !readCharacters.has(characterId) },
      messages,
      tasks: [],
    } });
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
  await page.route("**/api/model/test", async (route) => {
    await route.fulfill({ json: { ok: true, latencyMs: 12 } });
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

test("authenticated shell exposes conversations, contacts and settings as three columns", async ({ page }) => {
  await mockChatApi(page);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "会话", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "联系人", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "联系人", exact: true }).click();
  await page.locator('[data-character-id="momo"]').click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill("从联系人进入");
  await page.locator(".cs-button--send").click();
  await expect(page.getByText("momo 回复")).toBeVisible();

  await page.getByRole("button", { name: "会话", exact: true }).click();
  const conversation = page.locator('[data-conversation-id]').first();
  await expect(conversation).toBeVisible();
  const conversationId = await conversation.getAttribute("data-conversation-id");
  expect(conversationId).toBe("00000000-0000-4000-8000-000000000001");
  await conversation.click();
  await expect(page.getByText("从联系人进入")).toBeVisible();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".im-settings-panel").getByRole("button", { name: "账号资料" })).toBeVisible();
  await expect(page.locator(".im-settings-panel").getByRole("button", { name: "密码管理" })).toBeVisible();
  await expect(page.locator(".im-settings-panel").getByRole("button", { name: "关于与说明" })).toBeVisible();
});

test("model settings save, restore, clear, and test unsaved values without chat history", async ({ page }) => {
  let testRequest: { config: { baseUrl: string; apiKey: string; model: string } } | undefined;
  await mockChatApi(page);
  await page.unroute("**/api/model/test");
  await page.route("**/api/model/test", async (route) => {
    testRequest = route.request().postDataJSON() as typeof testRequest;
    await route.fulfill({ json: { ok: true, latencyMs: 7 } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByText("已配置")).toBeVisible();
  await expect(page.getByLabel("API Key")).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "显示" }).click();
  await expect(page.getByLabel("API Key")).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "隐藏" }).click();
  await page.getByLabel("Base URL").fill("https://unsaved.example/custom");
  await page.getByLabel("API Key").fill("unsaved-secret");
  await page.getByLabel("Model").fill("unsaved-model");
  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByRole("status")).toContainText("连接成功");
  expect(testRequest?.config).toEqual({ baseUrl: "https://unsaved.example/custom", apiKey: "unsaved-secret", model: "unsaved-model" });
  expect(await page.evaluate(() => localStorage.getItem("let-us-talk:model-config:v1"))).toContain("provider.example");

  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByText("配置已保存到当前浏览器")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("Base URL")).toHaveValue("https://unsaved.example/custom");
  await page.getByRole("button", { name: "清除配置" }).click();
  await expect(page.getByText("已清除本地模型配置")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("let-us-talk:model-config:v1"))).toBeNull();
  await page.getByRole("button", { name: "联系人", exact: true }).click();
  await expect(page.getByText("Momo 历史消息")).toBeVisible();
});

test("sending without a local model configuration is blocked before chat history changes", async ({ page }) => {
  let chatRequests = 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatApi(page);
  await page.unroute("**/api/chat");
  await page.route("**/api/chat", async (route) => {
    chatRequests += 1;
    await route.continue();
  });
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("let-us-talk:model-config:v1"));
  await page.reload();
  await page.locator('[data-character-id="momo"]').click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill("未配置时不应发送");
  await page.locator(".cs-button--send").click();
  await expect(page.getByRole("alert")).toContainText("请先前往设置保存模型配置");
  await expect(page.getByRole("button", { name: "设置", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".im-model-settings")).toBeVisible();
  expect(chatRequests).toBe(0);
  await expect(page.getByText("未配置", { exact: true })).toBeVisible();
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
  await expect(editor).toBeEditable();
  await editor.fill("只给 Momo 的消息");
  await page.locator(".cs-button--send").click();
  await page.locator('[data-character-id="loki"]').click();
  await expect(page.getByText("Momo 延迟回复")).toHaveCount(0);

  const responsePromise = page.waitForResponse("**/api/chat");
  releaseMomoResponse();
  await responsePromise;
  await expect(page.getByText("Momo 延迟回复")).toHaveCount(0);
});

test("clearing the current conversation shows the empty state without clearing another contact", async ({ page }) => {
  await mockChatApi(page);
  await page.goto("/");

  await expect(page.getByText("Momo 历史消息")).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "清空当前会话" }).click();
  await expect(page.getByText("开始和 Momo 聊天")).toBeVisible();
  await expect(page.getByText("Momo 历史消息")).toHaveCount(0);

  await page.locator('[data-character-id="loki"]').click();
  await expect(page.getByText("Loki 历史消息")).toBeVisible();
});

test("a failed message can be retried without duplicating it", async ({ page }) => {
  let attempts = 0;
  const messageIds: string[] = [];
  await mockChatApi(page);
  await page.unroute("**/api/chat");
  await page.route("**/api/chat", async (route) => {
    attempts += 1;
    const body = route.request().postDataJSON() as { characterId: string; content: string; messageId: string };
    messageIds.push(body.messageId);
    if (attempts === 1) {
      await route.fulfill({ status: 503, json: { error: "服务暂时不可用，请重试" } });
      return;
    }
    const response = [
      message(body.characterId, "user", body.content),
      message(body.characterId, "assistant", "重试成功"),
    ];
    await route.fulfill({ json: { userMessage: response[0], assistantMessage: response[1] } });
  });
  await page.goto("/");

  const editor = page.locator('[contenteditable="true"]');
  await expect(editor).toBeEditable();
  await editor.fill("网络失败后重试");
  await page.locator(".cs-button--send").click();
  await expect(page.getByRole("alert")).toContainText("服务暂时不可用，请重试");
  await page.getByRole("button", { name: "重试发送" }).click();

  await expect(page.getByText("重试成功")).toBeVisible();
  await expect(page.getByText("网络失败后重试", { exact: true })).toHaveCount(1);
  expect(attempts).toBe(2);
  expect(messageIds[0]).toBe(messageIds[1]);
});

test("a network failure explains what to do next", async ({ page }) => {
  let attempts = 0;
  await mockChatApi(page);
  await page.unroute("**/api/chat");
  await page.route("**/api/chat", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort("failed");
      return;
    }
    const body = route.request().postDataJSON() as { characterId: string; content: string };
    const response = [
      message(body.characterId, "user", body.content),
      message(body.characterId, "assistant", "网络恢复后的回复"),
    ];
    await route.fulfill({ json: { userMessage: response[0], assistantMessage: response[1] } });
  });
  await page.goto("/");

  const editor = page.locator('[contenteditable="true"]');
  await expect(editor).toBeEditable();
  await editor.fill("网络故障测试");
  await page.locator(".cs-button--send").click();
  await expect(page.getByRole("alert")).toContainText("网络连接失败，请稍后重试");
  await page.getByRole("button", { name: "重试发送" }).click();
  await expect(page.getByText("网络恢复后的回复")).toBeVisible();
  expect(attempts).toBe(2);
});

test("sending disables duplicate submission and clearly reports progress", async ({ page }) => {
  let releaseResponse!: () => void;
  const responseReady = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let attempts = 0;
  await mockChatApi(page);
  await page.unroute("**/api/chat");
  await page.route("**/api/chat", async (route) => {
    attempts += 1;
    const body = route.request().postDataJSON() as { characterId: string; content: string };
    await responseReady;
    const response = [
      message(body.characterId, "user", body.content),
      message(body.characterId, "assistant", "单次回复"),
    ];
    await route.fulfill({ json: { userMessage: response[0], assistantMessage: response[1] } });
  });
  await page.goto("/");

  const editor = page.locator('[contenteditable="true"]');
  await expect(editor).toBeEditable();
  await editor.fill("不要重复发送");
  await page.locator(".cs-button--send").click();
  await expect(page.getByRole("status")).toContainText("正在等待 Momo 回复");
  await expect(page.getByText("对方正在输入中…")).toBeVisible();
  await expect(page.locator(".cs-button--send")).toBeDisabled();
  expect(attempts).toBe(1);
  releaseResponse();
  await expect(page.getByText("单次回复")).toBeVisible();
});

test("about explains the AI identity and MVP limitations outside the chat", async ({ page }) => {
  await mockChatApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "关于与说明" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("AI 身份");
  await expect(dialog).toContainText("实验性质");
  await expect(dialog).toContainText("MVP 限制");
  await expect(page.locator(".cs-conversation-header")).not.toContainText("AI 角色");
});

test("auth form uses custom validation and Chinese login errors", async ({ page }) => {
  await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/sign-in/email", (route) => route.fulfill({
    status: 401,
    json: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
  }));
  await page.goto("/");

  await page.getByRole("button", { name: "欢迎回来" }).click();
  await expect(page.getByText("请输入有效的邮箱地址")).toBeVisible();
  await expect(page.getByText("请输入密码")).toBeVisible();
  await expect(page.getByLabel("邮箱")).toHaveAttribute("aria-invalid", "true");

  await page.getByLabel("邮箱").fill("user@example.com");
  await page.getByLabel("密码").fill("password123");
  await page.getByRole("button", { name: "欢迎回来" }).click();
  await expect(page.getByRole("alert")).toHaveText("邮箱或密码错误");
});

test("conversation summaries show unread dots and opening a conversation clears the dot", async ({ page }) => {
  await mockChatApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "会话", exact: true }).click();
  await expect(page.locator('[aria-label="未读消息"]')).toHaveCount(1);
  await page.locator('[data-conversation-id="00000000-0000-4000-8000-000000000002"]').click();
  await expect(page.locator('[aria-label="未读消息"]')).toHaveCount(0);
});

test("desktop context menu hides a conversation and contact selection restores its history", async ({ page }) => {
  await mockChatApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "会话", exact: true }).click();
  const conversation = page.locator('[data-conversation-id="00000000-0000-4000-8000-000000000001"]');
  await conversation.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "隐藏会话" }).click({ force: true });
  await expect(conversation).toHaveCount(0);
  await page.getByRole("button", { name: "联系人", exact: true }).click();
  await page.locator('[data-character-id="momo"]').click();
  await expect(page.getByText("Momo 历史消息")).toBeVisible();
});

test("messages preserve emoji and can be copied", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockChatApi(page);
  await page.goto("/");
  const editor = page.locator('[contenteditable="true"]');
  await expect(editor).toBeEditable();
  await editor.fill("你好 ✨🙂");
  await page.locator(".cs-button--send").click();
  await expect(page.getByText("你好 ✨🙂", { exact: true })).toBeVisible();
  const sentMessage = page.locator(".im-message-row").filter({ hasText: "你好 ✨🙂" });
  await sentMessage.getByRole("button", { name: "复制消息" }).click();
  await expect(sentMessage.getByRole("button", { name: "复制消息" })).toContainText("已复制");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("你好 ✨🙂");
});

test("mobile navigation opens a selected contact in the chat pane and returns to the list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatApi(page);
  await page.goto("/");
  await expect(page.locator('[data-mobile-chat="false"]')).toBeVisible();
  await page.locator('[data-character-id="loki"]').click();
  await expect(page.locator('[data-mobile-chat="true"]')).toBeVisible();
  await expect(page.getByText("Loki 历史消息")).toBeVisible();
  await page.getByRole("button", { name: "返回列表" }).click();
  await expect(page.locator('[data-mobile-chat="false"]')).toBeVisible();
});
