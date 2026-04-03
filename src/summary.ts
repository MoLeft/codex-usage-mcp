import os from "node:os";
import path from "node:path";
import { projectLabelFromCwd } from "./path-utils.js";
import { parseSessionsDirectory } from "./parser.js";
import type {
  ParsedEvent,
  RangePayload,
  RateLimitSnapshot,
  SourceInfo,
  UsageEventPayload,
  UsageRow,
  UsageStats
} from "./types.js";

interface MutableStats {
  calls: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  estimatedCostUsd: number;
  hasUnknownCost: boolean;
}

interface BuildSummaryOptions {
  sessionsDir?: string;
  now?: Date;
  topProjects?: number;
  projectCwdPrefix?: string;
  slotMinutes?: number;
}

export interface UsageSummary {
  generatedAt: string;
  source: SourceInfo;
  total: UsageStats;
  current5h: {
    range: RangePayload;
    total: UsageStats;
    bySlot: Array<UsageRow & { slot: string }>;
    byModel: Array<UsageRow & { model: string }>;
  };
  currentWeek: {
    range: RangePayload;
    total: UsageStats;
    byDate: Array<UsageRow & { date: string }>;
    byModel: Array<UsageRow & { model: string }>;
  };
  projects: Array<UsageRow & { cwd: string | null; label: string }>;
  recentEvents: UsageEventPayload[];
  rateLimit: RateLimitSnapshot | null;
  metrics: {
    tokensPerMinute5h: number;
    callsPerMinute5h: number;
    avgTokensPerEvent5h: number;
    cacheHitRatio5h: number;
    outputRatio5h: number;
    activeProjects5h: number;
    activeModels5h: number;
    spikeRatio15mVs5h: number;
    freshnessSeconds: number | null;
  };
}

function emptyMutableStats(): MutableStats {
  return {
    calls: 0,
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    estimatedCostUsd: 0,
    hasUnknownCost: false
  };
}

function finalizeStats(stats: MutableStats): UsageStats {
  return {
    calls: stats.calls,
    totalTokens: stats.totalTokens,
    inputTokens: stats.inputTokens,
    cachedInputTokens: stats.cachedInputTokens,
    outputTokens: stats.outputTokens,
    reasoningOutputTokens: stats.reasoningOutputTokens,
    estimatedCostUsd: stats.hasUnknownCost ? null : Number(stats.estimatedCostUsd.toFixed(6))
  };
}

function applyEvent(stats: MutableStats, event: ParsedEvent): void {
  stats.calls += 1;
  stats.totalTokens += Math.max(0, event.delta.totalTokens);
  stats.inputTokens += Math.max(0, event.delta.inputTokens);
  stats.cachedInputTokens += Math.max(0, event.delta.cachedInputTokens);
  stats.outputTokens += Math.max(0, event.delta.outputTokens);
  stats.reasoningOutputTokens += Math.max(0, event.delta.reasoningOutputTokens);
  if (event.estimatedCostUsd === null) {
    stats.hasUnknownCost = true;
  } else if (!stats.hasUnknownCost) {
    stats.estimatedCostUsd += event.estimatedCostUsd;
  }
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

function formatDateKey(date: Date): string {
  return formatLocalDateTime(date).slice(0, 10);
}

function floorToBucket(date: Date, bucketMinutes: number): Date {
  const dt = new Date(date.getTime());
  const flooredMinutes = Math.floor(dt.getMinutes() / bucketMinutes) * bucketMinutes;
  dt.setMinutes(flooredMinutes, 0, 0);
  return dt;
}

function startOfWeek(date: Date): Date {
  const dt = new Date(date.getTime());
  const day = dt.getDay();
  const delta = day === 0 ? 6 : day - 1;
  dt.setDate(dt.getDate() - delta);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function safeRatio(numerator: number, denominator: number, digits = 4): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(digits));
}

function sortRows<T extends UsageRow>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    const costA = a.estimatedCostUsd ?? -1;
    const costB = b.estimatedCostUsd ?? -1;
    return costB - costA;
  });
}

function toSeriesRows<K extends string, T extends string>(
  map: Map<T, MutableStats>,
  keyName: K
): Array<UsageRow & Record<K, string>> {
  const rows = [...map.entries()].map(([key, stats]) => ({
    [keyName]: key,
    ...finalizeStats(stats)
  })) as Array<UsageRow & Record<K, string>>;
  rows.sort((a, b) => String(a[keyName]).localeCompare(String(b[keyName])));
  return rows;
}

