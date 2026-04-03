import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildRateLimitStatus,
  buildRecentUsageEvents,
  buildUsageBreakdown,
  buildUsageRange,
  buildUsageSummary
} from "./summary.js";
import type { RateLimitHistoryEntry, RateLimitSnapshot } from "./types.js";

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function summaryLine(parts: Array<string | number | null | undefined>): string {
  return parts.filter((part) => part !== null && part !== undefined && part !== "").join(" | ");
}

function formatLocalDateTime(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function serializeRateLimit(snapshot: RateLimitSnapshot | null): Record<string, unknown> | null {
  if (!snapshot) return null;
  return {
    limitId: snapshot.limitId,
    limitName: snapshot.limitName,
    observedAt: snapshot.observedAt ? formatLocalDateTime(snapshot.observedAt) : null,
    usedPercent: snapshot.usedPercent,
    windowMinutes: snapshot.windowMinutes,
    resetsAt: snapshot.resetsAt ? formatLocalDateTime(snapshot.resetsAt) : null,
    remainingSeconds: snapshot.remainingSeconds,
    scope: snapshot.scope
  };
}

function serializeRateLimitHistory(entry: RateLimitHistoryEntry): Record<string, unknown> {
  return {
    limitId: entry.limitId,
    limitName: entry.limitName,
    observedAt: formatLocalDateTime(entry.observedAt),
    usedPercent: entry.usedPercent,
    windowMinutes: entry.windowMinutes,
    resetsAt: entry.resetsAt ? formatLocalDateTime(entry.resetsAt) : null,
    remainingSeconds: entry.remainingSeconds,
    scope: entry.scope,
    sessionId: entry.sessionId,
    sessionFile: entry.sessionFile
  };
}

const dateRangePresetSchema = z.enum([
  "last_1h",
  "last_24h",
  "last_7d",
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month"
]);

const sortBySchema = z.enum(["totalTokens", "calls", "estimatedCostUsd"]);

export function createServer(): McpServer {
  const server = new McpServer({
    name: "codex-usage-mcp",
    version: "0.1.0"
  });

  server.tool(
    "get_usage_overview",
    "Get overall Codex token usage, current rolling 5-hour usage, current week cumulative usage, top projects, and the latest official 5-hour rate-limit snapshot.",
    {
      sessionsDir: z.string().optional(),
      includeCosts: z.boolean().default(true),
      includeRateLimits: z.boolean().default(true),
      topProjects: z.number().int().min(1).max(100).default(10)
    },
    async ({ sessionsDir, includeCosts, includeRateLimits, topProjects }) => {
      const summary = await buildUsageSummary({ sessionsDir, topProjects });
      const payload = {
        generatedAt: summary.generatedAt,
        source: summary.source,
        total: includeCosts ? summary.total : { ...summary.total, estimatedCostUsd: null },
        current5h: {
          ...summary.current5h.total,
          estimatedCostUsd: includeCosts ? summary.current5h.total.estimatedCostUsd : null
        },
        currentWeek: {
          ...summary.currentWeek.total,
          estimatedCostUsd: includeCosts ? summary.currentWeek.total.estimatedCostUsd : null
        },
        rateLimit: includeRateLimits ? serializeRateLimit(summary.rateLimit) : null,
        topProjects: summary.projects.slice(0, topProjects).map((project) => ({
          ...project,
          estimatedCostUsd: includeCosts ? project.estimatedCostUsd : null
        })),
        metrics: summary.metrics
      };

      const text = summaryLine([
        `generated ${summary.generatedAt}`,
        `totalTokens=${summary.total.totalTokens}`,
        `current5h=${summary.current5h.total.totalTokens}`,
        `currentWeek=${summary.currentWeek.total.totalTokens}`,
        `projects=${Math.min(topProjects, summary.projects.length)}`,
        includeRateLimits && summary.rateLimit?.usedPercent !== null
          ? `rateLimit=${summary.rateLimit?.usedPercent?.toFixed(2)}%`
          : null
      ]);

      return {
        content: [
          {
            type: "text",
            text: `${text}\n\n${asText(payload)}`
          }
        ],
        structuredContent: payload
      };
    }
  );

  server.tool(
    "get_current_5h_usage",
    "Get strict rolling 5-hour Codex usage with optional 5-minute slots, model breakdown, metrics, and the latest official 5-hour rate-limit snapshot.",
    {
      sessionsDir: z.string().optional(),
      includeSlots: z.boolean().default(true),
      includeModels: z.boolean().default(true),
      slotMinutes: z.number().int().min(1).max(60).default(5)
    },
    async ({ sessionsDir, includeSlots, includeModels, slotMinutes }) => {
      const summary = await buildUsageSummary({ sessionsDir, slotMinutes });
      const payload = {
        range: summary.current5h.range,
        total: summary.current5h.total,
        bySlot: includeSlots ? summary.current5h.bySlot : [],
        byModel: includeModels ? summary.current5h.byModel : [],
        rateLimit: serializeRateLimit(summary.rateLimit),
        metrics: summary.metrics,
        source: summary.source
      };

      return {
        content: [
          {
            type: "text",
            text:
              `${summaryLine([
                `range=${summary.current5h.range.start}..${summary.current5h.range.end}`,
                `tokens=${summary.current5h.total.totalTokens}`,
                `calls=${summary.current5h.total.calls}`,
                `rateLimit=${summary.rateLimit?.usedPercent?.toFixed(2) ?? "n/a"}%`
              ])}\n\n${asText(payload)}`
          }
        ],
        structuredContent: payload
      };
    }
  );

  server.tool(
    "get_current_week_usage",
    "Get current week cumulative Codex usage from local Monday 00:00 until now, with optional by-date and by-model breakdowns.",
    {
      sessionsDir: z.string().optional(),
      includeByDate: z.boolean().default(true),
      includeByModel: z.boolean().default(true)
    },
    async ({ sessionsDir, includeByDate, includeByModel }) => {
      const summary = await buildUsageSummary({ sessionsDir });
      const payload = {
        range: summary.currentWeek.range,
        total: summary.currentWeek.total,
        byDate: includeByDate ? summary.currentWeek.byDate : [],
        byModel: includeByModel ? summary.currentWeek.byModel : [],
        source: summary.source
      };

      return {
        content: [
          {
            type: "text",
            text:
              `${summaryLine([
                `weekStart=${summary.currentWeek.range.start}`,
                `tokens=${summary.currentWeek.total.totalTokens}`,
                `calls=${summary.currentWeek.total.calls}`
              ])}\n\n${asText(payload)}`
          }
        ],
        structuredContent: payload
      };
    }
  );

  server.tool(
    "get_project_usage",
    "Get Codex usage grouped by project cwd. Returns both raw cwd and a friendly label. Supports prefix filtering and sorting by tokens, calls, or cost.",
    {
      sessionsDir: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(20),
      sortBy: sortBySchema.default("totalTokens"),
      projectCwdPrefix: z.string().optional()
    },
    async ({ sessionsDir, limit, sortBy, projectCwdPrefix }) => {
      const summary = await buildUsageSummary({ sessionsDir, projectCwdPrefix, topProjects: 500 });
      const projects = [...summary.projects].sort((a, b) => {
        if (sortBy === "calls") return b.calls - a.calls;
        if (sortBy === "estimatedCostUsd") return (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1);
        return b.totalTokens - a.totalTokens;
      });

      const payload = {
        projects: projects.slice(0, limit),
        source: summary.source
      };

      return {
        content: [
          {
            type: "text",
            text:
              `${summaryLine([
                `projects=${Math.min(limit, projects.length)}`,
                `sortBy=${sortBy}`,
                projectCwdPrefix ? `filter=${projectCwdPrefix}` : null
              ])}\n\n${asText(payload)}`
          }
        ],
        structuredContent: payload
      };
    }
  );

  server.tool(
    "get_recent_usage_events",
    "Get recent or filtered Codex usage events, with optional time/model/session filters for debugging spikes and attribution.",
    {
      sessionsDir: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      projectCwdPrefix: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      preset: dateRangePresetSchema.optional(),
      model: z.string().optional(),
      session: z.string().optional(),
      sortOrder: z.enum(["desc", "asc"]).default("desc")
    },
    async ({ sessionsDir, limit, projectCwdPrefix, start, end, preset, model, session, sortOrder }) => {
      const result = await buildRecentUsageEvents({
        sessionsDir,
        limit,
        projectCwdPrefix,
        start,
        end,
        preset,
        model,
        session,
        sortOrder
      });
      const payload = {
        range: result.range,
        source: result.source,
        events: result.events
      };

      return {
        content: [
          {
            type: "text",
            text:
              `${summaryLine([
                `events=${result.events.length}`,
                `range=${result.range.start}..${result.range.end}`,
                model ? `model=${model}` : null,
                session ? `session=${session}` : null,
                projectCwdPrefix ? `filter=${projectCwdPrefix}` : null,
                `order=${sortOrder}`
              ])}\n\n${asText(payload)}`
          }
        ],
        structuredContent: payload
      };
    }
  );

  server.tool(
    "get_usage_range",
    "Get Codex usage for an arbitrary time range with optional project/model filters, time-series buckets, and top project/model breakdowns.",
    {
      sessionsDir: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      preset: dateRangePresetSchema.optional(),
      projectCwdPrefix: z.string().optional(),
      model: z.string().optional(),
      includeSeries: z.boolean().default(true),
      bucketMinutes: z.number().int().min(1).max(1440).optional(),
      includeTopProjects: z.boolean().default(true),
      includeTopModels: z.boolean().default(true),
      limit: z.number().int().min(1).max(200).default(20)
    },
    async ({
      sessionsDir,
      start,
      end,
      preset,
      projectCwdPrefix,
      model,
      includeSeries,
      bucketMinutes,
      includeTopProjects,
      includeTopModels,
      limit
    }) => {
      const result = await buildUsageRange({
        sessionsDir,
        start,
        end,
        preset,
        projectCwdPrefix,
        model,
        includeSeries,
        bucketMinutes,
        includeTopProjects,
        includeTopModels,
        limit
      });
      const payload = {
        range: result.range,
        total: result.total,
        series: result.series,
        topProjects: result.topProjects,
        topModels: result.topModels,
        source: result.source,
        metrics: result.metrics
      };

      return {
        content: [
          {
            type: "text",
            text:
              `${summaryLine([
                `range=${result.range.start}..${result.range.end}`,
                `tokens=${result.total.totalTokens}`,
                `calls=${result.total.calls}`,
                `projects=${result.topProjects.length}`,
                `models=${result.topModels.length}`
              ])}\n\n${asText(payload)}`
          }
        ],
        structuredContent: payload
      };
    }
  );

  server.tool(
    "get_usage_breakdown",
    "Get Codex usage broken down by project, model, session, or date across an arbitrary time range.",
    {
      sessionsDir: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      preset: dateRangePresetSchema.optional(),
      dimension: z.enum(["project", "model", "session", "date"]),
      projectCwdPrefix: z.string().optional(),
      model: z.string().optional(),
      sortBy: sortBySchema.default("totalTokens"),
      limit: z.number().int().min(1).max(200).default(20),
      includeUnknown: z.boolean().default(false)
    },
    async ({ sessionsDir, start, end, preset, dimension, projectCwdPrefix, model, sortBy, limit, includeUnknown }) => {
      const result = await buildUsageBreakdown({
        sessionsDir,
        start,
        end,
        preset,
        dimension,
        projectCwdPrefix,
        model,
        sortBy,
        limit,
        includeUnknown
      });
      const payload = {
        range: result.range,
        dimension: result.dimension,
        rows: result.rows,
        total: result.total,
        source: result.source
      };

      return {
        content: [
          {
            type: "text",
            text:
              `${summaryLine([
                `dimension=${dimension}`,
                `rows=${result.rows.length}`,
                `range=${result.range.start}..${result.range.end}`,
                `sortBy=${sortBy}`
              ])}\n\n${asText(payload)}`
          }
        ],
        structuredContent: payload
      };
    }
  );

  server.tool(
    "get_rate_limit_status",
    "Get current Codex rate-limit status, all discovered limit snapshots, and optional historical rate-limit observations.",
    {
      sessionsDir: z.string().optional(),
      includeAllLimits: z.boolean().default(true),
      includeHistory: z.boolean().default(false),
      historyLimit: z.number().int().min(1).max(500).default(50),
      limitId: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      preset: dateRangePresetSchema.optional()
    },
    async ({ sessionsDir, includeAllLimits, includeHistory, historyLimit, limitId, start, end, preset }) => {
      const result = await buildRateLimitStatus({
        sessionsDir,
        includeAllLimits,
        includeHistory,
        historyLimit,
        limitId,
        start,
        end,
        preset
      });
      const payload = {
        primary: serializeRateLimit(result.primary),
        limits: result.limits.map(serializeRateLimit),
        history: result.history.map(serializeRateLimitHistory),
        range: result.range,
        source: result.source
      };

      return {
        content: [
          {
            type: "text",
            text:
              `${summaryLine([
                `primary=${result.primary?.limitId ?? "none"}`,
                `limits=${result.limits.length}`,
                includeHistory ? `history=${result.history.length}` : null,
                limitId ? `limitId=${limitId}` : null,
                result.range ? `range=${result.range.start}..${result.range.end}` : null
              ])}\n\n${asText(payload)}`
          }
        ],
        structuredContent: payload
      };
    }
  );

  return server;
}
