import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildUsageSummary } from "./summary.js";

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function summaryLine(parts: Array<string | number | null | undefined>): string {
  return parts.filter((part) => part !== null && part !== undefined && part !== "").join(" | ");
}

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
        rateLimit: includeRateLimits ? summary.rateLimit : null,
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
        rateLimit: summary.rateLimit,
        metrics: summary.metrics
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
        byModel: includeByModel ? summary.currentWeek.byModel : []
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
      sortBy: z.enum(["totalTokens", "calls", "estimatedCostUsd"]).default("totalTokens"),
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
        projects: projects.slice(0, limit)
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
    "Get the latest Codex usage events, useful for investigating recent spikes or finding which project/model consumed tokens most recently.",
    {
      sessionsDir: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      projectCwdPrefix: z.string().optional()
    },
    async ({ sessionsDir, limit, projectCwdPrefix }) => {
      const summary = await buildUsageSummary({ sessionsDir, projectCwdPrefix });
      const payload = {
        events: summary.recentEvents.slice(0, limit)
      };

      return {
        content: [
          {
            type: "text",
            text:
              `${summaryLine([
                `events=${Math.min(limit, summary.recentEvents.length)}`,
                projectCwdPrefix ? `filter=${projectCwdPrefix}` : null
              ])}\n\n${asText(payload)}`
          }
        ],
        structuredContent: payload
      };
    }
  );

  return server;
}
