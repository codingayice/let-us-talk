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