function toTopRows<K extends string, T extends string>(
  map: Map<T, MutableStats>,
  keyName: K,
  limit: number
): Array<UsageRow & Record<K, string>> {
  const rows = [...map.entries()].map(([key, stats]) => ({
    [keyName]: key,
    ...finalizeStats(stats)
  })) as Array<UsageRow & Record<K, string>>;
  return sortRows(rows).slice(0, Math.max(1, limit));
}

function materializeProjectRows(projectStats: Map<string, MutableStats>): Array<UsageRow & { cwd: string | null; label: string }> {
  const groupedByLabel = new Map<string, string[]>();
  for (const cwd of projectStats.keys()) {
    const baseLabel = projectLabelFromCwd(cwd);
    const items = groupedByLabel.get(baseLabel) ?? [];
    items.push(cwd);
    groupedByLabel.set(baseLabel, items);
  }

  const labelMap = new Map<string, string>();
  for (const [baseLabel, cwds] of groupedByLabel.entries()) {
    const sorted = [...cwds].sort((a, b) => a.localeCompare(b));
    sorted.forEach((cwd, index) => {
      labelMap.set(cwd, index === 0 ? baseLabel : `${baseLabel} (${index + 1})`);
    });
  }

  const rows = [...projectStats.entries()].map(([cwd, stats]) => ({
    cwd,
    label: labelMap.get(cwd) ?? projectLabelFromCwd(cwd),
    ...finalizeStats(stats)
  }));
  return sortRows(rows);
}

function buildRecentEvents(events: ParsedEvent[], projectRows: Array<UsageRow & { cwd: string | null; label: string }>): UsageEventPayload[] {
  const labelByCwd = new Map<string, string>();
  for (const row of projectRows) {
    if (row.cwd) labelByCwd.set(row.cwd, row.label);
  }

  return [...events]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, 50)
    .map((event) => ({
      timestamp: formatLocalDateTime(event.timestamp),
      model: event.model,
      cwd: event.cwd,
      label: event.cwd ? labelByCwd.get(event.cwd) ?? projectLabelFromCwd(event.cwd) : "unknown",
      pricingSource: event.pricingSource,
      totalTokens: Math.max(0, event.delta.totalTokens),
      inputTokens: Math.max(0, event.delta.inputTokens),
      cachedInputTokens: Math.max(0, event.delta.cachedInputTokens),
      outputTokens: Math.max(0, event.delta.outputTokens),
      reasoningOutputTokens: Math.max(0, event.delta.reasoningOutputTokens),
      estimatedCostUsd: event.estimatedCostUsd
    }));
}

function defaultSessionsDir(): string {
  const envPath = process.env.CODEX_USAGE_SESSIONS_DIR;
  if (envPath && envPath.trim()) {
    return path.resolve(envPath);
  }
  return path.join(os.homedir(), ".codex", "sessions");
}

