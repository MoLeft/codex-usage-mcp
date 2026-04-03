export interface UsageDelta {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ParsedEvent {
  timestamp: Date;
  model: string;
  cwd: string | null;
  sessionId: string;
  sessionFile: string;
  delta: UsageDelta;
  estimatedCostUsd: number | null;
  pricingSource: string;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  observedAt: Date | null;
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: Date | null;
  remainingSeconds: number | null;
  scope: "global" | "model";
}

export interface RateLimitHistoryEntry extends RateLimitSnapshot {
  observedAt: Date;
  sessionId: string;
  sessionFile: string;
}

export interface UsageStats {
  calls: number;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  estimatedCostUsd: number | null;
}

export interface UsageRow extends UsageStats {}

export interface RangePayload {
  start: string;
  end: string;
  bucketMinutes?: number;
}

export interface SourceInfo {
  sessionsDir: string;
  files: number;
  latestEventAt: string | null;
}

export interface UsageEventPayload {
  timestamp: string;
  model: string;
  cwd: string | null;
  label: string;
  sessionId: string;
  sessionFile: string;
  pricingSource: string;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  estimatedCostUsd: number | null;
}

export type DateRangePreset =
  | "last_1h"
  | "last_24h"
  | "last_7d"
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month";

export type BreakdownDimension = "project" | "model" | "session" | "date";

export interface UsageFilter {
  start?: string;
  end?: string;
  preset?: DateRangePreset;
  projectCwdPrefix?: string;
  model?: string;
  session?: string;
}
