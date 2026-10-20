# dsh-child-model

给 DeepSeek Harness 的子智能体和智能体团队（Agent Teams）队友**分别指定模型**。

主 Agent 用一个模型（比如便宜的），委派出去的活跑在另一个模型上——这是本插件解决的问题。

## 为什么需要插件

- `subagent` 工具**能**带 `provider` / `model`（本机已开启 `subagent-model-selection`），但那是**每次调用手写参数**，而且要过白名单。
- 团队工具 `spawn_teammate` 的参数里**没有任何模型字段**：底层 `startActivation` 不传 `agentOptions`，队友一律继承 Lead 的路由。这就是本插件存在的理由。

## 它怎么做到的

每个本地子会话都是同进程里的一等 Agent：创建完成会发 `agent/created`，而 `agent/request` 是决定「这一步发给哪个 provider/model」的 waterfall。插件在**该子 Agent 自己的 ctx** 上挂一对监听：

| 事件 | 作用 |
|---|---|
| `system-prompt/assemble` | 改 `{{model}}` 变量，让子 Agent 的自我认知与实际路由一致 |
| `agent/request` | 改真实请求的 `provider` / `model` / `reasoningEffort` |

`agent.ctx` 随 Agent 销毁自动回收，插件还会把 disposer 按 childId 存一份，插件卸载时一并清掉。

匹配顺序：**队友名精确** → **队友名包含** → **委派描述包含** → **默认路由**。名字优先，因为队友名是 Lead 自己起的、可预测；描述是自然语言，适合兜底。

## 必须一起改 reasoningEffort（重要）

`cpa-*` 这类路由在 provider profile 上带**路由级默认档位**（本机 `dsh-cpa-switch` 的 `REASONING_DEFAULT = 'high'`）。pi-ai 的取值是：

```js
resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)
```

所以**只清掉请求里的 effort 不等于没有 effort**，而是回落到路由默认值。目标模型不支持那个档位时，请求会硬失败（`UNSUPPORTED_REASONING_EFFORT`）。

插件因此按顺序**逐个候选交给适配器验证**，第一个通过的就是答案：

1. 规则里点名的 `reasoningEffort`
2. 模型自己声明的默认档
3. 模型声明的每个档位
4. `off`
5. （仅显式允许时）完全不发 effort

全都过不了 → **保留继承路由**并记录原因，绝不把孩子打死。典型例子：`cpa-trae/trae/glm-5.3-flash` 不声明任何档位，而该路由默认档是 `high`，两者冲突，除非在 CPA Switch 面板里关掉「思考档位」，否则这个模型选不了——设置页的「最近委派」会把这个原因写清楚。

## 安装

```powershell
dsh plugin --profile web add "C:\Users\11965\Desktop\自定义子智能体模型插件"
```

包是 `link:` 形式：改本目录的代码后，用 HMR 重新加载那一行即可，不必重装。

## 配置

两个入口，**文件优先**：

1. patch（`cordis.patch.yml` 里本插件那一行）——首次默认值、手写配置。
2. `$DSH_HOME/storages/dsh-child-model/rules.json`——设置页写这里，**改动即时生效**，不触发插件树重建（写 patch 会重建 fiber，cpa-switch 的踩坑记录）。

```jsonc
{
  "enabled": true,
  "rules": [
    // match 命中「队友名」或「委派描述」，子串、不区分大小写
    { "match": "reviewer", "provider": "cpa-trae", "model": "trae/deepseek-v4.1-flash" },
    { "match": "cheap",    "provider": "cpa-trae", "model": "trae/deepseek-v4.1-flash", "reasoningEffort": "off" }
  ],
  // 点选出来的「点名表」，优先级高于 rules。键可以是队友名，
  // 也可以是 `#<childId>`（子智能体没有名字，但它的会话 id 冷恢复后不变）
  "members": {
    "cheap-two": { "provider": "cpa-trae", "model": "trae/deepseek-v4.1-flash" },
    "#4f91736a-1846-4be0-b193-5bb1431d9dc2": { "provider": "cpa-trae", "model": "trae/glm-5.3-flash" }
  },
  // 没有命中任何规则时用这条；null / 省略 = 不干预，保持继承
  "defaultRoute": null,
  // 「本对话默认」：按 Lead 会话 id 存。来源是「首次创建时问一次」的回答，
  // 也可以由面板上的「本对话默认 ✕」清除。
  "sessions": {
    "session-7788a1a3-899d-4b70-96fe-b0697acf4210": {
      "provider": "cpa-workbuddy",
      "model": "wb/deepseek-v4.1-flash"
    }
  },
  // 已经问过「用什么模型」的会话（值=时间戳）。问过就不再问；
  // 清掉这里的键 ⇒ 该会话下次派活会重新问。
  "asked": { "session-7788a1a3-899d-4b70-96fe-b0697acf4210": "2026-10-20T03:50:36.864Z" },
  // 关掉「首次创建时询问」
  "askOnFirst": true,
  "maxDepth": 1,        // 只作用于直接子代；深层嵌套默认不动
  "applyToFork": false  // fork 子代默认不改（会破坏继承前缀的 KV 复用）
}
```

优先级：**点名表（队友名 → `#childId`）→ 本对话默认（`sessions`）→ rules（名字精确 → 名字包含 → 描述包含）→ `defaultRoute` → 继承**。