export async function buildUsageSummary(options: BuildSummaryOptions = {}): Promise<UsageSummary> {
  const now = options.now ?? new Date();
  const sessionsDir = options.sessionsDir ? path.resolve(options.sessionsDir) : defaultSessionsDir();
  const slotMinutes = Math.max(1, options.slotMinutes ?? 5);
  const topProjects = Math.max(1, options.topProjects ?? 10);

  const parsed = await parseSessionsDirectory(sessionsDir, options.projectCwdPrefix);
  const events = parsed.events;

  const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  const weekStart = startOfWeek(now);

  const total = emptyMutableStats();
  const current5h = emptyMutableStats();
  const currentWeek = emptyMutableStats();
  const recent15m = emptyMutableStats();

  const slotStats = new Map<string, MutableStats>();
  const current5hModelStats = new Map<string, MutableStats>();
  const currentWeekDateStats = new Map<string, MutableStats>();
  const currentWeekModelStats = new Map<string, MutableStats>();
  const projectStats = new Map<string, MutableStats>();

  for (const event of events) {
    applyEvent(total, event);

    const projectKey = event.cwd ?? "unknown";
    if (!projectStats.has(projectKey)) projectStats.set(projectKey, emptyMutableStats());
    applyEvent(projectStats.get(projectKey)!, event);

    if (event.timestamp >= fiveHoursAgo) {
      applyEvent(current5h, event);
      const slotKey = formatLocalDateTime(floorToBucket(event.timestamp, slotMinutes)).slice(0, 16);
      if (!slotStats.has(slotKey)) slotStats.set(slotKey, emptyMutableStats());
      applyEvent(slotStats.get(slotKey)!, event);

      if (!current5hModelStats.has(event.model)) current5hModelStats.set(event.model, emptyMutableStats());
      applyEvent(current5hModelStats.get(event.model)!, event);
    }

    if (event.timestamp >= weekStart) {
      applyEvent(currentWeek, event);
      const dateKey = formatDateKey(event.timestamp);
      if (!currentWeekDateStats.has(dateKey)) currentWeekDateStats.set(dateKey, emptyMutableStats());
      applyEvent(currentWeekDateStats.get(dateKey)!, event);

      if (!currentWeekModelStats.has(event.model)) currentWeekModelStats.set(event.model, emptyMutableStats());
      applyEvent(currentWeekModelStats.get(event.model)!, event);
    }

    if (event.timestamp >= fifteenMinutesAgo) {
      applyEvent(recent15m, event);
    }
  }

  for (
    let cursor = floorToBucket(fiveHoursAgo, slotMinutes);
    cursor.getTime() <= floorToBucket(now, slotMinutes).getTime();
    cursor = new Date(cursor.getTime() + slotMinutes * 60 * 1000)
  ) {
    const key = formatLocalDateTime(cursor).slice(0, 16);
    if (!slotStats.has(key)) slotStats.set(key, emptyMutableStats());
  }

  for (let cursor = new Date(weekStart.getTime()); cursor.getTime() <= now.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    const key = formatDateKey(cursor);
    if (!currentWeekDateStats.has(key)) currentWeekDateStats.set(key, emptyMutableStats());
  }

  const projectRows = materializeProjectRows(
    new Map(
      [...projectStats.entries()]
        .filter(([cwd]) => cwd !== "unknown")
        .map(([cwd, stats]) => [cwd, stats])
    )
  );

  const latestEvent = events[events.length - 1] ?? null;
  const current5hTotal = finalizeStats(current5h);
  const recent15mTotal = finalizeStats(recent15m);
  const metrics = {
    tokensPerMinute5h: Number((current5hTotal.totalTokens / 300).toFixed(2)),
    callsPerMinute5h: Number((current5hTotal.calls / 300).toFixed(3)),
    avgTokensPerEvent5h: safeRatio(current5hTotal.totalTokens, current5hTotal.calls, 2),
    cacheHitRatio5h: safeRatio(current5hTotal.cachedInputTokens, current5hTotal.inputTokens),
    outputRatio5h: safeRatio(current5hTotal.outputTokens, current5hTotal.inputTokens),
    activeProjects5h: new Set(events.filter((event) => event.timestamp >= fiveHoursAgo).map((event) => event.cwd ?? "unknown")).size,
    activeModels5h: new Set(events.filter((event) => event.timestamp >= fiveHoursAgo).map((event) => event.model)).size,
    spikeRatio15mVs5h:
      current5hTotal.totalTokens > 0
        ? safeRatio(recent15mTotal.totalTokens / 15, current5hTotal.totalTokens / 300, 2)
        : 0,
    freshnessSeconds: latestEvent ? Math.max(0, Math.round((now.getTime() - latestEvent.timestamp.getTime()) / 1000)) : null
  };

  return {
    generatedAt: formatLocalDateTime(now),
    source: {
      sessionsDir,
      files: parsed.files.length,
      latestEventAt: latestEvent ? formatLocalDateTime(latestEvent.timestamp) : null
    },
    total: finalizeStats(total),
    current5h: {
      range: {
        start: formatLocalDateTime(fiveHoursAgo),
        end: formatLocalDateTime(now),
        bucketMinutes: slotMinutes
      },
      total: current5hTotal,
      bySlot: toSeriesRows(slotStats, "slot"),
      byModel: toTopRows(current5hModelStats, "model", 15)
    },
    currentWeek: {
      range: {
        start: formatLocalDateTime(weekStart),
        end: formatLocalDateTime(now)
      },
      total: finalizeStats(currentWeek),
      byDate: toSeriesRows(currentWeekDateStats, "date"),
      byModel: toTopRows(currentWeekModelStats, "model", 15)
    },
    projects: projectRows.slice(0, topProjects),
    recentEvents: buildRecentEvents(events, projectRows),
    rateLimit: parsed.rateLimit,
    metrics
  };
}
