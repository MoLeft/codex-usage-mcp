import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRateLimitStatus,
  buildRecentUsageEvents,
  buildUsageBreakdown,
  buildUsageRange,
  buildUsageSummary
} from "../src/summary.js";

const fixturesDir = path.resolve("test/fixtures/sessions");
const fixedNow = new Date(2026, 3, 2, 15, 0, 0);

describe("buildUsageSummary", () => {
  it("parses cumulative token counters without double counting", async () => {
    const summary = await buildUsageSummary({ sessionsDir: fixturesDir, now: fixedNow });
    expect(summary.total.totalTokens).toBe(730);
    expect(summary.total.calls).toBe(7);
  });

  it("builds strict rolling 5-hour usage and fills slot gaps", async () => {
    const summary = await buildUsageSummary({ sessionsDir: fixturesDir, now: fixedNow, slotMinutes: 5 });
    expect(summary.current5h.total.totalTokens).toBe(380);
    expect(summary.current5h.bySlot[0]?.slot).toBe("2026-04-02 10:00");
    expect(summary.current5h.bySlot.at(-1)?.slot).toBe("2026-04-02 15:00");
    expect(summary.current5h.bySlot.some((row) => row.totalTokens === 0)).toBe(true);
  });

  it("builds current week usage from local monday start", async () => {
    const summary = await buildUsageSummary({ sessionsDir: fixturesDir, now: fixedNow });
    expect(summary.currentWeek.range.start).toBe("2026-03-30 00:00:00");
    expect(summary.currentWeek.total.totalTokens).toBe(730);
    expect(summary.currentWeek.byDate.some((row) => row.date === "2026-03-31")).toBe(true);
  });

  it("keeps unknown model costs as null instead of failing", async () => {
    const summary = await buildUsageSummary({ sessionsDir: fixturesDir, now: fixedNow });
    expect(summary.total.estimatedCostUsd).toBeNull();
    const alpha = summary.projects.find((project) => project.cwd?.includes("alpha"));
    expect(alpha?.estimatedCostUsd).toBeNull();
  });

  it("prefers the global codex rate-limit snapshot", async () => {
    const summary = await buildUsageSummary({ sessionsDir: fixturesDir, now: fixedNow });
    expect(summary.rateLimit?.limitId).toBe("codex");
    expect(summary.rateLimit?.usedPercent).toBe(55);
    expect(summary.rateLimitsById.size).toBe(2);
    expect(summary.rateLimitHistory).toHaveLength(3);
  });

  it("filters project usage with Windows-compatible mixed separators", async () => {
    const summary = await buildUsageSummary({
      sessionsDir: fixturesDir,
      now: fixedNow,
      projectCwdPrefix: "c:/workspace/sample/alpha"
    });
    expect(summary.projects).toHaveLength(1);
    expect(summary.projects[0]?.cwd).toContain("alpha");
    expect(summary.total.totalTokens).toBe(410);
  });

  it("supports arbitrary time ranges with combined project and model filters", async () => {
    const result = await buildUsageRange({
      sessionsDir: fixturesDir,
      now: fixedNow,
      start: "2026-04-02 09:00:00",
      end: "2026-04-02 15:00:00",
      projectCwdPrefix: "C:/workspace/sample/alpha",
      model: "gpt-5.4-codex"
    });
    expect(result.total.totalTokens).toBe(320);
    expect(result.total.calls).toBe(3);
    expect(result.topProjects[0]?.label).toBe("alpha");
    expect(result.topModels[0]?.model).toBe("gpt-5.4-codex");
  });

  it("supports preset ranges and parses offset datetimes correctly", async () => {
    const presetResult = await buildUsageRange({
      sessionsDir: fixturesDir,
      now: fixedNow,
      preset: "today"
    });
    expect(presetResult.total.totalTokens).toBe(630);

    const offsetResult = await buildUsageRange({
      sessionsDir: fixturesDir,
      now: fixedNow,
      start: "2026-04-02T05:00:00Z",
      end: "2026-04-02T07:00:00Z"
    });
    expect(offsetResult.total.totalTokens).toBe(290);
    expect(offsetResult.total.calls).toBe(3);
  });

  it("builds model, session, and date breakdowns", async () => {
    const byModel = await buildUsageBreakdown({
      sessionsDir: fixturesDir,
      now: fixedNow,
      dimension: "model"
    });
    expect(byModel.rows).toHaveLength(3);
    expect("model" in byModel.rows[0]!).toBe(true);
    expect(byModel.rows[0]?.totalTokens).toBe(320);

    const bySession = await buildUsageBreakdown({
      sessionsDir: fixturesDir,
      now: fixedNow,
      dimension: "session"
    });
    expect(bySession.rows).toHaveLength(2);
    expect(bySession.rows.some((row) => "sessionId" in row && row.sessionId === "session-a.jsonl")).toBe(true);
    expect(bySession.rows.some((row) => "sessionId" in row && row.sessionId === "session-b.jsonl")).toBe(true);

    const byDate = await buildUsageBreakdown({
      sessionsDir: fixturesDir,
      now: fixedNow,
      dimension: "date"
    });
    expect(byDate.rows).toHaveLength(2);
    expect(byDate.rows[0] && "date" in byDate.rows[0] ? byDate.rows[0].date : null).toBe("2026-04-02");
    expect(byDate.rows[0]?.totalTokens).toBe(630);
  });

  it("returns all latest rate limits and filtered rate-limit history", async () => {
    const result = await buildRateLimitStatus({
      sessionsDir: fixturesDir,
      now: fixedNow,
      includeHistory: true,
      preset: "last_7d"
    });
    expect(result.primary?.limitId).toBe("codex");
    expect(result.limits).toHaveLength(2);
    expect(result.history).toHaveLength(3);
    expect(result.history[0]?.limitId).toBe("gpt-5-mini");

    const codexOnly = await buildRateLimitStatus({
      sessionsDir: fixturesDir,
      now: fixedNow,
      includeHistory: true,
      limitId: "codex",
      start: "2026-04-02 00:00:00",
      end: "2026-04-02 23:59:59"
    });
    expect(codexOnly.limits).toHaveLength(1);
    expect(codexOnly.history).toHaveLength(2);
    expect(codexOnly.history.every((entry) => entry.limitId === "codex")).toBe(true);
  });

  it("filters recent events by model, session, and time range while exposing session metadata", async () => {
    const result = await buildRecentUsageEvents({
      sessionsDir: fixturesDir,
      now: fixedNow,
      start: "2026-04-02 13:00:00",
      end: "2026-04-02 15:00:00",
      model: "gpt-5-mini",
      session: "session-b.jsonl",
      sortOrder: "asc"
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.sessionId).toBe("session-b.jsonl");
    expect(result.events[0]?.sessionFile).toContain("session-b.jsonl");
    expect(result.events[0]?.timestamp).toBe("2026-04-02 14:20:00");
  });
});
