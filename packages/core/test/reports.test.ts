import { describe, expect, test } from "vitest";

import type { AnalyzeReport } from "./internal.js";
import {
  renderAnalyzeJsonReport,
  renderAnalyzeMarkdownReport,
  renderAnalyzeTerminalReport,
} from "./internal.js";

const report: AnalyzeReport = {
  generatedAt: "2026-06-22T12:00:00.000Z",
  projectRoot: "/workspace/project",
  summary: {
    packages: 1,
    capabilities: 2,
    bundles: 1,
    links: 1,
    findings: 1,
    readiness: "needs_review",
  },
  packages: [
    {
      id: "default/acme/tools",
      type: "git",
      installKind: "formula",
      source: "https://example.com/acme/tools.git",
      ref: "0123456789012345678901234567890123456789",
      advisories: 1,
    },
  ],
  capabilities: [
    {
      id: "default/acme/tools:skills-review",
      packageId: "default/acme/tools",
      kind: "skill",
      name: "review",
      path: "skills/review",
    },
    {
      id: "default/acme/tools:mcp-search",
      packageId: "default/acme/tools",
      kind: "mcp",
      name: "search",
      path: "mcp/search/mcp.json",
      serverName: "search",
      transport: "stdio",
    },
  ],
  bundles: [
    {
      id: "coding",
      items: 2,
      readiness: "needs_review",
      missingItems: [],
      warnings: ["Review advisory before linking"],
    },
  ],
  links: [
    {
      id: "coding:opencode:/workspace/project",
      bundleId: "coding",
      tool: "opencode",
      projectRoot: "/workspace/project",
      outputs: [".opencode/skill/review/SKILL.md"],
    },
  ],
  findings: [
    {
      id: "advisory-1",
      severity: "medium",
      status: "warning",
      category: "advisory",
      title: "Hook advisory",
      message: "Review hook <script>alert(1)</script>",
      source: "default/acme/tools",
      confidence: "high",
      recommendation: "Review hook before linking.",
    },
  ],
  recommendations: ["Review hook before linking."],
};

describe("analyze report renderers", () => {
  test("renders terminal analyze report summary and inventory", () => {
    const output = renderAnalyzeTerminalReport(report);

    expect(output).toContain("SAMX Analyze Report");
    expect(output).toContain("Readiness: needs_review");
    expect(output).toContain("Packages: 1");
    expect(output).toContain("default/acme/tools:skills-review");
    expect(output).toContain("coding:opencode:/workspace/project");
    expect(output).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
  });

  test("renders parseable analyze JSON", () => {
    const parsed = JSON.parse(renderAnalyzeJsonReport(report)) as AnalyzeReport;

    expect(parsed.summary.readiness).toBe("needs_review");
    expect(parsed.summary.packages).toBe(1);
    expect(parsed.packages[0]?.id).toBe("default/acme/tools");
  });

  test("renders markdown with escaped untrusted finding text", () => {
    const output = renderAnalyzeMarkdownReport(report);

    expect(output).toContain("# SAMX Analyze Report");
    expect(output).toContain("Review hook &lt;script&gt;alert\(1\)&lt;/script&gt;");
    expect(output).not.toContain("Review hook <script>alert(1)</script>");
  });
});
