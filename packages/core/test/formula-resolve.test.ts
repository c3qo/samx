import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { execa } from "execa";

import {
  addRegistry,
  readFormula,
  resolveFormula,
  searchFormulas,
  splitFormulaId,
  trustRegistry,
} from "./internal.js";

describe("formula read/search/resolve", () => {
  test("reads formula by fully qualified id and checks filename id match", async () => {
    const rawFormula = formulaYaml("example/safe-bash", { name: "Safe Bash" });
    const root = await createFormulaRegistry("alpha", "example/safe-bash", { name: "Safe Bash" });

    await expect(
      readFormula({ samxHome: root, id: "alpha/example/safe-bash" })
    ).resolves.toMatchObject({
      id: "example/safe-bash",
      name: "Safe Bash",
      raw: rawFormula,
    });
    await expect(readFormula({ samxHome: root, id: "alpha/example/mismatch" })).rejects.toThrow(
      "Formula id mismatch"
    );
  });

  test("splits registry-qualified owner repo formula ids", () => {
    expect(splitFormulaId("community/obra/superpowers")).toEqual({
      registry: "community",
      formula: "obra/superpowers",
    });
  });

  test("rejects unsafe formula refs", () => {
    expect(() => splitFormulaId("community/superpowers")).toThrow(
      "Formula id must be <registry>/<owner>/<repo>"
    );
    expect(() => splitFormulaId("community/../superpowers")).toThrow("Invalid formula id");
    expect(() => splitFormulaId("community/obra/superpowers/extra")).toThrow(
      "Formula id must be <registry>/<owner>/<repo>"
    );
    expect(() => splitFormulaId("community/obra\\superpowers")).toThrow("Invalid formula id");
  });

  test("searches registry formulas by id name and description", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-formula-search-"));
    await addRegistry({ samxHome: root, id: "beta", url: "https://example.test/beta.git" });
    await writeFormula(root, "beta", "example/zeta", {
      name: "Zeta Tools",
      description: "Shell safety helpers",
    });
    await writeFormula(root, "beta", "example/alpha", {
      name: "Alpha Tools",
      description: "Review workflows",
    });

    expect(await searchFormulas({ samxHome: root, query: "tools" })).toEqual([
      { id: "beta/example/alpha", name: "Alpha Tools", description: "Review workflows" },
      { id: "beta/example/zeta", name: "Zeta Tools", description: "Shell safety helpers" },
    ]);
    expect(await searchFormulas({ samxHome: root, query: "shell" })).toEqual([
      { id: "beta/example/zeta", name: "Zeta Tools", description: "Shell safety helpers" },
    ]);
  });

  test("reads and searches nested formula files", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-formula-nested-"));
    await addRegistry({ samxHome: root, id: "local", url: "https://example.test/local.git" });
    await writeFormula(root, "local", "obra/superpowers", { name: "Superpowers" });

    await expect(
      readFormula({ samxHome: root, id: "local/obra/superpowers" })
    ).resolves.toMatchObject({
      id: "obra/superpowers",
      name: "Superpowers",
    });
    await expect(searchFormulas({ samxHome: root, query: "superpowers" })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "local/obra/superpowers" })])
    );
  });

  test("resolves registry formula without recipe security", async () => {
    const rawFormula = formulaYaml("example/safe-bash", {});
    const root = await createFormulaRegistry("alpha", "example/safe-bash", {});

    const recipe = await resolveFormula({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "abc123",
    });

    expect(recipe.id).toBe("alpha/example/safe-bash");
    expect(recipe.formula).toMatchObject({
      registry: "alpha",
      path: "formulas/example/safe-bash.yaml",
      registryUrl: "https://example.test/alpha.git",
      registryCommit: "abc123",
    });
    expect(recipe.formula.formulaHash).toBe(
      `sha256:${createHash("sha256").update(rawFormula).digest("hex")}`
    );
    expect(
      recipe.capabilities.map((capability) => ({
        id: capability.id,
        formulaCapabilityId: capability.formulaCapabilityId,
        kind: capability.kind,
      }))
    ).toEqual([{ id: "alpha/example/safe-bash:lint", formulaCapabilityId: "lint", kind: "skill" }]);
    expect(recipe).not.toHaveProperty("security");
  });

  test("resolves env requirements into recipe lock", async () => {
    const root = await createFormulaRegistry("alpha", "example/safe-bash", {
      requirements: "requirements:\n  env:\n    - GITHUB_TOKEN\n",
    });

    const recipe = await resolveFormula({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "abc123",
    });

    expect(recipe.requirements).toEqual({ env: ["GITHUB_TOKEN"] });
  });

  test("resolves trusted registry formula source revision override", async () => {
    const root = await createFormulaRegistry("alpha", "example/safe-bash", {});
    await trustRegistry({ samxHome: root, id: "alpha" });

    const recipe = await resolveFormula({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "abc123",
      sourceRevision: SHA_B,
    });

    expect(recipe.source).toMatchObject({ type: "git", revision: SHA_B });
    expect(recipe).not.toHaveProperty("security");
  });

  test("rejects malformed formula ids", () => {
    expect(() => splitFormulaId("missing-slash")).toThrow(
      "Formula id must be <registry>/<owner>/<repo>"
    );
    expect(() => splitFormulaId("alpha/")).toThrow("Formula id must be <registry>/<owner>/<repo>");
  });

  test("rejects file source urls from untrusted registries", async () => {
    const root = await createFormulaRegistry("alpha", "example/safe-bash", {
      sourceUrl: "file:///tmp/safe-bash.git",
    });

    await expect(
      resolveFormula({ samxHome: root, id: "alpha/example/safe-bash", registryCommit: SHA_A })
    ).rejects.toThrow("file:// source URLs require a local trusted registry");
  });

  test("allows file source urls from trusted registries", async () => {
    const root = await createFormulaRegistry("alpha", "example/safe-bash", {
      sourceUrl: "file:///tmp/safe-bash.git",
    });
    await trustRegistry({ samxHome: root, id: "alpha" });

    await expect(
      resolveFormula({ samxHome: root, id: "alpha/example/safe-bash", registryCommit: SHA_A })
    ).resolves.toMatchObject({ source: { url: "file:///tmp/safe-bash.git" } });
  });

  test("allows file source urls from local registries", async () => {
    const root = await createFormulaRegistry("alpha", "example/safe-bash", {
      registryUrl: "file:///tmp/alpha.git",
      sourceUrl: "file:///tmp/safe-bash.git",
    });

    await expect(
      resolveFormula({ samxHome: root, id: "alpha/example/safe-bash", registryCommit: SHA_A })
    ).resolves.toMatchObject({ source: { url: "file:///tmp/safe-bash.git" } });
  });

  test("resolves source HEAD from default branch when requested", async () => {
    const source = await createGitSourceWithTwoCommits();
    const root = await createFormulaRegistry("alpha", "example/safe-bash", {
      registryUrl: "file:///tmp/alpha.git",
      sourceUrl: `file://${source.path}`,
      revision: source.first,
    });

    await expect(
      resolveFormula({
        samxHome: root,
        id: "alpha/example/safe-bash",
        registryCommit: SHA_A,
        sourceHead: true,
      })
    ).resolves.toMatchObject({ source: { revision: source.second } });
  });

  test("resolves source ref branch or tag when requested", async () => {
    const source = await createGitSourceWithTwoCommits();
    const root = await createFormulaRegistry("alpha", "example/safe-bash", {
      registryUrl: "file:///tmp/alpha.git",
      sourceUrl: `file://${source.path}`,
      revision: source.first,
    });

    await expect(
      resolveFormula({
        samxHome: root,
        id: "alpha/example/safe-bash",
        registryCommit: SHA_A,
        sourceHead: true,
        sourceRef: "v2",
      })
    ).resolves.toMatchObject({ source: { revision: source.second } });
  });

  test("rejects invalid source ref names", async () => {
    const source = await createGitSourceWithTwoCommits();
    const root = await createFormulaRegistry("alpha", "example/safe-bash", {
      registryUrl: "file:///tmp/alpha.git",
      sourceUrl: `file://${source.path}`,
      revision: source.first,
    });

    await expect(
      resolveFormula({
        samxHome: root,
        id: "alpha/example/safe-bash",
        registryCommit: SHA_A,
        sourceHead: true,
        sourceRef: "refs/heads/main",
      })
    ).rejects.toThrow("Invalid source ref");
    await expect(
      resolveFormula({
        samxHome: root,
        id: "alpha/example/safe-bash",
        registryCommit: SHA_A,
        sourceHead: true,
        sourceRef: "release/v1",
      })
    ).rejects.toThrow("Invalid source ref");
  });
});

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function createFormulaRegistry(
  registry: string,
  formula: string,
  overrides: Record<string, unknown>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samx-formula-"));
  await addRegistry({
    samxHome: root,
    id: registry,
    url:
      typeof overrides.registryUrl === "string"
        ? overrides.registryUrl
        : `https://example.test/${registry}.git`,
  });
  await writeFormula(root, registry, formula, overrides);
  await writeFormula(root, registry, `${formula.split("/").slice(0, -1).join("/")}/mismatch`, {
    ...overrides,
    id: "example/different",
  });
  return root;
}

