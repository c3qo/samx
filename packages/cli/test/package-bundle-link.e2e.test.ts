import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

import { runCli } from "../src/index.js";
import type { CliRuntimeOptions } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function run(
  args: string[],
  options: { cwd: string; samxHome: string } & Partial<CliRuntimeOptions>
) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    cwd: options.cwd,
    env: { SAMX_HOME: options.samxHome, PWD: options.cwd },
    isTty: options.isTty,
    capabilitySelector: options.capabilitySelector,
    bundleSelector: options.bundleSelector,
    bundleItemSelector: options.bundleItemSelector,
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { exitCode, stdout, stderr };
}

async function commitAll(cwd: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.test", "add", "."],
    { cwd }
  );
  try {
    await execFileAsync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "source"],
      { cwd }
    );
  } catch {
    await gitHead(cwd);
  }
}

async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

async function writeSuperpowersFormula(
  samxHome: string,
  packageRoot: string,
  revision: string,
  advisories = "",
  requirements = ""
): Promise<void> {
  await mkdir(join(samxHome, "registries", "default", "formulas", "obra"), { recursive: true });
  await writeFile(
    join(samxHome, "registries", "default", "formulas", "obra", "superpowers.yaml"),
    `schemaVersion: 1
id: obra/superpowers
name: Superpowers
description: Review workflows
source:
  type: git
  url: ${pathToFileURL(packageRoot).href}
  revision: ${revision}
capabilities:
  - id: skills-code-review
    kind: skill
    path: skills/code-review
  - id: agents-reviewer
    kind: agent
    path: agents/reviewer
  - id: mcp-github
    kind: mcp
    path: mcp/github/mcp.json
${requirements}
${advisories}
`,
    "utf8"
  );
}

async function createSuperpowersFixture(options: {
  samxHome: string;
  projectRoot?: string;
  advisories?: string;
  requirements?: string;
}): Promise<{ packageRoot: string; projectRoot: string }> {
  const projectRoot = options.projectRoot ?? (await mkdtemp(join(tmpdir(), "samx-cli-project-")));
  const packageRoot = await mkdtemp(join(tmpdir(), "samx-cli-package-"));
  await mkdir(join(packageRoot, "skills", "code-review"), { recursive: true });
  await mkdir(join(packageRoot, "agents", "reviewer"), { recursive: true });
  await mkdir(join(packageRoot, "mcp", "github"), { recursive: true });
  await writeFile(
    join(packageRoot, "skills", "code-review", "SKILL.md"),
    "# Code Review\n",
    "utf8"
  );
  await writeFile(join(packageRoot, "agents", "reviewer", "AGENT.md"), "# Reviewer\n", "utf8");
  await writeFile(
    join(packageRoot, "mcp", "github", "mcp.json"),
    JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
    "utf8"
  );
  await commitAll(packageRoot);
  const sourceRevision = await gitHead(packageRoot);
  await writeSuperpowersFormula(
    options.samxHome,
    packageRoot,
    sourceRevision,
    options.advisories ?? "",
    options.requirements ?? ""
  );
  await commitAll(join(options.samxHome, "registries", "default"));
  await run(["registry", "trust", "default"], { cwd: projectRoot, samxHome: options.samxHome });
  return { packageRoot, projectRoot };
}

