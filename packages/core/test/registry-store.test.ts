import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vitest";

import {
  addRegistry,
  cloneOrFetchRegistry,
  ensureDefaultRegistry,
  getRegistry,
  gitHead,
  listRegistries,
  readSamxLock,
  registryManifestPath,
  registryUrlsEquivalent,
  removeRegistry,
  trustRegistry,
  writeSamxLock,
} from "./internal.js";

const defaultRegistryUrl = "https://github.com/c3qo/samx-registry.git";

describe("registry store", () => {
  test("resolves registry manifest path from injected home", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-path-"));

    expect(registryManifestPath(root)).toBe(join(root, "registries.json"));
  });

  test("adds, upserts, lists sorted registries, and writes registries.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-store-"));

    await addRegistry({ samxHome: root, id: "zeta", url: "https://example.test/zeta.git" });
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    const updated = await addRegistry({
      samxHome: root,
      id: "zeta",
      url: "https://example.test/zeta-v2.git",
    });

    expect(updated).toEqual({ id: "zeta", url: "https://example.test/zeta-v2.git" });
    expect(await listRegistries({ samxHome: root })).toEqual([
      { id: "default", url: defaultRegistryUrl, trusted: false },
      { id: "alpha", url: "https://example.test/alpha.git", trusted: false },
      { id: "zeta", url: "https://example.test/zeta-v2.git", trusted: false },
    ]);
    expect(JSON.parse(await readFile(join(root, "registries.json"), "utf8"))).toEqual({
      registries: [
        { id: "default", url: defaultRegistryUrl },
        { id: "alpha", url: "https://example.test/alpha.git" },
        { id: "zeta", url: "https://example.test/zeta-v2.git" },
      ],
    });
  });

  test("provides built-in default registry when manifest is missing or omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-default-"));

    await expect(listRegistries({ samxHome: root })).resolves.toEqual([
      { id: "default", url: defaultRegistryUrl, trusted: false },
    ]);
    await expect(getRegistry({ samxHome: root, id: "default" })).resolves.toEqual({
      id: "default",
      url: defaultRegistryUrl,
    });

    await writeFile(
      join(root, "registries.json"),
      JSON.stringify({ registries: [{ id: "local", url: "https://example.test/local.git" }] }),
      "utf8"
    );

    await expect(listRegistries({ samxHome: root })).resolves.toEqual([
      { id: "default", url: defaultRegistryUrl, trusted: false },
      { id: "local", url: "https://example.test/local.git", trusted: false },
    ]);
  });

  test("persists built-in default registry when ensured", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-ensure-default-"));
    await writeFile(join(root, "registries.json"), JSON.stringify({ registries: [] }), "utf8");

    await ensureDefaultRegistry({ samxHome: root });

    expect(JSON.parse(await readFile(join(root, "registries.json"), "utf8"))).toEqual({
      registries: [{ id: "default", url: defaultRegistryUrl }],
    });
  });

  test("rejects replacing built-in default registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-replace-default-"));

    await expect(
      addRegistry({ samxHome: root, id: "default", url: "https://example.test/default.git" })
    ).rejects.toThrow("Cannot replace built-in registry: default");
  });

  test("marks listed registries trusted after trustRegistry", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-trust-"));

    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await trustRegistry({ samxHome: root, id: "alpha" });

    expect(await getRegistry({ samxHome: root, id: "alpha" })).toEqual({
      id: "alpha",
      url: "https://example.test/alpha.git",
    });
    expect(await listRegistries({ samxHome: root })).toEqual([
      { id: "default", url: defaultRegistryUrl, trusted: false },
      { id: "alpha", url: "https://example.test/alpha.git", trusted: true },
    ]);
  });

  test("removes registry record, checkout, and lock metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-remove-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await addRegistry({ samxHome: root, id: "beta", url: "https://example.test/beta.git" });
    await trustRegistry({ samxHome: root, id: "alpha" });
    await mkdir(join(root, "registries", "alpha"), { recursive: true });
    await writeSamxLock(
      { samxHome: root },
      {
        schemaVersion: 1,
        trustedRegistries: ["alpha"],
        registries: { alpha: { url: "https://example.test/alpha.git", commit: "abc123" } },
        formulas: [],
      }
    );

    await removeRegistry({ samxHome: root, id: "alpha" });

    await expect(listRegistries({ samxHome: root })).resolves.toEqual([
      { id: "default", url: defaultRegistryUrl, trusted: false },
      { id: "beta", url: "https://example.test/beta.git", trusted: false },
    ]);
    await expect(readSamxLock({ samxHome: root })).resolves.toMatchObject({
      trustedRegistries: [],
      registries: {},
    });
    await expect(stat(join(root, "registries", "alpha"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects removing built-in default registry even with force", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-remove-default-"));

    await expect(removeRegistry({ samxHome: root, id: "default" })).rejects.toThrow(
      "Cannot remove built-in registry: default"
    );
    await expect(removeRegistry({ samxHome: root, id: "default", force: true })).rejects.toThrow(
      "Cannot remove built-in registry: default"
    );
  });

  test("rejects removing missing registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-remove-missing-"));

    await expect(removeRegistry({ samxHome: root, id: "missing" })).rejects.toThrow(
      "Registry not found: missing"
    );
  });

  test("rejects removing registry used by installed formula package", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-remove-used-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeSamxLock(
      { samxHome: root },
      {
        schemaVersion: 1,
        trustedRegistries: [],
        registries: { alpha: { url: "https://example.test/alpha.git", commit: "abc123" } },
        formulas: [
          {
            id: "alpha/example/safe-bash",
            formulaPath: "formulas/example/safe-bash.yaml",
            formulaHash: `sha256:${"a".repeat(64)}`,
            source: {
              type: "git",
              url: "https://example.test/safe-bash.git",
              revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            capabilities: ["alpha/example/safe-bash:lint"],
          },
        ],
      }
    );

    await expect(removeRegistry({ samxHome: root, id: "alpha" })).rejects.toThrow(
      "Registry is used by package: alpha/example/safe-bash"
    );
  });

  test("force removes registry but leaves installed formula lock entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-remove-force-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeSamxLock(
      { samxHome: root },
      {
        schemaVersion: 1,
        trustedRegistries: [],
        registries: { alpha: { url: "https://example.test/alpha.git", commit: "abc123" } },
        formulas: [
          {
            id: "alpha/example/safe-bash",
            formulaPath: "formulas/example/safe-bash.yaml",
            formulaHash: `sha256:${"a".repeat(64)}`,
            source: {
              type: "git",
              url: "https://example.test/safe-bash.git",
              revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            capabilities: ["alpha/example/safe-bash:lint"],
          },
        ],
      }
    );

    await removeRegistry({ samxHome: root, id: "alpha", force: true });

    await expect(listRegistries({ samxHome: root })).resolves.toEqual([
      { id: "default", url: defaultRegistryUrl, trusted: false },
    ]);
    await expect(readSamxLock({ samxHome: root })).resolves.toMatchObject({
      registries: {},
      formulas: [expect.objectContaining({ id: "alpha/example/safe-bash" })],
    });
  });

  test("validates ids and requires registry existence for get and trust", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-errors-"));

    await expect(
      addRegistry({ samxHome: root, id: "../outside", url: "https://example.test/registry.git" })
    ).rejects.toThrow("Invalid store id");
    await expect(getRegistry({ samxHome: root, id: "missing" })).rejects.toThrow(
      "Registry not found: missing"
    );
    await expect(trustRegistry({ samxHome: root, id: "missing" })).rejects.toThrow(
      "Registry not found: missing"
    );
  });

  test("rejects unsafe registry URL transports", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-url-"));

    await expect(
      addRegistry({ samxHome: root, id: "pwn", url: "ext::sh -c touch /tmp/pwned" })
    ).rejects.toThrow("Registry URL must use https, git, ssh, or file protocol");
  });

  test("rejects malformed registries.json entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-malformed-"));
    await writeFile(
      join(root, "registries.json"),
      JSON.stringify({
        registries: [{ id: "../outside", url: "https://example.test/registry.git" }],
      }),
      "utf8"
    );

    await expect(listRegistries({ samxHome: root })).rejects.toThrow();
  });
});

