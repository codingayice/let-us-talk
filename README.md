# Let Us Talk

一个面向 AI 角色私聊的 TypeScript MVP。

当前产品规格见：[docs/mvp-spec.md](docs/mvp-spec.md)

实施任务单见：[docs/mvp-tickets.md](docs/mvp-tickets.md)

## 当前边界

- 单个匿名用户，本地生成 `userId`
- 3 个固定 AI 角色
- 一对一文字聊天
- 普通一次性完整回复
- SQLite 持久化聊天记录
- 一个 OpenAI-compatible 模型适配器
- 暂不包含长期记忆、群聊、AI 主动消息和真人社交

规格文档已经确定；当前代码仍处于前端/后端骨架阶段，SQLite、匿名用户隔离、普通回复和清空会话会按规格继续实现。

## 启动

服务端使用 Node.js 内置的 `node:sqlite`，需要 Node.js 22.5 或更高版本。

```bash
pnpm install
copy .env.example .env
# 编辑 .env，填写 LLM_API_KEY 和 LLM_MODEL
pnpm dev
```

前端：http://localhost:5173
API：http://localhost:3001

## 模型适配

服务端通过 `@ai-sdk/openai-compatible` 接入兼容 OpenAI Chat Completions API 的服务。只需修改：

- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`

业务代码只依赖 `ChatModel` 接口，未来可以增加官方 Anthropic、Google 或本地 Ollama 适配器。
