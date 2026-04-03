# codex-usage-mcp

`codex-usage-mcp` 是一个本地 `stdio` MCP server，用来读取 `~/.codex/sessions/**/*.jsonl`，把 Codex CLI 的 token 使用情况整理成可直接被 Codex 调用的工具。

它默认提供 5 个工具：

- `get_usage_overview`
- `get_current_5h_usage`
- `get_current_week_usage`
- `get_project_usage`
- `get_recent_usage_events`

## Install

```bash
npm install -g codex-usage-mcp
```

或直接通过 `npx` 给 Codex 接入：

```bash
codex mcp add codex-usage -- npx -y codex-usage-mcp
```

如果默认会话目录不是 `~/.codex/sessions`，也可以在接入时直接传环境变量：

```bash
codex mcp add codex-usage --env CODEX_USAGE_SESSIONS_DIR=D:/workspace/.codex/sessions -- npx -y codex-usage-mcp
```

## config.toml Example

默认配置文件位置是 `~/.codex/config.toml`，也可以用项目级 `.codex/config.toml`。

```toml
[mcp_servers.codex-usage]
command = "npx"
args = ["-y", "codex-usage-mcp"]
startup_timeout_sec = 15
tool_timeout_sec = 60

[mcp_servers.codex-usage.env]
CODEX_USAGE_SESSIONS_DIR = "D:/workspace/.codex/sessions"
```

如果你想临时覆盖目录，也可以在调用工具时直接传 `sessionsDir`。本包支持两种自定义方式：

- 环境变量 `CODEX_USAGE_SESSIONS_DIR`
- 工具参数里的 `sessionsDir`

也可以在 `config.toml` 里指定工作目录：

```toml
[mcp_servers.codex-usage-local]
command = "node"
args = ["dist/cli.js"]
cwd = "D:/workspace/codex-usage-mcp"
startup_timeout_sec = 15
tool_timeout_sec = 60
```

## Tool Inputs

### `get_usage_overview`

```json
{
  "sessionsDir": "C:/Users/you/.codex/sessions",
  "includeCosts": true,
  "includeRateLimits": true,
  "topProjects": 10
}
```

### `get_current_5h_usage`

```json
{
  "sessionsDir": "C:/Users/you/.codex/sessions",
  "includeSlots": true,
  "includeModels": true,
  "slotMinutes": 5
}
```

### `get_current_week_usage`

```json
{
  "sessionsDir": "C:/Users/you/.codex/sessions",
  "includeByDate": true,
  "includeByModel": true
}
```

### `get_project_usage`

```json
{
  "sessionsDir": "C:/Users/you/.codex/sessions",
  "limit": 20,
  "sortBy": "totalTokens",
  "projectCwdPrefix": "D:/workspace"
}
```

### `get_recent_usage_events`

```json
{
  "sessionsDir": "C:/Users/you/.codex/sessions",
  "limit": 50,
  "projectCwdPrefix": "D:/workspace"
}
```

## Development

```bash
npm install
npm run build
npm test
```

## Notes

- 只读解析日志，不会修改任何会话文件。
- 文本文件统一按 UTF-8 读取。
- “当前周限额窗口”按“本周累计使用”实现，不是官方周配额快照。
- 未知模型不会报错，但相关 `estimatedCostUsd` 会返回 `null`。
