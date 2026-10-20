# dsh-switchboard 架构说明

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
| 设置文件 | `$DSH_HOME/storages/dsh-switchboard/rules.json` | 改动即时生效，不重建 fiber |

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

`sessions` / `asked` **只从设置文件读**（patch 不提供这两项），因为它们是运行时产物，
不是配置项：一个由「首次派活询问」写入，一个随 `/session` 变更。

单条规则：

| 字段 | 类型 | 含义 |
|---|---|---|
| `match` | string | 匹配词，子串、不区分大小写 |
| `provider` | string | 渠道 id |
| `model` | string | 模型 id |
| `reasoningEffort` | string | 可选；留空则由适配器挑 |

路由对象：`{ provider, model, reasoningEffort? }`。

写入语义（契约，不可回退）：

- **写入基座必须是 `readJsonFile()` 的原始形态**，不是 `effectiveSettings()` 的归一化视图。
  后者只保留已知键、且把 patch 值烘进结果；拿它整体覆写会（1）清掉未提及的键，
  （2）让文件里的旧快照永久盖住以后对 patch 的修改（文件优先 → patch 失效）。
- **未提及字段一律原样保留**：写入语句固定为 `writeJsonFile(rulesPath(), { ...raw, ...改动 })`。
  `POST /rules` 只覆盖 7 个键（`enabled` / `rules` / `members` / `defaultRoute` /
  `maxDepth` / `applyToFork` / `askOnFirst`），`sessions` / `asked` 与未来新增键随 `...raw` 透传。
- **字段存在性才是「要不要改」**：判据是 `'key' in body`，不是「新值是不是 `undefined`」。
  否则 `defaultRoute: null`（用户取消勾选）会被当成缺失，旧路由又活回来。
- **`null` 清空只对 3 个字段成立**：`rules`（→ `[]`）、`members`（→ `{}`）、`defaultRoute`（→ `null`）。
  `enabled` / `maxDepth` / `applyToFork` / `askOnFirst` 传 `null` 被类型检查丢弃、**保留当前值**，不清空。
- **`members` 是整表替换语义**：写盘点名表时基座用 `effectiveSettings().members`（已含 patch 层），
  否则写回后文件里的表会把 patch 里的成员整表挤掉。其余字段无一例外走原始文件。
  由此产生一个**配置陷阱**：patch 里的 `members` 只在设置文件**没有**该键时生效；
  一旦 `/spawn` 或界面写过 `members`，文件即成为唯一来源，此后在 patch 里新增的成员不再被读到。
  要改成员请走界面或 `/member`，不要改 patch。
- `maxDepth` 有下界：负数（手填 `-1` 会跳过全部子代）按非法值丢弃、保留当前值。

来由与替代方案见 [决策记录](../.agents/notes/2026-10-20-config-write-merge.md)。

## HTTP 契约

界面通过宿主注册的路由读写，全部挂在 `/api/v1/switchboard/` 下，共 9 个端点。

