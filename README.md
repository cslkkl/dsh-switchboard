<div align="center">

# dsh-model-roster

**让 DeepSeek Harness 里的每个子智能体和队友，跑在各自的模型上**

主 Agent 用一个模型，派出去的活换一个：贵的活给强模型，琐碎的活给便宜的

[![License](https://img.shields.io/badge/license-MIT-2563eb?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square)](.node-version)
[![Dependencies](https://img.shields.io/badge/dependencies-0-339933?style=flat-square)](package-lock.json)
[![Platform](https://img.shields.io/badge/platform-DSH%20Web-111827?style=flat-square)](docs/ARCHITECTURE.md)

[为什么](#为什么需要它) · [能力](#能力) · [安装](#安装) · [界面](#界面) · [边界](#边界)

</div>

## 为什么需要它

原生工具做不到这件事：

| 工具 | 模型字段 | 问题 |
|---|---|---|
| `spawn_teammate` | 无 | 队友一律继承主 Agent 的路由 |
| `subagent` | 有 | 每次调用手写参数，且要过白名单 |

这个插件把它变成名册：一个对话里的成员都在册上，每人一个模型，点一下就改。

## 能力

| 能力 | 说明 |
|---|---|
| 点成员换模型 | 头部「模型」入口列出全部队友与子智能体，点一行即换 |
| 按规则批量指定 | 一条规则命中多个成员，匹配名字或任务描述，子串、不区分大小写 |
| 按对话设默认 | 首次派活问一次，之后整个对话沿用，不再打扰 |
| 运行时生效 | 运行中的成员下一步就换，不需要重启 Harness |
| 一键全换 | 本会话所有成员切到同一模型，或一键退回继承 |
| 面板内新建 | 直接创建队友或子智能体，首个请求就跑在所选模型上 |
| 失败不误伤 | 档位不兼容时保留继承路由并给出原因，不把子会话打死 |

## 安装

```powershell
dsh plugin --profile web add "<本插件目录>"
```

首次安装后重启一次 Harness，浏览器端界面才会加载。此后改代码不需要重启。

## 配置

配置写在 `$DSH_HOME/storages/dsh-model-roster/rules.json`，保存即时生效。

```jsonc
{
  "rules": [
    { "match": "cheap", "provider": "cpa-trae", "model": "trae/deepseek-v4.1-flash" }
  ]
}
```

优先级：点名指定 → 本对话默认 → 规则 → 全局默认 → 继承主 Agent。

<details>
<summary>完整字段与 HTTP 契约</summary>

字段表、规则结构、路由对象、八个 HTTP 端点、创建路径的接口差异，全部在
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

</details>

## 界面

<div align="center">

![设置卡片](docs/settings-card.png)

<sub>插件详情页的规则卡片：每条规则显示匹配词、目标模型，以及最近命中的成员</sub>

</div>

| 入口 | 位置 | 用途 |
|---|---|---|
| 「模型」按钮 | 对话头部操作区 | 点成员换模型、批量换、本对话默认、新建成员 |
| 「子智能体模型」卡片 | 插件详情页 | 规则编辑、生效范围、最近委派记录 |

成员状态分三种，界面直接标出来：**运行中**（下一步生效）、**待唤醒使用**（下次唤醒生效）、**未运行**（下次创建生效）。

<details>
<summary>更多截图</summary>

<div align="center">

![模型下拉](docs/dropdown-width.png)

<sub>渠道下拉按内容自适应宽度，长渠道名不截断</sub>

![首次询问](docs/first-ask-card.png)

<sub>一个对话里第一次派活时问一次，选完就是本对话默认</sub>

</div>

</details>

## 生效时机

换模型不需要重启 Harness。三种状态各自的生效点：

| 成员状态 | 何时用新模型 |
|---|---|
| 运行中 | 本轮后续步骤 |
| 空闲驻留 | 下一次请求 |
| 已回收 | 下次被唤醒 |

只有两种情形需要重启：首次安装，或改动 `package.json` 的 `dsh.client` 段。

## 边界

- 只管本地子会话。外部后端（Codex、Claude Code、ACP）没有本地 Agent，管不到。
- 主 Agent 不受影响。
- 换模型不改 provider 的输出上限，`maxTokens` 仍由 provider profile 决定。
- 与 monkey-patch `spawnTeammate` 的同类插件互斥，只启用一个。

## 许可

MIT，见 [LICENSE](LICENSE)。

维护者文档（架构、脚本、决策记录）从 [AGENTS.md](AGENTS.md) 的文档地图进入。