### 首次创建时问一次

一个对话里**第一次**派活、且这次既没点名也没命中规则（也就是纯继承）时，插件会用官方的
`userQuestions` 服务问一句：「这个对话里创建子智能体和队友时，用哪个模型？」

- 候选是「继承主 Agent」+ 每个渠道的头一个模型（最多 6 个），不是整本模型目录。
- 选完写进 `sessions[<lead>]`，**这个对话之后每次派活都用它**；选「继承」则删掉这条。
- **不阻塞创建**：问是 fire-and-forget，子智能体先用继承模型跑起来；你答完如果它还活着就当场改它。
- **先记账再问**：`asked[lead]` 在发问前写入，同一对话并发创建不会弹两次；问失败也不清标记（宁可少问，不反复骚扰）。
- 命中点名或规则的派活不触发询问——你已经表过态了。

## 界面

### ① 头部「模型」按钮 —— 点成员就换（主用法）

对话头部操作区多一个「模型」入口，点开后是本会话的**团队成员 + 子智能体**清单：

- 每行显示名字、说明、以及**当前实际路由**（没有就是「继承」）；
- 点这一行 → 展开 provider 分组下拉 + model 下拉（+ 可选推理档位）→ 应用；
- **成员正在运行时立刻生效**（改的是 `agent.options`，下一步请求就换）；已结束的成员写进点名表，**下次唤醒/冷恢复时生效**，界面会明说是哪一种；
- 「清除」按钮把该成员退回规则/继承。

> 为什么不是直接点原来那张成员卡片：Agent Teams 面板是**封闭组件**，只对外暴露一个头部触发按钮，成员行是它内部渲染的，没有成员级插槽。插件按规范不读、不改别人的 DOM，所以做成同位置的第二个入口 + 同样的成员清单。

### ② Plugins → 本插件详情页的「子智能体模型」卡片

四块：**没匹配到规则时**（一个下拉，第一项是「继承主 Agent」）、**按名字或任务描述指定**（每条规则一张卡片，带「最近命中：谁、谁、谁」）、**生效范围**（委派深度 / fork）、**最近委派**（表头是「实际使用的模型」「为什么是这个模型」）。卡片头有一行摘要，例如「1 条规则 · 默认：继承主 Agent」。

### ③ 「本对话默认」

首次派活时回答的那个选择会显示在「模型」面板里，形式是「本对话默认：`wb/deepseek-v4.1-flash` ✕」。点 ✕ 会同时清掉 `sessions` 和 `asked` 两条记录，于是这个对话下次派活会重新问你。

### ④ 面板里直接创建

同一个「模型」面板顶部有「＋ 新建队友 / 子智能体」折叠区：选类型、填名称（仅队友）/ 任务描述 / 初始任务、选 provider + model，点「创建」。创建出来的成员**第一次请求就跑在所选模型上**，不经过「继承再改写」那一步。

两条创建路径用的是不同的官方接口，原因见下节：

| 类型 | 官方接口 | 模型怎么进去 |
|---|---|---|
| 队友 | `agentTeams.spawnTeammate()` | 它只收 provider *名字*，不接 `agentOptions`；所以先写点名表，`agent/created` 钩子再按名字装上 |
| 子智能体 | `subagents.startActivation()` | 它的 `request.agentOptions` 是官方字段，直接随请求传下去；`subagent/descriptor` 也会记下真实路由（冷恢复不丢） |

> 团队名册的上限由 `agent-team` 那行的 `maxMembers` 决定（默认 8，本机已调到 32）。官方名册**只增不删**——没有移除成员的 API，所以一个会话里可劲儿建会建满，满了就换会话。

