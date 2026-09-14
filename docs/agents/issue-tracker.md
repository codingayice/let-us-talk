# Issue tracker：GitHub

本项目的 issue 和规格文档发布在 GitHub Issues。所有 issue tracker 操作使用 `gh` CLI，并根据当前 Git remote 自动识别仓库。

## 常用操作

- 创建 issue：`gh issue create --title "..." --body "..."`
- 查看 issue：`gh issue view <number> --comments`
- 列出 issue：`gh issue list --state open`
- 添加评论：`gh issue comment <number> --body "..."`
- 添加或移除标签：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- 关闭 issue：`gh issue close <number> --comment "..."`

## Pull Request

PR 不作为 triage 请求入口。

## 技能发布规则

当技能要求“发布到 issue tracker”时，创建一个 GitHub issue。

当技能要求“获取相关 ticket”时，运行 `gh issue view <number> --comments`。
