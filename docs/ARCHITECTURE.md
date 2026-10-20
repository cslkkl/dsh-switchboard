# dsh-child-model 架构说明

本文件记录**不变的设计决策**与**契约**。
文件级清单与「改哪波及谁」在 [tools/README.md](../tools/README.md)，维护入口在 [AGENTS.md](../AGENTS.md)。

## 目标与边界

- 目标：让**同一进程内的子会话**（子智能体、团队队友）跑在与 Lead 不同的模型上。
- 约束一：只用官方公开接缝，不 monkey-patch 别人的服务方法。
- 约束二：换模型失败时**保留继承路由**，不把子会话打死。
- 约束三：配置写入不重建插件树（写 patch 会重建 fiber）。
- 范围：仅 `header.origin === 'subagent'` 的本地子会话；外部后端（Codex / Claude Code / ACP）无本地 Agent，不在范围内。

## 路由接缝

子会话是同进程里的一等 Agent，创建完成发 `agent/created`，步骤发请求前走 `agent/request` waterfall。
插件在该子 Agent **自己的 ctx** 上挂监听：

| 事件 | 作用 |
|---|---|
| `agent/created` | 决定该子会话用哪条路由，然后安装监听 |
| `system-prompt/assemble` | 改写 `{{model}}` 变量，使自我认知与实际路由一致 |
| `agent/request` | 改写真实请求的 `provider` / `model` / `reasoningEffort` |

两个关键事实：

- `prepareRequest()` **每一步都重新读 `agent.options`**，所以改 `agent.options` 对运行中的 Agent 下一步即生效。
- `agent.ctx` 随 Agent 销毁自动回收；插件另按 childId 存一份 disposer，卸载时一并清理。

## 决策优先级

解析顺序，前者优先：

1. `members[队友名]` —— 点名指定
2. `members['#<childId>']` —— 按会话 id 点名（子智能体无名，但会话 id 冷恢复后不变）
3. `sessions[<leadSessionId>]` —— 本对话默认
4. `rules` —— 队友名精确 → 队友名包含 → 委派描述包含
5. `defaultRoute` —— 全局默认
6. 继承 Lead 路由

命中来源写入探针的 `applied.hit`，取值 `member:` / `child:` / `session` / `name:` / `name~` / `label~` / `(default)`。
界面据此显示「为什么是这个模型」。

## 推理档位耦合（必须一起处理）

`cpa-*` 路由在 provider profile 上带**路由级默认档位**（本机 `dsh-cpa-switch` 的 `REASONING_DEFAULT = 'high'`）。
pi-ai 的取值是 `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`。

推论：**清掉请求里的 effort 不等于没有 effort**，而是回落到路由默认值。
目标模型不支持该档位时请求硬失败（`UNSUPPORTED_REASONING_EFFORT`）。

插件的处理是逐候选交给适配器验证，第一个通过即采用：

1. 规则里点名的 `reasoningEffort`
2. 模型自己声明的默认档
3. 模型声明的每个档位
4. `off`
5. 完全不发 effort（仅显式允许时）

全部失败 → 保留继承路由并记录原因。
实例：`cpa-trae/trae/glm-5.3-flash` 不声明任何档位，而该路由默认档是 `high`，两者冲突，除非在 CPA Switch 面板关掉「思考档位」。

## 配置契约

两处来源，**文件优先**：

| 来源 | 位置 | 生效方式 |
|---|---|---|
| patch | `cordis.patch.yml` 本插件那一行的 `config` | 首次默认值；改动会重建 fiber |
| 设置文件 | `$DSH_HOME/storages/dsh-child-model/rules.json` | 改动即时生效，不重建 fiber |

字段：

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；关闭后一律继承 |
| `rules` | array | `[]` | 规则表，见下 |
| `members` | object | `{}` | 点名表，值为路由对象；键为队友名或 `#<childId>` |
| `sessions` | object | `{}` | 本对话默认，键为 Lead 会话 id，值为路由对象 |
| `asked` | object | `{}` | 已询问过的会话，值为时间戳字符串 |
| `defaultRoute` | object \| null | `null` | 未命中时使用的路由 |
| `askOnFirst` | boolean | `true` | 首次派活时是否询问 |
| `maxDepth` | integer | `1` | 生效的最大委派深度 |
| `applyToFork` | boolean | `false` | 是否也作用于 fork 出来的子会话 |

