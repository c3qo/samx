import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { addLocalPackage } from "../src/packages/local.js";
import { getPackage, listPackages } from "../src/packages/store.js";

describe("formula package store listing", () => {
  test("lists formula-derived packages and supports getPackage", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-store-"));
    const packageRoot = join(root, "packages", "default", "obra", "superpowers");
    await mkdir(join(packageRoot, "source"), { recursive: true });
    await writeFile(
      join(packageRoot, "recipe.lock.json"),
      JSON.stringify(recipeLock("default/obra/superpowers")),
      "utf8"
    );

    await expect(listPackages({ samxHome: root })).resolves.toEqual([
      {
        id: "default/obra/superpowers",
        installKind: "formula",
        source: "https://example.test/superpowers.git",
        type: "git",
        ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        path: join(packageRoot, "source"),
        requirements: { env: [] },
        advisories: [
          {
            id: "candidate-validation",
            severity: "warning",
            category: "generation",
            message: "Formula candidate required generation advisories.",
            paths: [],
          },
        ],
      },
    ]);
    await expect(getPackage({ samxHome: root, id: "default/obra/superpowers" })).resolves.toEqual(
      expect.objectContaining({ id: "default/obra/superpowers", path: join(packageRoot, "source") })
    );
  });

  test("adds and lists local packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-local-package-store-"));
    const source = await mkdtemp(join(tmpdir(), "samx-local-package-source-"));
    const resolvedSource = await realpath(source);

    await addLocalPackage({ samxHome: root, id: "local-tools", source });

    await expect(listPackages({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        id: "local-tools",
        source: resolvedSource,
        type: "local",
        installKind: "local",
        path: resolvedSource,
      }),
    ]);
    await expect(getPackage({ samxHome: root, id: "local-tools" })).resolves.toEqual(
      expect.objectContaining({ id: "local-tools" })
    );
  });

  test("lists virtual formula packages without local source path", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-virtual-package-store-"));
    const packageRoot = join(root, "packages", "default", "obra", "virtual-tools");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "recipe.lock.json"),
      JSON.stringify({
        ...recipeLock("default/obra/virtual-tools"),
        source: {
          type: "virtual",
          origin: { type: "remote", url: "https://example.test/virtual-tools" },
        },
        capabilities: [
          {
            id: "default/obra/virtual-tools:server",
            formulaCapabilityId: "server",
            kind: "mcp",
            spec: {
              serverName: "server",
              transport: "remote",
              sourceFormat: "direct",
              config: { url: "https://example.test/mcp" },
            },
          },
        ],
      }),
      "utf8"
    );

    await expect(listPackages({ samxHome: root })).resolves.toEqual([
      {
        id: "default/obra/virtual-tools",
        installKind: "formula",
        source: "https://example.test/virtual-tools",
        type: "virtual",
        requirements: { env: [] },
        advisories: [
          {
            id: "candidate-validation",
            severity: "warning",
            category: "generation",
            message: "Formula candidate required generation advisories.",
            paths: [],
          },
        ],
      },
    ]);
  });
});

function recipeLock(id: string) {
  return {
    schemaVersion: 1,
    id,
    formula: {
      registry: "default",
      path: "formulas/obra/superpowers.yaml",
      registryUrl: "https://example.test/default.git",
      registryCommit: "reg123",
      formulaHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    source: {
      type: "git",
      url: "https://example.test/superpowers.git",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    capabilities: [
      { id: `${id}:review`, formulaCapabilityId: "review", kind: "skill", path: "skills/review" },
    ],
    advisories: [
      {
        id: "candidate-validation",
        severity: "warning",
        category: "generation",
        message: "Formula candidate required generation advisories.",
        paths: [],
      },
    ],
  };
}
