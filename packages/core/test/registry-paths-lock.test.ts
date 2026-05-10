import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  addTrustedRegistry,
  readSamxLock,
  removeFormulaFromSamxLock,
  samxPaths,
  upsertFormulaInSamxLock,
} from "./internal.js";

const formula = {
  id: "default/example/safe-bash",
  formulaPath: "formulas/example/safe-bash.yaml",
  formulaHash: `sha256:${"a".repeat(64)}`,
  source: {
    type: "git" as const,
    url: "https://github.com/example/safe-bash.git",
    revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  capabilities: ["safe-bash"],
};

describe("registry-first store paths", () => {
  test("builds registry, package, recipe, capability, bundle, and link paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-paths-"));
    const paths = samxPaths(root);

    expect(paths.root).toBe(root);
    expect(paths.registriesDir).toBe(join(root, "registries"));
    expect(paths.registryRoot("community")).toBe(join(root, "registries", "community"));
    expect(paths.packagesDir).toBe(join(root, "packages"));
    expect(paths.packageRoot("community", "example/safe-bash")).toBe(
      join(root, "packages", "community", "example", "safe-bash")
    );
    expect(paths.recipeLock("community", "example/safe-bash")).toBe(
      join(root, "packages", "community", "example", "safe-bash", "recipe.lock.json")
    );
    expect(paths.recipeAuditDir("community", "example/safe-bash")).toBe(
      join(root, "packages", "community", "example", "safe-bash", "recipe-locks")
    );
    expect(paths.capabilities).toBe(join(root, "capabilities.json"));
    expect(paths.samxLock).toBe(join(root, "samx.lock"));
    expect(paths.bundleFile("coding")).toBe(join(root, "bundles", "coding.yaml"));
    expect(paths.linkRecords).toBe(join(root, "links", "project-links.json"));
  });

  test("rejects traversal ids for registry-first paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-traversal-"));
    const paths = samxPaths(root);

    for (const id of [
      "",
      "..",
      "../outside",
      "nested/package",
      "nested\\package",
      join(root, "absolute"),
    ]) {
      expect(() => paths.registryRoot(id)).toThrow("Invalid store id");
      expect(() => paths.packageRoot(id, "example/safe-bash")).toThrow("Invalid store id");
      expect(() => paths.bundleFile(id)).toThrow("Invalid store id");
    }
    for (const id of ["", "..", "../outside", "nested\\package", join(root, "absolute")]) {
      expect(() => paths.packageRoot("community", id)).toThrow("Invalid store path");
      expect(() => paths.recipeLock("community", id)).toThrow("Invalid store path");
      expect(() => paths.recipeAuditDir("community", id)).toThrow("Invalid store path");
    }
  });
});

describe("workspace samx.lock", () => {
  test("reads default lock, trusts registries, upserts formulas, and removes formulas", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-lock-"));

    await expect(readSamxLock({ samxHome: root })).resolves.toEqual({
      schemaVersion: 1,
      trustedRegistries: [],
      registries: {},
      formulas: [],
    });

    await addTrustedRegistry({ samxHome: root, registry: "z-community" });
    await addTrustedRegistry({ samxHome: root, registry: "alpha" });
    await addTrustedRegistry({ samxHome: root, registry: "community" });
    await addTrustedRegistry({ samxHome: root, registry: "community" });
    await upsertFormulaInSamxLock({
      samxHome: root,
      registry: {
        id: "community",
        url: "https://github.com/example/registry.git",
        commit: "abc123",
      },
      formula: { ...formula, id: "default/example/z-last" },
    });
    await upsertFormulaInSamxLock({
      samxHome: root,
      registry: {
        id: "community",
        url: "https://github.com/example/registry.git",
        commit: "abc123",
      },
      formula,
    });
    await upsertFormulaInSamxLock({
      samxHome: root,
      registry: {
        id: "community",
        url: "https://github.com/example/registry.git",
        commit: "def456",
      },
      formula: { ...formula, capabilities: ["safe-bash", "git-guard"] },
    });

    expect(await readSamxLock({ samxHome: root })).toEqual({
      schemaVersion: 1,
      trustedRegistries: ["alpha", "community", "z-community"],
      registries: {
        community: { url: "https://github.com/example/registry.git", commit: "def456" },
      },
      formulas: [
        { ...formula, capabilities: ["safe-bash", "git-guard"] },
        { ...formula, id: "default/example/z-last" },
      ],
    });

    await removeFormulaFromSamxLock({ samxHome: root, id: "default/example/safe-bash" });

    expect(await readSamxLock({ samxHome: root })).toEqual({
      schemaVersion: 1,
      trustedRegistries: ["alpha", "community", "z-community"],
      registries: {
        community: { url: "https://github.com/example/registry.git", commit: "def456" },
      },
      formulas: [{ ...formula, id: "default/example/z-last" }],
    });
  });
});
