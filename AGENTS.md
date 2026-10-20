# dsh-model-roster — 维护索引

## 全局规则

- 换路由必须同时确定推理档位，否则回落到路由级默认档并可能硬失败。见 [架构·推理档位耦合](docs/ARCHITECTURE.md#推理档位耦合必须一起处理)。
- 配置写 `rules.json`，不写 patch；写 patch 会重建 fiber。见 [架构·配置契约](docs/ARCHITECTURE.md#配置契约)。
- 只用官方接缝（`agent/created` / `agent/request` / `agent.options`），不 monkey-patch 他人服务方法。
- 客户端模块清单在宿主启动时扫描；改了 `package.json` 的 `dsh.client` 段必须重启。
- 文档改动后跑链接校验；大批量改动后跑换行校验。

## 常用命令

```powershell
node --check index.js                      # 宿主语法
node --check client.js                     # 客户端语法
dsh plugin --profile web add "<本目录>"     # 安装（link: 形式）
```

- 宿主改动：`dsh_hot_reload`（`entryId: dsh-model-roster`），先 `node --check index.js`。
- 客户端改动：HMR 自动生效，不必重启。
- 接口自测：`node tools/probe-http.mjs GET /api/v1/model-roster/state`，见 [tools/README.md](tools/README.md)。
- 检查选择：文档改动 → 链接校验 + 换行校验；代码改动 → `node --check` + 对应接口自测。

## 验证快照

- 无 CI。当前状态为命令级实测通过：两个半端 `node --check` 通过，模块用 React stub 执行并注册两个 slot。
- 换模型已在真实实例验证：`inherited wb/…` → `applied cpa-trae/trae/…`，探针记 `hit: member:<名>`。
- 本对话默认已验证：`hit: "session"`，且第二次派活记 `ask-skip: already-asked`。

## 待办

- [ ] 拆 `client.js`（约 2900 行）需引入构建链，与「浏览器直接加载单文件」契约冲突，待决。
- [ ] L3 工具链（ESLint / Prettier / pre-commit / CI）尚未接入；当前零依赖无 lint 配置。
- [ ] 链接校验需排除 `*research*`（外部包 README 原文，链接指向它们自己的仓库）。

## 活跃坑

- `client-modules` 把「这一行有没有 client 包」按 `sourceKey` 缓存，**判空后永不重试**：装/卸插件与宿主启动撞车会让本插件从浏览器清单消失，唯一解法是再重启一次。见 [依据记录](.agents/notes/client-modules-cache.md)。
- 客户端半端的清单问题症状：`/plugins/??` 里没有本包、`__DSH_BOOT__.entries` 也没有，但宿主端点照常 200。
- `client.js` 里给下拉弹层加 `contain: size` 会让弹层高度塌成 0，只剩一条搜索框的缝。

## 文档地图

- 用户门面 → [README.md](README.md)
- 架构与契约 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 脚本手册 → [tools/README.md](tools/README.md)
- 决策与依据 → [.agents/notes/](.agents/notes/)
- 外部 API 调研（非活文档、外部包 README 原文）→ [.agents/notes/research/](.agents/notes/research/)
