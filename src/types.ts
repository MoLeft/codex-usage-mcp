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
  pricingSource: string;
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  estimatedCostUsd: number | null;
}
