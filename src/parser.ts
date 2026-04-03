import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { estimateCostUsd } from "./pricing.js";
import { pathMatchesPrefix } from "./path-utils.js";
import type { ParsedEvent, RateLimitSnapshot, UsageDelta } from "./types.js";

interface ParsedSessionResult {
  events: ParsedEvent[];
  rateLimit: RateLimitSnapshot | null;
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  if (/[zZ]|[+\-]\d{2}:\d{2}$/.test(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
  );
  if (!match) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const [, y, m, d, hh, mm, ss = "0", ms = "0"] = match;
  return new Date(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss),
    Number(ms.padEnd(3, "0"))
  );
}

function usageDeltaFromPayload(value: unknown): UsageDelta | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  return {
    inputTokens: safeNumber(payload.input_tokens),
    cachedInputTokens: safeNumber(payload.cached_input_tokens),
    outputTokens: safeNumber(payload.output_tokens),
    reasoningOutputTokens: safeNumber(payload.reasoning_output_tokens),
    totalTokens: safeNumber(payload.total_tokens)
  };
}

function diffUsageDelta(current: UsageDelta, previous: UsageDelta | null): UsageDelta {
  if (!previous) return current;
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
    totalTokens: current.totalTokens - previous.totalTokens
  };
}

function buildRateLimitSnapshot(payload: unknown, timestamp: Date): RateLimitSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const rateLimits = payload as Record<string, unknown>;
  const primary = rateLimits.primary;
  const primaryObj = primary && typeof primary === "object" ? (primary as Record<string, unknown>) : {};

  const usedPercent =
    typeof primaryObj.used_percent === "number" && Number.isFinite(primaryObj.used_percent)
      ? primaryObj.used_percent
      : null;
  const windowMinutes =
    typeof primaryObj.window_minutes === "number" && Number.isFinite(primaryObj.window_minutes)
      ? primaryObj.window_minutes
      : null;

  let resetsAt: Date | null = null;
  if (typeof primaryObj.resets_at === "number" && Number.isFinite(primaryObj.resets_at)) {
    const dt = new Date(primaryObj.resets_at * 1000);
    resetsAt = Number.isNaN(dt.getTime()) ? null : dt;
  }

  let remainingSeconds =
    typeof primaryObj.resets_in_seconds === "number" && Number.isFinite(primaryObj.resets_in_seconds)
      ? Math.max(0, Math.round(primaryObj.resets_in_seconds))
      : null;

  if (!resetsAt && remainingSeconds !== null) {
    resetsAt = new Date(timestamp.getTime() + remainingSeconds * 1000);
  } else if (resetsAt && remainingSeconds === null) {
    remainingSeconds = Math.max(0, Math.round((resetsAt.getTime() - timestamp.getTime()) / 1000));
  }

  const limitId = typeof rateLimits.limit_id === "string" ? rateLimits.limit_id : null;
  const limitName = typeof rateLimits.limit_name === "string" ? rateLimits.limit_name : null;
  return {
    limitId,
    limitName,
    observedAt: timestamp,
    usedPercent,
    windowMinutes,
    resetsAt,
    remainingSeconds,
    scope: limitId === "codex" || !limitName ? "global" : "model"
  };
}

function shouldReplaceRateLimit(existing: RateLimitSnapshot | null, candidate: RateLimitSnapshot): boolean {
  if (!existing) return true;

  const existingScopeRank = existing.scope === "global" ? 1 : 0;
  const candidateScopeRank = candidate.scope === "global" ? 1 : 0;
  if (existingScopeRank !== candidateScopeRank) return candidateScopeRank > existingScopeRank;

  const existingReset = existing.resetsAt?.getTime() ?? Number.MIN_SAFE_INTEGER;
  const candidateReset = candidate.resetsAt?.getTime() ?? Number.MIN_SAFE_INTEGER;
  if (existing.limitId === candidate.limitId && candidateReset !== existingReset) {
    return candidateReset > existingReset;
  }
  if (candidateReset !== existingReset) return candidateReset > existingReset;

  const existingUsed = existing.usedPercent ?? -1;
  const candidateUsed = candidate.usedPercent ?? -1;
  if (candidateUsed !== existingUsed) return candidateUsed > existingUsed;

  const existingObserved = existing.observedAt?.getTime() ?? Number.MIN_SAFE_INTEGER;
  const candidateObserved = candidate.observedAt?.getTime() ?? Number.MIN_SAFE_INTEGER;
  return candidateObserved > existingObserved;
}

