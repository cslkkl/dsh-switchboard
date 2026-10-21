# tools/ — 诊断脚本手册

- 职责：在真实实例上验证插件行为，不参与运行时逻辑。
- 全部零依赖，直接用 `node` 跑。
- 使用约束（只读、不打印密钥）→ 见 [AGENTS.md](AGENTS.md)。

## probe-http.mjs

- 作用：用浏览器会话密钥自签 cookie，直接请求宿主 HTTP 端点。
- 用法：`node tools/probe-http.mjs <GET|POST> <路径> ['<JSON>']`
- 例：`node tools/probe-http.mjs GET /api/v1/switchboard/state`
- 带 query 要整体加引号（`&` 会被 PowerShell 当分隔符）：
  `node tools/probe-http.mjs GET "/api/v1/switchboard/simulate?name=cheap-worker&label=cheap-worker"`
  返回 `{ok, route, hit, hitKind}`；未命中是 **200 + `route: null`**，不是 404。
- 密钥来源：`$DSH_HOME/.credentials.yaml`；只在本进程内使用，不打印、不落盘。
- 超时：默认 60 秒，可用 `PROBE_TIMEOUT_MS` 调整。
- 依赖：无。被依赖：人工自测；根 [AGENTS.md](../AGENTS.md) 常用命令引用它。

## read-session.mjs

- 作用：解出 DSH 会话日志的**全部** zstd 帧。
- 为什么需要：`session.v4.jsonl.zstd` 是多帧格式，Node 流式解压只吐第一帧。
- 用法：`node tools/read-session.mjs <session.v4.jsonl.zstd>`
- 典型用途：核对子会话真实的 `request/header.config`，确认路由真被改写。
- 依赖：无。

## decode-readmes.mjs

- 作用：从 API 响应里解出 base64 编码的 README，落成可读文件。
- 用途：读取插件市场或包市场的说明文本。
- 依赖：无。

## check-css-usage.mjs

- 作用：核对 `client.js` 的 CSS 定义与使用点是否对得上。
- 用法：`node tools/check-css-usage.mjs`
- 判据：样式表里定义了但 JSX 再没引用的类 = 死规则；JSX 引用了但样式表没有的类 = 未定义类。
- 退出码：0 = 两边都干净；1 = 有死规则或未定义类，逐条打印类名。
- 典型用途：改完样式后确认删干净的规则真的删掉了、新加的类都有定义。
- 依赖：无。被依赖：人工自检；根 [AGENTS.md](../AGENTS.md) 常用命令引用它。

## check-markdown-links.py

- 作用：校验 Markdown 里的相对链接、锚点与「引用未做成链接」。
- 用法：`python tools/check-markdown-links.py . --fragments --refs --github --exclude '*research*'`
- 关键参数：`--github` 模拟 GitHub 实际解析（大小写敏感、目标须被 git 跟踪）；
  `--fragments` 校验 `#锚点`；`--refs` 校验文档引用未做成链接；`--exclude` 按 fnmatch 排除。
- 退出码：0 = 只有警告；1 = 有错误（断链）。
- 典型用途：改完文档后确认没有断链、锚点仍对应真实标题。
- 依赖：仅标准库。被依赖：CI（`.github/workflows/check.yml`）。

## check-line-endings.py

- 作用：检查仓库内文本文件的换行符是否一致。
- 用法：`python tools/check-line-endings.py . --exclude '*research*' --ext .js --ext .md --ext .mjs --ext .json --ext .yml --ext .py`
- 关键参数：`--ext` 指定要检查的扩展名（可多次）；`--exclude` 按 fnmatch 排除。
- 退出码：0 = 一致；1 = 存在不一致。
- 典型用途：跨平台协作或批量改动后确认没有混进 CRLF。
- 依赖：仅标准库。被依赖：CI（`.github/workflows/check.yml`）。

## 文档网络的出口

- 规则层 → [AGENTS.md](AGENTS.md)
- 回到根索引 → [../AGENTS.md](../AGENTS.md)
- 设计依据 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
