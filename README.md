# dsh-child-model

给 DeepSeek Harness 的子智能体和智能体团队队友**逐个指定模型**：主 Agent 跑便宜的，派出去的活跑在另一个模型上。

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Deps](https://img.shields.io/badge/dependencies-0-brightgreen)

## 解决什么

- `spawn_teammate` 的参数里没有模型字段，队友一律继承主 Agent 的路由。
- `subagent` 能带模型，但每次调用手写参数，且要过白名单。
- 本插件把这件事变成**按成员、按对话、点一下就换**。

## 能力

- 按成员换模型：头部「模型」入口列出本会话全部队友与子智能体，点一行即换。
- 按名字或任务描述批量指定：一条规则命中多个成员，子串匹配、不区分大小写。
- 按对话设定默认：首次派活问一次，之后整个对话都用它，不再打扰。
- 运行时生效：运行中的成员下一步即换模型，不需要重启 Harness。
- 一次全换：把本会话所有成员批量切到同一模型，或一键恢复继承。
- 面板内创建：直接新建队友 / 子智能体，首个请求就跑在所选模型上。
- 失败不误伤：档位不兼容时保留继承路由并给出可读原因，不把子会话打死。

## 快速上手

```powershell
dsh plugin --profile web add "<本插件目录>"
```

首次安装后重启一次 Harness，浏览器端界面才会出现；此后改代码不需要重启。

配置写在 `$DSH_HOME/storages/dsh-child-model/rules.json`，改动即时生效：

```jsonc
{
  "rules": [
    { "match": "cheap", "provider": "cpa-trae", "model": "trae/deepseek-v4.1-flash" }
  ]
}
```

完整字段、优先级链、HTTP 契约 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 界面入口

| 入口 | 位置 | 用途 |
|---|---|---|
| 「模型」按钮 | 对话头部操作区 | 点成员换模型、批量换、本对话默认、新建成员 |
| 「子智能体模型」卡片 | 插件详情页 | 规则编辑、生效范围、最近委派记录 |

## 边界

- 只管本地子会话；外部后端（Codex / Claude Code / ACP）没有本地 Agent，管不到。
- 主 Agent 不受影响。
- 换模型不改 provider 的输出上限（`maxTokens` 仍由 provider profile 决定）。
- 与 monkey-patch `spawnTeammate` 的同类插件互斥，只启用一个。

## 许可与贡献

MIT，见 [LICENSE](LICENSE)。

维护者文档（架构、脚本、决策记录）从 [AGENTS.md](AGENTS.md) 的文档地图进入。
