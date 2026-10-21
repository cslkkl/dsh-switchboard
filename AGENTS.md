# dsh-switchboard — 维护索引

## 全局规则

- 换路由必须同时确定推理档位，否则回落到路由级默认档并可能硬失败。见 [架构·推理档位耦合](docs/ARCHITECTURE.md#推理档位耦合必须一起处理)。
- 配置写 `rules.json`，不写 patch；写 patch 会重建 fiber。见 [架构·配置契约](docs/ARCHITECTURE.md#配置契约)。
- 配置写入一律 `{ ...readJsonFile(), ...本次改动 }`，**不得整体覆写**（否则清掉 `sessions`/`asked`）。见 [决策记录](.agents/notes/2026-10-20-config-write-merge.md)。
- 只用官方接缝（`agent/created` / `agent/request` / `agent/disposed` / `system-prompt/assemble`），不 monkey-patch 他人服务方法。
- 客户端模块清单在宿主启动时扫描；改了 `package.json` 的 `dsh.client` 段必须重启。
- 文档改动后跑链接校验；大批量改动后跑换行校验。

## 常用命令

```powershell
node --check index.js                      # 宿主语法
node --check client.js                     # 客户端语法
dsh plugin --profile web add "<本目录>"     # 安装（link: 形式）
```

- 宿主改动：`dsh_hot_reload`（`entryId: dsh-switchboard`），先 `node --check index.js`。
- 客户端改动：HMR 自动生效，不必重启。
- 接口自测：`node tools/probe-http.mjs GET /api/v1/switchboard/state`，见 [tools/README.md](tools/README.md)。
- 样式自检：`node tools/check-css-usage.mjs`（死规则 / 未定义类，见 [tools/README.md](tools/README.md)）。
- 文档校验：`python tools/check-markdown-links.py . --fragments --refs --github --exclude '*research*'` 与
  `python tools/check-line-endings.py . --exclude '*research*' --ext .js --ext .md --ext .mjs --ext .json --ext .yml --ext .py`。
- 换行守卫：`python tools/check-repo-eol.py`（查仓库 blob 与工作区副本是否都是 LF），
  `python tools/check-repo-eol.py --fix` 把工作区副本转回 LF。**在 PowerShell 里改完文件必跑** ——
  `WriteAllLines` / `Set-Content` 写的是 CRLF，会让 `git status` 报 M 而 `git diff` 是空的。
- 检查选择：文档改动 → 链接校验 + 换行校验；代码改动 → `node --check` + 对应接口自测；样式改动 → 外加 `check-css-usage`。
- CI：`.github/workflows/check.yml` 每次推送与 PR 跑上面全部检查，命令与本节一致。

## 验证快照

CI：`.github/workflows/check.yml`，每次推送与 PR 跑语法、样式自检、链接与换行校验。
以下为 2026-10-20 / 2026-10-21 命令级 + 真实实例实测：

- `node --check index.js`、`node --check client.js` 均 exit 0。
- 热重载 `dsh-switchboard` 成功（`swapped=1`），宿主 `index.js` 1701 行、客户端 `client.js` 4453 行。
- `GET /state` 200：带 `lastErrors`（当前 0 条），`routes[].models[].reasoning` 形状正确
  （例 `cpa-workbuddy/wb/deepseek-v4.1-flash` → `{defaultEffort:"high", efforts:[off,high]}`）。
- `/simulate` 三种命中：`?name=cheap-worker` → `hitKind:"member"`；`?name=cheap-zzz` →
  `hitKind:"name-contains"`；`?name=zzz-no-match` → 200 + `route:null` + `hitKind:"none"`。
- `GET /members` 响应含 `lastErrors`。
- `GET /recent` 返回 20 条，委派与操作记录混排，`summary` 示例：
  `设为 cpa-workbuddy/wb/deepseek-v4.1-flash`、`询问已跳过（本对话问过）`、
  `本对话默认设为 cpa-trae/trae/deepseek-v4.1-flash`。
- 配置写入实证：`POST /rules {"enabled":true}` 后 `sessions` 仍 1 条、`asked` 仍 2 条、
  `askOnFirst` 保住，与备份逐项一致（唯一差异是补上了原本缺失的 `defaultRoute: null`）。
  本轮全程 `rules.json` 只读，三条数据未变。
- 换模型已在真实实例验证：`inherited wb/…` → `applied cpa-trae/trae/…`，探针记 `hit: member:<名>`。
- 本对话默认已验证：`hit: "session"`，且第二次派活记 `ask-skip: already-asked`。
- 客户端视觉改造（2026-10-21）在真实实例上量过：卡片边框 `.5px`、圆角 16/12/8、标题 14px/500；
  头部「模型」按钮与兄弟按钮同为 28px 高、y 与 bottom 完全一致、图标 14px；
  面板 460px、head 固定不滚、body 独立滚动（scrollH 756 / clientH 404）；
  批量条与新建表单的三档各 204px 且无截断；键盘模态焦点环实测 `2px solid` 品牌色、offset 2px；
  toast 亮色 `#353638` / 暗色 `#43454a` 深底浅字。
- 面板信息架构重做（2026-10-21）：分「本对话默认 / 批量设置 / 成员」三区，各带标题；
  渠道 / 模型 / 推理档位三个下拉各有可见标签，批量条实测各 213px、编辑器 207px+421px 跨行。
- 下拉宽度探测：改用已渲染选项的 `getComputedStyle`（原先硬编码 `line-height:18px` 与实际差 17px，
  导致弹层宽 264px、内容实需 285px，标签被截断）；实测修后宽 334px、9 个选项无一截断。
  宽度按选项集指纹缓存，滚动时 `getBoundingClientRect` 调用从 1+N 次降到 2 次。
- `node tools/check-css-usage.mjs` exit 0：74 个类，0 死规则、0 未定义类。

## 待办

- [ ] 拆 `client.js`（4453 行，单文件零构建）需引入构建链，与「浏览器直接加载单文件」契约冲突，待决。
- [ ] L3 工具链（ESLint / Prettier / pre-commit）尚未接入；当前零依赖无 lint 配置。CI 已接入，只跑既有校验脚本。
- [ ] 链接校验需排除 `*research*`（外部包 README 原文，链接指向它们自己的仓库；该目录已排除出版本库，本机仍保留）。

## 活跃坑

- **`POST /rules` 曾整体覆写 `rules.json`**（已收敛，别回退）：拿 `effectiveSettings()` 归一化视图当写入基座，把 `sessions`（本对话默认）、`asked`（已问标记）、`askOnFirst` 一起清掉 —— 症状是「保存设置即清空本对话默认，下次派活又被问一次」。现在所有写路径一律 `{ ...readJsonFile(), ...改动 }`。回归检查：`POST /rules {"enabled":true}` 后 `sessions`/`asked` 条目数必须不变。见 [决策记录](.agents/notes/2026-10-20-config-write-merge.md)。
- `client-modules` 把「这一行有没有 client 包」按 `sourceKey` 缓存，**判空后永不重试**：装/卸插件与宿主启动撞车会让本插件从浏览器清单消失，唯一解法是再重启一次。见 [依据记录](.agents/notes/client-modules-cache.md)。
- 客户端半端的清单问题症状：`/plugins/??` 里没有本包、`__DSH_BOOT__.entries` 也没有，但宿主端点照常 200。
- `client.js` 里给下拉弹层加 `contain: size` 会让弹层高度塌成 0，只剩一条搜索框的缝。
- `--dsw-focus-ring-color` **只在 `html[data-input-modality=pointer]` 下被定义**，键盘模态下为空：
  写焦点环必须带 `var(..., var(--dsw-alias-state-business-primary))` 回退，否则键盘用户看不到焦点。
  见 [决策记录](.agents/notes/2026-10-21-client-visual-tokens.md)。
- 插件自己的样式值一律用宿主 token（`--dsw-radius-*`、`--dsw-alias-*`、`--dsh-frame-overlay-top`），
  不要回头写 `1px` / 自定圆角 / 写死阴影 —— 首轮视觉评审全是这类问题。同上决策记录。

## 文档地图

- 用户门面 → [README.md](README.md)
- 架构与契约 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 脚本手册 → [tools/README.md](tools/README.md)
- 决策与依据 → [.agents/notes/](.agents/notes/)
- 外部 API 调研（非活文档、外部包 README 原文）→ 本机 `.agents/notes/research/`，已排除出版本库
