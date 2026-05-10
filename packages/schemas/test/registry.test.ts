import { describe, expect, test } from "vitest";

import { formulaSchema, recipeLockSchema, samxLockSchema } from "../src/index.js";

describe("registry schemas", () => {
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  test("parses formula capabilities using kind", () => {
    const formula = formulaSchema.parse({
      schemaVersion: 1,
      id: "obra/superpowers",
      name: "Superpowers",
      source: {
        type: "git",
        url: "https://github.com/obra/superpowers.git",
        ref: "v1.2.3",
        revision: sha,
      },
      capabilities: [
        {
          id: "brainstorming",
          kind: "skill",
          path: "skills/brainstorming/SKILL.md",
          description: "Explore requirements before implementation.",
        },
      ],
      requirements: { env: ["GITHUB_TOKEN"] },
      hooks: {
        mode: "explicit",
        entries: [
          {
            id: "safe-bash",
            appliesTo: ["skill:brainstorming"],
            files: [{ target: "opencode", path: "hooks/safe-bash.js" }],
            required: false,
          },
        ],
      },
    });

    expect(formula.capabilities[0]).toMatchObject({
      id: "brainstorming",
      kind: "skill",
      description: "Explore requirements before implementation.",
    });
    expect(formula.requirements.env).toEqual(["GITHUB_TOKEN"]);
    expect(formula.hooks.entries[0]).toMatchObject({
      id: "safe-bash",
      files: [{ target: "opencode", path: "hooks/safe-bash.js" }],
    });
    expect(formula).not.toHaveProperty("trust");
  });

  test("rejects legacy requirements paths", () => {
    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "example/legacy",
        name: "Legacy",
        source: { type: "git", url: "https://example.test/legacy.git", revision: sha },
        capabilities: [{ id: "legacy", kind: "skill", path: "skills/legacy/SKILL.md" }],
        requirements: { paths: ["node_modules"] },
      })
    ).toThrow();
  });

  test("rejects formula trust", () => {
    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "example/trust",
        name: "Trust",
        source: { type: "git", url: "https://example.test/trust.git", revision: sha },
        capabilities: [{ id: "trust", kind: "skill", path: "skills/trust/SKILL.md" }],
        trust: { level: "community" },
      })
    ).toThrow();
  });

  test("rejects legacy formula capability summary and metadata", () => {
    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "example/summary",
        name: "Summary",
        source: { type: "git", url: "https://example.test/summary.git", revision: sha },
        capabilities: [
          { id: "summary", kind: "skill", path: "skills/summary/SKILL.md", summary: "Old field." },
        ],
      })
    ).toThrow();

    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "example/metadata",
        name: "Metadata",
        source: { type: "git", url: "https://example.test/metadata.git", revision: sha },
        capabilities: [
          { id: "metadata", kind: "skill", path: "skills/metadata/SKILL.md", metadata: {} },
        ],
      })
    ).toThrow();
  });

  test("defaults formula requirements and hooks to spec shape", () => {
    const formula = formulaSchema.parse({
      schemaVersion: 1,
      id: "example/defaults",
      name: "Defaults",
      source: { type: "git", url: "https://example.test/defaults.git", revision: sha },
      capabilities: [{ id: "defaults", kind: "skill", path: "skills/defaults/SKILL.md" }],
    });

    expect(formula.requirements).toEqual({ env: [] });
    expect(formula.hooks).toEqual({ mode: "explicit", entries: [] });
    expect(formula).not.toHaveProperty("trust");
  });

  test("allows directory paths with optional entry and rejects entry path traversal", () => {
    const formula = formulaSchema.parse({
      schemaVersion: 1,
      id: "example/entries",
      name: "Entries",
      source: { type: "git", url: "https://example.test/entries.git", revision: sha },
      capabilities: [
        { id: "skill", kind: "skill", path: "skills/review" },
        { id: "agent", kind: "agent", path: "agents/reviewer", entry: "agent.md" },
        { id: "mcp", kind: "mcp", path: "mcp/github", entry: "mcp.json" },
      ],
    });

    expect(formula.capabilities[1]).toMatchObject({ path: "agents/reviewer", entry: "agent.md" });
    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "example/bad-entry",
        name: "Bad Entry",
        source: { type: "git", url: "https://example.test/bad-entry.git", revision: sha },
        capabilities: [{ id: "bad", kind: "skill", path: "skills/bad", entry: "../SKILL.md" }],
      })
    ).toThrow();
  });

  test("rejects entry when capability path points to a known file", () => {
    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "example/bad-file-entry",
        name: "Bad File Entry",
        source: { type: "git", url: "https://example.test/bad-file-entry.git", revision: sha },
        capabilities: [
          { id: "bad", kind: "skill", path: "skills/bad/SKILL.md", entry: "SKILL.md" },
        ],
      })
    ).toThrow();
  });

  test("rejects capability type field", () => {
    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "example/bad",
        name: "Bad",
        source: { type: "git", url: "https://example.test/bad.git", revision: sha },
        capabilities: [{ id: "bad", kind: "skill", type: "skill", path: "skills/bad/SKILL.md" }],
      })
    ).toThrow();
  });

  test("rejects archive sources", () => {
    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "example/archive",
        name: "Archive",
        source: { type: "archive", url: "https://example.test/archive.tgz", revision: "abc" },
        capabilities: [{ id: "x", kind: "skill", path: "skills/x/SKILL.md" }],
      })
    ).toThrow();
  });

  test("rejects unsafe git source urls and non-locked revisions", () => {
    const base = {
      schemaVersion: 1,
      id: "example/bad",
      name: "Bad",
      capabilities: [{ id: "bad", kind: "skill", path: "skills/bad/SKILL.md" }],
    };

    expect(() =>
      formulaSchema.parse({
        ...base,
        source: { type: "git", url: "ext::sh -c touch /tmp/pwned", revision: sha },
      })
    ).toThrow();
    expect(() =>
      formulaSchema.parse({
        ...base,
        source: { type: "git", url: "https://example.test/bad.git", revision: "main" },
      })
    ).toThrow();
  });

  test("parses virtual remote MCP formula with spec-backed capability", () => {
    const formula = formulaSchema.parse({
      schemaVersion: 1,
      id: "example/remote-mcp",
      name: "Remote MCP",
      source: { type: "virtual", origin: { type: "remote", url: "https://example.test/mcp" } },
      capabilities: [
        {
          id: "remote",
          kind: "mcp",
          spec: {
            serverName: "remote",
            transport: "remote",
            sourceFormat: "direct",
            config: { url: "https://example.test/mcp" },
          },
        },
      ],
    });

    expect(formula.source).toEqual({
      type: "virtual",
      origin: { type: "remote", url: "https://example.test/mcp" },
    });
    expect(formula.capabilities[0]).toMatchObject({
      kind: "mcp",
      spec: { serverName: "remote", transport: "remote" },
    });
  });

  test("parses virtual npm-provenance stdio MCP formula", () => {
    const formula = formulaSchema.parse({
      schemaVersion: 1,
      id: "example/npm-mcp",
      name: "NPM MCP",
      source: {
        type: "virtual",
        origin: { type: "npm", package: "@example/mcp", version: "1.2.3" },
      },
      capabilities: [
        {
          id: "npm",
          kind: "mcp",
          spec: {
            serverName: "npm",
            transport: "stdio",
            sourceFormat: "claude-local",
            config: { command: "npx", args: ["@example/mcp"] },
          },
        },
      ],
    });

    expect(formula.source).toEqual({
      type: "virtual",
      origin: { type: "npm", package: "@example/mcp", version: "1.2.3" },
    });
  });

  test("rejects invalid virtual MCP capability shapes and transport conflicts", () => {
    const base = {
      schemaVersion: 1,
      id: "example/bad-virtual",
      name: "Bad Virtual",
      source: { type: "virtual" },
    };

    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [{ id: "skill", kind: "skill", path: "skills/skill/SKILL.md" }],
      })
    ).toThrow("Formula with virtual source may only contain spec-backed MCP capabilities");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [
          {
            id: "mcp",
            kind: "mcp",
            path: "mcp/server",
            spec: {
              serverName: "mcp",
              transport: "remote",
              sourceFormat: "direct",
              config: { url: "https://example.test/mcp" },
            },
          },
        ],
      })
    ).toThrow("MCP capability requires exactly one of path or spec");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [{ id: "mcp", kind: "mcp" }],
      })
    ).toThrow("MCP capability requires exactly one of path or spec");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [{ id: "mcp", kind: "mcp", path: "mcp/server" }],
      })
    ).toThrow("Formula with virtual source may only contain spec-backed MCP capabilities");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [
          {
            id: "mcp",
            kind: "mcp",
            entry: "mcp.json",
            spec: {
              serverName: "mcp",
              transport: "remote",
              sourceFormat: "direct",
              config: { url: "https://example.test/mcp" },
            },
          },
        ],
      })
    ).toThrow("Capability entry requires path");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [
          {
            id: "mcp",
            kind: "mcp",
            spec: {
              serverName: "mcp",
              transport: "stdio",
              sourceFormat: "direct",
              config: { url: "https://example.test/mcp" },
            },
          },
        ],
      })
    ).toThrow("MCP spec transport conflicts with URL config");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [
          {
            id: "mcp",
            kind: "mcp",
            spec: { serverName: "mcp", transport: "stdio", sourceFormat: "direct", config: {} },
          },
        ],
      })
    ).toThrow("MCP spec stdio transport requires command config");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [
          {
            id: "mcp",
            kind: "mcp",
            spec: {
              serverName: "mcp",
              transport: "stdio",
              sourceFormat: "direct",
              config: { command: "mcp-server", url: "https://example.test/mcp" },
            },
          },
        ],
      })
    ).toThrow("MCP spec transport conflicts with URL config");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [
          {
            id: "mcp",
            kind: "mcp",
            spec: {
              serverName: "mcp",
              transport: "remote",
              sourceFormat: "direct",
              config: { command: "mcp-server" },
            },
          },
        ],
      })
    ).toThrow("MCP spec transport conflicts with command config");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [
          {
            id: "mcp",
            kind: "mcp",
            spec: { serverName: "mcp", transport: "remote", sourceFormat: "direct", config: {} },
          },
        ],
      })
    ).toThrow("MCP spec remote transport requires URL config");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [
          {
            id: "mcp",
            kind: "mcp",
            spec: {
              serverName: "mcp",
              transport: "remote",
              sourceFormat: "direct",
              config: { command: "mcp-server", url: "https://example.test/mcp" },
            },
          },
        ],
      })
    ).toThrow("MCP spec transport conflicts with command config");
    expect(() =>
      formulaSchema.parse({
        ...base,
        capabilities: [
          {
            id: "mcp",
            kind: "mcp",
            spec: {
              serverName: "mcp",
              transport: "remote",
              sourceFormat: "opencode",
              config: { command: ["mcp-server"], url: "https://example.test/mcp" },
            },
          },
        ],
      })
    ).toThrow("MCP spec transport conflicts with command config");
  });

  test("rejects skill and agent specs", () => {
    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "example/bad-spec",
        name: "Bad Spec",
        source: { type: "git", url: "https://example.test/bad-spec.git", revision: sha },
        capabilities: [
          {
            id: "skill",
            kind: "skill",
            path: "skills/skill/SKILL.md",
            spec: {
              serverName: "skill",
              transport: "remote",
              sourceFormat: "direct",
              config: { url: "https://example.test/mcp" },
            },
          },
        ],
      })
    ).toThrow("Skill and agent capabilities require path and must not include spec");
    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "example/missing-path",
        name: "Missing Path",
        source: { type: "git", url: "https://example.test/missing-path.git", revision: sha },
        capabilities: [{ id: "agent", kind: "agent" }],
      })
    ).toThrow("Skill and agent capabilities require path and must not include spec");
  });

  test("parses recipe lock and samx lock", () => {
    const recipe = recipeLockSchema.parse({
      schemaVersion: 1,
      id: "default/obra/superpowers",
      formula: {
        registry: "default",
        path: "formulas/obra/superpowers.yaml",
        registryUrl: "https://github.com/c3qo/samx-registry.git",
        registryCommit: "abc1230000000000000000000000000000000000",
        formulaHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      },
      source: {
        type: "git",
        url: "https://github.com/obra/superpowers.git",
        ref: "v1.2.3",
        revision: sha,
      },
      capabilities: [
        {
          id: "default/obra/superpowers:brainstorming",
          formulaCapabilityId: "brainstorming",
          kind: "skill",
          path: "skills/brainstorming/SKILL.md",
        },
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
    });
    const lock = samxLockSchema.parse({
      schemaVersion: 1,
      trustedRegistries: ["default"],
      registries: {
        default: {
          url: "https://github.com/c3qo/samx-registry.git",
          commit: "abc1230000000000000000000000000000000000",
        },
      },
      formulas: [
        {
          id: recipe.id,
          formulaPath: recipe.formula.path,
          formulaHash: recipe.formula.formulaHash,
          source: recipe.source,
          capabilities: recipe.capabilities.map((capability) => capability.id),
        },
      ],
    });

    expect(lock.trustedRegistries).toEqual(["default"]);
    expect(recipe.advisories).toEqual([
      {
        id: "candidate-validation",
        severity: "warning",
        category: "generation",
        message: "Formula candidate required generation advisories.",
        paths: [],
      },
    ]);
  });

  test("preserves virtual recipe and samx lock sources and specs", () => {
    const recipe = recipeLockSchema.parse({
      schemaVersion: 1,
      id: "default/example/remote-mcp",
      formula: {
        registry: "default",
        path: "formulas/example/remote-mcp.yaml",
        registryUrl: "https://github.com/c3qo/samx-registry.git",
        registryCommit: "abc1230000000000000000000000000000000000",
        formulaHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      },
      source: { type: "virtual", origin: { type: "remote", url: "https://example.test/mcp" } },
      capabilities: [
        {
          id: "default/example/remote-mcp:remote",
          formulaCapabilityId: "remote",
          kind: "mcp",
          spec: {
            serverName: "remote",
            transport: "remote",
            sourceFormat: "direct",
            config: { url: "https://example.test/mcp" },
          },
        },
      ],
    });
    const lock = samxLockSchema.parse({
      schemaVersion: 1,
      formulas: [
        {
          id: recipe.id,
          formulaPath: recipe.formula.path,
          formulaHash: recipe.formula.formulaHash,
          source: recipe.source,
          capabilities: recipe.capabilities.map((capability) => capability.id),
        },
      ],
    });

    expect(recipe.source).toEqual({
      type: "virtual",
      origin: { type: "remote", url: "https://example.test/mcp" },
    });
    expect(recipe.capabilities[0]).toMatchObject({ spec: { serverName: "remote" } });
    expect(lock.formulas[0]?.source).toEqual(recipe.source);
  });

  test("rejects virtual recipe lock skill and path-backed MCP capabilities", () => {
    const base = {
      schemaVersion: 1,
      id: "default/example/bad-virtual",
      formula: {
        registry: "default",
        path: "formulas/example/bad-virtual.yaml",
        registryUrl: "https://github.com/c3qo/samx-registry.git",
        registryCommit: "abc1230000000000000000000000000000000000",
        formulaHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      },
      source: { type: "virtual" },
    };

    expect(() =>
      recipeLockSchema.parse({
        ...base,
        capabilities: [
          {
            id: "default/example/bad-virtual:skill",
            formulaCapabilityId: "skill",
            kind: "skill",
            path: "skills/skill/SKILL.md",
          },
        ],
      })
    ).toThrow("Formula with virtual source may only contain spec-backed MCP capabilities");
    expect(() =>
      recipeLockSchema.parse({
        ...base,
        capabilities: [
          {
            id: "default/example/bad-virtual:mcp",
            formulaCapabilityId: "mcp",
            kind: "mcp",
            path: "mcp/server",
          },
        ],
      })
    ).toThrow("Formula with virtual source may only contain spec-backed MCP capabilities");
  });

  test("rejects recipe security", () => {
    expect(() =>
      recipeLockSchema.parse({
        schemaVersion: 1,
        id: "default/obra/superpowers",
        formula: {
          registry: "default",
          path: "formulas/obra/superpowers.yaml",
          registryUrl: "https://github.com/c3qo/samx-registry.git",
          registryCommit: "abc1230000000000000000000000000000000000",
          formulaHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        },
        source: {
          type: "git",
          url: "https://github.com/obra/superpowers.git",
          ref: "v1.2.3",
          revision: sha,
        },
        capabilities: [
          {
            id: "default/obra/superpowers:brainstorming",
            formulaCapabilityId: "brainstorming",
            kind: "skill",
            path: "skills/brainstorming/SKILL.md",
          },
        ],
        security: {
          trustLevel: "community",
          trustedRegistry: false,
          executableLinkingAllowed: false,
          warnings: [],
        },
      })
    ).toThrow();
  });

  test("rejects flat formula ids", () => {
    expect(() =>
      formulaSchema.parse({
        schemaVersion: 1,
        id: "safe-bash",
        name: "Safe Bash",
        source: { type: "git", url: "https://example.test/safe-bash.git", revision: sha },
        capabilities: [{ id: "safe-bash", kind: "skill", path: "skills/safe-bash/SKILL.md" }],
      })
    ).toThrow("Formula id must be <owner>/<repo>");
  });
});