单条规则：

| 字段 | 类型 | 含义 |
|---|---|---|
| `match` | string | 匹配词，子串、不区分大小写 |
| `provider` | string | 渠道 id |
| `model` | string | 模型 id |
| `reasoningEffort` | string | 可选；留空则由适配器挑 |

路由对象：`{ provider, model, reasoningEffort? }`。

写入语义：`POST /rules` 按**字段存在性**合并；某字段传 `null` 表示清空。

## HTTP 契约

界面通过宿主注册的路由读写，全部挂在 `/api/v1/child-model/` 下。

| 方法 | 路径 | 请求 | 说明 |
|---|---|---|---|
| GET | `/state` | — | 有效设置 + provider/model 目录 |
| POST | `/rules` | 任意字段子集 | 字段级合并写入；`null` 清空 |
| GET | `/recent` | — | 最近委派记录 |
| GET | `/members?lead=` | — | 该 Lead 下的成员 + 各自路由 + `sessionRoute` |
| POST | `/member` | `{name\|childId, route\|null}` | 校验后落盘，并对存活 Agent 立即生效 |
| POST | `/spawn` | `{lead, kind, name?, description, prompt, route}` | 创建成员并指定模型 |
| POST | `/bulk` | `{lead, route\|null, scope}` | 把本对话全部成员换成同一模型 |
| POST | `/session` | `{lead, route\|null}` | 读写本对话默认；`null` 连同 `asked` 一起清 |

## 创建路径的接口差异

两条创建路径用的是不同的官方接口，模型注入方式不同：

| 类型 | 官方接口 | 模型怎么进去 |
|---|---|---|
| 队友 | `agentTeams.spawnTeammate()` | 只收 provider 名字，不接 `agentOptions`；先写点名表，`agent/created` 再按名字安装 |
| 子智能体 | `subagents.startActivation()` | `request.agentOptions` 是官方字段，随请求传下；`subagent/descriptor` 记录真实路由 |

两者都要求传入非 undefined 的 `AbortSignal`（内部调用 `throwIfAborted`）。

## 生效时机

| 成员状态 | 何时用新模型 | 依据 |
|---|---|---|
| 运行中 | 本轮后续 step | `prepareRequest()` 每步读 `agent.options` |
| 空闲驻留 | 下一次请求 | Agent 仍在，options 仍被读取 |
| 已回收 | 下次被唤醒 | 唤醒重走 `agent/created`，按点名表重装 |

需要重启 DSH 的两种情形：首次安装，或改动 `package.json` 的 `dsh.client` 段。
其余情况：宿主侧 `dsh_hot_reload`，客户端侧 HMR。

## 防错清单

- **换路由必须同时确定 effort**：否则回落到路由级默认档，目标模型不支持就硬失败。
- **`asked` 不能按路由对象校验**：其值是时间戳；用 `normalizeMembers` 处理会整表被过滤，导致每会话反复询问。
- **`client-modules` 的清单缓存判空即永久跳过**：详见 [依据记录](../.agents/notes/client-modules-cache.md)。
- **团队名册只增不删**：官方无移除 API；上限由 `agent-team` 行的 `maxMembers` 决定。
- **规则换模型但不换 provider 的 `maxTokens`**：输出上限仍由 provider profile 决定。
- **与 monkey-patch 类插件互斥**：两者同时配规则会各改一次，行为取决于顺序。
- **不要给下拉弹层加 `contain: size`**：会让弹层高度塌成 0，只剩搜索框一条缝。

## 文档网络

| 层 | 位置 |
|---|---|
| 维护索引（自动注入） | [AGENTS.md](../AGENTS.md) |
| 用户门面 | [README.md](../README.md) |
| 脚本手册 | [tools/README.md](../tools/README.md) |
| 决策与依据 | [.agents/notes/](../.agents/notes/) |