async function writeFormula(
  root: string,
  registry: string,
  formula: string,
  overrides: Record<string, unknown>
): Promise<void> {
  await mkdir(
    join(root, "registries", registry, "formulas", formula.split("/").slice(0, -1).join("/")),
    { recursive: true }
  );
  await writeFile(
    join(root, "registries", registry, "formulas", `${formula}.yaml`),
    formulaYaml(formula, overrides),
    "utf8"
  );
}

function formulaYaml(id: string, overrides: Record<string, unknown>): string {
  const name = typeof overrides.name === "string" ? overrides.name : "Safe Bash";
  const description =
    typeof overrides.description === "string" ? overrides.description : "Safe shell workflows";
  const formulaId = typeof overrides.id === "string" ? overrides.id : id;
  const sourceUrl =
    typeof overrides.sourceUrl === "string"
      ? overrides.sourceUrl
      : `https://example.test/${id}.git`;
  return `schemaVersion: 1
id: ${formulaId}
name: ${name}
description: ${description}
source:
  type: git
  url: ${sourceUrl}
  revision: ${SHA_A}
capabilities:
  - id: lint
    kind: skill
    path: skills/lint
${typeof overrides.requirements === "string" ? overrides.requirements : ""}
`;
}

async function createGitSourceWithTwoCommits(): Promise<{
  path: string;
  first: string;
  second: string;
}> {
  const path = await mkdtemp(join(tmpdir(), "samx-source-head-"));
  await execa("git", ["init", "-b", "main"], { cwd: path });
  await execa("git", ["config", "user.email", "test@example.test"], { cwd: path });
  await execa("git", ["config", "user.name", "Test"], { cwd: path });
  await mkdir(join(path, "skills", "lint"), { recursive: true });
  await writeFile(join(path, "skills", "lint", "SKILL.md"), "# Lint\n\nFirst.\n", "utf8");
  await execa("git", ["add", "."], { cwd: path });
  await execa("git", ["commit", "-m", "first"], { cwd: path });
  const { stdout: first } = await execa("git", ["rev-parse", "HEAD"], { cwd: path });
  await writeFile(join(path, "skills", "lint", "SKILL.md"), "# Lint\n\nSecond.\n", "utf8");
  await execa("git", ["add", "."], { cwd: path });
  await execa("git", ["commit", "-m", "second"], { cwd: path });
  await execa("git", ["tag", "v2"], { cwd: path });
  const { stdout: second } = await execa("git", ["rev-parse", "HEAD"], { cwd: path });
  return { path, first, second };
}
