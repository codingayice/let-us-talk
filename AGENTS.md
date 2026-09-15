# Agent 协作说明

## Agent skills

### Issue tracker

本项目使用 GitHub Issues 管理需求、规格和开发事项。使用 `gh` CLI 操作。详见 `docs/agents/issue-tracker.md`。

### 提交信息

提交信息遵循 Conventional Commits，使用中文，并使用 GitHub Issue 关联：

```text
<type>(<scope>): <简短说明>

<可选：说明实现原因、行为变化或验证方式>

<可选：Fixes #<issue-number> / Refs #<issue-number>>
```

`type` 使用 `feat`、`fix`、`docs`、`test`、`refactor`、`build`、`ci`、`chore` 或 `revert`；`scope` 按需填写。标题使用祈使语气，聚焦一个变更，控制在约 72 个字符内；正文说明“为什么”和重要影响，Issue 关联写在正文末尾。完成提交前，确认提交信息能独立说明变更目的，并且关联的 Issue 编号真实存在。

需求对应的 Issue 完成并验证通过后，关闭该 GitHub Issue，并在关闭时记录完成情况。

### Triage 标签

使用默认标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### 领域文档

本项目采用 single-context 布局：根目录使用 `CONTEXT.md`，架构决策记录在 `docs/adr/`。详见 `docs/agents/domain.md`。

## UI 设计规范

Web 端是中文 AI Social Messaging IM 产品。展示层使用项目自有的 IM Modules 和原生 CSS，不直接引入第三方 IM 组件库；聊天、会话、认证、模型配置和持久化行为必须继续由现有运行时与 API 提供。

- 一级导航固定为“消息、联系人、发现、我的”，登录后的默认页面为“消息”。桌面端采用导航栏、列表栏、主内容栏三栏布局；移动端将列表和详情切换为两个独立屏幕，并在详情提供“返回列表”。
- 颜色 Token 只能从 `apps/web/src/styles.css` 的 `--im-*` 变量使用：主色 `#4F7DF3`、悬停色 `#2E6AE0`、浅蓝 `#E8F0FE`、页面背景 `#F5F7FA`、边框 `#E5E8ED`、主文字 `#1F2937`、次文字 `#8A93A4`、占位色 `#B0B8C8`、在线绿 `#34D399`、离线灰 `#9CA3AF`、未读红 `#EF4444`。
- 字体优先使用本地 `Inter`，中文回退到苹方、微软雅黑和系统字体。字号层级为 24/18/15/14/12/11px；间距只使用 4/8/12/16/24/32px；圆角使用 8/10/12/16/18/24px；阴影使用小、中、大三级 Token。
- 会话项必须展示头像、名称、最新消息摘要、时间和未读徽标；聊天头部必须展示头像、名称、在线状态和简介。头像地址必须通过 `AvatarProvider` 适配器生成；远端头像不可用时保持不可用，不在组件内伪造回退头像。
- 消息气泡区分 AI 入站和用户出站，保留时间、发送者和复制消息动作。历史加载、空状态、发送中、任务失败和重试状态必须可见且语义明确。
- 搜索、语音、视频、图片、贴纸、表情、反应及置顶/免打扰/拉黑/举报等仅提供视觉组件；未开放能力必须 `disabled`，不得触发聊天或账号请求。
- 所有交互控件必须有中文可访问名称、可见键盘焦点、正确的 disabled/hover/active 状态和至少适合触摸的点击区域；支持 `prefers-reduced-motion`。
- 发现页使用完整的页面外壳与清晰空状态，不虚构社交内容；我的页面承载账号资料、密码管理、模型配置、关于说明和退出登录。AI 好友资料为只读展示。
- 修改 UI 时不得恢复 ChatScope 依赖、全局样式或 Tailwind；不得把业务状态、消息传输、会话对账或模型调用重新放入页面组件。固定视口验收使用桌面 1440x900 和移动 390x844，并等待字体及确定性 fixture 数据稳定后再截图。
