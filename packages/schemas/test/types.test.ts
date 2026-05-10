import { describe, expect, it, test } from "vitest";

import {
  analyzeReportSchema,
  evidenceSchema,
  indexedAgentSchema,
  indexedMcpSchema,
  indexedSkillSchema,
  linkRecordSchema,
  pluginRulesSchema,
  normalizedExtensionSchema,
  samxPackageManifestSchema,
} from "../src/index.js";

describe("shared schemas", () => {
  it("requires indexed skill path", () => {
    expect(() =>
      indexedSkillSchema.parse({
        id: "pkg:skills-review",
        packageId: "pkg",
        name: "review",
        kind: "skill",
      })
    ).toThrow();
  });

  it("allows indexed MCP without path", () => {
    const mcp = indexedMcpSchema.parse({
      id: "pkg:mcp-github",
      packageId: "pkg",
      name: "github",
      kind: "mcp",
      serverName: "github",
      config: { url: "https://example.test/mcp" },
      sourceFormat: "direct",
      transport: "remote",
    });

    expect(mcp.path).toBeUndefined();
  });

  it("applies defaults for requirements, permissions, and metadata", () => {
    const extension = normalizedExtensionSchema.parse({
      id: "skill.github-review",
      name: "GitHub review",
      kind: "skill",
      sourcePath: ".claude/skills/github-review/SKILL.md",
      entryFiles: [".claude/skills/github-review/SKILL.md"],
      declaredRequirements: {},
      inferredRequirements: {},
      declaredPermissions: {},
      inferredPermissions: {},
      risks: [],
    });

    expect(extension.declaredRequirements).toEqual({
      commands: [],
      env: [],
      paths: [],
    });
    expect(extension.declaredPermissions).toEqual({
      shell: false,
      network: false,
      filesystem: [],
      browser: false,
      secrets: [],
    });
    expect(extension.metadata).toEqual({});
  });

  it("validates analyze reports for SAMX-managed state", () => {
    const report = analyzeReportSchema.parse({
      generatedAt: "2026-06-22T00:00:00.000Z",
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
          source: "https://example.test/acme/tools.git",
          path: "/tmp/samx/packages/default/acme/tools/source",
          advisories: 1,
        },
      ],
      capabilities: [
        {
          id: "default/acme/tools:skills-review",
          packageId: "default/acme/tools",
          kind: "skill",
          name: "review",
          path: "/tmp/samx/packages/default/acme/tools/source/skills/review",
        },
        {
          id: "default/acme/tools:mcp-github",
          packageId: "default/acme/tools",
          kind: "mcp",
          name: "github",
          serverName: "github",
          transport: "remote",
        },
      ],
      bundles: [
        {
          id: "coding",
          items: 2,
          readiness: "needs_review",
          missingItems: [],
          warnings: ["Optional hook target unsupported: audit (opencode)"],
        },
      ],
      links: [
        {
          id: "coding:opencode:/workspace/project",
          bundleId: "coding",
          tool: "opencode",
          projectRoot: "/workspace/project",
          outputs: ["/workspace/project/.opencode/opencode.json"],
        },
      ],
      findings: [
        {
          id: "package:default/acme/tools:advisory:0",
          severity: "medium",
          status: "warning",
          category: "package",
          title: "Package advisory",
          message: "Review package advisory for default/acme/tools.",
          source: "default/acme/tools",
          confidence: "high",
        },
      ],
      recommendations: ["Review package advisories before linking."],
    });

    expect(report.summary.readiness).toBe("needs_review");
    expect(report.capabilities[1]?.kind).toBe("mcp");
  });

  it("rejects invalid evidence line numbers", () => {
    expect(() =>
      evidenceSchema.parse({
        file: "SKILL.md",
        line: 0,
        source: "declared",
        confidence: "high",
      })
    ).toThrow();
  });

  it("rejects unsafe link target paths in plugin rules", () => {
    expect(() =>
      pluginRulesSchema.parse({
        linkTargets: {
          unsafe: {
            capabilities: {
              mcp: {
                mode: "mcp-json-merge",
                output: "../mcp.json",
              },
            },
          },
        },
      })
    ).toThrow();
    expect(() =>
      pluginRulesSchema.parse({
        linkTargets: {
          unsafe: {
            capabilities: {
              skill: {
                mode: "directory-symlink",
                root: "/tmp/skills",
              },
            },
          },
        },
      })
    ).toThrow();
  });
});