describe("registry git sync", () => {
  test("rejects existing registry checkout with different origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-git-mismatch-"));
    const firstSource = join(root, "first-source");
    const secondSource = join(root, "second-source");
    const checkout = join(root, "checkout");

    await createGitRepo(firstSource);
    await createGitRepo(secondSource);
    await cloneOrFetchRegistry(firstSource, checkout);

    await expect(cloneOrFetchRegistry(secondSource, checkout)).rejects.toThrow(
      `Registry checkout origin mismatch: ${checkout}`
    );
  });

  test("accepts equivalent origin URLs with trailing slashes and git suffixes", async () => {
    expect(
      registryUrlsEquivalent("https://example.test/org/repo.git", "https://example.test/org/repo/")
    ).toBe(true);
    expect(
      registryUrlsEquivalent("https://example.test/org/repo.git/", "https://example.test/org/repo")
    ).toBe(true);
    expect(
      registryUrlsEquivalent(
        "https://example.test/org/repo-a.git",
        "https://example.test/org/repo-b.git"
      )
    ).toBe(false);
  });

  test("creates parent directory before cloning registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-git-"));
    const source = join(root, "source");
    const clone = join(root, "nested", "registry");

    await createGitRepo(source);

    await cloneOrFetchRegistry(source, clone);

    expect(await gitHead(clone)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("rejects unsafe registry clone URL transports before invoking git", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-registry-git-url-"));

    await expect(
      cloneOrFetchRegistry("ext::sh -c touch /tmp/pwned", join(root, "checkout"))
    ).rejects.toThrow("Registry URL must use https, git, ssh, or file protocol");
  });
});

async function createGitRepo(path: string): Promise<void> {
  await execa("git", ["init", path]);
  await execa("git", ["config", "user.email", "samx@example.test"], { cwd: path });
  await execa("git", ["config", "user.name", "SAMX Test"], { cwd: path });
  await writeFile(join(path, "README.md"), "# Registry\n", "utf8");
  await execa("git", ["add", "."], { cwd: path });
  await execa("git", ["commit", "-m", "initial registry"], { cwd: path });
}
