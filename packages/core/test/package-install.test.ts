import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vitest";

import {
  addBundleItem,
  addFormulaPackage,
  addLocalPackage,
  addRegistry,
  createBundle,
  listCapabilities,
  previewFormulaPackageUpdate,
  readSamxLock,
  regenerateCapabilities,
  removeFormulaPackage,
  trustRegistry,
  updateFormulaPackage,
  upsertLinkRecord,
  writeRecipeLocks,
} from "./internal.js";

describe("formula package install", () => {
  test("adds formula package with recipe locks, samx lock, materialized source, and capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-install-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash");

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      sourceRevision: SHA_B,
      now: new Date("2026-05-25T12:34:56.000Z"),
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await writeFile(
          join(destination, "skills", "lint", "SKILL.md"),
          "# Lint\n\nSafer shell linting.\n",
          "utf8"
        );
      },
    });

    const packageRoot = join(root, "packages", "alpha", "example/safe-bash");
    const recipe = JSON.parse(await readFile(join(packageRoot, "recipe.lock.json"), "utf8"));
    expect(recipe).toMatchObject({
      id: "alpha/example/safe-bash",
      formula: { registryCommit: "reg123" },
      source: { revision: SHA_B },
    });
    expect(await readdir(join(packageRoot, "recipe-locks"))).toEqual([
      "2026-05-25T12-34-56-000Z.recipe.lock.json",
    ]);
    await expect(
      stat(join(packageRoot, "source", "skills", "lint", "SKILL.md"))
    ).resolves.toBeTruthy();

    await expect(readSamxLock({ samxHome: root })).resolves.toMatchObject({
      registries: { alpha: { url: "https://example.test/alpha.git", commit: "reg123" } },
      formulas: [
        expect.objectContaining({
          id: "alpha/example/safe-bash",
          formulaPath: "formulas/example/safe-bash.yaml",
          source: expect.objectContaining({ revision: SHA_B }),
          capabilities: ["alpha/example/safe-bash:lint"],
        }),
      ],
    });
    const capabilities = await listCapabilities({ samxHome: root });
    expect(capabilities).toEqual([
      expect.objectContaining({
        id: "alpha/example/safe-bash:lint",
        registry: "alpha",
        formula: "example/safe-bash",
        package: "alpha/example/safe-bash",
        kind: "skill",
        packageId: "alpha/example/safe-bash",
        name: "lint",
        path: join(packageRoot, "source", "skills", "lint"),
        description: "Safer shell linting.",
        metadata: { body: "# Lint\n\nSafer shell linting.\n" },
      }),
    ]);
    const generated = JSON.parse(await readFile(join(root, "capabilities.json"), "utf8"));
    expect(Object.keys(generated.capabilities[0]).sort()).toEqual([
      "description",
      "formula",
      "id",
      "kind",
      "package",
      "path",
      "registry",
    ]);
  });

  test("persists formula advisories into recipe lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-install-advisory-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(
      root,
      "alpha",
      "example/safe-bash",
      "skills/lint",
      "skill",
      `https://example.test/example/safe-bash.git`,
      SHA_A,
      "community",
      `advisories:
  - id: candidate-validation
    severity: warning
    category: generation
    message: Formula candidate required generation advisories.
    paths: []`
    );

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await writeFile(join(destination, "skills", "lint", "SKILL.md"), "# Lint\n", "utf8");
      },
    });

    const recipe = JSON.parse(
      await readFile(
        join(root, "packages", "alpha", "example/safe-bash", "recipe.lock.json"),
        "utf8"
      )
    );
    expect(recipe.advisories).toEqual([
      expect.objectContaining({ id: "candidate-validation", severity: "warning" }),
    ]);
  });

  test("defaults registry commit to checked out registry HEAD", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-head-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash");
    await execa("git", ["init"], { cwd: join(root, "registries", "alpha") });
    await execa("git", ["config", "user.email", "test@example.test"], {
      cwd: join(root, "registries", "alpha"),
    });
    await execa("git", ["config", "user.name", "Test"], { cwd: join(root, "registries", "alpha") });
    await execa("git", ["add", "."], { cwd: join(root, "registries", "alpha") });
    await execa("git", ["commit", "-m", "formula"], { cwd: join(root, "registries", "alpha") });
    const { stdout: head } = await execa("git", ["rev-parse", "HEAD"], {
      cwd: join(root, "registries", "alpha"),
    });

    const recipe = await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await writeFile(join(destination, "skills", "lint", "SKILL.md"), "# Lint\n", "utf8");
      },
    });

    expect(recipe.formula.registryCommit).toBe(head);
    await expect(readSamxLock({ samxHome: root })).resolves.toMatchObject({
      registries: { alpha: { commit: head } },
    });
  });

  test("does not overwrite timestamped recipe audit records", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-audit-"));
    const recipe = recipeLock("alpha/example/safe-bash", "reg123");

    await writeRecipeLocks({
      samxHome: root,
      registry: "alpha",
      formula: "example/safe-bash",
      recipe,
      now: new Date("2026-05-25T12:34:56.000Z"),
    });

    await writeRecipeLocks({
      samxHome: root,
      registry: "alpha",
      formula: "example/safe-bash",
      recipe: recipeLock("alpha/example/safe-bash", "reg456"),
      now: new Date("2026-05-25T12:34:56.000Z"),
    });
    const audit = JSON.parse(
      await readFile(
        join(
          root,
          "packages",
          "alpha",
          "example/safe-bash",
          "recipe-locks",
          "2026-05-25T12-34-56-000Z.recipe.lock.json"
        ),
        "utf8"
      )
    );
    expect(audit.formula.registryCommit).toBe("reg123");
  });

  test("suffixes same-millisecond recipe audit records", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-audit-collision-"));
    const now = new Date("2026-05-25T12:34:56.000Z");

    await writeRecipeLocks({
      samxHome: root,
      registry: "alpha",
      formula: "example/safe-bash",
      recipe: recipeLock("alpha/example/safe-bash", "reg123"),
      now,
    });
    await writeRecipeLocks({
      samxHome: root,
      registry: "alpha",
      formula: "example/safe-bash",
      recipe: recipeLock("alpha/example/safe-bash", "reg456"),
      now,
    });

    await expect(
      readdir(join(root, "packages", "alpha", "example/safe-bash", "recipe-locks"))
    ).resolves.toEqual([
      "2026-05-25T12-34-56-000Z-1.recipe.lock.json",
      "2026-05-25T12-34-56-000Z.recipe.lock.json",
    ]);
  });

  test("indexes skill file formula paths as capability directories and reads description from file", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-file-path-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "skills/lint/SKILL.md");

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await writeFile(
          join(destination, "skills", "lint", "SKILL.md"),
          "# Lint\n\nSummary from skill file.\n",
          "utf8"
        );
      },
    });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        path: join(root, "packages", "alpha", "example/safe-bash", "source", "skills", "lint"),
        description: "Summary from skill file.",
      }),
    ]);
  });

  test("indexes directory formula paths using explicit and default entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-entry-path-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await mkdir(join(root, "registries", "alpha", "formulas", "example"), { recursive: true });
    await writeFile(
      join(root, "registries", "alpha", "formulas", "example", "safe-bash.yaml"),
      `schemaVersion: 1
id: example/safe-bash
name: Safe Bash
source:
  type: git
  url: https://example.test/safe-bash.git
  revision: ${SHA_A}
capabilities:
  - id: lint
    kind: skill
    path: skills/lint
  - id: reviewer
    kind: agent
    path: agents/reviewer
    entry: agent.md
`,
      "utf8"
    );

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await mkdir(join(destination, "agents", "reviewer"), { recursive: true });
        await writeFile(
          join(destination, "skills", "lint", "SKILL.md"),
          "# Lint\n\nSkill summary.\n",
          "utf8"
        );
        await writeFile(
          join(destination, "agents", "reviewer", "agent.md"),
          "# Reviewer\n\nAgent summary.\n",
          "utf8"
        );
      },
    });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        id: "alpha/example/safe-bash:lint",
        kind: "skill",
        path: join(root, "packages", "alpha", "example/safe-bash", "source", "skills", "lint"),
        description: "Skill summary.",
      }),
      expect.objectContaining({
        id: "alpha/example/safe-bash:reviewer",
        kind: "agent",
        path: join(root, "packages", "alpha", "example/safe-bash", "source", "agents", "reviewer"),
        description: "Agent summary.",
      }),
    ]);
  });

  test("maps generated MCP capability to legacy server config from source file", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-mcp-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "mcp/github/mcp.json", "mcp");

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "mcp", "github"), { recursive: true });
        await writeFile(
          join(destination, "mcp", "github", "mcp.json"),
          JSON.stringify({
            mcpServers: {
              github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
            },
          }),
          "utf8"
        );
      },
    });

    const capabilities = await listCapabilities({ samxHome: root });
    expect(capabilities).toEqual([
      expect.objectContaining({
        id: "alpha/example/safe-bash:lint",
        kind: "mcp",
        serverName: "github",
        config: expect.objectContaining({ command: "npx" }),
      }),
    ]);
    const generated = JSON.parse(await readFile(join(root, "capabilities.json"), "utf8"));
    expect(Object.keys(generated.capabilities[0]).sort()).toEqual([
      "formula",
      "id",
      "kind",
      "package",
      "path",
      "registry",
    ]);
  });

  test("indexes OpenCode MCP source format metadata from source file", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-opencode-mcp-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "mcp/github/mcp.json", "mcp");

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "mcp", "github"), { recursive: true });
        await writeFile(
          join(destination, "mcp", "github", "mcp.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: {
              github: {
                type: "local",
                command: ["npx", "-y", "@modelcontextprotocol/server-github"],
                environment: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
              },
            },
          }),
          "utf8"
        );
      },
    });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        id: "alpha/example/safe-bash:lint",
        kind: "mcp",
        serverName: "github",
        sourceFormat: "opencode",
        transport: "stdio",
        config: expect.objectContaining({ type: "local" }),
      }),
    ]);
  });

  test("indexes Claude API MCP connector source format metadata from source file", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-claude-api-mcp-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "mcp/github/mcp.json", "mcp");

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "mcp", "github"), { recursive: true });
        await writeFile(
          join(destination, "mcp", "github", "mcp.json"),
          JSON.stringify({
            mcp_servers: [
              {
                type: "url",
                url: "https://example.test/mcp",
                name: "github",
                authorization_token: "${GITHUB_TOKEN}",
              },
            ],
            tools: [
              { type: "mcp_toolset", mcp_server_name: "github", default_config: { enabled: true } },
            ],
          }),
          "utf8"
        );
      },
    });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        kind: "mcp",
        serverName: "github",
        sourceFormat: "claude-api",
        transport: "remote",
        config: expect.objectContaining({
          type: "url",
          url: "https://example.test/mcp",
          authorization_token: "${GITHUB_TOKEN}",
        }),
        metadata: expect.objectContaining({
          claudeToolset: expect.objectContaining({
            type: "mcp_toolset",
            mcp_server_name: "github",
          }),
        }),
      }),
    ]);
  });

  test("rejects Claude API MCP connector source file without matching toolset", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-claude-api-mcp-missing-toolset-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "mcp/github/mcp.json", "mcp");

    await expect(
      addFormulaPackage({
        samxHome: root,
        id: "alpha/example/safe-bash",
        registryCommit: "reg123",
        materialize: async ({ destination }) => {
          await mkdir(join(destination, "mcp", "github"), { recursive: true });
          await writeFile(
            join(destination, "mcp", "github", "mcp.json"),
            JSON.stringify({
              mcp_servers: [{ type: "url", url: "https://example.test/mcp", name: "github" }],
              tools: [],
            }),
            "utf8"
          );
        },
      })
    ).rejects.toThrow(/Claude API MCP config must contain exactly one toolset for server github:/u);
  });

  test("rejects Claude API MCP connector source file with duplicate toolsets", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-claude-api-mcp-duplicate-toolsets-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "mcp/github/mcp.json", "mcp");

    await expect(
      addFormulaPackage({
        samxHome: root,
        id: "alpha/example/safe-bash",
        registryCommit: "reg123",
        materialize: async ({ destination }) => {
          await mkdir(join(destination, "mcp", "github"), { recursive: true });
          await writeFile(
            join(destination, "mcp", "github", "mcp.json"),
            JSON.stringify({
              mcp_servers: [{ type: "url", url: "https://example.test/mcp", name: "github" }],
              tools: [
                { type: "mcp_toolset", mcp_server_name: "github" },
                { type: "mcp_toolset", mcp_server_name: "other" },
              ],
            }),
            "utf8"
          );
        },
      })
    ).rejects.toThrow(/Claude API MCP config must contain exactly one toolset for server github:/u);
  });

  test("indexes direct MCP source url as stdio transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-direct-mcp-url-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "mcp/github/mcp.json", "mcp");

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "mcp", "github"), { recursive: true });
        await writeFile(
          join(destination, "mcp", "github", "mcp.json"),
          JSON.stringify({ url: "https://example.test/mcp" }),
          "utf8"
        );
      },
    });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        kind: "mcp",
        sourceFormat: "direct",
        transport: "stdio",
        config: expect.objectContaining({ url: "https://example.test/mcp" }),
      }),
    ]);
  });

  test("indexes Claude local HTTP MCP source as remote transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-claude-http-mcp-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "mcp/airtable/mcp.json", "mcp");

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "mcp", "airtable"), { recursive: true });
        await writeFile(
          join(destination, "mcp", "airtable", "mcp.json"),
          JSON.stringify({
            mcpServers: { airtable: { type: "http", url: "https://mcp.airtable.com/mcp" } },
          }),
          "utf8"
        );
      },
    });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        kind: "mcp",
        serverName: "airtable",
        sourceFormat: "claude-local",
        transport: "remote",
        config: expect.objectContaining({ type: "http", url: "https://mcp.airtable.com/mcp" }),
      }),
    ]);
  });

  test("indexes direct named HTTP MCP source as remote transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-direct-http-mcp-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "mcp/airtable/mcp.json", "mcp");

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "mcp", "airtable"), { recursive: true });
        await writeFile(
          join(destination, "mcp", "airtable", "mcp.json"),
          JSON.stringify({ airtable: { type: "http", url: "https://mcp.airtable.com/mcp" } }),
          "utf8"
        );
      },
    });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        kind: "mcp",
        serverName: "airtable",
        sourceFormat: "direct",
        transport: "remote",
        config: expect.objectContaining({ type: "http", url: "https://mcp.airtable.com/mcp" }),
      }),
    ]);
  });

  test("indexes direct SSE MCP source as remote transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-direct-sse-mcp-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "mcp/weather/mcp.json", "mcp");

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "mcp", "weather"), { recursive: true });
        await writeFile(
          join(destination, "mcp", "weather", "mcp.json"),
          JSON.stringify({ type: "sse", url: "https://weather.example/sse" }),
          "utf8"
        );
      },
    });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        kind: "mcp",
        sourceFormat: "direct",
        transport: "remote",
        config: expect.objectContaining({ type: "sse", url: "https://weather.example/sse" }),
      }),
    ]);
  });

  test("maps generated MCP capability from directory formula path to entry file", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-mcp-dir-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "mcp/github", "mcp");

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "mcp", "github"), { recursive: true });
        await writeFile(
          join(destination, "mcp", "github", "mcp.json"),
          JSON.stringify({ mcpServers: { github: { command: "node" } } }),
          "utf8"
        );
      },
    });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        id: "alpha/example/safe-bash:lint",
        kind: "mcp",
        serverName: "github",
        config: expect.objectContaining({ command: "node" }),
        path: join(
          root,
          "packages",
          "alpha",
          "example/safe-bash",
          "source",
          "mcp",
          "github",
          "mcp.json"
        ),
      }),
    ]);
  });

  test("rejects malformed generated capabilities index", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-bad-capabilities-"));
    await writeFile(
      join(root, "capabilities.json"),
      JSON.stringify({ capabilities: [{ id: "missing-fields" }] }),
      "utf8"
    );

    await expect(listCapabilities({ samxHome: root })).rejects.toThrow();
  });

  test("reads canonical capability index shape from capabilities file", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-canonical-capabilities-"));
    await writeFile(
      join(root, "capabilities.json"),
      JSON.stringify({
        capabilities: [
          {
            id: "alpha/example/safe-bash:lint",
            packageId: "alpha/example/safe-bash",
            name: "lint",
            kind: "skill",
            path: "/tmp/lint",
            metadata: { body: "# Lint\n" },
            hooks: [],
          },
        ],
      }),
      "utf8"
    );

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        id: "alpha/example/safe-bash:lint",
        packageId: "alpha/example/safe-bash",
        name: "lint",
        kind: "skill",
        path: "/tmp/lint",
      }),
    ]);
  });

  test("regenerates formula hook entries onto indexed capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-formula-hooks-"));
    const packageRoot = join(root, "packages", "alpha", "example/safe-bash");
    await mkdir(join(packageRoot, "source", "skills", "lint"), { recursive: true });
    await mkdir(join(packageRoot, "source", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "source", "skills", "lint", "SKILL.md"), "# Lint\n", "utf8");
    await writeFile(
      join(packageRoot, "source", "hooks", "safe-bash.js"),
      "export default {}\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "recipe.lock.json"),
      JSON.stringify({
        ...recipeLock("alpha/example/safe-bash", "reg123"),
        hooks: {
          mode: "explicit",
          entries: [
            {
              id: "example/safe-bash",
              appliesTo: ["skill:lint"],
              files: [{ target: "opencode", path: "hooks/safe-bash.js" }],
              required: false,
            },
          ],
        },
      }),
      "utf8"
    );

    await regenerateCapabilities({ samxHome: root });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        id: "alpha/example/safe-bash:lint",
        hooks: [
          expect.objectContaining({
            id: "example/safe-bash",
            packageId: "alpha/example/safe-bash",
            tool: "opencode",
            file: join(packageRoot, "source", "hooks", "safe-bash.js"),
            appliesTo: ["skill:lint"],
          }),
        ],
      }),
    ]);
  });

  test("adds virtual MCP formula package without materializing source and indexes spec capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-virtual-mcp-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeVirtualMcpFormula(root, "alpha", "example/virtual-github");

    const recipe = await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/virtual-github",
      registryCommit: "reg123",
      materialize: async () => {
        throw new Error("virtual sources must not materialize");
      },
    });

    const packageRoot = join(root, "packages", "alpha", "example/virtual-github");
    expect(recipe.source).toEqual({
      type: "virtual",
      origin: { type: "remote", url: "https://example.test/mcp" },
    });
    await expect(stat(join(packageRoot, "source"))).rejects.toMatchObject({ code: "ENOENT" });
    const lockedRecipe = JSON.parse(await readFile(join(packageRoot, "recipe.lock.json"), "utf8"));
    expect(lockedRecipe.source).toEqual(recipe.source);
    await expect(readSamxLock({ samxHome: root })).resolves.toMatchObject({
      formulas: [
        expect.objectContaining({
          id: "alpha/example/virtual-github",
          source: recipe.source,
          capabilities: ["alpha/example/virtual-github:github"],
        }),
      ],
    });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        id: "alpha/example/virtual-github:github",
        kind: "mcp",
        packageId: "alpha/example/virtual-github",
        name: "github",
        serverName: "github",
        sourceFormat: "direct",
        transport: "remote",
        config: { url: "https://example.test/mcp" },
        description: "Virtual GitHub MCP.",
      }),
    ]);
    expect(await listCapabilities({ samxHome: root })).not.toEqual([
      expect.objectContaining({ path: expect.any(String) }),
    ]);
    const generated = JSON.parse(await readFile(join(root, "capabilities.json"), "utf8"));
    expect(generated.capabilities).toEqual([
      expect.objectContaining({
        id: "alpha/example/virtual-github:github",
        kind: "mcp",
        serverName: "github",
        sourceFormat: "direct",
        transport: "remote",
        config: { url: "https://example.test/mcp" },
        description: "Virtual GitHub MCP.",
      }),
    ]);
    expect(generated.capabilities[0]).not.toHaveProperty("path");
  });

  test("does not write partial package state when invalid virtual recipe fails validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-invalid-virtual-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeVirtualMcpFormula(
      root,
      "alpha",
      "example/bad-virtual",
      `transport: remote
        config:
          command: node`
    );

    await expect(
      addFormulaPackage({
        samxHome: root,
        id: "alpha/example/bad-virtual",
        registryCommit: "reg123",
      })
    ).rejects.toThrow();

    await expect(
      readFile(join(root, "packages", "alpha", "example/bad-virtual", "recipe.lock.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readSamxLock({ samxHome: root })).resolves.toMatchObject({ formulas: [] });
  });

  test("cleans new virtual package state when capability regeneration fails after locks are written", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-virtual-regen-failure-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeVirtualMcpFormula(root, "alpha", "example/virtual-github");
    await mkdir(join(root, "capabilities.json"));

    await expect(
      addFormulaPackage({
        samxHome: root,
        id: "alpha/example/virtual-github",
        registryCommit: "reg123",
      })
    ).rejects.toThrow();

    const packageRoot = join(root, "packages", "alpha", "example/virtual-github");
    await expect(readFile(join(packageRoot, "recipe.lock.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readSamxLock({ samxHome: root })).resolves.toMatchObject({ formulas: [] });
    await expect(stat(join(packageRoot, "source"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects generated capabilities containing legacy type field", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-type-capabilities-"));
    await writeFile(
      join(root, "capabilities.json"),
      JSON.stringify({
        capabilities: [
          {
            id: "alpha/example/safe-bash:lint",
            registry: "alpha",
            formula: "example/safe-bash",
            package: "alpha/example/safe-bash",
            kind: "skill",
            type: "mcp",
            path: "/tmp/skill",
          },
        ],
      }),
      "utf8"
    );

    await expect(listCapabilities({ samxHome: root })).rejects.toThrow();
  });

  test("rejects generated capabilities containing MCP extras", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-extra-capabilities-"));
    await writeFile(
      join(root, "capabilities.json"),
      JSON.stringify({
        capabilities: [
          {
            id: "alpha/example/safe-bash:mcp",
            registry: "alpha",
            formula: "example/safe-bash",
            package: "alpha/example/safe-bash",
            kind: "mcp",
            path: "/tmp/mcp.json",
            serverName: "github",
            config: {},
          },
        ],
      }),
      "utf8"
    );

    await expect(listCapabilities({ samxHome: root })).rejects.toThrow();
  });

  test("rejects tampered recipe lock paths during capability regeneration", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-tampered-lock-"));
    await mkdir(join(root, "packages", "alpha", "example/safe-bash"), { recursive: true });
    await writeFile(
      join(root, "packages", "alpha", "example/safe-bash", "recipe.lock.json"),
      JSON.stringify({
        ...recipeLock("alpha/example/safe-bash", "reg123"),
        capabilities: [
          {
            id: "alpha/example/safe-bash:lint",
            formulaCapabilityId: "lint",
            kind: "skill",
            path: "../../outside",
          },
        ],
      }),
      "utf8"
    );

    await expect(regenerateCapabilities({ samxHome: root })).rejects.toThrow();
  });

  test("rejects capability paths that escape package source through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-symlink-escape-"));
    const packageRoot = join(root, "packages", "alpha", "example/safe-bash");
    const outside = join(root, "outside");
    await mkdir(join(packageRoot, "source"), { recursive: true });
    await mkdir(join(outside, "skill"), { recursive: true });
    await writeFile(join(outside, "skill", "SKILL.md"), "# Escaped\n", "utf8");
    await symlink(outside, join(packageRoot, "source", "linked"));
    await writeFile(
      join(packageRoot, "recipe.lock.json"),
      JSON.stringify({
        ...recipeLock("alpha/example/safe-bash", "reg123"),
        capabilities: [
          {
            id: "alpha/example/safe-bash:lint",
            formulaCapabilityId: "lint",
            kind: "skill",
            path: "linked/skill",
          },
        ],
      }),
      "utf8"
    );

    await expect(regenerateCapabilities({ samxHome: root })).rejects.toThrow(
      "escapes package source"
    );
  });

  test("does not write recipe or samx lock when add validation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-add-validation-failure-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash", "linked/skill");

    await expect(
      addFormulaPackage({
        samxHome: root,
        id: "alpha/example/safe-bash",
        registryCommit: "reg123",
        materialize: async ({ destination }) => {
          const outside = join(root, "outside");
          await mkdir(join(outside, "skill"), { recursive: true });
          await writeFile(join(outside, "skill", "SKILL.md"), "# Escaped\n", "utf8");
          await mkdir(destination, { recursive: true });
          await symlink(outside, join(destination, "linked"));
        },
      })
    ).rejects.toThrow("escapes package source");

    await expect(
      readFile(join(root, "packages", "alpha", "example/safe-bash", "recipe.lock.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readSamxLock({ samxHome: root })).resolves.toMatchObject({ formulas: [] });
  });

  test("keeps existing source and recipe lock when update materialize fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-update-failure-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash");
    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      sourceRevision: SHA_A,
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await writeFile(
          join(destination, "skills", "lint", "SKILL.md"),
          "# Lint\n\nOriginal.\n",
          "utf8"
        );
      },
    });

    await expect(
      updateFormulaPackage({
        samxHome: root,
        id: "alpha/example/safe-bash",
        registryCommit: "reg456",
        sourceRevision: SHA_B,
        materialize: async () => {
          throw new Error("materialize failed");
        },
      })
    ).rejects.toThrow("materialize failed");

    const packageRoot = join(root, "packages", "alpha", "example/safe-bash");
    await expect(
      readFile(join(packageRoot, "source", "skills", "lint", "SKILL.md"), "utf8")
    ).resolves.toContain("Original.");
    const recipe = JSON.parse(await readFile(join(packageRoot, "recipe.lock.json"), "utf8"));
    expect(recipe.formula.registryCommit).toBe("reg123");
    expect(recipe.source.revision).toBe(SHA_A);
  });

  test("keeps existing source and recipe lock when virtual update fails after source replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-virtual-update-failure-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash");
    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      sourceRevision: SHA_A,
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await writeFile(
          join(destination, "skills", "lint", "SKILL.md"),
          "# Lint\n\nOriginal.\n",
          "utf8"
        );
      },
    });
    await writeVirtualMcpFormula(root, "alpha", "example/safe-bash");
    await rm(join(root, "capabilities.json"));
    await mkdir(join(root, "capabilities.json"));

    await expect(
      updateFormulaPackage({
        samxHome: root,
        id: "alpha/example/safe-bash",
        registryCommit: "reg456",
      })
    ).rejects.toThrow();

    const packageRoot = join(root, "packages", "alpha", "example/safe-bash");
    await expect(
      readFile(join(packageRoot, "source", "skills", "lint", "SKILL.md"), "utf8")
    ).resolves.toContain("Original.");
    const recipe = JSON.parse(await readFile(join(packageRoot, "recipe.lock.json"), "utf8"));
    expect(recipe.formula.registryCommit).toBe("reg123");
    expect(recipe.source.type).toBe("git");
    expect(recipe.source.revision).toBe(SHA_A);
  });

  test("keeps virtual recipe lock when git update fails after source replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-git-update-from-virtual-failure-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeVirtualMcpFormula(root, "alpha", "example/safe-bash");
    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
    });
    await writeFormula(root, "alpha", "example/safe-bash");
    await rm(join(root, "capabilities.json"));
    await mkdir(join(root, "capabilities.json"));

    await expect(
      updateFormulaPackage({
        samxHome: root,
        id: "alpha/example/safe-bash",
        registryCommit: "reg456",
        sourceRevision: SHA_A,
        materialize: async ({ destination }) => {
          await mkdir(join(destination, "skills", "lint"), { recursive: true });
          await writeFile(
            join(destination, "skills", "lint", "SKILL.md"),
            "# Lint\n\nGit replacement.\n",
            "utf8"
          );
        },
      })
    ).rejects.toThrow();

    const packageRoot = join(root, "packages", "alpha", "example/safe-bash");
    await expect(stat(join(packageRoot, "source"))).rejects.toMatchObject({ code: "ENOENT" });
    const recipe = JSON.parse(await readFile(join(packageRoot, "recipe.lock.json"), "utf8"));
    expect(recipe.formula.registryCommit).toBe("reg123");
    expect(recipe.source.type).toBe("virtual");
    await expect(readSamxLock({ samxHome: root })).resolves.toMatchObject({
      formulas: [
        expect.objectContaining({
          id: "alpha/example/safe-bash",
          source: expect.objectContaining({ type: "virtual" }),
        }),
      ],
    });
  });

  test("previews formula package update field changes before applying", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-update-preview-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash");
    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await writeFile(join(destination, "skills", "lint", "SKILL.md"), "# Lint\n", "utf8");
      },
    });
    await writeFormula(
      root,
      "alpha",
      "example/safe-bash",
      "skills/format",
      "skill",
      "https://example.test/safe-bash-renamed.git",
      SHA_B
    );

    const preview = await previewFormulaPackageUpdate({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(preview.id).toBe("alpha/example/safe-bash");
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        {
          field: "registryCommit",
          before: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          after: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        {
          field: "source.url",
          before: "https://example.test/example/safe-bash.git",
          after: "https://example.test/safe-bash-renamed.git",
        },
        { field: "source.revision", before: SHA_A, after: SHA_B },
        expect.objectContaining({ field: "formulaHash" }),
      ])
    );
  });

  test("removes formula package and regenerates samx lock and capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-remove-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash");
    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await writeFile(join(destination, "skills", "lint", "SKILL.md"), "# Lint\n", "utf8");
      },
    });

    await removeFormulaPackage({ samxHome: root, id: "alpha/example/safe-bash" });

    await expect(stat(join(root, "packages", "alpha", "example/safe-bash"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readSamxLock({ samxHome: root })).resolves.toMatchObject({ formulas: [] });
    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([]);
  });

  test("refuses to remove formula package while bundles reference its capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-remove-bundle-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash");
    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await writeFile(join(destination, "skills", "lint", "SKILL.md"), "# Lint\n", "utf8");
      },
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "alpha/example/safe-bash:lint",
      kind: "skill",
    });

    await expect(
      removeFormulaPackage({ samxHome: root, id: "alpha/example/safe-bash" })
    ).rejects.toThrow("Package is used by bundle: coding");
    await expect(stat(join(root, "packages", "alpha", "example/safe-bash"))).resolves.toBeTruthy();
  });

  test("refuses to remove formula package while link records reference it unless forced", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-remove-linked-"));
    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(root, "alpha", "example/safe-bash");
    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: "reg123",
      materialize: async ({ destination }) => {
        await mkdir(join(destination, "skills", "lint"), { recursive: true });
        await writeFile(join(destination, "skills", "lint", "SKILL.md"), "# Lint\n", "utf8");
      },
    });
    await upsertLinkRecord(
      { samxHome: root },
      {
        id: "coding:opencode:/tmp/project",
        bundleId: "coding",
        tool: "opencode",
        projectRoot: "/tmp/project",
        generatedFiles: [
          join(root, "packages", "alpha", "example/safe-bash", "source", "skills", "lint"),
        ],
        managedJsonEntries: [],
        managedHooks: [],
        adjacentHooks: [],
        createdAt: "2026-05-25T00:00:00.000Z",
      }
    );

    await expect(
      removeFormulaPackage({ samxHome: root, id: "alpha/example/safe-bash" })
    ).rejects.toThrow("Package is linked: coding:opencode:/tmp/project");
    await expect(
      removeFormulaPackage({ samxHome: root, id: "alpha/example/safe-bash", force: true })
    ).resolves.toBeUndefined();
    await expect(stat(join(root, "packages", "alpha", "example/safe-bash"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("default materializer checks out the locked source revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-revision-"));
    const remote = join(root, "remote");
    await mkdir(remote, { recursive: true });
    await execa("git", ["init"], { cwd: remote });
    await execa("git", ["config", "user.email", "test@example.test"], { cwd: remote });
    await execa("git", ["config", "user.name", "Test"], { cwd: remote });
    await mkdir(join(remote, "skills", "lint"), { recursive: true });
    await writeFile(join(remote, "skills", "lint", "SKILL.md"), "# Locked\n", "utf8");
    await execa("git", ["add", "."], { cwd: remote });
    await execa("git", ["commit", "-m", "source"], { cwd: remote });
    const { stdout: lockedRevision } = await execa("git", ["rev-parse", "HEAD"], { cwd: remote });
    await writeFile(join(remote, "skills", "lint", "SKILL.md"), "# Moved\n", "utf8");
    await execa("git", ["add", "."], { cwd: remote });
    await execa("git", ["commit", "-m", "move"], { cwd: remote });

    await addRegistry({ samxHome: root, id: "alpha", url: "https://example.test/alpha.git" });
    await writeFormula(
      root,
      "alpha",
      "example/safe-bash",
      "skills/lint",
      "skill",
      `file://${remote}`,
      lockedRevision,
      "local"
    );
    await trustRegistry({ samxHome: root, id: "alpha" });

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: SHA_A,
    });

    await expect(
      readFile(
        join(
          root,
          "packages",
          "alpha",
          "example/safe-bash",
          "source",
          "skills",
          "lint",
          "SKILL.md"
        ),
        "utf8"
      )
    ).resolves.toBe("# Locked\n");
  });

  test("adds formula package from source head override", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-source-head-"));
    const source = await createGitSourceWithTwoCommits(root);
    await addRegistry({ samxHome: root, id: "alpha", url: "file:///tmp/alpha.git" });
    await writeFormula(
      root,
      "alpha",
      "example/safe-bash",
      "skills/lint",
      "skill",
      `file://${source.path}`,
      source.first,
      "local"
    );

    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: SHA_A,
      sourceHead: true,
    });

    const recipe = JSON.parse(
      await readFile(
        join(root, "packages", "alpha", "example/safe-bash", "recipe.lock.json"),
        "utf8"
      )
    );
    expect(recipe.source.revision).toBe(source.second);
    await expect(
      readFile(
        join(
          root,
          "packages",
          "alpha",
          "example/safe-bash",
          "source",
          "skills",
          "lint",
          "SKILL.md"
        ),
        "utf8"
      )
    ).resolves.toContain("Second.");
  });

  test("previews source head update revision changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-package-source-head-preview-"));
    const source = await createGitSourceWithTwoCommits(root);
    await addRegistry({ samxHome: root, id: "alpha", url: "file:///tmp/alpha.git" });
    await writeFormula(
      root,
      "alpha",
      "example/safe-bash",
      "skills/lint",
      "skill",
      `file://${source.path}`,
      source.first,
      "local"
    );
    await addFormulaPackage({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: SHA_A,
    });

    const preview = await previewFormulaPackageUpdate({
      samxHome: root,
      id: "alpha/example/safe-bash",
      registryCommit: SHA_A,
      sourceHead: true,
    });

    expect(preview.changes).toContainEqual({
      field: "source.revision",
      before: source.first,
      after: source.second,
    });
  });

  test("indexes local package skills agents and mcp servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-local-package-index-"));
    const source = await mkdtemp(join(tmpdir(), "samx-local-package-source-"));
    await mkdir(join(source, "skills", "review"), { recursive: true });
    await mkdir(join(source, "agents", "reviewer"), { recursive: true });
    await mkdir(join(source, "mcp", "github"), { recursive: true });
    await writeFile(
      join(source, "skills", "review", "SKILL.md"),
      "# Review\n\nReview code.\n",
      "utf8"
    );
    await writeFile(
      join(source, "agents", "reviewer", "AGENT.md"),
      "# Reviewer\n\nReview agent.\n",
      "utf8"
    );
    await writeFile(
      join(source, "mcp", "github", "mcp.json"),
      JSON.stringify({ command: "node", args: ["server.js"] }),
      "utf8"
    );

    await addLocalPackage({ samxHome: root, id: "local-tools", source });

    await expect(listCapabilities({ samxHome: root })).resolves.toEqual([
      expect.objectContaining({
        id: "local-tools:agents-reviewer",
        kind: "agent",
        packageId: "local-tools",
        name: "reviewer",
      }),
      expect.objectContaining({
        id: "local-tools:mcp-github",
        kind: "mcp",
        packageId: "local-tools",
        serverName: "github",
      }),
      expect.objectContaining({
        id: "local-tools:skills-review",
        kind: "skill",
        packageId: "local-tools",
        name: "review",
      }),
    ]);
  });
});

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function writeFormula(
  root: string,
  registry: string,
  formula: string,
  capabilityPath = "skills/lint",
  kind = "skill",
  sourceUrl = `https://example.test/${formula}.git`,
  revision = SHA_A,
  _trustLevel = "community",
  advisories = ""
): Promise<void> {
  await mkdir(
    join(root, "registries", registry, "formulas", formula.split("/").slice(0, -1).join("/")),
    { recursive: true }
  );
  await writeFile(
    join(root, "registries", registry, "formulas", `${formula}.yaml`),
    `schemaVersion: 1
id: ${formula}
name: Safe Bash
description: Safe shell workflows
source:
  type: git
  url: ${sourceUrl}
  revision: ${revision}
capabilities:
  - id: lint
    kind: ${kind}
    path: ${capabilityPath}
${advisories}
`,
    "utf8"
  );
}