function choosePrimaryRateLimit(rateLimits: Map<string, RateLimitSnapshot>): RateLimitSnapshot | null {
  const codex = rateLimits.get("codex");
  if (codex) return codex;

  const values = [...rateLimits.values()];
  values.sort((a, b) => {
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
  return values[0] ?? null;
}

async function parseSessionFile(filePath: string, projectCwdPrefix?: string): Promise<ParsedSessionResult> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const events: ParsedEvent[] = [];
  const rateLimits = new Map<string, RateLimitSnapshot>();
  let currentModel = "unknown";
  let currentCwd: string | null = null;
  let previousTotal: UsageDelta | null = null;

  try {
    for await (const line of rl) {
      if (!line) continue;

      if (line.includes('"type":"session_meta"')) {
        try {
          const parsed = JSON.parse(line) as { payload?: { cwd?: unknown } };
          if (typeof parsed.payload?.cwd === "string" && parsed.payload.cwd.trim()) {
            currentCwd = parsed.payload.cwd;
          }
        } catch {}
        continue;
      }

      if (line.includes('"type":"turn_context"')) {
        try {
          const parsed = JSON.parse(line) as { payload?: { cwd?: unknown; model?: unknown } };
          if (typeof parsed.payload?.model === "string" && parsed.payload.model.trim()) {
            currentModel = parsed.payload.model;
          }
          if (typeof parsed.payload?.cwd === "string" && parsed.payload.cwd.trim()) {
            currentCwd = parsed.payload.cwd;
          }
        } catch {}
        continue;
      }

      if (!line.includes('"type":"token_count"')) continue;

      let parsed: { timestamp?: unknown; payload?: Record<string, unknown> } | null = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;

      const timestamp = parseTimestamp(parsed.timestamp);
      if (!timestamp) continue;

      const payload = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {};
      const snapshot = buildRateLimitSnapshot(payload.rate_limits, timestamp);
      if (snapshot) {
        const key = snapshot.limitId ?? "global";
        const existing = rateLimits.get(key) ?? null;
        if (shouldReplaceRateLimit(existing, snapshot)) {
          rateLimits.set(key, snapshot);
        }
      }

      const info = payload.info;
      if (!info || typeof info !== "object") continue;
      const infoObj = info as Record<string, unknown>;
      const totalUsage = usageDeltaFromPayload(infoObj.total_token_usage);
      if (!totalUsage) continue;

      const delta = diffUsageDelta(totalUsage, previousTotal);
      previousTotal = totalUsage;
      if (delta.totalTokens <= 0) continue;
      if (!pathMatchesPrefix(currentCwd, projectCwdPrefix)) continue;

      const cost = estimateCostUsd(currentModel, delta);
      events.push({
        timestamp,
        model: currentModel,
        cwd: currentCwd,
        delta,
        estimatedCostUsd: cost.estimatedCostUsd,
        pricingSource: cost.pricingSource
      });
    }
  } finally {
    rl.close();
    stream.close();
  }

  return {
    events,
    rateLimit: choosePrimaryRateLimit(rateLimits)
  };
}

function listSessionFilesRecursive(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSessionFilesRecursive(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export async function parseSessionsDirectory(
  sessionsDir: string,
  projectCwdPrefix?: string
): Promise<{ files: string[]; events: ParsedEvent[]; rateLimit: RateLimitSnapshot | null }> {
  const files = listSessionFilesRecursive(sessionsDir);
  const allEvents: ParsedEvent[] = [];
  const rateLimits = new Map<string, RateLimitSnapshot>();

  for (const file of files) {
    const parsed = await parseSessionFile(file, projectCwdPrefix);
    allEvents.push(...parsed.events);
    if (parsed.rateLimit) {
      const key = parsed.rateLimit.limitId ?? "global";
      const existing = rateLimits.get(key) ?? null;
      if (shouldReplaceRateLimit(existing, parsed.rateLimit)) {
        rateLimits.set(key, parsed.rateLimit);
      }
    }
  }

  allEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return {
    files,
    events: allEvents,
    rateLimit: choosePrimaryRateLimit(rateLimits)
  };
}
