# 工作区（WeChat ↔ Claude Code 桥接环境）

这是通过微信消息桥接 Claude Code 的会话环境。用户以微信消息形式下达指令，回复直接推送回微信。

## 现有内容

| 路径 | 说明 |
|---|---|
| `wechat-claude-code/` | 微信 ↔ Claude Code 消息桥接项目 |
| `sensecli/` | sense CLI 相关代码 |
| `red.md` | LarAdmin 项目进度与凭据速查（含 DB 密码，已 gitignore，禁止入库） |
| `task_5d97c90a.json` | 任务定义文件 |

## 环境信息

- 工作目录：`/workspace`（git 仓库，分支 `master`，远端主分支 `main`）
- 交互入口：微信（非终端），需要交付文件时直接给出文件路径，系统会自动解析并推送给用户

## 备注

仓库当前只有 1 个初始提交，`README.md`、`red.md`、`sensecli/`、`task_5d97c90a.json`、`wechat-claude-code/` 均未纳入版本控制。
