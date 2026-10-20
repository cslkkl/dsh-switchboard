# .agents/notes/ — 记录组织

- 职责：存放决策（选了 A 不选 B）与依据（调查、对照、评估的结论）。
- 两类共用本目录，靠文件开头第 3 行的状态行区分有效性，靠小节结构区分类型。
- 使用约束与写作规则 → 见 [AGENTS.md](AGENTS.md)。

## 怎么找

- 想知道「现在为什么这么设计」→ 按主题词在文件名里搜；决策类带日期前缀。
- 想知道「这条依据还成立吗」→ 看状态行；`生效` 才继续引用。
- 想知道「现在实际是什么行为」→ 不看这里，看 [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。

## 当前记录

| 文件 | 类型 | 主题 |
|---|---|---|
| [2026-10-20-route-seam.md](2026-10-20-route-seam.md) | 决策 | 用什么接缝改写子会话路由 |
| [2026-10-20-reasoning-effort-coupling.md](2026-10-20-reasoning-effort-coupling.md) | 决策 | 换路由必须同时确定推理档位 |
| [2026-10-20-session-default-ask.md](2026-10-20-session-default-ask.md) | 决策 | 首次派活询问与「本对话默认」 |
| [2026-10-20-config-write-merge.md](2026-10-20-config-write-merge.md) | 决策 | 配置写入必须保留未提及字段 |
| [client-modules-cache.md](client-modules-cache.md) | 依据 | 客户端模块清单缓存判空即永久跳过 |

## 出口

- 规则层 → [AGENTS.md](AGENTS.md)
- 根索引 → [../../AGENTS.md](../../AGENTS.md)
- 设计现状 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
