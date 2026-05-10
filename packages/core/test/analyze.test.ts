import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  addBundleItem,
  atomicWriteJson,
  createBundle,
  runAnalyze,
  samxPaths,
  upsertLinkRecord,
} from "./internal.js";

describe("analyze aggregator", () => {
  test("reports empty SAMX state", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-analyze-empty-"));

    const report = await runAnalyze({ samxHome: root });

    expect(report.summary).toEqual({
      packages: 0,
      capabilities: 0,
      bundles: 0,
      links: 0,
      findings: 1,
      readiness: "unknown",
    });
    expect(report.findings[0]).toMatchObject({
      id: "inventory:empty",
      severity: "info",
      confidence: "low",
      recommendation: "Install a package or create a bundle before linking capabilities.",
    });
    expect(report.recommendations).toEqual(["Review warnings before relying on linked capabilities."]);
  });

  test("reports installed package capability bundle link and advisory", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-analyze-seeded-"));
    const project = await mkdtemp(join(tmpdir(), "samx-analyze-project-"));
    const packageRoot = join(root, "packages", "default", "acme", "tools");
    await mkdir(join(packageRoot, "source", "skills", "review"), { recursive: true });
    await writeFile(join(packageRoot, "source", "skills", "review", "SKILL.md"), "Review code", "utf8");
    await writeFile(join(packageRoot, "recipe.lock.json"), JSON.stringify(recipeLock()), "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "default/acme/tools:review",
          packageId: "default/acme/tools",
          kind: "skill",
          name: "review",
          path: join(packageRoot, "source", "skills", "review"),
          metadata: {},
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "default/acme/tools:review",
      kind: "skill",
    });
    await upsertLinkRecord(
      { samxHome: root },
      {
        id: "coding:opencode",
        bundleId: "coding",
        tool: "opencode",
        projectRoot: project,
        generatedFiles: [join(project, ".opencode", "skill", "review", "SKILL.md")],
        managedJsonEntries: [
          { path: join(project, ".opencode", "opencode.json"), keyPath: ["mcp"], key: "server" },
        ],
        managedTomlEntries: [{ path: join(project, ".codex", "config.toml"), tablePath: ["mcp_servers"], key: "server" }],
        managedInstructionBlocks: [
          { path: join(project, "AGENTS.md"), bundleId: "coding", tool: "codex" },
        ],
        managedHooks: [
          {
            id: "hook",
            packageId: "default/acme/tools",
            tool: "opencode",
            kind: "symlink",
            outputs: [join(project, ".opencode", "plugins", "hook.js")],
            sentinels: [],
            fingerprints: ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          },
        ],
        adjacentHooks: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      }
    );

    const report = await runAnalyze({ samxHome: root, projectRoot: project });

    expect(report.summary).toMatchObject({
      packages: 1,
      capabilities: 1,
      bundles: 1,
      links: 1,
      readiness: "needs_review",
    });
    expect(report.packages[0]?.advisories).toBe(1);
    expect(report.capabilities[0]?.name).toBe("review");
    expect(report.links[0]?.outputs).toContain(join(project, ".opencode", "opencode.json"));
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "package:default/acme/tools:advisory:0",
          recommendation: "Review package advisories before linking.",
        }),
      ])
    );
    expect(report.recommendations).toEqual([
      "Review package advisories before linking.",
      "Review warnings before relying on linked capabilities.",
    ]);
  });

  test("reports missing bundle capability item as blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-analyze-missing-"));
    await createBundle({ samxHome: root, id: "broken" });
    await addBundleItem({
      samxHome: root,
      bundleId: "broken",
      itemId: "missing:skills-review",
      kind: "skill",
    });

    const report = await runAnalyze({ samxHome: root });

    expect(report.summary.readiness).toBe("blocked");
    expect(report.bundles[0]?.missingItems).toEqual(["missing:skills-review"]);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "bundle:broken:missing:missing:skills-review",
          recommendation: "Remove the missing item or reinstall the package that provides it.",
        }),
      ])
    );
    expect(report.recommendations).toEqual([
      "Resolve blocked bundle or link issues before applying links.",
    ]);
  });

  test("project-scoped analyze ignores unrelated broken bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-analyze-project-scope-"));
    const project = await mkdtemp(join(tmpdir(), "samx-analyze-project-scope-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-review",
          packageId: "pkg",
          kind: "skill",
          name: "review",
          path: "/tmp/SKILL.md",
          metadata: {},
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });
    await createBundle({ samxHome: root, id: "broken" });
    await addBundleItem({
      samxHome: root,
      bundleId: "broken",
      itemId: "missing:skills-review",
      kind: "skill",
    });
    await upsertLinkRecord(
      { samxHome: root },
      {
        id: "coding:opencode",
        bundleId: "coding",
        tool: "opencode",
        projectRoot: project,
        generatedFiles: [join(project, ".opencode", "skill", "review", "SKILL.md")],
        managedJsonEntries: [],
        managedTomlEntries: [],
        managedInstructionBlocks: [],
        managedHooks: [],
        adjacentHooks: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      }
    );

    const report = await runAnalyze({ samxHome: root, projectRoot: project });

    expect(report.summary.readiness).toBe("ready");
    expect(report.summary.bundles).toBe(1);
    expect(report.bundles.map((bundle) => bundle.id)).toEqual(["coding"]);
    expect(report.findings.map((finding) => finding.id)).not.toContain(
      "bundle:broken:missing:missing:skills-review"
    );
  });

  test("reports stale link missing bundle check errors as blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-analyze-stale-link-"));
    const project = await mkdtemp(join(tmpdir(), "samx-analyze-stale-link-project-"));
    await upsertLinkRecord(
      { samxHome: root },
      {
        id: "missing:opencode",
        bundleId: "missing",
        tool: "opencode",
        projectRoot: project,
        generatedFiles: [join(project, ".opencode", "skill", "review", "SKILL.md")],
        managedJsonEntries: [],
        managedTomlEntries: [],
        managedInstructionBlocks: [],
        managedHooks: [],
        adjacentHooks: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      }
    );

    const report = await runAnalyze({ samxHome: root });

    expect(report.summary.readiness).toBe("blocked");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        id: "link:missing:opencode:check-error",
        severity: "high",
        status: "blocked",
      })
    );
  });
});

function recipeLock() {
  return {
    schemaVersion: 1,
    id: "default/acme/tools",
    formula: {
      registry: "default",
      path: "formulas/acme/tools.yaml",
      registryUrl: "https://example.test/default.git",
      registryCommit: "reg123",
      formulaHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    source: {
      type: "git",
      url: "https://example.test/tools.git",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    capabilities: [
      {
        id: "default/acme/tools:review",
        formulaCapabilityId: "review",
        kind: "skill",
        path: "skills/review",
      },
    ],
    advisories: [
      {
        id: "candidate-validation",
        severity: "warning",
        category: "generation",
        message: "Review generated hook inventory.",
        paths: [],
      },
    ],
  };
}