async function writeVirtualMcpFormula(
  root: string,
  registry: string,
  formula: string,
  spec = `transport: remote
config:
  url: https://example.test/mcp`
): Promise<void> {
  await mkdir(
    join(root, "registries", registry, "formulas", formula.split("/").slice(0, -1).join("/")),
    { recursive: true }
  );
  await writeFile(
    join(root, "registries", registry, "formulas", `${formula}.yaml`),
    `schemaVersion: 1
id: ${formula}
name: Virtual GitHub
description: Virtual GitHub MCP
source:
  type: virtual
  origin:
    type: remote
    url: https://example.test/mcp
capabilities:
  - id: github
    kind: mcp
    description: Virtual GitHub MCP.
    spec:
      serverName: github
      sourceFormat: direct
${spec
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
`,
    "utf8"
  );
}

async function createGitSourceWithTwoCommits(
  root: string
): Promise<{ path: string; first: string; second: string }> {
  const path = join(root, `source-${Math.random().toString(16).slice(2)}`);
  await mkdir(path, { recursive: true });
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
  const { stdout: second } = await execa("git", ["rev-parse", "HEAD"], { cwd: path });
  return { path, first, second };
}

function recipeLock(id: string, registryCommit: string) {
  return {
    schemaVersion: 1 as const,
    id,
    formula: {
      registry: "alpha",
      path: "formulas/example/safe-bash.yaml",
      registryUrl: "https://example.test/alpha.git",
      registryCommit,
      formulaHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    source: { type: "git" as const, url: "https://example.test/safe-bash.git", revision: SHA_A },
    capabilities: [
      {
        id: `${id}:lint`,
        formulaCapabilityId: "lint",
        kind: "skill" as const,
        path: "skills/lint",
      },
    ],
    requirements: { env: [] },
    hooks: { mode: "explicit" as const, entries: [] },
    advisories: [],
  };
}
