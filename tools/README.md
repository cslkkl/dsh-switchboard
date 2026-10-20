# tools/ — 诊断脚本手册

- 职责：在真实实例上验证插件行为，不参与运行时逻辑。
- 全部零依赖，直接用 `node` 跑。
- 使用约束（只读、不打印密钥）→ 见 [AGENTS.md](AGENTS.md)。

## probe-http.mjs

- 作用：用浏览器会话密钥自签 cookie，直接请求宿主 HTTP 端点。
- 用法：`node tools/probe-http.mjs <GET|POST> <路径> ['<JSON>']`
- 例：`node tools/probe-http.mjs GET /api/v1/child-model/state`
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

## 文档网络的出口

- 规则层 → [AGENTS.md](AGENTS.md)
- 回到根索引 → [../AGENTS.md](../AGENTS.md)
- 设计依据 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
