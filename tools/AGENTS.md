# tools/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

## 本目录约束

- 脚本只做**只读诊断**，不写宿主状态；唯一的例外是明确标注的写操作。
- 不打印密钥：cookie 与 `.credentials.yaml` 内容一律不落盘、不回显。
- 新增脚本必须同时更新 [README.md](README.md) 与根 [AGENTS.md](../AGENTS.md) 常用命令。
- 脚本用 `node` 直接跑，不引入依赖；保持零依赖可用。