describe("package manifest hook schema", () => {
  it("accepts explicit package hook declarations", () => {
    expect(
      samxPackageManifestSchema.parse({
        hooks: [
          {
            id: "safe-bash",
            description: "Reject dangerous shell commands",
            appliesTo: ["skill:review", "agent:reviewer"],
            files: [
              { target: "claude", path: "skills/review/hooks/claude.json" },
              { target: "opencode", path: "hooks/safe-bash/opencode.js" },
            ],
            required: true,
          },
        ],
      })
    ).toEqual({
      hooks: [
        {
          id: "safe-bash",
          description: "Reject dangerous shell commands",
          appliesTo: ["skill:review", "agent:reviewer"],
          files: [
            { target: "claude", path: "skills/review/hooks/claude.json" },
            { target: "opencode", path: "hooks/safe-bash/opencode.js" },
          ],
          required: true,
        },
      ],
    });
  });

  it("rejects implicit required", () => {
    expect(() =>
      samxPackageManifestSchema.parse({
        hooks: [
          {
            id: "safe-bash",
            appliesTo: ["skill:review"],
            files: [{ target: "claude", path: "hooks/claude.json" }],
          },
        ],
      })
    ).toThrow();
  });

  it("rejects duplicate hook file targets", () => {
    const result = samxPackageManifestSchema.safeParse({
      hooks: [
        {
          id: "safe-bash",
          appliesTo: ["skill:lint"],
          files: [
            { target: "opencode", path: "hooks/one.js" },
            { target: "opencode", path: "hooks/two.js" },
          ],
          required: false,
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain(
        "Duplicate hook file target: opencode"
      );
    }
  });

  it("rejects legacy hook targets field", () => {
    const result = samxPackageManifestSchema.safeParse({
      hooks: [
        {
          id: "safe-bash",
          appliesTo: ["skill:lint"],
          targets: ["opencode"],
          files: [{ target: "opencode", path: "hooks/opencode.js" }],
          required: false,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsafe hook paths", () => {
    expect(() =>
      samxPackageManifestSchema.parse({
        hooks: [
          {
            id: "unsafe",
            appliesTo: ["skill:review"],
            files: [{ target: "claude", path: "../outside.json" }],
            required: false,
          },
        ],
      })
    ).toThrow();
  });

  it("rejects invalid appliesTo references", () => {
    expect(() =>
      samxPackageManifestSchema.parse({
        hooks: [
          {
            id: "safe-bash",
            appliesTo: ["mcp:github"],
            files: [{ target: "claude", path: "hooks/claude.json" }],
            required: false,
          },
        ],
      })
    ).toThrow();
  });

  it("rejects duplicate hook ids", () => {
    expect(() =>
      samxPackageManifestSchema.parse({
        hooks: [
          {
            id: "safe-bash",
            appliesTo: ["skill:review"],
            files: [{ target: "claude", path: "hooks/claude.json" }],
            required: true,
          },
          {
            id: "safe-bash",
            appliesTo: ["agent:reviewer"],
            files: [{ target: "opencode", path: "hooks/opencode.js" }],
            required: false,
          },
        ],
      })
    ).toThrow();
  });
});

describe("indexed hook attachment schema", () => {
  it("accepts skill and agent hook attachments and defaults hooks to empty arrays", () => {
    const hook = {
      id: "safe-bash",
      packageId: "pkg",
      description: "Reject dangerous shell commands",
      tool: "claude",
      file: "hooks/claude.json",
      required: true,
      appliesTo: ["skill:review"],
    };

    expect(
      indexedSkillSchema.parse({
        id: "review",
        packageId: "pkg",
        name: "Review",
        kind: "skill",
        path: "skills/review/SKILL.md",
        hooks: [hook],
      }).hooks
    ).toEqual([hook]);

    expect(
      indexedAgentSchema.parse({
        id: "reviewer",
        packageId: "pkg",
        name: "Reviewer",
        kind: "agent",
        path: "agents/reviewer/AGENT.md",
        hooks: [{ ...hook, appliesTo: ["agent:reviewer"] }],
      }).hooks
    ).toHaveLength(1);

    expect(
      indexedSkillSchema.parse({
        id: "review",
        packageId: "pkg",
        name: "Review",
        kind: "skill",
        path: "skills/review/SKILL.md",
      }).hooks
    ).toEqual([]);

    expect(
      indexedAgentSchema.parse({
        id: "reviewer",
        packageId: "pkg",
        name: "Reviewer",
        kind: "agent",
        path: "agents/reviewer/AGENT.md",
      }).hooks
    ).toEqual([]);
  });

  it("rejects invalid appliesTo references on indexed hook attachments", () => {
    expect(() =>
      indexedSkillSchema.parse({
        id: "review",
        packageId: "pkg",
        name: "Review",
        kind: "skill",
        path: "skills/review/SKILL.md",
        hooks: [
          {
            id: "safe-bash",
            packageId: "pkg",
            tool: "claude",
            file: "hooks/claude.json",
            required: true,
            appliesTo: ["mcp:github"],
          },
        ],
      })
    ).toThrow();
  });

  it("rejects empty appliesTo on indexed hook attachments", () => {
    expect(() =>
      indexedSkillSchema.parse({
        id: "review",
        packageId: "pkg",
        name: "Review",
        kind: "skill",
        path: "skills/review/SKILL.md",
        hooks: [
          {
            id: "safe-bash",
            packageId: "pkg",
            tool: "claude",
            file: "hooks/claude.json",
            required: true,
            appliesTo: [],
          },
        ],
      })
    ).toThrow();
  });
});

describe("link record managed hooks schema", () => {
  test("parses enabled adjacent hooks on link records", () => {
    const parsed = linkRecordSchema.parse({
      id: "coding:opencode:/repo",
      bundleId: "coding",
      tool: "opencode",
      projectRoot: "/repo",
      generatedFiles: ["/repo/.opencode/plugins/review-opencode.js"],
      managedJsonEntries: [],
      managedHooks: [],
      adjacentHooks: [
        {
          id: "review-opencode",
          packageId: "pkg",
          tool: "opencode",
          sourcePath: "/samx/packages/pkg/skills/review/hooks/opencode.js",
          fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          appliesTo: ["skill:review"],
        },
      ],
      createdAt: "2026-05-17T00:00:00.000Z",
    });

    expect(parsed.adjacentHooks).toEqual([
      expect.objectContaining({ id: "review-opencode", packageId: "pkg", tool: "opencode" }),
    ]);
  });

  it("accepts managed hook metadata for link records", () => {
    expect(
      linkRecordSchema.parse({
        id: "bundle:claude:/tmp/project",
        bundleId: "bundle",
        tool: "claude",
        projectRoot: "/tmp/project",
        generatedFiles: [],
        managedJsonEntries: [],
        managedHooks: [
          {
            id: "safe-bash",
            packageId: "pkg",
            tool: "claude",
            kind: "jsonMerge",
            outputs: ["/tmp/project/.claude/settings.json"],
            sentinels: ["pkg:safe-bash:bundle:claude"],
            fingerprints: [
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ],
          },
        ],
        createdAt: "2026-05-16T00:00:00.000Z",
      }).managedHooks
    ).toHaveLength(1);
  });

  it("defaults managedHooks to an empty array", () => {
    expect(
      linkRecordSchema.parse({
        id: "bundle:claude:/tmp/project",
        bundleId: "bundle",
        tool: "claude",
        projectRoot: "/tmp/project",
        generatedFiles: [],
        managedJsonEntries: [],
        createdAt: "2026-05-16T00:00:00.000Z",
      }).managedHooks
    ).toEqual([]);
  });

  it("rejects invalid managed hook fingerprints", () => {
    expect(() =>
      linkRecordSchema.parse({
        id: "bundle:claude:/tmp/project",
        bundleId: "bundle",
        tool: "claude",
        projectRoot: "/tmp/project",
        generatedFiles: [],
        managedJsonEntries: [],
        managedHooks: [
          {
            id: "safe-bash",
            packageId: "pkg",
            tool: "claude",
            kind: "jsonMerge",
            outputs: ["/tmp/project/.claude/settings.json"],
            sentinels: ["pkg:safe-bash:bundle:claude"],
            fingerprints: [
              "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ],
          },
        ],
        createdAt: "2026-05-16T00:00:00.000Z",
      })
    ).toThrow();
  });
});
