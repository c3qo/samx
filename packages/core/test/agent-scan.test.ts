import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { AgentScanReportError, ingestAgentScanFindings } from "./internal.js";

async function makeTempWorkspace() {
  return mkdtemp(join(tmpdir(), "samx-agent-scan-"));
}

describe("ingestAgentScanFindings", () => {
  test("parses valid Agent Scan JSON from a report path", async () => {
    const cwd = await makeTempWorkspace();
    const reportPath = join(cwd, "agent-scan.json");
    await writeFile(
      reportPath,
      JSON.stringify({
        findings: [
          {
            id: "AS-001",
            severity: "critical",
            title: "Hardcoded token",
            message: "A token was found in the skill.",
            path: ".claude/skills/review/SKILL.md",
            line: 7,
            snippet: "token=abc123",
            extensionId: "claude-skills-review",
          },
        ],
      })
    );

    const findings = await ingestAgentScanFindings(reportPath);

    expect(findings).toEqual([
      expect.objectContaining({
        id: "agent-scan:AS-001",
        severity: "critical",
        status: "blocked",
        category: "security-scanner",
        extensionId: "claude-skills-review",
        title: "Hardcoded token",
        message: "A token was found in the skill.",
        source: "agent-scan",
        confidence: "high",
        evidence: [
          {
            file: ".claude/skills/review/SKILL.md",
            line: 7,
            snippet: "token=abc123",
            source: "external-scanner",
            confidence: "high",
          },
        ],
      }),
    ]);
  });

  test("returns a controlled error for a missing report file", async () => {
    await expect(ingestAgentScanFindings("/missing/agent-scan.json")).rejects.toThrow(
      AgentScanReportError
    );
  });

  test("returns a controlled error for a malformed report file", async () => {
    const cwd = await makeTempWorkspace();
    const reportPath = join(cwd, "agent-scan.json");
    await writeFile(reportPath, "{not json");

    await expect(ingestAgentScanFindings(reportPath)).rejects.toThrow(AgentScanReportError);
  });

  test("returns a controlled error for an oversized report file", async () => {
    const cwd = await makeTempWorkspace();
    const reportPath = join(cwd, "agent-scan.json");
    await writeFile(reportPath, JSON.stringify({ findings: [] }));

    await expect(ingestAgentScanFindings(reportPath, { maxReportBytes: 8 })).rejects.toThrow(
      AgentScanReportError
    );
  });

  test("returns a controlled error when report shape is too deeply nested", async () => {
    await expect(
      ingestAgentScanFindings(
        { findings: [{ location: { nested: { too: "deep" } } }] },
        { maxDepth: 3 }
      )
    ).rejects.toThrow(AgentScanReportError);
  });

  test("returns a controlled error when a report has too many findings", async () => {
    await expect(
      ingestAgentScanFindings(
        { findings: [{ message: "one" }, { message: "two" }] },
        { maxFindings: 1 }
      )
    ).rejects.toThrow(AgentScanReportError);
  });

  test("ignores unknown external fields while converting findings", async () => {
    const findings = await ingestAgentScanFindings({
      findings: [
        {
          severity: "low",
          name: "Unexpected field shape",
          description: "Unknown fields should not leak into SAMX findings.",
          file: "rules/security.mdc",
          unknownNestedData: { ignored: true },
        },
      ],
      scannerMetadata: { ignored: true },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "low",
      status: "warning",
      category: "security-scanner",
      title: "Unexpected field shape",
      message: "Unknown fields should not leak into SAMX findings.",
      source: "agent-scan",
      confidence: "high",
    });
    expect(findings[0]).not.toHaveProperty("unknownNestedData");
    expect(findings[0]).not.toHaveProperty("scannerMetadata");
  });

  test("converts results arrays and unknown severities into SAMX findings safely", async () => {
    const findings = await ingestAgentScanFindings({
      results: [
        {
          ruleId: "shell-risk",
          severity: "surprising",
          message: "Uses shell execution.",
          file: "commands/run.md",
        },
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        id: "agent-scan:shell-risk",
        severity: "medium",
        status: "warning",
        category: "security-scanner",
        title: "Uses shell execution.",
        message: "Uses shell execution.",
        source: "agent-scan",
        confidence: "low",
        evidence: [{ file: "commands/run.md", source: "external-scanner", confidence: "low" }],
      }),
    ]);
  });

  test("skips malformed array entries instead of creating synthetic scanner risks", async () => {
    const findings = await ingestAgentScanFindings([
      "not an object",
      null,
      [],
      {
        id: "valid-finding",
        severity: "low",
        title: "Valid finding",
        message: "Only object entries are converted.",
      },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: "agent-scan:valid-finding", title: "Valid finding" });
  });

  test("preserves nested location evidence and normalizes confidence casing", async () => {
    const findings = await ingestAgentScanFindings({
      findings: [
        {
          id: "nested-location",
          severity: "medium",
          confidence: "LOW",
          message: "Nested location should be preserved.",
          location: { file: "rules/security.mdc", line: 12 },
        },
        {
          id: "mixed-confidence",
          severity: "low",
          confidence: "Medium",
          message: "Mixed-case confidence should normalize.",
        },
      ],
    });

    expect(findings[0]).toMatchObject({
      confidence: "low",
      evidence: [
        { file: "rules/security.mdc", line: 12, source: "external-scanner", confidence: "low" },
      ],
    });
    expect(findings[1]).toMatchObject({ confidence: "medium" });
  });

  test("converts plain report arrays into SAMX findings", async () => {
    const findings = await ingestAgentScanFindings([
      {
        id: "array-finding",
        severity: "info",
        title: "Informational finding",
        message: "Plain arrays are supported.",
      },
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        id: "agent-scan:array-finding",
        severity: "info",
        status: "ok",
        category: "security-scanner",
        title: "Informational finding",
        message: "Plain arrays are supported.",
        source: "agent-scan",
        confidence: "high",
      }),
    ]);
  });
});
