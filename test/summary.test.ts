import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildUsageSummary } from "../src/summary.js";

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
});