## HTTP 端点（界面用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/child-model/state` | 有效设置 + 可选 provider/model 目录 |
| POST | `/api/v1/child-model/rules` | 写入规则文件（字段级合并，`null` 表示清空） |
| GET | `/api/v1/child-model/recent` | 最近委派记录（按 childId 合并） |
| GET | `/api/v1/child-model/members?lead=<会话id>` | 该 Lead 下的成员/子代理 + 各自当前路由 |
| POST | `/api/v1/child-model/member` | `{name|childId, route\|null}`，先校验路由再落盘 + 对存活 Agent 立即生效 |
| POST | `/api/v1/child-model/spawn` | `{lead, kind, name?, description, prompt, route}` 创建成员并直接指定模型 |
| POST | `/api/v1/child-model/bulk` | `{lead, route\|null, scope}` 把本对话全部成员一次换成同一模型 |
| POST | `/api/v1/child-model/session` | `{lead, route\|null}` 读写「本对话默认」；`null` 连同 `asked` 一起清 |

## 验证工具

- `node tools/read-session.mjs <session.v4.jsonl.zstd>`：DSH 会话日志是**多帧** zstd，流式解压只吐第一帧，这个脚本按魔数切帧解全。用它核对子会话真实的 `request/header.config`。
- `node tools/probe-http.mjs GET /api/v1/child-model/state`：用 `.credentials.yaml` 里的浏览器会话密钥自签 cookie 直接打接口（密钥不落盘、不打印）。

## 生效时机（不需要重启）

换一个成员的模型，**三种状态都不需要重启 DSH**：

| 成员状态 | 何时用新模型 | 依据 |
|---|---|---|
| 正在跑（running） | **下一步**（本轮后续 step） | `prepareRequest()` 每一步都读 `agent.options`，改它即换 |
| 空闲但驻留（inactive / live） | **下一次请求** | 同上：Agent 还在，options 仍被读取 |
| 已被回收（冷恢复） | **下次被唤醒时**（发消息 / 派活） | 唤醒重新走 `agent/created`，插件在那时按点名表重装路由 |

唯一需要重启 DSH 的情形：**第一次安装本插件**（或改了 `package.json` 的 `dsh.client` 段）——浏览器端模块清单是宿主启动时扫描的。此后改客户端代码由 HMR 热替换、改宿主代码用 `dsh_hot_reload`，都不必重启。

## 已知边界

- **只处理本地子会话**（`header.origin === 'subagent'`）。外部后端（Codex / Claude Code / ACP）没有本地 Agent，管不到。
- **主 Agent 不受影响**：`delegationDepth === 0` 的会话直接跳过。
- **模型必须先在该 provider 上存在**：路由写错会在委派前被 `resolveModelInfo` 拦下，回退到继承路由并留下诊断。
- **换路由必须一起处理推理档**：`cpa-*` 路由带路由级默认档位（`reasoning: high`），只清请求里的 effort 会回落到它。插件按「配置点名 → 模型默认 → 逐档 → off」逐个让适配器验证，全不行就保留继承路由并记录原因；典型例子是 `trae/glm-5.3-flash`（不声明任何档位）——除非在 CPA Switch 面板关掉「思考档位」，否则选不了。
- 规则换模型但**不换 provider 的 `maxTokens`**：输出上限仍由 provider profile / 继承值决定。
- 设置页写的是 `rules.json`，不是 patch：想要「配置进版本库」就把内容手抄进 `cordis.patch.yml` 的 `config`。
- **与第三方同类插件的冲突面**：那些插件通常 monkey-patch `agentTeams.spawnTeammate` / `startContinuable`；本插件走公开的 `agent/created` + 改 `agent.options`。两者同时配了规则会**各改一次**，行为取决于顺序，用一个就停掉另一个。
- **客户端半边的清单在宿主启动时扫描**：首次安装 / 改 `dsh.client` 后要重启一次 DSH，`/plugins/dsh-child-model/client.js` 才会从 404 变 200（之后改动是 HMR）。
- **⚠️ 装/卸其他插件与启动撞车，会让本插件从浏览器清单里消失**：`client-modules` 把「这一行有没有 `dsh.client` 包」按 `sourceKey(行名, 解析基准)` 缓存，**缓存成 null 之后永不重试**（`resolveMeta` 的 `pkgMeta.set(key, null)`）。实测：`dsh plugin remove` 正在重写 `node_modules` 时宿主启动，本行被判为“没有 client 包”，此后改文件 mtime、禁用再启用、热重载都无效（key 没变，命中的是同一份缓存）。**症状**是 `/plugins/??` 里没有本包、`__DSH_BOOT__.entries` 里也没有，而宿主端点照常 200。**唯一解法是再重启一次**（并确保安装/卸载动作已经结束），所以别在装完插件的同一秒启动。