| 方法 | 路径 | 请求 | 说明 |
|---|---|---|---|
| GET | `/state` | — | 有效设置 + provider/model 目录（含每模型档位）+ `lastErrors` |
| POST | `/rules` | 7 字段子集 | 只覆盖这 7 个键，其余原样保留；`null` 仅对 `rules`/`members`/`defaultRoute` 清空。`sessions` / `asked` 不归这里，传了静默忽略。响应带 `lastErrors` |
| GET | `/recent` | — | 委派记录**与**操作记录混排，取尾部 20 条（`limit` 默认 20）、最新在前。见下 |
| GET | `/simulate` | `?lead=&name=&label=&childId=` | 规则试算：预览这次派活会命中哪一层。未命中返回 200 + `route: null`。见「[规则试算](#规则试算simulate)」 |
| GET | `/members?lead=` | — | 该 Lead 下的成员 + 各自路由；`settings` 里含 `enabled`、`sessionRoute`、`asked`（布尔：本对话是否已问过）；响应带 `lastErrors` |
| POST | `/member` | `{name\|childId, route\|null}` | 校验后落盘，并对存活 Agent 立即生效。`route` 非 `null` 但形状非法 → 400 `需要 provider 和 model`，不静默清点名 |
| POST | `/spawn` | `{lead, kind, name?, description, prompt, route}` | 创建成员并指定模型 |
| POST | `/bulk` | `{lead, route\|null, scope}` | 把本对话全部成员换成同一模型 |
| POST | `/session` | `{lead, route\|null}` | 读写本对话默认；`null` 连同 `asked` 一起清 |

`/recent` 的两类记录：

- **委派记录**带 `childId`。一次委派写两条探针（解析 + 已应用），按 `childId` 合并成一条，
  所以直接 tail 文件会把同一个孩子算成两次委派。
- **操作记录**带 `action` 无 `childId`（`spawn` / `member-set` / `bulk` / `session-set` / `ask-*`），
  各自独立成条。它们没有 `applied` / `memberName` / `label`，表格四列会渲染成空行，
  所以每条补一个 `summary` 字段（宿主生成的中文短句，如「设为 `provider/model`」）。
- 两类按各自**最后一次出现的位置**排序后混排，取尾部 20 条。排序依据是文件里的先后
  而非 `time` 字段：合并后的委派记录要按第二条（已应用）的位置算，否则会沉到旧处。

`probe.jsonl` 有轮转：写入前若文件超 512KB，只保留最后 200 行重写。它不是只增不减的日志。

## 创建路径的接口差异

两条创建路径用的是不同的官方接口，模型注入方式不同：

| 类型 | 官方接口 | 模型怎么进去 |
|---|---|---|
| 队友 | `agentTeams.spawnTeammate()` | 只收 provider 名字，不接 `agentOptions`；先写点名表，`agent/created` 再按名字安装 |
| 子智能体 | `subagents.startActivation()` | `request.agentOptions` 是官方字段，随请求传下；`subagent/descriptor` 记录真实路由 |

两者都要求传入非 undefined 的 `AbortSignal`（内部调用 `throwIfAborted`）。

## 模型档位元数据

界面要给「这条规则用哪一档」，所以 `/state` 与 `/members` 的 `routes[].models[]` 里每个模型都带：

```jsonc
{ "reasoning": { "defaultEffort": "high", "efforts": [{ "id": "off", "name": "关" }, …] } }
```

`reasoning: null` = 该模型不声明任何档位（界面禁用档位下拉并提示原因）。

两个必须记住的事实：

- **`listModels()` 不含 `reasoning`**。它返回 `LlmModelInfo`；档位只在 `resolveModelInfo()`
  的 `LlmResolvedModelInfo` 里。所以 `describeRoutes()` 必须**逐模型**再解析一次
  （官方 `buildModelCatalog()` 同样做法）。
- 逐模型解析带进程内缓存，TTL 60 秒（`REASONING_CACHE_TTL_MS`，按 `provider\0model` 作键）。
  单次解析抛错降级成 `null`，不让一个模型的适配器拒绝把整个 `/state` 打成 500。

权威形状是 `dsh-llm` 的 `LlmModelReasoningInfo`：`{ efforts: [{ id, name, description? }], defaultEffort? }`，
且 `normalizeModelInfo()` 保证 `efforts` 非空、`defaultEffort` 必在 `efforts` 之内。

客户端据此做两件事：档位下拉的选项来自 `reasoning.efforts`，首项恒为「自动（由适配器挑）」；
换渠道/模型时用 `reconcileEffort()` 决定旧档位留不留 —— 新模型声明了这个档才保留，
否则退回自动。一刀切清空会丢用户刚选的档（违反「档位必须与路由一起确定」），
一刀切保留又会把不支持的档带到新模型上硬失败（`UNSUPPORTED_REASONING_EFFORT`）。

## 规则试算（`/simulate`）

设置卡片每条规则行尾有输入框 + 「试算」按钮，回车或点击才发请求（不自动发、不防抖轮询）。
语义是**下发前预览**：「这个成员名 / 这段任务描述，真派活时会命中哪一层、用哪个模型」。

- **复用 `resolveRoute()`**，不另写一套匹配。预览与实际委派走同一条解析链，
  不存在「预览说命中 A、实际跑 B」的漂移。
- 四个 query 全部可选、缺省按空串：`lead` / `name` / `label` / `childId`。
  设置卡片拿不到会话上下文，`lead` 恒为空，所以卡片里试算不会返回 `session`。
- 响应 `{ ok, route, hit, hitKind }`。`hit` 原样回传内部代号（界面已有翻译），
  `hitKind` 是给前端分组用的稳定枚举：`member` / `child` / `session` / `name` /
  `name-contains` / `label-contains` / `default` / `none`。
- `route` 只投影 `provider` / `model` / 可选 `reasoningEffort`。命中规则时
  `resolveRoute()` 会把规则对象的 `match` 一起展开，直接透传会让「路由」多出一个不属于它的键。
- **未命中返回 200 + `route: null` + `hitKind: 'none'`，不是 404**。前端要能区分
  「没命中任何规则（将继承 Lead）」和「接口根本没上线/挂了」——后者才该提醒用户。
  客户端对 404/501 单独给「试算接口还没上线」的 warn 提示。
- 只读：不发任何 `POST`，不写盘。
- 增删规则与保存成功后清空试算结果，因为行下标会移位，旧结果会贴到错的规则上。

## 失败可见性

换路由失败不打死子会话，但**不能只留日志**。宿主维护一个模块级 `lastErrors`
（上限 10 条，最新在前，形状 `{ time, childId, route, reason }`），`pickEffort`
与 `installRoute` 失败都记一条；`/state`、`/members`、`/rules` 的响应都带这个字段。
它与 `probe.jsonl` 同源不同用：探针是落盘流水，`lastErrors` 是给界面的内存榜
（只留失败，进程重启即清空）。

现状：面板顶部有**失败红条**（`renderErrorBar()`），数据来自 `/members`、`/state`、
`/rules` 三处响应里的 `lastErrors`。

- 默认只显示**最新 1 条**，一行话讲清三件事：「`<成员名>` 换成 `<provider/model>` 失败：`<原因>`」。
  只写「失败」等于没说 —— 用户下一步要看的就是谁、想换成什么、为什么没成。
- 多于 1 条时给「还有 N 条」可展开，展开项带时间与逐条原因。
- `×` 关闭记的是**被关闭那条的 `time`**（不是布尔标记），所以更新的失败会自动让红条重新出现，
  不用手动复位。关闭只影响显示，不动配置、不写盘。
- 无失败时整块不渲染，不占位。
- 客户端对条目做形状归一化：`reason` 为空的条目丢弃（没原因可念的条目对用户没意义），
  顺序不重排（宿主已是最新在前）。

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
- **配置写入不得整体覆写**：写入基座必须是 `readJsonFile()` 原始形态，`{ ...raw, ...改动 }`。
  用 `effectiveSettings()` 当基座会清掉 `sessions` / `asked` / 未知键，症状是「保存即清空本对话默认、下次派活重新询问」。
  见 [决策记录](../.agents/notes/2026-10-20-config-write-merge.md)。
- **`listModels()` 没有 `reasoning` 字段**：档位只在 `resolveModelInfo()` 里，需要逐模型补一次并缓存。
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
