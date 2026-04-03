import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("MCP smoke", () => {
  it("initializes, lists tools, and calls a tool end-to-end", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [path.resolve("dist/cli.js")],
      cwd: path.resolve("."),
      stderr: "pipe"
    });

    const client = new Client(
      { name: "codex-usage-mcp-test-client", version: "0.1.0" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name).sort();
      expect(toolNames).toEqual([
        "get_current_5h_usage",
        "get_current_week_usage",
        "get_project_usage",
        "get_recent_usage_events",
        "get_usage_overview"
      ]);

      const result = await client.callTool({
        name: "get_usage_overview",
        arguments: {
          sessionsDir: path.resolve("test/fixtures/sessions"),
          topProjects: 2
        }
      });

      expect(result.content[0]).toMatchObject({ type: "text" });
      expect((result.content[0] as { text: string }).text).toContain("totalTokens=730");

      const structured = result.structuredContent as
        | {
            total?: { totalTokens?: number };
            current5h?: { totalTokens?: number };
            topProjects?: Array<{ cwd?: string | null; totalTokens?: number }>;
          }
        | undefined;
      expect(structured?.total?.totalTokens).toBe(730);
      expect(typeof structured?.current5h?.totalTokens).toBe("number");
      expect((structured?.current5h?.totalTokens ?? -1)).toBeGreaterThanOrEqual(0);
      expect(structured?.topProjects?.length).toBe(2);
    } finally {
      await transport.close();
    }
  });
});
