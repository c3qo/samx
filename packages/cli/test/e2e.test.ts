import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { runCli } from "../src/index.js";

const fixture = new URL("./fixtures/messy-project/", import.meta.url);
const fixturePath = fileURLToPath(fixture);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    cwd: options.cwd ?? fixturePath,
    env: options.env ?? {},
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    probeRunner: async (command, args) => ({
      exitCode: command === "which" || args.includes("--version") ? 0 : 1,
      stdout: command === "which" ? `/usr/bin/${args[0] ?? "tool"}` : `${command} test-version`,
    }),
  });

  return { exitCode, stdout, stderr };
}

async function seededSamxHome(projectRoot: string): Promise<{ samxHome: string; capabilityRoot: string }> {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-e2e-home-"));
  const packageRoot = join(samxHome, "packages", "default", "acme", "tools");
  const sourceRoot = join(packageRoot, "source");
  const capabilityRoot = join(sourceRoot, "skills", "review");
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
          projectRoot,
          generatedFiles: [join(projectRoot, ".opencode", "skill", "review", "SKILL.md")],
          managedJsonEntries: [
            { path: join(projectRoot, ".opencode", "opencode.json"), keyPath: ["mcp"], key: "server" },
          ],
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
  return { samxHome, capabilityRoot };
}

test("analyze reports SAMX-managed inventory as json", async () => {
  const { samxHome } = await seededSamxHome(fixturePath);
  const result = await run(["analyze", "--json"], { env: { SAMX_HOME: samxHome } });

  expect(result.exitCode, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as {
    summary: { packages: number; capabilities: number; bundles: number; links: number };
    packages: Array<{ id: string; advisories: number }>;
    capabilities: Array<{ id: string; kind: string }>;
    findings: Array<{ id: string; category: string }>;
  };
  expect(report.summary).toMatchObject({ packages: 1, capabilities: 1, bundles: 1, links: 1 });
  expect(report.packages).toEqual([
    expect.objectContaining({ id: "default/acme/tools", advisories: 1 }),
  ]);
  expect(report.capabilities).toEqual([
    expect.objectContaining({ id: "default/acme/tools:review", kind: "skill" }),
  ]);
  expect(report.findings).toEqual([
    expect.objectContaining({ id: "package:default/acme/tools:advisory:0", category: "advisory" }),
  ]);
});

test("analyze terminal surfaces SAMX state", async () => {
  const { samxHome } = await seededSamxHome(fixturePath);

  const terminal = await run(["analyze"], { env: { SAMX_HOME: samxHome } });

  expect(terminal.exitCode, terminal.stderr).toBe(0);
  expect(terminal.stdout).toContain("SAMX Analyze Report");
  expect(terminal.stdout).toContain("default/acme/tools:review");
  expect(terminal.stdout).toContain("Review generated hook inventory.");
});

test("explicit fixture path scopes SAMX-managed links from pnpm filter package cwd", async () => {
  const { samxHome } = await seededSamxHome(fixturePath);
  const env = { PWD: repoRoot, SAMX_HOME: samxHome };

  const terminal = await run(["analyze", "test/fixtures/messy-project"], { cwd: packageRoot, env });
  const json = await run(["analyze", "test/fixtures/messy-project", "--json"], {
    cwd: packageRoot,
    env,
  });

  expect(terminal.exitCode, terminal.stderr).toBe(0);
  expect(terminal.stdout).toContain("Project:");
  expect(terminal.stdout).toContain("coding:opencode");
  expect(json.exitCode, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({
    projectRoot: resolve(fixturePath),
    summary: { bundles: 1, links: 1 },
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
