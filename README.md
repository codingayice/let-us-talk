# Let Us Talk

一个面向 AI 角色私聊的 TypeScript MVP。

当前产品规格见：[docs/mvp-spec.md](docs/mvp-spec.md)

实施任务单见：[docs/mvp-tickets.md](docs/mvp-tickets.md)

## 当前边界

- Better Auth 邮箱密码账号与单设备服务端会话
- 3 个固定 AI 角色
- 一对一文字聊天
- 普通一次性完整回复
- SQLite 持久化账号、会话和聊天记录
- 一个 OpenAI-compatible 模型适配器
- 暂不包含长期记忆、群聊、AI 主动消息和真人社交

规格文档已经确定；当前代码支持登录账号隔离、单设备会话、普通回复和清空会话。

## 启动

服务端使用 Node.js 内置的 `node:sqlite`，需要 Node.js 22.5 或更高版本。

```bash
pnpm install
copy .env.example .env
pnpm dev
```

前端：http://localhost:5173
API：http://localhost:3001

开发环境默认跳过邮箱验证；密码重置链接会输出到服务端日志。生产环境请设置随机的 `BETTER_AUTH_SECRET`，并启用邮箱验证及邮件发送实现。

## 模型适配

登录后打开“设置”，填写 OpenAI-compatible 服务的 Base URL、API Key 和 Model，并先测试连接再保存。配置只保存在当前浏览器；服务端不读取全局模型环境变量，也不会持久化或回显 API Key。

业务代码通过请求级 `ChatModel` 适配器调用模型，未来可以增加官方 Anthropic、Google 或本地 Ollama 适配器。
