import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import { runCli } from "../src/index.js";
import type { CliRuntimeOptions } from "../src/index.js";

async function fixtureProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "samx-cli-"));
  await writeFile(
    join(project, "CLAUDE.md"),
    "# Claude Instructions\n\nUse pnpm for tests.\n",
    "utf8"
  );
  await writeFile(
    join(project, "agent-scan.json"),
    JSON.stringify({
      findings: [
        {
          id: "unsafe-shell",
          severity: "high",
          title: "Unsafe shell command",
          message: "Shell command needs review",
          extensionId: "claude",
          file: "CLAUDE.md",
        },
      ],
    }),
    "utf8"
  );
  return project;
}

async function run(
  args: string[],
  options: { cwd?: string; homeDir?: string; isTty?: boolean; env?: NodeJS.ProcessEnv } = {}
) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    cwd: options.cwd ?? (await fixtureProject()),
    homeDir: options.homeDir,
    env: options.env ?? {},
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    probeRunner: async () => ({ exitCode: 0 }),
    isTty: options.isTty,
  });

  return { exitCode, stdout, stderr };
}

async function seededSamxHome(): Promise<{ samxHome: string; project: string; packageRoot: string; capabilityRoot: string; output: string }> {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
  const project = await mkdtemp(join(tmpdir(), "samx-cli-project-"));
  const packageRoot = join(samxHome, "packages", "default", "acme", "tools");
  const sourceRoot = join(packageRoot, "source");
  const capabilityRoot = join(sourceRoot, "skills", "review");
  const output = join(project, ".opencode", "skill", "review", "SKILL.md");
  await mkdir(capabilityRoot, { recursive: true });
  await mkdir(join(samxHome, "bundles"), { recursive: true });
  await mkdir(join(samxHome, "links"), { recursive: true });
  await writeFile(join(capabilityRoot, "SKILL.md"), "Review code", "utf8");
  await writeFile(join(packageRoot, "recipe.lock.json"), JSON.stringify(recipeLock()), "utf8");
  await writeFile(
    join(samxHome, "capabilities.json"),
    JSON.stringify({
      capabilities: [
        {
          id: "default/acme/tools:review",
          registry: "default",
          formula: "acme/tools",
          package: "default/acme/tools",
          kind: "skill",
          path: capabilityRoot,
          description: "Review code",
        },
      ],
    }),
    "utf8"
  );
  await writeFile(
    join(samxHome, "bundles", "coding.yaml"),
    "id: coding\nitems:\n  - id: default/acme/tools:review\n    kind: skill\n",
    "utf8"
  );
  await writeFile(
    join(samxHome, "links", "project-links.json"),
    JSON.stringify({
      links: [
        {
          id: "coding:opencode",
          bundleId: "coding",
          tool: "opencode",
          projectRoot: project,
          generatedFiles: [output],
          managedJsonEntries: [{ path: join(project, ".opencode", "opencode.json"), keyPath: ["mcp"], key: "server" }],
          managedTomlEntries: [],
          managedInstructionBlocks: [],
          managedHooks: [],
          adjacentHooks: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
    "utf8"
  );
  return { samxHome, project, packageRoot: sourceRoot, capabilityRoot, output };
}

async function runWithUpdateNotifier(
  args: string[],
  updateNotifier: NonNullable<CliRuntimeOptions["updateNotifier"]>,
  options: { env?: NodeJS.ProcessEnv } = {}
) {
  let stdout = "";
  let stderr = "";
  const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
  const exitCode = await runCli(args, {
    cwd: await fixtureProject(),
    env: { ...options.env, SAMX_HOME: options.env?.SAMX_HOME ?? samxHome },
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    probeRunner: async () => ({ exitCode: 0 }),
    updateNotifier,
  });

  return { exitCode, stdout, stderr };
}

test("top-level help lists current commands only", async () => {
  const result = await run(["--help"]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("analyze [projectRoot]");
  expect(result.stdout).toContain("registry <command>");
  expect(result.stdout).toContain("search <query>");
  expect(result.stdout).not.toContain("show <formula>");
  expect(result.stdout).toContain("pkg <command>");
  expect(result.stdout).toContain("capability <command>");
  expect(result.stdout).toContain("bundle <command>");
  expect(result.stdout).toContain("add <formula | capability-id>");
  expect(result.stdout).toContain("remove <capability-id | alias>");
  expect(result.stdout).toContain("link <bundle-id>");
  expect(result.stdout).toContain("unlink <bundle-id>");
  expect(result.stdout).toContain("tui");
  expect(result.stdout).not.toContain("export [path]");
});

test("prints package version", async () => {
  const result = await run(["--version"]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe(`${packageJson.version}\n`);
  expect(result.stderr).toBe("");
});

test("prints update notice to stderr without polluting json stdout", async () => {
  const result = await runWithUpdateNotifier(["analyze", "--json"], () => ({
    update: { current: "0.2.0", latest: "0.2.3" },
  }));

  expect(result.exitCode, result.stderr).toBe(0);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  expect(result.stderr).toContain("Update available: @c3qo/samx 0.2.0 -> 0.2.3");
  expect(result.stderr).toContain("Run npm install -g @c3qo/samx to update.");
});

test("skips update checks from env and flag", async () => {
  let checks = 0;
  const updateNotifier = () => {
    checks += 1;
    return { update: { current: "0.2.0", latest: "0.2.3" } };
  };

  const ci = await runWithUpdateNotifier(["analyze"], updateNotifier, { env: { CI: "true" } });
  const env = await runWithUpdateNotifier(["analyze"], updateNotifier, {
    env: { SAMX_NO_UPDATE_CHECK: "1" },
  });
  const flag = await runWithUpdateNotifier(["analyze", "--no-update-check"], updateNotifier);

  expect(ci.exitCode, ci.stderr).toBe(0);
  expect(env.exitCode, env.stderr).toBe(0);
  expect(flag.exitCode, flag.stderr).toBe(0);
  expect(checks).toBe(0);
});

test("ignores update notifier failures", async () => {
  const result = await runWithUpdateNotifier(["analyze"], () => {
    throw new Error("registry unavailable");
  });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("SAMX Analyze Report");
  expect(result.stderr).not.toContain("registry unavailable");
});

test("command help explains subcommands and required arguments", async () => {
  const pkg = await run(["pkg", "--help"]);
  const pkgInstall = await run(["pkg", "install", "--help"]);
  const pkgUninstall = await run(["pkg", "uninstall", "--help"]);
  const registry = await run(["registry", "--help"]);
  const registryAdd = await run(["registry", "add", "--help"]);
  const registryRemove = await run(["registry", "remove", "--help"]);
  const search = await run(["search", "--help"]);
  const formula = await run(["formula", "--help"]);
  const formulaShow = await run(["formula", "show", "--help"]);
  const capability = await run(["capability", "--help"]);
  const bundle = await run(["bundle", "--help"]);
  const bundleCheck = await run(["bundle", "check", "--help"]);
  const link = await run(["link", "--help"]);
  const unlink = await run(["unlink", "--help"]);
  const tui = await run(["tui", "--help"]);
  const analyze = await run(["analyze", "--help"]);

  expect(pkg.stdout).toContain("pkg install <formula>");
  expect(pkg.stdout).toContain("pkg update [formula]");
  expect(pkgInstall.stdout).toContain("samx pkg install --local <local-package-id> <path>");
  expect(pkgInstall.stdout).toContain("formula            Formula id, for example example/safe-bash");
  expect(pkgInstall.stdout).toContain("local-package-id   Local package id");
  expect(pkgInstall.stdout).toContain("samx pkg install example/safe-bash --head --ref main");
  expect(pkgInstall.stdout).not.toContain("default/example/safe-bash");
  expect(pkg.stdout).toContain("pkg install --local <local-package-id> <path>");
  expect(pkg.stdout).toContain("pkg uninstall <package-id>");
  expect(pkgUninstall.stdout).toContain("samx pkg uninstall <package-id>");
  expect(registry.stdout).toContain("registry add <registry-id> <url>");
  expect(registry.stdout).toContain("registry trust <registry-id>");
  expect(registry.stdout).toContain("registry sync [registry-id]");
  expect(registry.stdout).toContain("registry remove <registry-id>");
  expect(registryAdd.stdout).toContain("samx registry add <registry-id> <url>");
  expect(registryAdd.stdout).toContain("--no-clone");
  expect(registryRemove.stdout).toContain("samx registry remove <registry-id>");
  expect(registryRemove.stdout).toContain("--force");
  expect(search.stdout).toContain("samx search <query>");
  expect(formula.stdout).toContain("formula show <formula>");
  expect(formulaShow.stdout).toContain("samx formula show <formula>");
  expect(capability.stdout).toContain("capability list");
  expect(capability.stdout).toContain("optionally by --type");
  expect(capability.stdout).toContain("capability show <capability-id>");
  expect(bundle.stdout).toContain("bundle create <bundle-id>");
  expect(bundle.stdout).toContain("bundle add <bundle-id> <capability-id>");
  expect(bundle.stdout).toContain("bundle remove <bundle-id> <capability-id>");
  expect(bundle.stdout).toContain("bundle destroy <bundle-id>");
  expect(bundle.stdout).toContain("bundle show <bundle-id>");
  expect(bundle.stdout).not.toContain("bundle export <bundle-id>");
  expect(bundle.stdout).toContain("bundle check <bundle-id> --tool <tool>");
  expect(bundleCheck.stdout).toContain("Required. One of: claude, codex, opencode, kiro");
  expect(link.stdout).toContain("samx link <bundle-id> --tool <tool>");
  expect(link.stdout).toContain("Required. One of: claude, codex, opencode, kiro");
  expect(link.stdout).toContain("--allow-advisories");
  expect(unlink.stdout).toContain("samx unlink <bundle-id> --tool <tool>");
  expect(tui.stdout).toContain("samx tui");
  expect(tui.stdout).toContain("Requires an interactive TTY");
  expect(analyze.stdout).toContain("--show <item-id>");
  expect(analyze.stdout).toContain("--format <format>");
  expect(analyze.stdout).toContain("Supported: json, markdown");
  expect((await run(["formula", "generate", "--help"])).stdout).not.toContain("--allow-advisories");
});

test("bundle export is unsupported", async () => {
  const result = await run(["bundle", "export", "coding"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Unsupported bundle command: export");
});

test("bundle check requires a bundle id", async () => {
  const result = await run(["bundle", "check"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("bundle check requires <bundle-id>.");
});

test("top-level add help describes porcelain workflow", async () => {
  const result = await run(["add", "--help"]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("samx add");
  expect(result.stdout).toContain("samx add <formula | capability-id> [options]");
  expect(result.stdout).toContain(
    "Installs packages when needed, adds selected capabilities to a project bundle, then links the bundle."
  );
  expect(result.stdout).toContain(
    "With no --bundle, uses the linked project bundle or creates one for the current directory."
  );
  expect(result.stdout).toContain(
    "Bare searches such as stripe may ask for confirmation before changing files."
  );
  expect(result.stdout).toContain("--bundle <bundle-id>");
  expect(result.stdout).toContain("--tool <tool>");
});

test("top-level remove help describes porcelain workflow", async () => {
  const result = await run(["remove", "--help"]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("samx remove");
  expect(result.stdout).toContain("samx remove [capability-id | alias] [options]");
  expect(result.stdout).toContain(
    "Removes capabilities from a project bundle, unlinks current outputs, then relinks remaining items."
  );
  expect(result.stdout).toContain(
    "Omit the argument to select capabilities from the target bundle."
  );
  expect(result.stdout).toContain(
    "Use --bundle to choose the bundle; positional arguments are capability queries, ids, or aliases."
  );
  expect(result.stdout).toContain(
    "Use samx unlink <bundle-id> to remove all outputs, or samx bundle destroy <bundle-id> to delete a bundle."
  );
  expect(result.stdout).toContain("--bundle <bundle-id>");
  expect(result.stdout).toContain("--tool <tool>");
});

test("tui requires an interactive TTY", async () => {
  const result = await run(["tui"], { isTty: false });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("samx tui requires an interactive TTY");
});

test("analyze renders terminal report for SAMX state by default", async () => {
  const { samxHome, project } = await seededSamxHome();

  const result = await run(["analyze"], { cwd: project, env: { SAMX_HOME: samxHome } });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("SAMX Analyze Report");
  expect(result.stdout).toContain("Packages: 1");
  expect(result.stdout).toContain("Capabilities: 1");
  expect(result.stdout).toContain("coding:opencode");
});

test("analyze scopes links and bundles to explicit project root", async () => {
  const { samxHome, project } = await seededSamxHome();
  const otherProject = await mkdtemp(join(tmpdir(), "samx-cli-other-project-"));

  const scoped = await run(["analyze", project, "--json"], { cwd: otherProject, env: { SAMX_HOME: samxHome } });
  const emptyScope = await run(["analyze", otherProject, "--json"], { cwd: otherProject, env: { SAMX_HOME: samxHome } });

  expect(scoped.exitCode, scoped.stderr).toBe(0);
  expect(JSON.parse(scoped.stdout).summary).toMatchObject({ packages: 1, capabilities: 1, bundles: 1, links: 1 });
  expect(emptyScope.exitCode, emptyScope.stderr).toBe(0);
  expect(JSON.parse(emptyScope.stdout).summary).toMatchObject({ packages: 1, capabilities: 1, bundles: 0, links: 0 });
});

test("analyze renders parseable json with --json", async () => {
  const { samxHome, project } = await seededSamxHome();

  const result = await run(["analyze", "--json"], { cwd: project, env: { SAMX_HOME: samxHome } });

  expect(result.exitCode, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as { packages: unknown[]; capabilities: unknown[]; bundles: unknown[]; links: unknown[] };
  expect(report.packages).toHaveLength(1);
  expect(report.capabilities).toHaveLength(1);
  expect(report.bundles).toHaveLength(1);
  expect(report.links).toHaveLength(1);
});

test("analyze renders markdown headings with --format markdown", async () => {
  const { samxHome, project } = await seededSamxHome();

  const result = await run(["analyze", "--format", "markdown"], { cwd: project, env: { SAMX_HOME: samxHome } });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("# SAMX Analyze Report");
  expect(result.stdout).toContain("## Summary");
});

test("analyze rejects unsupported output formats", async () => {
  const { samxHome, project } = await seededSamxHome();

  const result = await run(["analyze", "--format", "xml"], { cwd: project, env: { SAMX_HOME: samxHome } });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Unsupported analyze format: xml");
});

test("analyze --paths prints managed paths", async () => {
  const { samxHome, project, packageRoot, capabilityRoot, output } = await seededSamxHome();

  const result = await run(["analyze", "--paths"], { cwd: project, env: { SAMX_HOME: samxHome } });
  const lines = result.stdout.trim().split("\n");

  expect(result.exitCode, result.stderr).toBe(0);
  expect(lines).toEqual([...new Set(lines)].sort((left, right) => left.localeCompare(right)));
  expect(lines).toContain(packageRoot);
  expect(lines).toContain(capabilityRoot);
  expect(lines).toContain(output);
  expect(result.stdout).toContain(join(project, ".opencode", "opencode.json"));
});

test("analyze --inventory prints SAMX inventory", async () => {
  const { samxHome, project } = await seededSamxHome();

  const result = await run(["analyze", "--inventory"], { cwd: project, env: { SAMX_HOME: samxHome } });

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("package\tdefault/acme/tools\tgit");
  expect(result.stdout).toContain("capability\tdefault/acme/tools:review\tskill");
  expect(result.stdout).toContain("bundle\tcoding\tready");
  expect(result.stdout).toContain("link\tcoding:opencode\topencode");
});

test("analyze --show prints a single item by id", async () => {
  const { samxHome, project } = await seededSamxHome();

  const capability = await run(["analyze", "--show", "default/acme/tools:review"], { cwd: project, env: { SAMX_HOME: samxHome } });
  const finding = await run(["analyze", "--show", "package:default/acme/tools:advisory:0"], { cwd: project, env: { SAMX_HOME: samxHome } });
  const missing = await run(["analyze", "--show", "missing"], { cwd: project, env: { SAMX_HOME: samxHome } });

  expect(capability.exitCode, capability.stderr).toBe(0);
  expect(JSON.parse(capability.stdout)).toMatchObject({ id: "default/acme/tools:review", kind: "skill" });
  expect(finding.exitCode, finding.stderr).toBe(0);
  expect(JSON.parse(finding.stdout)).toMatchObject({ id: "package:default/acme/tools:advisory:0" });
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain("Analyze item not found: missing");
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