describe("package bundle link Slice 1 CLI", () => {
  test("link dry-run shows formula advisories and apply requires allowance", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({
      samxHome,
      advisories: `advisories:
  - id: optional-opencode-plugin
    severity: info
    category: linking
    message: This formula includes an optional OpenCode plugin link target.
    paths:
      - .opencode/plugins/superpowers.js`,
    });

    const packageAdd = await run(["pkg", "install", "obra/superpowers"], {
      cwd: projectRoot,
      samxHome,
    });
    expect(packageAdd.exitCode, packageAdd.stderr).toBe(0);
    expect(await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome })).toMatchObject(
      { exitCode: 0 }
    );
    expect(
      await run(["bundle", "add", "coding", "default/obra/superpowers:skills-code-review"], {
        cwd: projectRoot,
        samxHome,
      })
    ).toMatchObject({ exitCode: 0 });

    const dryRun = await run(
      ["link", "coding", "--tool", "opencode", "--project", projectRoot, "--dry-run"],
      { cwd: projectRoot, samxHome }
    );
    expect(dryRun.exitCode, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain("Formula advisories:");
    const blocked = await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("Bundle has formula advisories");
    expect(blocked.stderr).toContain("--allow-advisories");
    const allowed = await run(
      ["link", "coding", "--tool", "opencode", "--project", projectRoot, "--allow-advisories"],
      { cwd: projectRoot, samxHome }
    );
    expect(allowed.exitCode, allowed.stderr).toBe(0);
  });

  test("capability show resolves default registry capability shorthand", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });

    const install = await run(["pkg", "install", "obra/superpowers"], {
      cwd: projectRoot,
      samxHome,
    });
    expect(install.exitCode, install.stderr).toBe(0);

    const result = await run(["capability", "show", "obra/superpowers:skills-code-review"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Capability: default/obra/superpowers:skills-code-review");
  });

  test("runs package add, bundle link dry-run, apply, and unlink through registry formulas", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-cli-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-project-"));
    await mkdir(join(packageRoot, "skills", "code-review"), { recursive: true });
    await mkdir(join(packageRoot, "skills", "code-review", "hooks"), { recursive: true });
    await mkdir(join(packageRoot, "agents", "reviewer"), { recursive: true });
    await mkdir(join(packageRoot, "mcp", "github"), { recursive: true });
    await mkdir(join(packageRoot, "hooks"), { recursive: true });
    await mkdir(join(packageRoot, ".opencode", "plugins"), { recursive: true });
    await writeFile(
      join(packageRoot, "skills", "code-review", "SKILL.md"),
      "# Code Review\n\nReview code changes safely.\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "skills", "code-review", "hooks", "opencode.js"),
      "export default {}\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "agents", "reviewer", "AGENT.md"),
      "# Reviewer\n\nReview the current branch.\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "mcp", "github", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        },
      }),
      "utf8"
    );
    await writeFile(join(packageRoot, "hooks", "safe-bash.js"), "export default {}\n", "utf8");
    await writeFile(join(packageRoot, "hooks", "session.js"), "export default {}\n", "utf8");
    await writeFile(
      join(packageRoot, ".opencode", "plugins", "superpowers.js"),
      "export default {}\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "hooks", "safe-bash.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "node safe-bash.js" }] },
          ],
        },
      }),
      "utf8"
    );
    await writeFile(
      join(packageRoot, "samx.package.json"),
      JSON.stringify({
        hooks: [
          {
            id: "safe-bash",
            appliesTo: ["skill:skills-code-review", "agent:agents-reviewer"],
            files: [
              { target: "claude", path: "hooks/safe-bash.json" },
              { target: "opencode", path: "hooks/safe-bash.js" },
            ],
            required: false,
          },
        ],
      }),
      "utf8"
    );
    await commitAll(packageRoot);
    const sourceRevision = await gitHead(packageRoot);
    const materializedRoot = join(samxHome, "packages", "default", "obra", "superpowers", "source");
    await writeSuperpowersFormula(
      samxHome,
      packageRoot,
      sourceRevision,
      "",
      `requirements:\n  env:\n    - ANTHROPIC_API_KEY`
    );
    await commitAll(join(samxHome, "registries", "default"));
    await run(["registry", "trust", "default"], { cwd: projectRoot, samxHome });

    const packageAdd = await run(["pkg", "install", "obra/superpowers"], {
      cwd: projectRoot,
      samxHome,
    });
    expect(packageAdd.exitCode, packageAdd.stderr).toBe(0);
    expect(packageAdd.stdout).toContain("Installed package: obra/superpowers");
    expect(packageAdd.stdout).not.toContain("default/obra/superpowers");
    const skills = await run(["capability", "list"], { cwd: projectRoot, samxHome });
    expect(skills.stdout).toContain("default/obra/superpowers:skills-code-review");
    expect(skills.stdout).toContain("default/obra/superpowers:agents-reviewer");
    expect(skills.stdout).toContain("default/obra/superpowers:mcp-github");
    const agents = await run(["capability", "list", "--type", "agent"], {
      cwd: projectRoot,
      samxHome,
    });
    expect(agents.stdout).toContain("default/obra/superpowers:agents-reviewer");
    expect(agents.stdout).not.toContain("default/obra/superpowers:skills-code-review");

    expect(await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome })).toMatchObject(
      { exitCode: 0 }
    );
    expect(
      await run(
        [
          "bundle",
          "add",
          "coding",
          "default/obra/superpowers:skills-code-review",
          "--as",
          "review-code",
        ],
        { cwd: projectRoot, samxHome }
      )
    ).toMatchObject({ exitCode: 0 });
    expect(
      await run(
        ["bundle", "add", "coding", "default/obra/superpowers:agents-reviewer", "--as", "reviewer"],
        { cwd: projectRoot, samxHome }
      )
    ).toMatchObject({ exitCode: 0 });
    expect(
      await run(["bundle", "add", "coding", "default/obra/superpowers:mcp-github"], {
        cwd: projectRoot,
        samxHome,
      })
    ).toMatchObject({ exitCode: 0 });

    const adjacentDryRun = await run(
      ["link", "coding", "--tool", "opencode", "--project", projectRoot, "--dry-run"],
      { cwd: projectRoot, samxHome }
    );
    expect(adjacentDryRun.exitCode, adjacentDryRun.stderr).toBe(0);
    expect(adjacentDryRun.stdout).toContain("Hooks:");
    expect(adjacentDryRun.stdout).not.toContain("Adjacent hook candidates:");

    const genericLink = await run(
      ["link", "coding", "--tool", "generic-markdown", "--project", projectRoot, "--dry-run"],
      { cwd: projectRoot, samxHome }
    );
    expect(genericLink.exitCode).toBe(1);
    expect(genericLink.stderr).toContain("Unsupported link target: generic-markdown");
    await expect(stat(join(projectRoot, "SAMX_SKILLS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const opencodeDoctor = await run(["bundle", "check", "coding", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
    });
    expect(opencodeDoctor.exitCode, opencodeDoctor.stderr).toBe(0);
    expect(opencodeDoctor.stdout).toContain("Status: ready");
    expect(opencodeDoctor.stdout).toContain("Environment reminders:");
    expect(opencodeDoctor.stdout).toContain("ANTHROPIC_API_KEY");
    expect(opencodeDoctor.stdout).toContain("Inferred hooks:");
    expect(opencodeDoctor.stdout).toContain("status: will link");

    const opencodeDryRun = await run(
      ["link", "coding", "--tool", "opencode", "--project", projectRoot, "--dry-run"],
      { cwd: projectRoot, samxHome }
    );
    expect(opencodeDryRun.exitCode, opencodeDryRun.stderr).toBe(0);
    expect(opencodeDryRun.stdout).toContain("Link plan for OpenCode");
    expect(opencodeDryRun.stdout).toContain("Skills:");
    expect(opencodeDryRun.stdout).toContain(
      `+ ${join(projectRoot, ".opencode", "skills", "review-code")} -> ${join(materializedRoot, "skills", "code-review")}`
    );
    expect(opencodeDryRun.stdout).toContain("Agents:");
    expect(opencodeDryRun.stdout).toContain(
      `+ ${join(projectRoot, ".opencode", "agents", "reviewer")} -> ${join(materializedRoot, "agents", "reviewer")}`
    );
    expect(opencodeDryRun.stdout).toContain("MCP:");
    expect(opencodeDryRun.stdout).toContain(
      `+ ${join(projectRoot, ".opencode", "opencode.json")} mcp.obra-superpowers-github`
    );
    expect(opencodeDryRun.stdout).toContain("Hooks:");
    expect(opencodeDryRun.stdout).toContain("Environment reminders:");
    expect(opencodeDryRun.stdout).toContain("ANTHROPIC_API_KEY");
    expect(opencodeDryRun.stdout).toContain("source: top-level inferred");
    expect(opencodeDryRun.stdout).toContain("source: adjacent inferred");

    const codexDryRun = await run(
      ["link", "coding", "--tool", "codex", "--project", projectRoot, "--dry-run"],
      { cwd: projectRoot, samxHome }
    );
    expect(codexDryRun.exitCode, codexDryRun.stderr).toBe(0);
    expect(codexDryRun.stdout).toContain("Instructions:");
    expect(codexDryRun.stdout).toContain("AGENTS.md");
    expect(codexDryRun.stdout).toContain(".codex/config.toml");

    const opencodeSkillDir = join(projectRoot, ".opencode", "skills", "review-code");
    const opencodeAgentDir = join(projectRoot, ".opencode", "agents", "reviewer");
    const opencodeMcp = join(projectRoot, ".opencode", "opencode.json");
    const opencodeSkillFile = join(opencodeSkillDir, "SKILL.md");
    await expect(stat(opencodeSkillDir)).rejects.toMatchObject({ code: "ENOENT" });

    const badUnlinkDryRun = await run(
      ["unlink", "coding", "--tool", "bad", "--project", projectRoot, "--dry-run"],
      { cwd: projectRoot, samxHome }
    );
    expect(badUnlinkDryRun.exitCode).toBe(1);
    expect(badUnlinkDryRun.stderr).toContain("Unsupported link target");

    const opencodeUnlinkDryRun = await run(
      ["unlink", "coding", "--tool", "opencode", "--project", projectRoot, "--dry-run"],
      { cwd: projectRoot, samxHome }
    );
    expect(opencodeUnlinkDryRun.exitCode).toBe(1);
    expect(opencodeUnlinkDryRun.stderr).toContain("Link record not found");

    const opencodeApply = await run(
      ["link", "coding", "--tool", "opencode", "--project", projectRoot],
      { cwd: projectRoot, samxHome }
    );
    expect(opencodeApply.exitCode, opencodeApply.stderr).toBe(0);
    expect(opencodeApply.stdout).toContain("Link plan for OpenCode");
    expect(opencodeApply.stdout).toContain("Skills:");
    expect(opencodeApply.stdout).toContain("Agents:");
    expect(opencodeApply.stdout).toContain("MCP:");
    expect(opencodeApply.stdout).toContain("Hooks:");
    expect((await lstat(opencodeSkillDir)).isSymbolicLink()).toBe(true);
    expect((await lstat(opencodeAgentDir)).isSymbolicLink()).toBe(true);
    expect(await readFile(opencodeSkillFile, "utf8")).toContain("# Code Review");
    expect(await readFile(join(opencodeAgentDir, "AGENT.md"), "utf8")).toContain("# Reviewer");
    expect(JSON.parse(await readFile(opencodeMcp, "utf8")).mcp["obra-superpowers-github"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
    });

    const trackedOpencodeUnlinkDryRun = await run(
      ["unlink", "coding", "--tool", "opencode", "--project", projectRoot, "--dry-run"],
      { cwd: projectRoot, samxHome }
    );
    expect(trackedOpencodeUnlinkDryRun.exitCode, trackedOpencodeUnlinkDryRun.stderr).toBe(0);
    expect(trackedOpencodeUnlinkDryRun.stdout).toContain("Unlink plan for OpenCode");
    expect(trackedOpencodeUnlinkDryRun.stdout).toContain("Will remove:");
    expect(trackedOpencodeUnlinkDryRun.stdout).toContain(opencodeSkillDir);
    expect(trackedOpencodeUnlinkDryRun.stdout).toContain(
      `- ${opencodeMcp} mcp.obra-superpowers-github`
    );
    expect(trackedOpencodeUnlinkDryRun.stdout).toContain("SAMX removes only recorded outputs.");
    expect(await readFile(opencodeSkillFile, "utf8")).toContain("# Code Review");

    const opencodeUnlink = await run(
      ["unlink", "coding", "--tool", "opencode", "--project", projectRoot],
      { cwd: projectRoot, samxHome }
    );
    expect(opencodeUnlink.exitCode, opencodeUnlink.stderr).toBe(0);
    expect(opencodeUnlink.stdout).toContain("Unlink plan for OpenCode");
    expect(opencodeUnlink.stdout).toContain(`- ${opencodeSkillDir}`);
    await expect(stat(opencodeSkillDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(opencodeAgentDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(opencodeMcp, "utf8"))).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: {},
    });

    for (const [tool, rootDir, mcpPath] of [
      ["claude", ".claude", ".mcp.json"],
      ["kiro", ".kiro", ".kiro/mcp.json"],
    ] as const) {
      const check = await run(["bundle", "check", "coding", "--tool", tool], {
        cwd: projectRoot,
        samxHome,
      });
      expect(check.exitCode, check.stderr).toBe(0);
      const skillDir = join(projectRoot, rootDir, "skills", "review-code");
      const agentDir = join(projectRoot, rootDir, "agents", "reviewer");
      const link = await run(["link", "coding", "--tool", tool, "--project", projectRoot], {
        cwd: projectRoot,
        samxHome,
      });
      expect(link.exitCode, link.stderr).toBe(0);
      expect(link.stdout).toContain("Skills:");
      expect(link.stdout).toContain(
        `+ ${skillDir} -> ${join(materializedRoot, "skills", "code-review")}`
      );
      expect(link.stdout).toContain("Agents:");
      expect(link.stdout).toContain(
        `+ ${agentDir} -> ${join(materializedRoot, "agents", "reviewer")}`
      );
      expect((await lstat(skillDir)).isSymbolicLink()).toBe(true);
      expect((await lstat(agentDir)).isSymbolicLink()).toBe(true);
      expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("# Code Review");
      const mcpConfig = JSON.parse(await readFile(join(projectRoot, mcpPath), "utf8"));
      const mcpKey = tool === "claude" ? "obra-superpowers-github" : "github";
      expect(mcpConfig.mcpServers[mcpKey].command).toBe("npx");
      const unlink = await run(["unlink", "coding", "--tool", tool, "--project", projectRoot], {
        cwd: projectRoot,
        samxHome,
      });
      expect(unlink.exitCode, unlink.stderr).toBe(0);
      await expect(stat(skillDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("dry-run unlink hides MCP JSON generated file from partial legacy records", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-legacy-mcp-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-legacy-mcp-project-"));
    const mcpPath = join(projectRoot, ".opencode", "mcp.json");
    await mkdir(join(samxHome, "links"), { recursive: true });
    await mkdir(join(projectRoot, ".opencode"), { recursive: true });
    await writeFile(mcpPath, JSON.stringify({ mcpServers: { keep: { command: "node" } } }), "utf8");
    await writeFile(
      join(samxHome, "links", "project-links.json"),
      JSON.stringify({
        links: [
          {
            id: `coding:opencode:${resolve(projectRoot)}`,
            bundleId: "coding",
            tool: "opencode",
            projectRoot: resolve(projectRoot),
            generatedFiles: [mcpPath],
            managedJsonEntries: [],
            managedHooks: [],
            adjacentHooks: [],
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8"
    );

    const unlink = await run(
      ["unlink", "coding", "--tool", "opencode", "--project", projectRoot, "--dry-run"],
      { cwd: projectRoot, samxHome }
    );

    expect(unlink.exitCode, unlink.stderr).toBe(0);
    expect(unlink.stdout).toContain("Unlink plan for OpenCode");
    expect(unlink.stdout).not.toContain(`- ${mcpPath}`);
  });

  test("reports blocked bundle check details and rejects unsupported output formats", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-project-"));

    expect(
      await run(["bundle", "create", "blocked"], { cwd: projectRoot, samxHome })
    ).toMatchObject({ exitCode: 0 });
    await mkdir(join(samxHome, "bundles"), { recursive: true });
    await writeFile(
      join(samxHome, "bundles", "blocked.yaml"),
      "id: blocked\nitems:\n  - id: missing:skills-code-review\n    kind: skill\n",
      "utf8"
    );

    const check = await run(["bundle", "check", "blocked", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
    });
    expect(check.exitCode, check.stderr).toBe(0);
    expect(check.stdout).toContain("Bundle: blocked");
    expect(check.stdout).toContain("Status: blocked");
    expect(check.stdout).toContain("Missing items: missing:skills-code-review");

    const missingTool = await run(["bundle", "check", "blocked"], { cwd: projectRoot, samxHome });
    expect(missingTool.exitCode).toBe(1);
    expect(missingTool.stderr).toContain("bundle check requires --tool");
  });

  test("top-level add creates a cwd-named project bundle when none exists", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });

    const result = await run(["add", "obra/superpowers:skills-code-review", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
    });

    const bundleId = (projectRoot.split("/").at(-1) ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Created project bundle: ${bundleId}`);
    expect(result.stdout).toContain(
      `Added to bundle: ${bundleId} <- obra/superpowers:skills-code-review`
    );
    expect(await readFile(join(samxHome, "bundles", `${bundleId}.yaml`), "utf8")).toContain(
      "default/obra/superpowers:skills-code-review"
    );
  });

  test("top-level add does not mutate an unlinked global bundle with the cwd name", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    const bundleId = (projectRoot.split("/").at(-1) ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    await run(["bundle", "create", bundleId], { cwd: projectRoot, samxHome });

    const result = await run(["add", "obra/superpowers:skills-code-review", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Created project bundle: ${bundleId}-2`);
    expect(await readFile(join(samxHome, "bundles", `${bundleId}.yaml`), "utf8")).not.toContain(
      "skills-code-review"
    );
    expect(await readFile(join(samxHome, "bundles", `${bundleId}-2.yaml`), "utf8")).toContain(
      "default/obra/superpowers:skills-code-review"
    );
  });

  test("top-level add requires explicit bundle when project links are ambiguous", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-project-"));
    await mkdir(join(samxHome, "links"), { recursive: true });
    await writeFile(
      join(samxHome, "links", "project-links.json"),
      JSON.stringify({
        links: [
          {
            id: `coding:opencode:${resolve(projectRoot)}`,
            bundleId: "coding",
            tool: "opencode",
            projectRoot: resolve(projectRoot),
            generatedFiles: [],
            managedJsonEntries: [],
            managedHooks: [],
            adjacentHooks: [],
            createdAt: new Date().toISOString(),
          },
          {
            id: `review:opencode:${resolve(projectRoot)}`,
            bundleId: "review",
            tool: "opencode",
            projectRoot: resolve(projectRoot),
            generatedFiles: [],
            managedJsonEntries: [],
            managedHooks: [],
            adjacentHooks: [],
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8"
    );

    const result = await run(["add", "obra/superpowers:skills-code-review", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Ambiguous project bundle");
    expect(result.stderr).toContain("Re-run with --bundle");
    expect(result.stderr).toContain("coding");
    expect(result.stderr).toContain("review");
  });

  test("top-level add prompts for a project bundle when project links are ambiguous in a TTY", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "review"], { cwd: projectRoot, samxHome });
    await mkdir(join(samxHome, "links"), { recursive: true });
    await writeFile(
      join(samxHome, "links", "project-links.json"),
      JSON.stringify({
        links: [
          {
            id: `coding:opencode:${resolve(projectRoot)}`,
            bundleId: "coding",
            tool: "opencode",
            projectRoot: resolve(projectRoot),
            generatedFiles: [],
            managedJsonEntries: [],
            managedHooks: [],
            adjacentHooks: [],
            createdAt: new Date().toISOString(),
          },
          {
            id: `review:opencode:${resolve(projectRoot)}`,
            bundleId: "review",
            tool: "opencode",
            projectRoot: resolve(projectRoot),
            generatedFiles: [],
            managedJsonEntries: [],
            managedHooks: [],
            adjacentHooks: [],
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8"
    );

    const result = await run(["add", "obra/superpowers:skills-code-review", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
      isTty: true,
      bundleSelector: async (bundleIds) => (bundleIds.includes("review") ? "review" : undefined),
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Using project bundle: review");
    expect(await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8")).not.toContain(
      "skills-code-review"
    );
    expect(await readFile(join(samxHome, "bundles", "review.yaml"), "utf8")).toContain(
      "default/obra/superpowers:skills-code-review"
    );
  });

  test("top-level add requires tool when no project link can infer one", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-project-"));
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });

    const result = await run(["add", "obra/superpowers:skills-code-review", "--bundle", "coding"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing required option: --tool");
  });

  test("top-level add requires explicit tool when project links are ambiguous", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-project-"));
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await mkdir(join(samxHome, "links"), { recursive: true });
    await writeFile(
      join(samxHome, "links", "project-links.json"),
      JSON.stringify({
        links: [
          {
            id: `coding:opencode:${resolve(projectRoot)}`,
            bundleId: "coding",
            tool: "opencode",
            projectRoot: resolve(projectRoot),
            generatedFiles: [],
            managedJsonEntries: [],
            managedHooks: [],
            adjacentHooks: [],
            createdAt: new Date().toISOString(),
          },
          {
            id: `coding:claude:${resolve(projectRoot)}`,
            bundleId: "coding",
            tool: "claude",
            projectRoot: resolve(projectRoot),
            generatedFiles: [],
            managedJsonEntries: [],
            managedHooks: [],
            adjacentHooks: [],
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8"
    );

    const result = await run(["add", "obra/superpowers:skills-code-review", "--bundle", "coding"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Ambiguous project tool");
    expect(result.stderr).toContain("Re-run with --tool");
    expect(result.stderr).toContain("opencode");
    expect(result.stderr).toContain("claude");
  });

  test("top-level add installs missing package, adds to bundle, and links project", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });

    const result = await run(
      ["add", "obra/superpowers:skills-code-review", "--bundle", "coding", "--tool", "opencode"],
      { cwd: projectRoot, samxHome }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Installed package: obra/superpowers");
    expect(result.stdout).toContain(
      "Added to bundle: coding <- obra/superpowers:skills-code-review"
    );
    expect(result.stdout).toContain("Link plan for OpenCode");
    expect(
      (
        await lstat(
          join(projectRoot, ".opencode", "skills", "default-obra-superpowers-skills-code-review")
        )
      ).isSymbolicLink()
    ).toBe(true);
    const bundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundle).toContain("default/obra/superpowers:skills-code-review");
  });

  test("top-level add stores alias from --as in bundle", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });

    const result = await run(
      [
        "add",
        "obra/superpowers:skills-code-review",
        "--as",
        "review-code",
        "--bundle",
        "coding",
        "--tool",
        "opencode",
      ],
      { cwd: projectRoot, samxHome }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const bundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundle).toContain("alias: review-code");
    expect(
      (await lstat(join(projectRoot, ".opencode", "skills", "review-code"))).isSymbolicLink()
    ).toBe(true);
  });

  test("top-level add selects the only capability from a formula id", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-cli-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-project-"));
    await mkdir(join(packageRoot, "skills", "code-review"), { recursive: true });
    await writeFile(
      join(packageRoot, "skills", "code-review", "SKILL.md"),
      "# Code Review\n",
      "utf8"
    );
    await commitAll(packageRoot);
    const sourceRevision = await gitHead(packageRoot);
    await mkdir(join(samxHome, "registries", "default", "formulas", "stripe"), { recursive: true });
    await writeFile(
      join(samxHome, "registries", "default", "formulas", "stripe", "ai.yaml"),
      `schemaVersion: 1
id: stripe/ai
name: Stripe AI
description: Stripe helpers
source:
  type: git
  url: ${pathToFileURL(packageRoot).href}
  revision: ${sourceRevision}
capabilities:
  - id: skills-code-review
    kind: skill
    path: skills/code-review
`,
      "utf8"
    );
    await commitAll(join(samxHome, "registries", "default"));
    await run(["registry", "trust", "default"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });

    const result = await run(["add", "stripe/ai", "--bundle", "coding", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Installed package: stripe/ai");
    expect(result.stdout).toContain("Added to bundle: coding <- stripe/ai:skills-code-review");
    expect(
      (
        await lstat(
          join(projectRoot, ".opencode", "skills", "default-stripe-ai-skills-code-review")
        )
      ).isSymbolicLink()
    ).toBe(true);
  });

  test("top-level add resolves a bare query to one formula before creating a project bundle", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-cli-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-project-"));
    await mkdir(join(packageRoot, "skills", "code-review"), { recursive: true });
    await writeFile(
      join(packageRoot, "skills", "code-review", "SKILL.md"),
      "# Code Review\n",
      "utf8"
    );
    await commitAll(packageRoot);
    const sourceRevision = await gitHead(packageRoot);
    await mkdir(join(samxHome, "registries", "default", "formulas", "stripe"), { recursive: true });
    await writeFile(
      join(samxHome, "registries", "default", "formulas", "stripe", "ai.yaml"),
      `schemaVersion: 1
id: stripe/ai
name: Stripe AI
description: Stripe helpers
source:
  type: git
  url: ${pathToFileURL(packageRoot).href}
  revision: ${sourceRevision}
capabilities:
  - id: skills-code-review
    kind: skill
    path: skills/code-review
`,
      "utf8"
    );
    await commitAll(join(samxHome, "registries", "default"));
    await run(["registry", "trust", "default"], { cwd: projectRoot, samxHome });

    const result = await run(["add", "stripe", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Created project bundle:");
    expect(result.stdout).toContain("Installed package: stripe/ai");
    expect(result.stdout).toContain("Added to bundle:");
    expect(result.stdout).toContain("stripe/ai:skills-code-review");
    expect(
      (
        await lstat(
          join(projectRoot, ".opencode", "skills", "default-stripe-ai-skills-code-review")
        )
      ).isSymbolicLink()
    ).toBe(true);
  });

  test("top-level add fuzzy single match in non-TTY prints exact formula without mutating", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-cli-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-project-"));
    await mkdir(join(packageRoot, "skills", "code-review"), { recursive: true });
    await writeFile(
      join(packageRoot, "skills", "code-review", "SKILL.md"),
      "# Code Review\n",
      "utf8"
    );
    await commitAll(packageRoot);
    const sourceRevision = await gitHead(packageRoot);
    await mkdir(join(samxHome, "registries", "default", "formulas", "stripe"), { recursive: true });
    await writeFile(
      join(samxHome, "registries", "default", "formulas", "stripe", "ai.yaml"),
      `schemaVersion: 1
id: stripe/ai
name: Stripe AI
description: Stripe helpers
source:
  type: git
  url: ${pathToFileURL(packageRoot).href}
  revision: ${sourceRevision}
capabilities:
  - id: skills-code-review
    kind: skill
    path: skills/code-review
`,
      "utf8"
    );
    await commitAll(join(samxHome, "registries", "default"));
    await run(["registry", "trust", "default"], { cwd: projectRoot, samxHome });

    const result = await run(["add", "stri", "--tool", "opencode"], { cwd: projectRoot, samxHome });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Matched one formula: stripe/ai");
    expect(result.stderr).toContain("Re-run with exact id to confirm: samx add stripe/ai");
    await expect(stat(join(samxHome, "bundles"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("top-level add fuzzy single match in TTY asks before installing", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-cli-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-project-"));
    const selections: string[][] = [];
    await mkdir(join(packageRoot, "skills", "code-review"), { recursive: true });
    await writeFile(
      join(packageRoot, "skills", "code-review", "SKILL.md"),
      "# Code Review\n",
      "utf8"
    );
    await commitAll(packageRoot);
    const sourceRevision = await gitHead(packageRoot);
    await mkdir(join(samxHome, "registries", "default", "formulas", "stripe"), { recursive: true });
    await writeFile(
      join(samxHome, "registries", "default", "formulas", "stripe", "ai.yaml"),
      `schemaVersion: 1
id: stripe/ai
name: Stripe AI
description: Stripe helpers
source:
  type: git
  url: ${pathToFileURL(packageRoot).href}
  revision: ${sourceRevision}
capabilities:
  - id: skills-code-review
    kind: skill
    path: skills/code-review
`,
      "utf8"
    );
    await commitAll(join(samxHome, "registries", "default"));
    await run(["registry", "trust", "default"], { cwd: projectRoot, samxHome });

    const result = await run(["add", "stri", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
      isTty: true,
      capabilitySelector: async (_formulaId, capabilities) => {
        selections.push(capabilities.map((capability) => capability.id));
        return ["skills-code-review"];
      },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(selections).toEqual([["skills-code-review"]]);
    expect(result.stdout).toContain("Selected capabilities: stripe/ai:skills-code-review");
    expect(result.stdout).toContain("Installed package: stripe/ai");
  });

  test("top-level add does not create a project bundle when a bare query has no formula match", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });

    const result = await run(["add", "missing-query", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Formula not found: missing-query");
    await expect(stat(join(samxHome, "bundles"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("top-level add lists capability choices for formula ids with multiple capabilities", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });

    const result = await run(
      ["add", "obra/superpowers", "--bundle", "coding", "--tool", "opencode"],
      { cwd: projectRoot, samxHome }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Formula has multiple capabilities: obra/superpowers");
    expect(result.stderr).toContain("- obra/superpowers:skills-code-review");
    expect(result.stderr).toContain("- obra/superpowers:agents-reviewer");
    expect(result.stderr).toContain("- obra/superpowers:mcp-github");
  });

  test("top-level add prompts for capabilities when formula has multiple capabilities in a TTY", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    const selections: string[][] = [];
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });

    const result = await run(
      ["add", "obra/superpowers", "--bundle", "coding", "--tool", "opencode"],
      {
        cwd: projectRoot,
        samxHome,
        isTty: true,
        capabilitySelector: async (_formulaId, capabilities) => {
          selections.push(capabilities.map((capability) => capability.id));
          return ["skills-code-review", "agents-reviewer"];
        },
      }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(selections).toEqual([["skills-code-review", "agents-reviewer", "mcp-github"]]);
    expect(result.stdout).toContain(
      "Selected capabilities: obra/superpowers:skills-code-review, obra/superpowers:agents-reviewer"
    );
    const bundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundle).toContain("default/obra/superpowers:skills-code-review");
    expect(bundle).toContain("default/obra/superpowers:agents-reviewer");
  });

  test("top-level add dry-run does not mutate bundle or links", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });

    const result = await run(
      [
        "add",
        "obra/superpowers:skills-code-review",
        "--bundle",
        "coding",
        "--tool",
        "opencode",
        "--dry-run",
      ],
      { cwd: projectRoot, samxHome }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Would add to bundle: coding <- obra/superpowers:skills-code-review"
    );
    const bundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundle).not.toContain("skills-code-review");
    await expect(stat(join(projectRoot, ".opencode"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("top-level add infers bundle and tool from existing project link", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(["bundle", "add", "coding", "obra/superpowers:skills-code-review"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });

    const result = await run(["add", "obra/superpowers:agents-reviewer"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Using project bundle: coding");
    expect(result.stdout).toContain("Added to bundle: coding <- obra/superpowers:agents-reviewer");
    expect(
      (
        await lstat(
          join(projectRoot, ".opencode", "agents", "default-obra-superpowers-agents-reviewer")
        )
      ).isSymbolicLink()
    ).toBe(true);
  });

  test("top-level remove removes by alias and relinks remaining bundle items", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(
      ["bundle", "add", "coding", "obra/superpowers:skills-code-review", "--as", "review-code"],
      { cwd: projectRoot, samxHome }
    );
    await run(["bundle", "add", "coding", "obra/superpowers:agents-reviewer"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });

    const result = await run(
      ["remove", "review-code", "--bundle", "coding", "--tool", "opencode"],
      { cwd: projectRoot, samxHome }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Unlink plan for OpenCode");
    expect(result.stdout).toContain(
      "Removed from bundle: coding <- obra/superpowers:skills-code-review"
    );
    expect(result.stdout).toContain("Link plan for OpenCode");
    expect(result.stdout).toContain("Relinked bundle: coding");
    await expect(
      stat(join(projectRoot, ".opencode", "skills", "review-code"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(projectRoot, ".opencode", "agents"))).isDirectory()).toBe(true);
    const bundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundle).not.toContain("skills-code-review");
    expect(bundle).toContain("agents-reviewer");
  });

  test("top-level remove without an id lists bundle item choices in non-TTY", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(
      ["bundle", "add", "coding", "obra/superpowers:skills-code-review", "--as", "review-code"],
      { cwd: projectRoot, samxHome }
    );
    await run(["bundle", "add", "coding", "obra/superpowers:agents-reviewer"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });

    const result = await run(["remove", "--bundle", "coding", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Capability required. Re-run with one of:");
    expect(result.stderr).toContain("- review-code (obra/superpowers:skills-code-review)");
    expect(result.stderr).toContain("- obra/superpowers:agents-reviewer");
    const bundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundle).toContain("skills-code-review");
    expect(bundle).toContain("agents-reviewer");
  });

  test("top-level remove fuzzy single match in non-TTY prints exact item without mutating", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(
      ["bundle", "add", "coding", "obra/superpowers:skills-code-review", "--as", "stripe-review"],
      { cwd: projectRoot, samxHome }
    );
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });
    const bundleBefore = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");

    const result = await run(["remove", "stri", "--bundle", "coding", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Matched one bundle item: stripe-review (obra/superpowers:skills-code-review)"
    );
    expect(result.stderr).toContain(
      "Re-run with exact id or alias to confirm: samx remove stripe-review"
    );
    expect(await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8")).toBe(bundleBefore);
  });

  test("top-level remove reports when positional argument is a bundle id", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(["bundle", "add", "coding", "obra/superpowers:skills-code-review"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });

    const result = await run(["remove", "coding"], { cwd: projectRoot, samxHome });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"coding" is a bundle id, not a capability id or alias.');
    expect(result.stderr).toContain("samx remove --bundle coding");
    expect(result.stderr).toContain("samx unlink coding --tool <tool>");
    expect(result.stderr).toContain("samx bundle destroy coding");
  });

  test("top-level remove without an id prompts for bundle items in a TTY", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    const selections: string[][] = [];
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(
      ["bundle", "add", "coding", "obra/superpowers:skills-code-review", "--as", "review-code"],
      { cwd: projectRoot, samxHome }
    );
    await run(["bundle", "add", "coding", "obra/superpowers:agents-reviewer"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });

    const result = await run(["remove", "--bundle", "coding", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
      isTty: true,
      bundleItemSelector: async (_bundleId, items) => {
        selections.push(items.map((item) => item.alias ?? item.id));
        return ["review-code"];
      },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(selections).toEqual([["review-code", "default/obra/superpowers:agents-reviewer"]]);
    expect(result.stdout).toContain("Selected removals: review-code");
    expect(result.stdout).toContain(
      "Removed from bundle: coding <- obra/superpowers:skills-code-review"
    );
  });

  test("top-level remove without an id can remove multiple selected items with one relink", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(["bundle", "add", "coding", "obra/superpowers:skills-code-review"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["bundle", "add", "coding", "obra/superpowers:agents-reviewer"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });

    const result = await run(["remove", "--bundle", "coding", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
      isTty: true,
      bundleItemSelector: async () => [
        "default/obra/superpowers:skills-code-review",
        "default/obra/superpowers:agents-reviewer",
      ],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Bundle is empty: coding. Project left unlinked.");
    const bundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundle).not.toContain("skills-code-review");
    expect(bundle).not.toContain("agents-reviewer");
    await expect(
      lstat(join(projectRoot, ".opencode", "skills", "default-obra-superpowers-skills-code-review"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(join(projectRoot, ".opencode", "agents", "default-obra-superpowers-agents-reviewer"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("top-level remove fuzzy TTY selection removes multiple selected matches", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(
      ["bundle", "add", "coding", "obra/superpowers:skills-code-review", "--as", "stripe-review"],
      { cwd: projectRoot, samxHome }
    );
    await run(
      ["bundle", "add", "coding", "obra/superpowers:agents-reviewer", "--as", "stripe-agent"],
      { cwd: projectRoot, samxHome }
    );
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });

    const result = await run(["remove", "stripe", "--bundle", "coding", "--tool", "opencode"], {
      cwd: projectRoot,
      samxHome,
      isTty: true,
      bundleItemSelector: async () => ["stripe-review", "stripe-agent"],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Removed from bundle: coding <- obra/superpowers:skills-code-review"
    );
    expect(result.stdout).toContain(
      "Removed from bundle: coding <- obra/superpowers:agents-reviewer"
    );
    expect(result.stdout).toContain("Bundle is empty: coding. Project left unlinked.");
    const bundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundle).not.toContain("skills-code-review");
    expect(bundle).not.toContain("agents-reviewer");
  });

  test("top-level remove without project bundle does not create one", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-cli-project-"));

    const result = await run(["remove", "--tool", "opencode"], { cwd: projectRoot, samxHome });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No project bundle linked");
    await expect(stat(join(samxHome, "bundles"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("top-level remove without an id dry-run does not mutate selected item", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(["bundle", "add", "coding", "obra/superpowers:skills-code-review"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });
    const bundleBefore = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");

    const result = await run(["remove", "--bundle", "coding", "--tool", "opencode", "--dry-run"], {
      cwd: projectRoot,
      samxHome,
      isTty: true,
      bundleItemSelector: async () => ["default/obra/superpowers:skills-code-review"],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Unlink plan for OpenCode");
    expect(result.stdout).toContain(
      "Would remove from bundle: coding <- obra/superpowers:skills-code-review"
    );
    expect(await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8")).toBe(bundleBefore);
  });

  test("top-level remove validates advisory relink before mutating bundle or links", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({
      samxHome,
      advisories: `advisories:
  - id: optional-opencode-plugin
    severity: info
    category: linking
    message: This formula includes an optional OpenCode plugin link target.
    paths:
      - .opencode/plugins/superpowers.js`,
    });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(["bundle", "add", "coding", "obra/superpowers:skills-code-review"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["bundle", "add", "coding", "obra/superpowers:agents-reviewer"], {
      cwd: projectRoot,
      samxHome,
    });
    const initialLink = await run(
      ["link", "coding", "--tool", "opencode", "--project", projectRoot, "--allow-advisories"],
      { cwd: projectRoot, samxHome }
    );
    expect(initialLink.exitCode, initialLink.stderr).toBe(0);
    const bundleBefore = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    const linkRecordBefore = await readFile(join(samxHome, "links", "project-links.json"), "utf8");

    const blocked = await run(
      ["remove", "obra/superpowers:skills-code-review", "--bundle", "coding", "--tool", "opencode"],
      { cwd: projectRoot, samxHome }
    );

    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("Bundle has formula advisories");
    expect(blocked.stderr).toContain("--allow-advisories");
    expect(await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8")).toBe(bundleBefore);
    expect(await readFile(join(samxHome, "links", "project-links.json"), "utf8")).toBe(
      linkRecordBefore
    );

    const allowed = await run(
      [
        "remove",
        "obra/superpowers:skills-code-review",
        "--bundle",
        "coding",
        "--tool",
        "opencode",
        "--allow-advisories",
      ],
      { cwd: projectRoot, samxHome }
    );
    expect(allowed.exitCode, allowed.stderr).toBe(0);
    const bundleAfter = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundleAfter).not.toContain("skills-code-review");
    expect(bundleAfter).toContain("agents-reviewer");
  });

  test("top-level remove dry-run does not mutate bundle or linked outputs", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(
      ["bundle", "add", "coding", "obra/superpowers:skills-code-review", "--as", "review-code"],
      { cwd: projectRoot, samxHome }
    );
    await run(["bundle", "add", "coding", "obra/superpowers:agents-reviewer"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });
    const bundleBefore = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    const linkRecordBefore = await readFile(join(samxHome, "links", "project-links.json"), "utf8");

    const result = await run(
      ["remove", "review-code", "--bundle", "coding", "--tool", "opencode", "--dry-run"],
      { cwd: projectRoot, samxHome }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Unlink plan for OpenCode");
    expect(await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8")).toBe(bundleBefore);
    expect(await readFile(join(samxHome, "links", "project-links.json"), "utf8")).toBe(
      linkRecordBefore
    );
    expect(
      (await lstat(join(projectRoot, ".opencode", "skills", "review-code"))).isSymbolicLink()
    ).toBe(true);
    expect(
      (
        await lstat(
          join(projectRoot, ".opencode", "agents", "default-obra-superpowers-agents-reviewer")
        )
      ).isSymbolicLink()
    ).toBe(true);
  });

  test("top-level remove keeps package installed and visible in pkg list", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(["bundle", "add", "coding", "obra/superpowers:skills-code-review"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });

    const result = await run(
      ["remove", "obra/superpowers:skills-code-review", "--bundle", "coding", "--tool", "opencode"],
      { cwd: projectRoot, samxHome }
    );
    const packages = await run(["pkg", "list"], { cwd: projectRoot, samxHome });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(packages.exitCode, packages.stderr).toBe(0);
    expect(packages.stdout).toContain("obra/superpowers");
    expect(
      await stat(join(samxHome, "packages", "default", "obra", "superpowers", "source"))
    ).toBeTruthy();
  });

  test("top-level remove reports ambiguity when shorthand id matches another item alias", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(["bundle", "add", "coding", "obra/superpowers:skills-code-review"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(
      [
        "bundle",
        "add",
        "coding",
        "obra/superpowers:agents-reviewer",
        "--as",
        "obra/superpowers:skills-code-review",
      ],
      { cwd: projectRoot, samxHome }
    );

    const result = await run(
      ["remove", "obra/superpowers:skills-code-review", "--bundle", "coding", "--tool", "opencode"],
      { cwd: projectRoot, samxHome }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Ambiguous bundle item");
    const bundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundle).toContain("skills-code-review");
    expect(bundle).toContain("agents-reviewer");
  });

  test("top-level remove leaves project unlinked when bundle becomes empty", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-cli-home-"));
    const { projectRoot } = await createSuperpowersFixture({ samxHome });
    await run(["pkg", "install", "obra/superpowers"], { cwd: projectRoot, samxHome });
    await run(["bundle", "create", "coding"], { cwd: projectRoot, samxHome });
    await run(["bundle", "add", "coding", "obra/superpowers:skills-code-review"], {
      cwd: projectRoot,
      samxHome,
    });
    await run(["link", "coding", "--tool", "opencode", "--project", projectRoot], {
      cwd: projectRoot,
      samxHome,
    });

    const result = await run(
      ["remove", "obra/superpowers:skills-code-review", "--bundle", "coding", "--tool", "opencode"],
      { cwd: projectRoot, samxHome }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Bundle is empty: coding. Project left unlinked.");
    await expect(
      stat(join(projectRoot, ".opencode", "skills", "default-obra-superpowers-skills-code-review"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    const bundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
    expect(bundle).not.toContain("skills-code-review");
  });
});
