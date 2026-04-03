<div align="center">

# codex-usage-mcp

**Production-friendly MCP server for analyzing local Codex CLI token usage, costs, projects, sessions, and rate limits.**

[简体中文](https://github.com/MoLeft/codex-usage-mcp/blob/main/md/README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/codex-usage-mcp?style=flat-square)](https://www.npmjs.com/package/codex-usage-mcp)
[![npm downloads](https://img.shields.io/npm/dm/codex-usage-mcp?style=flat-square)](https://www.npmjs.com/package/codex-usage-mcp)
[![Node.js](https://img.shields.io/node/v/codex-usage-mcp?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/MoLeft/codex-usage-mcp?style=flat-square)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/MoLeft/codex-usage-mcp?style=flat-square)](https://github.com/MoLeft/codex-usage-mcp/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/MoLeft/codex-usage-mcp?style=flat-square)](https://github.com/MoLeft/codex-usage-mcp/issues)
[![MCP](https://img.shields.io/badge/MCP-stdio-0A7EA4?style=flat-square)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square)](https://www.typescriptlang.org/)

</div>

`codex-usage-mcp` reads local Codex session logs from `~/.codex/sessions/**/*.jsonl` and turns them into queryable MCP tools. It is designed for day-to-day developer visibility: how many tokens you used, which projects were active, which models were most expensive, which session caused a spike, and what your latest rate-limit status looks like.

It exposes structured JSON plus readable summaries, so it works well both for humans and for downstream agents.

## Why This Exists

Codex CLI stores rich local usage data, but raw session logs are awkward to inspect directly. This server wraps those logs in a focused MCP interface so you can ask questions like:

- How many tokens did I use in the last 24 hours?
- Which project consumed the most tokens this week?
- Which session caused the latest spike?
- What is my current Codex rate-limit status?
- How does usage break down by model, project, session, or date?

## Features

- Fixed-window views for rolling 5-hour usage and current-week usage
- Arbitrary time-range queries with explicit `start/end` or named `preset`
- Aggregations by `project`, `model`, `session`, and `date`
- Event-level debugging with `sessionId` and `sessionFile`
- Rate-limit inspection with primary snapshot, all latest limits, and optional history
- Windows-friendly path-prefix filtering with mixed separator support
- Cost estimation with graceful fallback for unknown models
- Local-only, read-only parsing of Codex session logs

## Tooling Surface

The server currently ships with 8 MCP tools:

| Tool | Purpose |
| --- | --- |
| `get_usage_overview` | Global overview: total usage, rolling 5h, current week, top projects, primary rate limit |
| `get_current_5h_usage` | Strict rolling 5-hour view with optional time buckets and model breakdown |
| `get_current_week_usage` | Current week cumulative view from local Monday 00:00 |
| `get_project_usage` | Project-level aggregation with prefix filtering and sorting |
| `get_recent_usage_events` | Event-level debugging with time, model, project, and session filters |
| `get_usage_range` | Arbitrary time-range query with optional time series and top lists |
| `get_usage_breakdown` | Aggregation by project, model, session, or date |
| `get_rate_limit_status` | Primary rate limit, all latest limits, and optional history |

## Installation

### Install from npm

```bash
npm install -g codex-usage-mcp
```

### Add it to Codex via `npx`

```bash
codex mcp add codex-usage -- npx -y codex-usage-mcp
```

### Override the default sessions directory

By default the server reads from `~/.codex/sessions`. If your logs live elsewhere, pass `CODEX_USAGE_SESSIONS_DIR`:

```bash
codex mcp add codex-usage --env CODEX_USAGE_SESSIONS_DIR=D:/workspace/.codex/sessions -- npx -y codex-usage-mcp
```

## Example `config.toml`

```toml
[mcp_servers.codex-usage]
command = "npx"
args = ["-y", "codex-usage-mcp"]
startup_timeout_sec = 15
tool_timeout_sec = 60

[mcp_servers.codex-usage.env]
CODEX_USAGE_SESSIONS_DIR = "D:/workspace/.codex/sessions"
```

To run from a local checkout instead of npm:

```toml
[mcp_servers.codex-usage-local]
command = "node"
args = ["dist/cli.js"]
cwd = "D:/workspace/codex-usage-mcp"
startup_timeout_sec = 15
tool_timeout_sec = 60
```

## Query Model

### Time Range Inputs

Range-based tools support either explicit datetimes or a preset:

- `start`
- `end`
- `preset`

If both are supplied, `start/end` takes precedence over `preset`.

Supported `preset` values:

- `last_1h`
- `last_24h`
- `last_7d`
- `today`
- `yesterday`
- `this_week`
- `last_week`
- `this_month`
- `last_month`

Time parsing rules:

- Datetimes without a timezone are interpreted in the local machine timezone
- Datetimes with `Z` or an explicit offset such as `+08:00` are parsed as absolute times
- Range filtering uses `start <= event.timestamp <= end`

### Common Filters

Depending on the tool, queries may support:

- `sessionsDir`
- `projectCwdPrefix`
- `model`
- `session`
- `limit`

## Usage Examples

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

Valid `sortBy` values:

- `totalTokens`
- `calls`
- `estimatedCostUsd`

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

Notable output fields:

- `sessionId`
- `sessionFile`
- `model`
- `cwd`
- `pricingSource`
- token deltas and estimated cost

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

Or with a preset:

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

Supported `dimension` values:

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

What you get:

- `primary`: the preferred rate-limit snapshot, still biased toward global Codex
- `limits`: the latest discovered snapshot for each limit
- `history`: real observed snapshots from logs, with no interpolation

## Output Notes

- Log files are read as UTF-8 text
- Unknown pricing models do not fail the query; `estimatedCostUsd` becomes `null`
- `sessionId` is derived from the relative session file path for stable filtering
- Week-based queries and naive datetimes use the local runtime timezone
- Project filters use path-prefix matching and handle Windows separator and case differences

## Development

```bash
npm install
npm run build
npm test
```

## FAQ

### Does this modify any Codex session logs?

No. It is read-only.

### Is this an official billing API?

No. It is a local analysis layer over Codex session logs, useful for visibility and debugging.

### What happens when a model is unknown?

Token usage is still counted, but cost estimation is returned as `null`.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=MoLeft/codex-usage-mcp&type=Date)](https://www.star-history.com/#MoLeft/codex-usage-mcp&Date)
