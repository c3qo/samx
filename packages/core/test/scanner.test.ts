import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createConfigRegistry, scanForExtensionFiles } from "./internal.js";

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

async function makeTempWorkspace() {
  return mkdtemp(join(tmpdir(), "samx-scanner-"));
}

async function touch(filePath: string) {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, "content");
}

function relativeList(root: string, files: string[]) {
  return files.map((file) => relative(root, file)).sort();
}

describe("scanForExtensionFiles", () => {
  test("uses injected plugin scan patterns", async () => {
    const cwd = await makeTempWorkspace();
    await touch(join(cwd, ".exampleai", "rules", "review.md"));
    await touch(join(cwd, ".claude", "skills", "ignored", "SKILL.md"));
    const registry = createConfigRegistry([
      {
        id: "exampleai",
        name: "ExampleAI",
        version: 1,
        description: "ExampleAI test pack.",
        rules: {
          scan: { project: [".exampleai/rules/**/*.md"], home: [], ignoredDirectories: [] },
          classify: [],
          groups: [],
          parse: {
            markdownFrontmatterKinds: [],
            mcpJsonKinds: [],
            profileKinds: [],
            packageJsonKinds: [],
          },
          inference: {
            commands: [],
            env: [],
            filesystem: [],
            shellRisks: [],
            broadMcpFilesystemRoots: [],
            networkCommands: [],
          },
          probes: { safeCommands: [] },
        },
      },
    ]);

    const files = await scanForExtensionFiles({ cwd, registry });

    expect(relativeList(cwd, files)).toEqual([".exampleai/rules/review.md"]);
  });

  test("project scope finds local AI config files without home paths", async () => {
    const cwd = await makeTempWorkspace();
    const homeDir = await makeTempWorkspace();

    await touch(join(cwd, ".claude", "skills", "review", "SKILL.md"));
    await touch(join(cwd, "CLAUDE.md"));
    await touch(join(cwd, "AGENTS.md"));
    await touch(join(cwd, ".cursor", "rules", "security.mdc"));
    await touch(join(cwd, ".cursor", "mcp.json"));
    await touch(join(cwd, ".opencode", "agents", "helper.md"));
    await touch(join(cwd, "mcp.json"));
    await touch(join(homeDir, ".claude", "CLAUDE.md"));

    const files = await scanForExtensionFiles({ cwd, homeDir });

    expect(relativeList(cwd, files)).toEqual([
      ".claude/skills/review/SKILL.md",
      ".cursor/mcp.json",
      ".cursor/rules/security.mdc",
      ".opencode/agents/helper.md",
      "AGENTS.md",
      "CLAUDE.md",
      "mcp.json",
    ]);
    expect(files.some((file) => file.startsWith(homeDir))).toBe(false);
  });

  test("project scope includes package bundles but skips ordinary package manifests", async () => {
    const cwd = await makeTempWorkspace();

    await writeFile(join(cwd, "package.json"), '{"name":"workspace"}');
    await expect(scanForExtensionFiles({ cwd })).resolves.toEqual([]);

    await writeFile(join(cwd, "package.json"), '{"name":"workspace","bin":{"workspace":"cli.js"}}');

    expect(relativeList(cwd, await scanForExtensionFiles({ cwd }))).toEqual(["package.json"]);
  });

  test("home and all scopes opt into home-level AI config paths", async () => {
    const cwd = await makeTempWorkspace();
    const homeDir = await makeTempWorkspace();

    await touch(join(cwd, "CLAUDE.md"));
    await touch(join(homeDir, ".claude", "skills", "home-skill", "SKILL.md"));
    await touch(join(homeDir, ".claude", "CLAUDE.md"));
    await touch(join(homeDir, ".cursor", "rules", "home-rule.mdc"));
    await touch(join(homeDir, ".cursor", "mcp.json"));
    await touch(join(homeDir, ".config", "opencode", "agents", "helper.md"));
    await touch(join(homeDir, "mcp.json"));

    const homeFiles = await scanForExtensionFiles({ cwd, homeDir, scope: "home" });
    const allFiles = await scanForExtensionFiles({ cwd, homeDir, scope: "all" });

    expect(relativeList(homeDir, homeFiles)).toEqual([
      ".claude/CLAUDE.md",
      ".claude/skills/home-skill/SKILL.md",
      ".config/opencode/agents/helper.md",
      ".cursor/mcp.json",
      ".cursor/rules/home-rule.mdc",
      "mcp.json",
    ]);
    expect(allFiles).toEqual(
      expect.arrayContaining([
        join(cwd, "CLAUDE.md"),
        join(homeDir, ".claude", "CLAUDE.md"),
        join(homeDir, ".claude", "skills", "home-skill", "SKILL.md"),
        join(homeDir, ".config", "opencode", "agents", "helper.md"),
        join(homeDir, ".cursor", "mcp.json"),
        join(homeDir, ".cursor", "rules", "home-rule.mdc"),
        join(homeDir, "mcp.json"),
      ])
    );
  });

  test("explicit path scans only that path", async () => {
    const cwd = await makeTempWorkspace();
    const selected = join(cwd, "selected");

    await touch(join(cwd, "CLAUDE.md"));
    await touch(join(selected, ".claude", "skills", "selected-skill", "SKILL.md"));
    await touch(join(cwd, "other", ".claude", "skills", "other-skill", "SKILL.md"));

    const files = await scanForExtensionFiles({ cwd, explicitPath: selected });

    expect(relativeList(selected, files)).toEqual([".claude/skills/selected-skill/SKILL.md"]);
  });

  test("ignores dependencies, git metadata, caches, and generated outputs", async () => {
    const cwd = await makeTempWorkspace();

    await touch(join(cwd, ".claude", "skills", "kept", "SKILL.md"));
    await touch(join(cwd, "node_modules", "pkg", "SKILL.md"));
    await touch(join(cwd, ".git", "hooks", "SKILL.md"));
    await touch(join(cwd, ".pnpm-store", "pkg", "SKILL.md"));
    await touch(join(cwd, "dist", "generated", "SKILL.md"));
    await touch(join(cwd, "coverage", "generated", "SKILL.md"));

    const files = await scanForExtensionFiles({ cwd });

    expect(relativeList(cwd, files)).toEqual([".claude/skills/kept/SKILL.md"]);
  });

  test("does not follow symlinked directories outside the scan root", async () => {
    const cwd = await makeTempWorkspace();
    const outside = await makeTempWorkspace();

    await touch(join(cwd, ".claude", "skills", "kept", "SKILL.md"));
    await touch(join(outside, "escaped", "SKILL.md"));
    await mkdir(join(cwd, ".claude", "skills"), { recursive: true });
    await symlink(join(outside, "escaped"), join(cwd, ".claude", "skills", "escaped"), "dir");

    const files = await scanForExtensionFiles({ cwd });

    expect(relativeList(cwd, files)).toEqual([".claude/skills/kept/SKILL.md"]);
    expect(files.some((file) => file.startsWith(outside))).toBe(false);
  });

  test("skips matched paths that disappear before containment checks finish", async () => {
    const cwd = await makeTempWorkspace();
    const flakyFile = join(cwd, ".claude", "skills", "flaky", "SKILL.md");

    await touch(join(cwd, ".claude", "skills", "kept", "SKILL.md"));
    await touch(flakyFile);

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        async realpath(path: string | Buffer | URL) {
          if (String(path) === flakyFile)
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return actual.realpath(path);
        },
      };
    });

    const { scanForExtensionFiles: scanWithFlakyRealpath } = await import("../src/scanner.js");

    const files = await scanWithFlakyRealpath({ cwd });

    expect(relativeList(cwd, files)).toEqual([".claude/skills/kept/SKILL.md"]);
  });
});
