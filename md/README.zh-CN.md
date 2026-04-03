# codex-usage-mcp

[English](../README.md)

一个适合放进专业开源仓库首页的 Codex 使用量 MCP 服务：读取本地 `~/.codex/sessions/**/*.jsonl`，把零散的 session 日志整理成可查询的 token、成本估算、项目分布、模型分布、session 明细和 rate limit 状态。

[![npm version](https://img.shields.io/npm/v/codex-usage-mcp?style=flat-square)](https://www.npmjs.com/package/codex-usage-mcp)
[![npm downloads](https://img.shields.io/npm/dm/codex-usage-mcp?style=flat-square)](https://www.npmjs.com/package/codex-usage-mcp)
[![Node.js](https://img.shields.io/node/v/codex-usage-mcp?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/MoLeft/codex-usage-mcp?style=flat-square)](../LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/MoLeft/codex-usage-mcp?style=flat-square)](https://github.com/MoLeft/codex-usage-mcp/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/MoLeft/codex-usage-mcp?style=flat-square)](https://github.com/MoLeft/codex-usage-mcp/issues)
[![MCP](https://img.shields.io/badge/MCP-stdio-0A7EA4?style=flat-square)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square)](https://www.typescriptlang.org/)

## 项目亮点

- 固定窗口查询：滚动 5 小时、本周累计
- 任意时间范围查询：支持 `start/end` 和 `preset`
- 多维聚合：`project`、`model`、`session`、`date`
- 明细排障：可直接定位是哪一个 session 抬高了 token
- 限额视角：主限额、全部最新限额、历史快照
- 本地只读：不会改动任何 Codex session 文件

## 适合解决的问题

- 我今天到底用了多少 token？
- 最近 24 小时哪个项目最重？
- 哪个模型最贵？
- 哪个 session 导致 usage spike？
- Codex 全局限额现在用了多少？

## 当前提供的 8 个 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `get_usage_overview` | 总览：总 token、当前 5 小时、本周累计、项目排行、主限额 |
| `get_current_5h_usage` | 严格滚动 5 小时查询，支持时间桶和模型分布 |
| `get_current_week_usage` | 本地时区下从本周一 00:00 到现在的累计 |
| `get_project_usage` | 按项目聚合，可按目录前缀过滤 |
| `get_recent_usage_events` | 事件级排障查询，支持时间、模型、项目、session 过滤 |
| `get_usage_range` | 任意时间范围查询，可返回时间序列和 top 列表 |
| `get_usage_breakdown` | 按项目、模型、session、日期做聚合 |
| `get_rate_limit_status` | 主限额、全部最新限额、历史限额快照 |

## 安装

### npm 全局安装

```bash
npm install -g codex-usage-mcp
```

### 通过 `npx` 接入 Codex

```bash
codex mcp add codex-usage -- npx -y codex-usage-mcp
```

### 覆盖默认 sessions 目录

默认读取 `~/.codex/sessions`，如果你的日志目录在别处：

```bash
codex mcp add codex-usage --env CODEX_USAGE_SESSIONS_DIR=D:/workspace/.codex/sessions -- npx -y codex-usage-mcp
```

## `config.toml` 示例

```toml
[mcp_servers.codex-usage]
command = "npx"
args = ["-y", "codex-usage-mcp"]
startup_timeout_sec = 15
tool_timeout_sec = 60

[mcp_servers.codex-usage.env]
CODEX_USAGE_SESSIONS_DIR = "D:/workspace/.codex/sessions"
```

如果你要直接跑本地源码构建产物：

```toml
[mcp_servers.codex-usage-local]
command = "node"
args = ["dist/cli.js"]
cwd = "D:/workspace/codex-usage-mcp"
startup_timeout_sec = 15
tool_timeout_sec = 60
```

## 查询模型

### 时间范围

范围类工具支持：

- `start`
- `end`
- `preset`

如果两者同时提供，优先使用 `start/end`。

支持的 `preset`：

- `last_1h`
- `last_24h`
- `last_7d`
- `today`
- `yesterday`
- `this_week`
- `last_week`
- `this_month`
- `last_month`

时间解析规则：

- 不带时区的时间按当前运行机器本地时区解释
- 带 `Z` 或 `+08:00` 这类 offset 的时间按绝对时间解析
- 过滤条件使用 `start <= event.timestamp <= end`

### 常见过滤参数

- `sessionsDir`
- `projectCwdPrefix`
- `model`
- `session`
- `limit`

## 输入示例

### `get_usage_overview`

```json
{
  "sessionsDir": "C:/Users/you/.codex/sessions",
  "includeCosts": true,
  "includeRateLimits": true,
  "topProjects": 10
}
```

### `get_recent_usage_events`

```json
{
  "sessionsDir": "C:/Users/you/.codex/sessions",
  "limit": 50,
  "projectCwdPrefix": "D:/workspace",
  "start": "2026-04-02 13:00:00",
  "end": "2026-04-02 15:00:00",
  "model": "gpt-5.4-codex",
  "session": "2026/04/02/session-a.jsonl",
  "sortOrder": "desc"
}
```

重点输出字段：

- `sessionId`
- `sessionFile`
- `model`
- `cwd`
- `pricingSource`
- token 增量和估算成本

### `get_usage_range`

```json
{
  "sessionsDir": "C:/Users/you/.codex/sessions",
  "start": "2026-04-01 00:00:00",
  "end": "2026-04-03 23:59:59",
  "projectCwdPrefix": "D:/workspace",
  "model": "gpt-5.4-codex",
  "includeSeries": true,
  "bucketMinutes": 60,
  "includeTopProjects": true,
  "includeTopModels": true,
  "limit": 20
}
```

也可以直接使用：

```json
{
  "preset": "last_7d"
}
```

### `get_usage_breakdown`

```json
{
  "sessionsDir": "C:/Users/you/.codex/sessions",
  "preset": "this_week",
  "dimension": "model",
  "sortBy": "totalTokens",
  "limit": 20,
  "includeUnknown": false
}
```

支持的 `dimension`：

- `project`
- `model`
- `session`
- `date`

### `get_rate_limit_status`

```json
{
  "sessionsDir": "C:/Users/you/.codex/sessions",
  "includeAllLimits": true,
  "includeHistory": true,
  "historyLimit": 100,
  "limitId": "codex",
  "preset": "last_24h"
}
```

返回说明：

- `primary`：优先选择 Codex 全局限额
- `limits`：每个限额当前最新状态
- `history`：日志中真实出现过的历史快照，不做插值

## 输出说明

- 所有日志以 UTF-8 文本读取
- 未知模型不会让查询失败，但 `estimatedCostUsd` 会返回 `null`
- `sessionId` 基于相对 session 文件路径生成，适合稳定过滤
- `currentWeek` 和无时区时间字符串都按本地时区处理
- 项目过滤使用路径前缀匹配，兼容 Windows 斜杠和大小写差异

## 本地开发

```bash
npm install
npm run build
npm test
```

## FAQ

### 会修改 Codex 的 session 文件吗？

不会。整个服务是只读解析。

### 这是官方账单接口吗？

不是。它是一个本地日志分析层，偏向开发者使用画像和排障。

### 模型价格未知怎么办？

token 统计照常返回，只有成本估算会变成 `null`。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=MoLeft/codex-usage-mcp&type=Date)](https://www.star-history.com/#MoLeft/codex-usage-mcp&Date)
