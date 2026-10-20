# 决策：用什么接缝改写子会话路由（2026-10-20）

状态：生效

## 问题

团队工具 `spawn_teammate` 的参数里没有模型字段，队友一律继承 Lead 路由。
`subagent` 工具虽能带 provider/model，但需要每次调用手写，且要过白名单。
需要一个让子会话跑在别的模型上的机制。

## 决策

走公开的 `agent/created` 事件拿到子 Agent，然后：

- 改写 `agent.options` 的 `provider` / `model`。
- 在该 Agent 自己的 ctx 上挂 `agent/request` 与 `system-prompt/assemble` 两个监听。

`prepareRequest()` 每一步都读 `agent.options`，所以对运行中的 Agent 下一步即生效。

## 替代方案（强制）

- **monkey-patch `agentTeams.spawnTeammate`**：同类第三方插件的常见做法；依赖内部签名，官方一改即碎，且多个插件会叠加改写。
- **包 `subagents.startActivation`**：只能覆盖子智能体，覆盖不到团队队友；团队是队友的唯一来源。
- **只在 `agent/request` 里改、不动 `agent.options`**：能跑，但 `agent.options` 仍是旧值，其它读它的代码（含 `{{model}}` 变量）会与实际路由不一致。
- **改 `cordis.patch.yml` 的 preset**：能改默认，但做不到按成员粒度、做不到运行时切换，且每次改都重建 fiber。

## 影响

- 收益：成员级、运行时、跨渠道切换；不需要重启；与官方签名解耦。
- 代价：与 monkey-patch 类插件同时配置时会各改一次，顺序决定结果，所以两者互斥。
- 代价：`agent.options` 是运行时对象（类型上 readonly），改写属有意越权，靠 `optionsPatched` 探针留痕。
