import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  addBundleItem,
  createBundle,
  getBundle,
  listBundles,
  removeBundleItem,
  resolveBundleItem,
  samxPaths,
} from "./internal.js";

describe("bundle store", () => {
  test("creates, lists, shows, adds, and removes skill items", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundles-"));

    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });

    expect(await listBundles({ samxHome: root })).toEqual([
      expect.objectContaining({ id: "coding" }),
    ]);
    expect(await getBundle({ samxHome: root, id: "coding" })).toEqual({
      id: "coding",
      items: [{ id: "superpowers:skills-code-review", kind: "skill" }],
    });

    await removeBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
    });
    expect((await getBundle({ samxHome: root, id: "coding" })).items).toEqual([]);
  });

  test("rejects creating an existing bundle without losing existing items", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-existing-"));

    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });

    await expect(createBundle({ samxHome: root, id: "coding" })).rejects.toThrow(
      "Bundle already exists: coding"
    );
    expect((await getBundle({ samxHome: root, id: "coding" })).items).toEqual([
      { id: "superpowers:skills-code-review", kind: "skill" },
    ]);
  });

  test("stores bundle item aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-alias-"));

    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
      alias: "review-code",
    });

    expect((await getBundle({ samxHome: root, id: "coding" })).items).toEqual([
      { id: "superpowers:skills-code-review", kind: "skill", alias: "review-code" },
    ]);
  });

  test("resolves bundle items by id or alias and rejects ambiguous aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-resolve-"));

    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
      alias: "review",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:agents-review",
      kind: "agent",
      alias: "review",
    });

    await expect(
      resolveBundleItem({ samxHome: root, bundleId: "coding", idOrAlias: "pkg:skills-review" })
    ).resolves.toEqual({
      id: "pkg:skills-review",
      kind: "skill",
      alias: "review",
    });
    await expect(
      resolveBundleItem({ samxHome: root, bundleId: "coding", idOrAlias: "missing" })
    ).rejects.toThrow("Bundle item not found in coding: missing");
    await expect(
      resolveBundleItem({ samxHome: root, bundleId: "coding", idOrAlias: "review" })
    ).rejects.toThrow("Ambiguous bundle item in coding: review");
  });

  test("resolves canonical ids before alias matches and rejects collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-resolve-canonical-"));

    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "default/obra/superpowers:skills-code-review",
      kind: "skill",
      alias: "obra/superpowers:agents-reviewer",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "default/obra/superpowers:agents-reviewer",
      kind: "agent",
    });

    await expect(
      resolveBundleItem({
        samxHome: root,
        bundleId: "coding",
        idOrAlias: "obra/superpowers:agents-reviewer",
        canonicalId: "default/obra/superpowers:agents-reviewer",
      })
    ).rejects.toThrow("Ambiguous bundle item in coding: obra/superpowers:agents-reviewer");
  });

  test("throws clear errors for missing bundles and empty ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-errors-"));

    await expect(createBundle({ samxHome: root, id: "" })).rejects.toThrow("Bundle id is required");
    await expect(getBundle({ samxHome: root, id: "missing" })).rejects.toThrow(
      "Bundle not found: missing"
    );
    await expect(
      addBundleItem({ samxHome: root, bundleId: "missing", itemId: "skill-a", kind: "skill" })
    ).rejects.toThrow("Bundle not found: missing");
  });

  test("wraps malformed bundle files with file context", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-malformed-"));
    await createBundle({ samxHome: root, id: "broken" });
    await writeFile(samxPaths(root).bundleFile("broken"), "id: [", "utf8");

    await expect(getBundle({ samxHome: root, id: "broken" })).rejects.toThrow(
      "Could not parse bundle file"
    );
  });

  test("rejects duplicate item ids in manually edited bundle files", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-duplicates-"));
    await createBundle({ samxHome: root, id: "coding" });
    await writeFile(
      samxPaths(root).bundleFile("coding"),
      "id: coding\nitems:\n  - id: skill-a\n    kind: skill\n  - id: skill-a\n    kind: agent\n",
      "utf8"
    );

    await expect(getBundle({ samxHome: root, id: "coding" })).rejects.toThrow(
      "Could not parse bundle file: " +
        samxPaths(root).bundleFile("coding") +
        ". Duplicate bundle item id: skill-a"
    );
  });

  test("rejects bundle ids that do not match the requested file", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-bundle-id-mismatch-"));
    await createBundle({ samxHome: root, id: "coding" });
    await writeFile(samxPaths(root).bundleFile("coding"), "id: other\nitems: []\n", "utf8");

    await expect(getBundle({ samxHome: root, id: "coding" })).rejects.toThrow(
      "Could not parse bundle file: " +
        samxPaths(root).bundleFile("coding") +
        ". Bundle id mismatch: expected coding, found other"
    );
  });
});
