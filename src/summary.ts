import os from "node:os";
import path from "node:path";
import { normalizeComparablePath, pathMatchesPrefix, projectLabelFromCwd } from "./path-utils.js";
import { choosePrimaryRateLimit, parseFlexibleDateTime, parseSessionsDirectory } from "./parser.js";
import type {
  BreakdownDimension,
  DateRangePreset,
  ParsedEvent,
  RateLimitHistoryEntry,
  RateLimitSnapshot,
  SourceInfo,
  UsageEventPayload,
  UsageFilter,
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

interface QueryOptions extends UsageFilter {
  sessionsDir?: string;
  now?: Date;
}

interface RangeQueryOptions extends QueryOptions {
  includeSeries?: boolean;
  bucketMinutes?: number;
  includeTopProjects?: boolean;
  includeTopModels?: boolean;
  limit?: number;
}

interface BreakdownQueryOptions extends QueryOptions {
  dimension: BreakdownDimension;
  sortBy?: "totalTokens" | "calls" | "estimatedCostUsd";
  limit?: number;
  includeUnknown?: boolean;
}

interface RecentEventsQueryOptions extends QueryOptions {
  limit?: number;
  sortOrder?: "desc" | "asc";
}

interface RateLimitStatusOptions {
  sessionsDir?: string;
  start?: string;
  end?: string;
  preset?: DateRangePreset;
  includeAllLimits?: boolean;
  includeHistory?: boolean;
  historyLimit?: number;
  limitId?: string;
  now?: Date;
}

interface ResolvedTimeRange {
  start: Date | null;
  end: Date | null;
  preset: DateRangePreset | null;
}

export interface UsageSummary {
  generatedAt: string;
  source: SourceInfo;
  total: UsageStats;
  current5h: {
    range: { start: string; end: string; bucketMinutes: number };
    total: UsageStats;
    bySlot: Array<UsageRow & { slot: string }>;
    byModel: Array<UsageRow & { model: string }>;
  };
  currentWeek: {
    range: { start: string; end: string };
    total: UsageStats;
    byDate: Array<UsageRow & { date: string }>;
    byModel: Array<UsageRow & { model: string }>;
  };
  projects: Array<UsageRow & { cwd: string | null; label: string }>;
  recentEvents: UsageEventPayload[];
  rateLimit: RateLimitSnapshot | null;
  rateLimitsById: Map<string, RateLimitSnapshot>;
  rateLimitHistory: RateLimitHistoryEntry[];
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

export interface UsageRangeResult {
  range: { start: string; end: string; bucketMinutes: number };
  total: UsageStats;
  series: Array<UsageRow & { slot: string }>;
  topProjects: Array<UsageRow & { cwd: string | null; label: string }>;
  topModels: Array<UsageRow & { model: string }>;
  source: SourceInfo;
  metrics: {
    tokensPerMinute: number;
    callsPerMinute: number;
    avgTokensPerEvent: number;
    cacheHitRatio: number;
    outputRatio: number;
    activeProjects: number;
    activeModels: number;
    freshnessSeconds: number | null;
  };
}

export interface UsageBreakdownResult {
  range: { start: string; end: string };
  dimension: BreakdownDimension;
  rows: BreakdownRow[];
  total: UsageStats;
  source: SourceInfo;
}

export interface RateLimitStatusResult {
  primary: RateLimitSnapshot | null;
  limits: RateLimitSnapshot[];
  history: RateLimitHistoryEntry[];
  range: { start: string; end: string } | null;
  source: SourceInfo;
}

export interface RecentUsageEventsResult {
  range: { start: string; end: string };
  events: UsageEventPayload[];
  source: SourceInfo;
}

type BreakdownRow =
  | (UsageRow & { cwd: string | null; label: string })
  | (UsageRow & { model: string })
  | (UsageRow & { sessionId: string; sessionFile: string; label: string })
  | (UsageRow & { date: string });

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

function aggregateStats(events: ParsedEvent[]): UsageStats {
  const stats = emptyMutableStats();
  for (const event of events) applyEvent(stats, event);
  return finalizeStats(stats);
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

function startOfDay(date: Date): Date {
  const dt = new Date(date.getTime());
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function startOfWeek(date: Date): Date {
  const dt = startOfDay(date);
  const day = dt.getDay();
  const delta = day === 0 ? 6 : day - 1;
  dt.setDate(dt.getDate() - delta);
  return dt;
}

function startOfMonth(date: Date): Date {
  const dt = startOfDay(date);
  dt.setDate(1);
  return dt;
}

function safeRatio(numerator: number, denominator: number, digits = 4): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(digits));
}

function sortRowsBy<T extends UsageRow>(rows: T[], sortBy: "totalTokens" | "calls" | "estimatedCostUsd" = "totalTokens"): T[] {
  return [...rows].sort((a, b) => {
    if (sortBy === "calls" && b.calls !== a.calls) return b.calls - a.calls;
    if (sortBy === "estimatedCostUsd") {
      const costDelta = (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1);
      if (costDelta !== 0) return costDelta;
    }
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    return (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1);
  });
}

function toSeriesRows<K extends string>(
  map: Map<string, MutableStats>,
  keyName: K
): Array<UsageRow & Record<K, string>> {
  const rows = [...map.entries()].map(([key, stats]) => ({
    [keyName]: key,
    ...finalizeStats(stats)
  })) as Array<UsageRow & Record<K, string>>;
  rows.sort((a, b) => String(a[keyName]).localeCompare(String(b[keyName])));
  return rows;
}

function toTopRows<K extends string>(
  map: Map<string, MutableStats>,
  keyName: K,
  limit: number,
  sortBy: "totalTokens" | "calls" | "estimatedCostUsd" = "totalTokens"
): Array<UsageRow & Record<K, string>> {
  const rows = [...map.entries()].map(([key, stats]) => ({
    [keyName]: key,
    ...finalizeStats(stats)
  })) as Array<UsageRow & Record<K, string>>;
  return sortRowsBy(rows, sortBy).slice(0, Math.max(1, limit));
}

function materializeProjectRows(
  projectStats: Map<string, MutableStats>
): Array<UsageRow & { cwd: string | null; label: string }> {
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
  return sortRowsBy(rows);
}

function buildRecentEvents(
  events: ParsedEvent[],
  sortOrder: "desc" | "asc" = "desc",
  limit = 50
): UsageEventPayload[] {
  const projectStats = new Map<string, MutableStats>();
  for (const event of events) {
    if (!event.cwd) continue;
    if (!projectStats.has(event.cwd)) projectStats.set(event.cwd, emptyMutableStats());
    applyEvent(projectStats.get(event.cwd)!, event);
  }

  const projectRows = materializeProjectRows(projectStats);
  const labelByCwd = new Map<string, string>();
  for (const row of projectRows) {
    if (row.cwd) labelByCwd.set(row.cwd, row.label);
  }

  const sorted = [...events].sort((a, b) =>
    sortOrder === "asc" ? a.timestamp.getTime() - b.timestamp.getTime() : b.timestamp.getTime() - a.timestamp.getTime()
  );

  return sorted.slice(0, Math.max(1, limit)).map((event) => ({
    timestamp: formatLocalDateTime(event.timestamp),
    model: event.model,
    cwd: event.cwd,
    label: event.cwd ? labelByCwd.get(event.cwd) ?? projectLabelFromCwd(event.cwd) : "unknown",
    sessionId: event.sessionId,
    sessionFile: event.sessionFile,
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

function buildSourceInfo(sessionsDir: string, files: string[], events: ParsedEvent[]): SourceInfo {
  const latestEvent = events.at(-1) ?? null;
  return {
    sessionsDir,
    files: files.length,
    latestEventAt: latestEvent ? formatLocalDateTime(latestEvent.timestamp) : null
  };
}

function normalizeOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function matchesSession(event: ParsedEvent, session: string): boolean {
  const target = normalizeComparablePath(session);
  const sessionId = normalizeComparablePath(event.sessionId);
  const sessionFile = normalizeComparablePath(event.sessionFile);
  return sessionId === target || sessionFile === target || sessionId.endsWith(`/${target}`) || sessionFile.endsWith(`/${target}`);
}

function resolvePresetRange(now: Date, preset: DateRangePreset): { start: Date; end: Date } {
  switch (preset) {
    case "last_1h":
      return { start: new Date(now.getTime() - 60 * 60 * 1000), end: now };
    case "last_24h":
      return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
    case "last_7d":
      return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now };
    case "today":
      return { start: startOfDay(now), end: now };
    case "yesterday": {
      const today = startOfDay(now);
      return { start: new Date(today.getTime() - 24 * 60 * 60 * 1000), end: new Date(today.getTime() - 1) };
    }
    case "this_week":
      return { start: startOfWeek(now), end: now };
    case "last_week": {
      const thisWeek = startOfWeek(now);
      return { start: new Date(thisWeek.getTime() - 7 * 24 * 60 * 60 * 1000), end: new Date(thisWeek.getTime() - 1) };
    }
    case "this_month":
      return { start: startOfMonth(now), end: now };
    case "last_month": {
      const thisMonth = startOfMonth(now);
      const prevMonth = startOfMonth(new Date(thisMonth.getFullYear(), thisMonth.getMonth() - 1, 1));
      return { start: prevMonth, end: new Date(thisMonth.getTime() - 1) };
    }
  }
}

function resolveTimeRange(filter: Pick<UsageFilter, "start" | "end" | "preset">, now: Date): ResolvedTimeRange {
  const parsedStart = normalizeOptional(filter.start);
  const parsedEnd = normalizeOptional(filter.end);
  if (parsedStart || parsedEnd) {
    const start = parsedStart ? parseFlexibleDateTime(parsedStart) : null;
    const end = parsedEnd ? parseFlexibleDateTime(parsedEnd) : now;
    if (parsedStart && !start) throw new Error(`Invalid start datetime: ${parsedStart}`);
    if (parsedEnd && !end) throw new Error(`Invalid end datetime: ${parsedEnd}`);
    if (start && end && start.getTime() > end.getTime()) {
      throw new Error(`Invalid time range: start ${parsedStart} is after end ${parsedEnd}`);
    }
    return { start, end, preset: null };
  }

  const preset = filter.preset ?? null;
  if (!preset) return { start: null, end: null, preset: null };
  const range = resolvePresetRange(now, preset);
  return { ...range, preset };
}

function chooseBucketMinutes(start: Date, end: Date): number {
  const durationMinutes = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 60000));
  if (durationMinutes <= 6 * 60) return 5;
  if (durationMinutes <= 24 * 60) return 15;
  if (durationMinutes <= 3 * 24 * 60) return 60;
  if (durationMinutes <= 14 * 24 * 60) return 6 * 60;
  if (durationMinutes <= 62 * 24 * 60) return 24 * 60;
  return 7 * 24 * 60;
}

function resolveOutputRange(events: ParsedEvent[], resolved: ResolvedTimeRange, now: Date): { start: Date; end: Date } {
  const earliest = events[0]?.timestamp ?? null;
  const latest = events.at(-1)?.timestamp ?? null;
  const start = resolved.start ?? earliest ?? resolved.end ?? now;
  const end = resolved.end ?? latest ?? resolved.start ?? now;
  return start.getTime() <= end.getTime() ? { start, end } : { start: end, end: end };
}

function filterEvents(events: ParsedEvent[], filter: UsageFilter, now: Date): { events: ParsedEvent[]; range: ResolvedTimeRange } {
  const range = resolveTimeRange(filter, now);
  const model = normalizeOptional(filter.model)?.toLowerCase() ?? null;
  const session = normalizeOptional(filter.session);

  const filtered = events.filter((event) => {
    if (filter.projectCwdPrefix && !pathMatchesPrefix(event.cwd, filter.projectCwdPrefix)) return false;
    if (model && event.model.trim().toLowerCase() !== model) return false;
    if (session && !matchesSession(event, session)) return false;
    if (range.start && event.timestamp.getTime() < range.start.getTime()) return false;
    if (range.end && event.timestamp.getTime() > range.end.getTime()) return false;
    return true;
  });

  filtered.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return { events: filtered, range };
}

function buildSeries(events: ParsedEvent[], start: Date, end: Date, bucketMinutes: number): Array<UsageRow & { slot: string }> {
  const slotStats = new Map<string, MutableStats>();
  for (const event of events) {
    const slotKey = formatLocalDateTime(floorToBucket(event.timestamp, bucketMinutes)).slice(0, 16);
    if (!slotStats.has(slotKey)) slotStats.set(slotKey, emptyMutableStats());
    applyEvent(slotStats.get(slotKey)!, event);
  }

  for (
    let cursor = floorToBucket(start, bucketMinutes);
    cursor.getTime() <= floorToBucket(end, bucketMinutes).getTime();
    cursor = new Date(cursor.getTime() + bucketMinutes * 60 * 1000)
  ) {
    const key = formatLocalDateTime(cursor).slice(0, 16);
    if (!slotStats.has(key)) slotStats.set(key, emptyMutableStats());
  }

  return toSeriesRows(slotStats, "slot");
}

function groupByModel(events: ParsedEvent[], limit: number): Array<UsageRow & { model: string }> {
  const stats = new Map<string, MutableStats>();
  for (const event of events) {
    if (!stats.has(event.model)) stats.set(event.model, emptyMutableStats());
    applyEvent(stats.get(event.model)!, event);
  }
  return toTopRows(stats, "model", limit);
}

function groupByProject(events: ParsedEvent[], includeUnknown: boolean): Array<UsageRow & { cwd: string | null; label: string }> {
  const stats = new Map<string, MutableStats>();
  for (const event of events) {
    const key = event.cwd ?? "unknown";
    if (key === "unknown" && !includeUnknown) continue;
    if (!stats.has(key)) stats.set(key, emptyMutableStats());
    applyEvent(stats.get(key)!, event);
  }

  const knownStats = new Map(
    [...stats.entries()]
      .filter(([cwd]) => cwd !== "unknown")
      .map(([cwd, value]) => [cwd, value])
  );
  const rows = materializeProjectRows(knownStats);

  if (includeUnknown && stats.has("unknown")) {
    rows.push({ cwd: null, label: "unknown", ...finalizeStats(stats.get("unknown")!) });
  }
  return rows;
}

function buildGenericMetrics(events: ParsedEvent[], total: UsageStats, start: Date, end: Date, now: Date) {
  const durationMinutes = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 60000));
  const latestEvent = events.at(-1) ?? null;
  return {
    tokensPerMinute: Number((total.totalTokens / durationMinutes).toFixed(2)),
    callsPerMinute: Number((total.calls / durationMinutes).toFixed(3)),
    avgTokensPerEvent: safeRatio(total.totalTokens, total.calls, 2),
    cacheHitRatio: safeRatio(total.cachedInputTokens, total.inputTokens),
    outputRatio: safeRatio(total.outputTokens, total.inputTokens),
    activeProjects: new Set(events.map((event) => event.cwd ?? "unknown")).size,
    activeModels: new Set(events.map((event) => event.model)).size,
    freshnessSeconds: latestEvent ? Math.max(0, Math.round((now.getTime() - latestEvent.timestamp.getTime()) / 1000)) : null
  };
}

function buildBreakdownRows(
  events: ParsedEvent[],
  dimension: BreakdownDimension,
  sortBy: "totalTokens" | "calls" | "estimatedCostUsd",
  limit: number,
  includeUnknown: boolean
): BreakdownRow[] {
  if (dimension === "project") {
    return sortRowsBy(groupByProject(events, includeUnknown), sortBy).slice(0, Math.max(1, limit));
  }

  if (dimension === "model") {
    const stats = new Map<string, MutableStats>();
    for (const event of events) {
      const key = event.model || "unknown";
      if (key === "unknown" && !includeUnknown) continue;
      if (!stats.has(key)) stats.set(key, emptyMutableStats());
      applyEvent(stats.get(key)!, event);
    }
    return toTopRows(stats, "model", limit, sortBy);
  }

  if (dimension === "session") {
    const stats = new Map<string, MutableStats>();
    const sessionFiles = new Map<string, string>();
    for (const event of events) {
      if (!stats.has(event.sessionId)) stats.set(event.sessionId, emptyMutableStats());
      sessionFiles.set(event.sessionId, event.sessionFile);
      applyEvent(stats.get(event.sessionId)!, event);
    }

    const rows = [...stats.entries()].map(([sessionId, value]) => ({
      sessionId,
      sessionFile: sessionFiles.get(sessionId) ?? sessionId,
      label: path.basename(sessionFiles.get(sessionId) ?? sessionId),
      ...finalizeStats(value)
    }));
    return sortRowsBy(rows, sortBy).slice(0, Math.max(1, limit));
  }

  const stats = new Map<string, MutableStats>();
  for (const event of events) {
    const dateKey = formatDateKey(event.timestamp);
    if (!stats.has(dateKey)) stats.set(dateKey, emptyMutableStats());
    applyEvent(stats.get(dateKey)!, event);
  }
  return toTopRows(stats, "date", limit, sortBy);
}

function sortRateLimitSnapshots(snapshots: RateLimitSnapshot[]): RateLimitSnapshot[] {
  return [...snapshots].sort((a, b) => {
    const scopeRank = (b.scope === "global" ? 1 : 0) - (a.scope === "global" ? 1 : 0);
    if (scopeRank !== 0) return scopeRank;
    const windowDelta = (b.windowMinutes ?? 0) - (a.windowMinutes ?? 0);
    if (windowDelta !== 0) return windowDelta;
    const resetDelta = (b.resetsAt?.getTime() ?? 0) - (a.resetsAt?.getTime() ?? 0);
    if (resetDelta !== 0) return resetDelta;
    const usedDelta = (b.usedPercent ?? -1) - (a.usedPercent ?? -1);
    if (usedDelta !== 0) return usedDelta;
    return (b.observedAt?.getTime() ?? 0) - (a.observedAt?.getTime() ?? 0);
  });
}

export async function buildUsageSummary(options: BuildSummaryOptions = {}): Promise<UsageSummary> {
  const now = options.now ?? new Date();
  const sessionsDir = options.sessionsDir ? path.resolve(options.sessionsDir) : defaultSessionsDir();
  const slotMinutes = Math.max(1, options.slotMinutes ?? 5);
  const topProjects = Math.max(1, options.topProjects ?? 10);

  const parsed = await parseSessionsDirectory(sessionsDir);
  const allEvents = parsed.events;
  const filteredAll = options.projectCwdPrefix
    ? allEvents.filter((event) => pathMatchesPrefix(event.cwd, options.projectCwdPrefix))
    : allEvents;

  const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  const weekStart = startOfWeek(now);

  const totalEvents = filteredAll;
  const current5hEvents = filteredAll.filter((event) => event.timestamp >= fiveHoursAgo);
  const currentWeekEvents = filteredAll.filter((event) => event.timestamp >= weekStart);
  const recent15mEvents = filteredAll.filter((event) => event.timestamp >= fifteenMinutesAgo);

  const slotRows = buildSeries(current5hEvents, fiveHoursAgo, now, slotMinutes);
  const currentWeekByDate = new Map<string, MutableStats>();
  for (const event of currentWeekEvents) {
    const dateKey = formatDateKey(event.timestamp);
    if (!currentWeekByDate.has(dateKey)) currentWeekByDate.set(dateKey, emptyMutableStats());
    applyEvent(currentWeekByDate.get(dateKey)!, event);
  }
  for (let cursor = new Date(weekStart.getTime()); cursor.getTime() <= now.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    const key = formatDateKey(cursor);
    if (!currentWeekByDate.has(key)) currentWeekByDate.set(key, emptyMutableStats());
  }

  const current5hTotal = aggregateStats(current5hEvents);
  const recent15mTotal = aggregateStats(recent15mEvents);
  const source = buildSourceInfo(sessionsDir, parsed.files, parsed.events);
  const metrics = {
    tokensPerMinute5h: Number((current5hTotal.totalTokens / 300).toFixed(2)),
    callsPerMinute5h: Number((current5hTotal.calls / 300).toFixed(3)),
    avgTokensPerEvent5h: safeRatio(current5hTotal.totalTokens, current5hTotal.calls, 2),
    cacheHitRatio5h: safeRatio(current5hTotal.cachedInputTokens, current5hTotal.inputTokens),
    outputRatio5h: safeRatio(current5hTotal.outputTokens, current5hTotal.inputTokens),
    activeProjects5h: new Set(current5hEvents.map((event) => event.cwd ?? "unknown")).size,
    activeModels5h: new Set(current5hEvents.map((event) => event.model)).size,
    spikeRatio15mVs5h:
      current5hTotal.totalTokens > 0
        ? safeRatio(recent15mTotal.totalTokens / 15, current5hTotal.totalTokens / 300, 2)
        : 0,
    freshnessSeconds: source.latestEventAt
      ? Math.max(0, Math.round((now.getTime() - (parsed.events.at(-1)?.timestamp.getTime() ?? now.getTime())) / 1000))
      : null
  };

  return {
    generatedAt: formatLocalDateTime(now),
    source,
    total: aggregateStats(totalEvents),
    current5h: {
      range: {
        start: formatLocalDateTime(fiveHoursAgo),
        end: formatLocalDateTime(now),
        bucketMinutes: slotMinutes
      },
      total: current5hTotal,
      bySlot: slotRows,
      byModel: groupByModel(current5hEvents, 15)
    },
    currentWeek: {
      range: {
        start: formatLocalDateTime(weekStart),
        end: formatLocalDateTime(now)
      },
      total: aggregateStats(currentWeekEvents),
      byDate: toSeriesRows(currentWeekByDate, "date"),
      byModel: groupByModel(currentWeekEvents, 15)
    },
    projects: groupByProject(totalEvents, false).slice(0, topProjects),
    recentEvents: buildRecentEvents(totalEvents, "desc", 50),
    rateLimit: parsed.rateLimit,
    rateLimitsById: parsed.rateLimitsById,
    rateLimitHistory: parsed.rateLimitHistory,
    metrics
  };
}

export async function buildUsageRange(options: RangeQueryOptions = {}): Promise<UsageRangeResult> {
  const now = options.now ?? new Date();
  const sessionsDir = options.sessionsDir ? path.resolve(options.sessionsDir) : defaultSessionsDir();
  const parsed = await parseSessionsDirectory(sessionsDir);
  const filtered = filterEvents(parsed.events, options, now);
  const outputRange = resolveOutputRange(filtered.events, filtered.range, now);
  const bucketMinutes = Math.max(1, Math.min(1440, options.bucketMinutes ?? chooseBucketMinutes(outputRange.start, outputRange.end)));
  const total = aggregateStats(filtered.events);

  return {
    range: {
      start: formatLocalDateTime(outputRange.start),
      end: formatLocalDateTime(outputRange.end),
      bucketMinutes
    },
    total,
    series: options.includeSeries === false ? [] : buildSeries(filtered.events, outputRange.start, outputRange.end, bucketMinutes),
    topProjects: options.includeTopProjects === false ? [] : groupByProject(filtered.events, false).slice(0, Math.max(1, options.limit ?? 20)),
    topModels: options.includeTopModels === false ? [] : groupByModel(filtered.events, Math.max(1, options.limit ?? 20)),
    source: buildSourceInfo(sessionsDir, parsed.files, parsed.events),
    metrics: buildGenericMetrics(filtered.events, total, outputRange.start, outputRange.end, now)
  };
}

export async function buildUsageBreakdown(options: BreakdownQueryOptions): Promise<UsageBreakdownResult> {
  const now = options.now ?? new Date();
  const sessionsDir = options.sessionsDir ? path.resolve(options.sessionsDir) : defaultSessionsDir();
  const parsed = await parseSessionsDirectory(sessionsDir);
  const filtered = filterEvents(parsed.events, options, now);
  const outputRange = resolveOutputRange(filtered.events, filtered.range, now);
  return {
    range: {
      start: formatLocalDateTime(outputRange.start),
      end: formatLocalDateTime(outputRange.end)
    },
    dimension: options.dimension,
    rows: buildBreakdownRows(
      filtered.events,
      options.dimension,
      options.sortBy ?? "totalTokens",
      options.limit ?? 20,
      options.includeUnknown ?? false
    ),
    total: aggregateStats(filtered.events),
    source: buildSourceInfo(sessionsDir, parsed.files, parsed.events)
  };
}

export async function buildRateLimitStatus(options: RateLimitStatusOptions = {}): Promise<RateLimitStatusResult> {
  const now = options.now ?? new Date();
  const sessionsDir = options.sessionsDir ? path.resolve(options.sessionsDir) : defaultSessionsDir();
  const parsed = await parseSessionsDirectory(sessionsDir);
  const limitId = normalizeOptional(options.limitId);

  const limits = sortRateLimitSnapshots(
    [...parsed.rateLimitsById.values()].filter((snapshot) => !limitId || snapshot.limitId === limitId)
  );
  const primary = choosePrimaryRateLimit(
    new Map(
      limits.map((snapshot) => [snapshot.limitId ?? `${snapshot.limitName ?? "global"}:${snapshot.scope}`, snapshot] as const)
    )
  );

  let history: RateLimitHistoryEntry[] = [];
  let range: { start: string; end: string } | null = null;
  if (options.includeHistory) {
    const resolved = resolveTimeRange(options, now);
    history = parsed.rateLimitHistory.filter((entry) => {
      if (limitId && entry.limitId !== limitId) return false;
      if (resolved.start && entry.observedAt.getTime() < resolved.start.getTime()) return false;
      if (resolved.end && entry.observedAt.getTime() > resolved.end.getTime()) return false;
      return true;
    });
    history.sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
    history = history.slice(0, Math.max(1, Math.min(500, options.historyLimit ?? 50)));
    const outputRange = resolveOutputRange(
      history.map((entry) => ({
        timestamp: entry.observedAt
      })) as ParsedEvent[],
      resolved,
      now
    );
    range = {
      start: formatLocalDateTime(outputRange.start),
      end: formatLocalDateTime(outputRange.end)
    };
  }

  return {
    primary,
    limits: options.includeAllLimits === false ? (primary ? [primary] : []) : limits,
    history,
    range,
    source: buildSourceInfo(sessionsDir, parsed.files, parsed.events)
  };
}

export async function buildRecentUsageEvents(options: RecentEventsQueryOptions = {}): Promise<RecentUsageEventsResult> {
  const now = options.now ?? new Date();
  const sessionsDir = options.sessionsDir ? path.resolve(options.sessionsDir) : defaultSessionsDir();
  const parsed = await parseSessionsDirectory(sessionsDir);
  const filtered = filterEvents(parsed.events, options, now);
  const outputRange = resolveOutputRange(filtered.events, filtered.range, now);
  return {
    range: {
      start: formatLocalDateTime(outputRange.start),
      end: formatLocalDateTime(outputRange.end)
    },
    events: buildRecentEvents(filtered.events, options.sortOrder ?? "desc", options.limit ?? 50),
    source: buildSourceInfo(sessionsDir, parsed.files, parsed.events)
  };
}
