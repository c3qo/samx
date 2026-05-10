import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  addBundleItem,
  atomicWriteJson,
  createBundle,
  linkBundle,
  runBundleCheck,
  samxPaths,
} from "./internal.js";

describe("bundle check", () => {
  test("reports ready bundle with opencode target", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-opencode-"));
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "pkg:skill",
          packageId: "pkg",
          name: "skill",
          kind: "skill",
          path: "/tmp/SKILL.md",
          metadata: { body: "body" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:skill", kind: "skill" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "ready",
      missingItems: [],
      hookBlockers: [],
      hooks: { required: 0, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [],
    });
  });

  test("reports ready bundle with claude and kiro targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-claude-kiro-"));
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "pkg:skill",
          packageId: "pkg",
          name: "skill",
          kind: "skill",
          path: "/tmp/SKILL.md",
          metadata: { body: "body" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:skill", kind: "skill" });

    for (const tool of ["claude", "kiro"] as const) {
      await expect(runBundleCheck({ samxHome: root, bundleId: "coding", tool })).resolves.toEqual({
        bundleId: "coding",
        status: "ready",
        missingItems: [],
        hookBlockers: [],
        hooks: { required: 0, optional: 0 },
        hookCandidates: [],
        enabledAdjacentHooks: [],
        warnings: [],
      });
    }
  });

  test("reports missing indexed skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-missing-"));
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:missing",
      kind: "skill",
    });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "blocked",
      missingItems: ["pkg:missing"],
      hookBlockers: [],
      hooks: { required: 0, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [],
    });
  });

  test("reports missing indexed skills with opencode target", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-opencode-missing-"));
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:missing",
      kind: "skill",
    });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "blocked",
      missingItems: ["pkg:missing"],
      hookBlockers: [],
      hooks: { required: 0, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [],
    });
  });

  test("rejects unsupported target", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-target-"));
    await createBundle({ samxHome: root, id: "coding" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "cursor" as "generic-markdown" })
    ).rejects.toThrow("Unsupported link target: cursor");
  });

  test("reports ready mixed capability bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-agent-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:agent",
          packageId: "pkg",
          name: "agent",
          kind: "agent",
          path: "/tmp/AGENT.md",
          metadata: { body: "body" },
        },
        {
          id: "pkg:mcp",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          config: { command: "npx" },
          metadata: {},
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:agent", kind: "agent" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:mcp", kind: "mcp" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "ready",
      missingItems: [],
      hookBlockers: [],
      hooks: { required: 0, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [],
    });
  });

  test("reports env reminders without blocking bundle readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-env-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-bundle-check-env-package-"));
    await mkdir(join(packageRoot, "skills", "review"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await indexFormulaFixture(
      root,
      "pkg",
      packageRoot,
      [
        {
          id: "pkg:skills-review",
          name: "review",
          kind: "skill",
          path: join(packageRoot, "skills", "review"),
          metadata: { body: "# Review\n" },
          hooks: [],
        },
      ],
      false,
      { env: ["ANTHROPIC_API_KEY"] }
    );
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    const report = await runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" });

    expect(report.status).toBe("ready");
    expect(report.environmentReminders).toEqual([{ packageId: "pkg", env: ["ANTHROPIC_API_KEY"] }]);
  });

  test("reports relevant adjacent hook candidates as off", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-adjacent-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-bundle-check-adjacent-package-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default {}\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot, [
      {
        id: "pkg:skills-review",
        name: "review",
        kind: "skill",
        path: join(packageRoot, "skills", "review"),
        metadata: { body: "# Review\n" },
        hooks: [],
      },
    ]);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    const report = await runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" });

    expect(report.status).toBe("ready");
    expect(report.hookCandidates).toEqual([
      expect.objectContaining({ packageId: "pkg", id: "review-opencode" }),
    ]);
  });

  test("reports mcp-only top-level hook skip warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-mcp-only-hook-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-bundle-check-mcp-only-hook-package-"));
    await mkdir(join(packageRoot, "mcp", "github"), { recursive: true });
    await mkdir(join(packageRoot, "hooks"), { recursive: true });
    await writeFile(
      join(packageRoot, "mcp", "github", "mcp.json"),
      JSON.stringify({ mcpServers: { github: { command: "node" } } }),
      "utf8"
    );
    await writeFile(join(packageRoot, "hooks", "safe-bash.js"), "export default {}\n", "utf8");
    await indexFormulaFixture(root, "pkg", packageRoot, [
      {
        id: "pkg:mcp-github",
        name: "github",
        kind: "mcp",
        path: join(packageRoot, "mcp", "github", "mcp.json"),
        serverName: "github",
        config: { command: "node" },
      },
    ]);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    const report = await runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" });

    expect(report.hookWarnings ?? []).toEqual([
      expect.stringContaining("Top-level hook skipped: hooks/safe-bash.js"),
    ]);
  });

  test("reports mcp-only opencode plugin hook skip warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-mcp-only-plugin-hook-"));
    const packageRoot = await mkdtemp(
      join(tmpdir(), "samx-bundle-check-mcp-only-plugin-hook-package-")
    );
    await mkdir(join(packageRoot, "mcp", "github"), { recursive: true });
    await mkdir(join(packageRoot, ".opencode", "plugins"), { recursive: true });
    await writeFile(
      join(packageRoot, "mcp", "github", "mcp.json"),
      JSON.stringify({ mcpServers: { github: { command: "node" } } }),
      "utf8"
    );
    await writeFile(
      join(packageRoot, ".opencode", "plugins", "superpowers.js"),
      "export default {}\n",
      "utf8"
    );
    await indexFormulaFixture(root, "superpowers", packageRoot, [
      {
        id: "superpowers:mcp-github",
        name: "github",
        kind: "mcp",
        path: join(packageRoot, "mcp", "github", "mcp.json"),
        serverName: "github",
        config: { command: "node" },
      },
    ]);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:mcp-github",
      kind: "mcp",
    });

    const report = await runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" });

    expect(report.hookWarnings ?? []).toEqual([
      expect.stringContaining("Top-level hook skipped: .opencode/plugins/superpowers.js"),
    ]);
  });

  test("filters adjacent hook candidates by selected tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-adjacent-tool-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-bundle-check-adjacent-tool-package-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default {}\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot, [
      {
        id: "pkg:skills-review",
        name: "review",
        kind: "skill",
        path: join(packageRoot, "skills", "review"),
        metadata: { body: "# Review\n" },
        hooks: [],
      },
    ]);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    const opencodeReport = await runBundleCheck({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
    });
    const claudeReport = await runBundleCheck({
      samxHome: root,
      bundleId: "coding",
      tool: "claude",
    });

    expect(opencodeReport.hookCandidates).toEqual([
      expect.objectContaining({ packageId: "pkg", id: "review-opencode", tool: "opencode" }),
    ]);
    expect(claudeReport.hookCandidates).toEqual([]);
  });

  test("filters adjacent hook candidates by selected package", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-adjacent-package-scope-"));
    const packageRootA = await mkdtemp(join(tmpdir(), "samx-bundle-check-adjacent-package-a-"));
    const packageRootB = await mkdtemp(join(tmpdir(), "samx-bundle-check-adjacent-package-b-"));
    for (const packageRoot of [packageRootA, packageRootB]) {
      await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
      await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
      await writeFile(
        join(packageRoot, "skills", "review", "hooks", "opencode.js"),
        "export default {}\n",
        "utf8"
      );
    }
    await indexFormulaFixture(root, "pkg-a", packageRootA, [
      {
        id: "pkg-a:skills-review",
        name: "review",
        kind: "skill",
        path: join(packageRootA, "skills", "review"),
        metadata: { body: "# Review\n" },
        hooks: [],
      },
    ]);
    await indexFormulaFixture(
      root,
      "pkg-b",
      packageRootB,
      [
        {
          id: "pkg-b:skills-review",
          name: "review",
          kind: "skill",
          path: join(packageRootB, "skills", "review"),
          metadata: { body: "# Review\n" },
          hooks: [],
        },
      ],
      true
    );
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg-a:skills-review",
      kind: "skill",
    });

    const report = await runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" });

    expect(report.hookCandidates).toEqual([
      expect.objectContaining({ packageId: "pkg-a", id: "review-opencode" }),
    ]);
  });

  test("reports enabled opencode adjacent hook source drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-check-opencode-drift-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-check-opencode-drift-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-check-opencode-drift-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default { before: true }\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot, [
      {
        id: "pkg:skills-review",
        name: "review",
        kind: "skill",
        path: join(packageRoot, "skills", "review"),
        metadata: { body: "# Review\n" },
        hooks: [],
      },
    ]);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });
    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      adjacentHooks: { mode: "all" },
    });
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default { after: true }\n",
      "utf8"
    );

    const report = await runBundleCheck({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
    });

    expect(report.enabledAdjacentHooks).toEqual([
      expect.objectContaining({ packageId: "pkg", id: "review-opencode", drift: true }),
    ]);
    expect(report.warnings.join("\n")).toContain("Enabled OpenCode hook source changed");
  });

  test("continues when matching link record is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-check-link-records-malformed-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-check-link-records-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "pkg:skill",
          packageId: "pkg",
          name: "skill",
          kind: "skill",
          path: "/tmp/SKILL.md",
          metadata: { body: "body" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:skill", kind: "skill" });
    await mkdir(join(root, "links"), { recursive: true });
    await writeFile(
      samxPaths(root).linkRecords,
      JSON.stringify({ links: [{ id: `coding:opencode:${projectRoot}` }] }),
      "utf8"
    );

    const report = await runBundleCheck({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
    });

    expect(report.status).toBe("ready");
    expect(report.enabledAdjacentHooks).toEqual([]);
    expect(report.warnings).toEqual([
      expect.stringContaining("Could not read link records for bundle check:"),
    ]);
  });

  test("reports enabled opencode adjacent hook without drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-check-opencode-no-drift-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-check-opencode-no-drift-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-check-opencode-no-drift-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default { ok: true }\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot, [
      {
        id: "pkg:skills-review",
        name: "review",
        kind: "skill",
        path: join(packageRoot, "skills", "review"),
        metadata: { body: "# Review\n" },
        hooks: [],
      },
    ]);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });
    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      adjacentHooks: { mode: "all" },
    });

    const report = await runBundleCheck({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
    });

    expect(report.enabledAdjacentHooks).toEqual([
      expect.objectContaining({ packageId: "pkg", id: "review-opencode", drift: false }),
    ]);
    expect(report.warnings.join("\n")).not.toContain("Enabled OpenCode hook source changed");
  });

  test("reads matching link record when unrelated records are malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-check-link-records-mixed-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-check-link-records-mixed-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-check-link-records-mixed-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default { ok: true }\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot, [
      {
        id: "pkg:skills-review",
        name: "review",
        kind: "skill",
        path: join(packageRoot, "skills", "review"),
        metadata: { body: "# Review\n" },
        hooks: [],
      },
    ]);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });
    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      adjacentHooks: { mode: "all" },
    });
    const records = JSON.parse(await readFile(samxPaths(root).linkRecords, "utf8"));
    await writeFile(
      samxPaths(root).linkRecords,
      JSON.stringify({ links: [{ id: "broken" }, records.links[0]] }),
      "utf8"
    );

    const report = await runBundleCheck({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
    });

    expect(report.enabledAdjacentHooks).toEqual([
      expect.objectContaining({ packageId: "pkg", id: "review-opencode", drift: false }),
    ]);
    expect(report.warnings).toEqual([]);
  });

  test("reports kind mismatches without generic-markdown guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-opencode-agent-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:item",
          packageId: "pkg",
          name: "item",
          kind: "agent",
          path: "/tmp/AGENT.md",
          metadata: { body: "body" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:item", kind: "skill" });

    const report = await runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" });

    expect(report).toEqual({
      bundleId: "coding",
      status: "ready",
      missingItems: [],
      hookBlockers: [],
      hooks: { required: 0, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: ["Bundle item kind mismatch: pkg:item (skill != agent)"],
    });
    expect(report.warnings.join("\n")).not.toContain("generic-markdown");
  });

  test("blocks required missing hook file", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-required-hook-"));
    const missingHook = join(root, "package", "hooks", "missing.js");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skill",
          packageId: "pkg",
          name: "skill",
          kind: "skill",
          path: "/tmp/SKILL.md",
          metadata: { body: "body" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "opencode",
              file: missingHook,
              required: true,
              appliesTo: ["skill:skill"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:skill", kind: "skill" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "blocked",
      missingItems: [],
      hookBlockers: ["Required hook file missing: safe-bash (opencode)"],
      hooks: { required: 1, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [],
    });
  });

  test("keeps optional missing hook file ready with warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-optional-hook-"));
    const missingHook = join(root, "package", "hooks", "missing.js");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:agent",
          packageId: "pkg",
          name: "agent",
          kind: "agent",
          path: "/tmp/AGENT.md",
          metadata: { body: "body" },
          hooks: [
            {
              id: "nice-to-have",
              packageId: "pkg",
              tool: "opencode",
              file: missingHook,
              required: false,
              appliesTo: ["agent:agent"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:agent", kind: "agent" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "ready",
      missingItems: [],
      hookBlockers: [],
      hooks: { required: 0, optional: 1 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: ["Optional hook file missing: nice-to-have (opencode)"],
    });
  });

  test("counts duplicate hook attachments once", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-duplicate-hook-"));
    const hookFile = join(root, "package", "hooks", "safe-bash.js");
    await mkdir(join(root, "package", "hooks"), { recursive: true });
    await writeFile(hookFile, "export const plugin = {}\n", "utf8");
    const hook = {
      id: "safe-bash",
      packageId: "pkg",
      tool: "opencode",
      file: hookFile,
      required: true,
      appliesTo: ["skill:one"],
    };
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:one",
          packageId: "pkg",
          name: "one",
          kind: "skill",
          path: "/tmp/one/SKILL.md",
          metadata: { body: "body" },
          hooks: [hook],
        },
        {
          id: "pkg:two",
          packageId: "pkg",
          name: "two",
          kind: "skill",
          path: "/tmp/two/SKILL.md",
          metadata: { body: "body" },
          hooks: [hook],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:one", kind: "skill" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:two", kind: "skill" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "ready",
      missingItems: [],
      hookBlockers: [],
      hooks: { required: 1, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [],
    });
  });

  test("blocks required hooks when selected target has no hook support", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-unsupported-hook-"));
    const hookFile = join(root, "package", "hooks", "safe-bash.js");
    await mkdir(join(root, "package", "hooks"), { recursive: true });
    await writeFile(hookFile, "export const plugin = {}\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skill",
          packageId: "pkg",
          name: "skill",
          kind: "skill",
          path: "/tmp/SKILL.md",
          metadata: { body: "body" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "opencode",
              file: hookFile,
              required: true,
              appliesTo: ["skill:skill"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:skill", kind: "skill" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "kiro" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "blocked",
      missingItems: [],
      hookBlockers: ["Required hook target unsupported: safe-bash (kiro)"],
      hooks: { required: 1, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [],
    });
  });

  test("blocks required hook with disallowed extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-required-extension-"));
    const hookFile = join(root, "package", "hooks", "safe-bash.ts");
    await mkdir(join(root, "package", "hooks"), { recursive: true });
    await writeFile(hookFile, "export const plugin = {}\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skill",
          packageId: "pkg",
          name: "skill",
          kind: "skill",
          path: "/tmp/SKILL.md",
          metadata: { body: "body" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "opencode",
              file: hookFile,
              required: true,
              appliesTo: ["skill:skill"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:skill", kind: "skill" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "blocked",
      missingItems: [],
      hookBlockers: ["Required hook file extension unsupported: safe-bash (opencode)"],
      hooks: { required: 1, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [],
    });
  });

  test("keeps optional hook with disallowed extension ready with warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-optional-extension-"));
    const hookFile = join(root, "package", "hooks", "nice-to-have.ts");
    await mkdir(join(root, "package", "hooks"), { recursive: true });
    await writeFile(hookFile, "export const plugin = {}\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:agent",
          packageId: "pkg",
          name: "agent",
          kind: "agent",
          path: "/tmp/AGENT.md",
          metadata: { body: "body" },
          hooks: [
            {
              id: "nice-to-have",
              packageId: "pkg",
              tool: "opencode",
              file: hookFile,
              required: false,
              appliesTo: ["agent:agent"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:agent", kind: "agent" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "opencode" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "ready",
      missingItems: [],
      hookBlockers: [],
      hooks: { required: 0, optional: 1 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: ["Optional hook file extension unsupported: nice-to-have (opencode)"],
    });
  });

  test("blocks required Claude hook file with invalid top-level shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-claude-invalid-"));
    const hookFile = join(root, "package", "hooks", "safe-bash.json");
    await mkdir(join(root, "package", "hooks"), { recursive: true });
    await writeFile(hookFile, JSON.stringify({ notHooks: [] }), "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skill",
          packageId: "pkg",
          name: "skill",
          kind: "skill",
          path: "/tmp/SKILL.md",
          metadata: { body: "body" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "claude",
              file: hookFile,
              required: true,
              appliesTo: ["skill:skill"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:skill", kind: "skill" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "claude" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "blocked",
      missingItems: [],
      hookBlockers: [
        "Required hook invalid: safe-bash (claude): Invalid Claude hooks: expected { hooks: { event: group[] } }",
      ],
      hooks: { required: 1, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [],
    });
  });

  test("blocks required Claude hook file with malformed event shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-claude-malformed-required-"));
    const hookFile = join(root, "package", "hooks", "safe-bash.json");
    await mkdir(join(root, "package", "hooks"), { recursive: true });
    await writeFile(hookFile, JSON.stringify({ hooks: { PreToolUse: {} } }), "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skill",
          packageId: "pkg",
          name: "skill",
          kind: "skill",
          path: "/tmp/SKILL.md",
          metadata: { body: "body" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "claude",
              file: hookFile,
              required: true,
              appliesTo: ["skill:skill"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:skill", kind: "skill" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "claude" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "blocked",
      missingItems: [],
      hookBlockers: [
        "Required hook invalid: safe-bash (claude): Invalid Claude hooks: event PreToolUse must be a group[]",
      ],
      hooks: { required: 1, optional: 0 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [],
    });
  });

  test("keeps optional Claude hook file with malformed group shape ready with warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-claude-malformed-optional-"));
    const hookFile = join(root, "package", "hooks", "nice-to-have.json");
    await mkdir(join(root, "package", "hooks"), { recursive: true });
    await writeFile(
      hookFile,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash" }] } }),
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:agent",
          packageId: "pkg",
          name: "agent",
          kind: "agent",
          path: "/tmp/AGENT.md",
          metadata: { body: "body" },
          hooks: [
            {
              id: "nice-to-have",
              packageId: "pkg",
              tool: "claude",
              file: hookFile,
              required: false,
              appliesTo: ["agent:agent"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:agent", kind: "agent" });

    await expect(
      runBundleCheck({ samxHome: root, bundleId: "coding", tool: "claude" })
    ).resolves.toEqual({
      bundleId: "coding",
      status: "ready",
      missingItems: [],
      hookBlockers: [],
      hooks: { required: 0, optional: 1 },
      hookCandidates: [],
      enabledAdjacentHooks: [],
      warnings: [
        "Optional hook invalid: nice-to-have (claude): Invalid Claude hooks: event PreToolUse group 0 must contain hooks[]",
      ],
    });
  });

  test("reports invalid Claude hook JSON syntax details", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-check-claude-syntax-"));
    const hookFile = join(root, "package", "hooks", "safe-bash.json");
    await mkdir(join(root, "package", "hooks"), { recursive: true });
    await writeFile(hookFile, "{not json", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skill",
          packageId: "pkg",
          name: "skill",
          kind: "skill",
          path: "/tmp/SKILL.md",
          metadata: { body: "body" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "claude",
              file: hookFile,
              required: true,
              appliesTo: ["skill:skill"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:skill", kind: "skill" });

    const report = await runBundleCheck({ samxHome: root, bundleId: "coding", tool: "claude" });

    expect(report.status).toBe("blocked");
    expect(report.hookBlockers[0]).toContain("Required hook invalid: safe-bash (claude):");
    expect(report.hookBlockers[0]).not.toContain(hookFile);
    expect(report.hookBlockers[0]).toMatch(/JSON|Expected|property name|Unexpected/u);
  });
});

async function indexFormulaFixture(
  root: string,
  packageId: string,
  packageRoot: string,
  capabilities: Array<Record<string, unknown>>,
  append = false,
  requirements?: { env: string[] }
): Promise<void> {
  const [registry = "fixtures", formula = packageId] = packageId.includes("/")
    ? packageId.split("/")
    : ["fixtures", packageId];
  await mkdir(join(root, "packages", registry, formula), { recursive: true });
  await symlink(packageRoot, join(root, "packages", registry, formula, "source"));
  await atomicWriteJson(samxPaths(root).recipeLock(registry, formula), {
    schemaVersion: 1,
    id: packageId,
    formula: {
      registry,
      path: `formulas/${formula}.yaml`,
      registryUrl: "https://example.test/fixtures.git",
      registryCommit: "reg123",
      formulaHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    source: {
      type: "git",
      url: "https://example.test/fixture.git",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    capabilities: [
      {
        id: `${packageId}:fixture`,
        formulaCapabilityId: "fixture",
        kind: "skill",
        path: "skills/fixture",
      },
    ],
    ...(requirements ? { requirements } : {}),
  });
  let existing: Array<Record<string, unknown>> = [];
  if (append) {
    try {
      existing = JSON.parse(await readFile(samxPaths(root).index, "utf8")).capabilities ?? [];
    } catch {}
  }
  await atomicWriteJson(samxPaths(root).index, {
    capabilities: [
      ...existing,
      ...capabilities.map((capability) => ({ packageId, ...capability })),
    ],
  });
}
