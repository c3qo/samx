import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

import { getLinkTargetConfig, loadBuiltinConfigRegistry } from "./internal.js";
import type { ConfigRegistry } from "./internal.js";

describe("plugin config registry", () => {
  test("loads built-in data-only plugin packs in deterministic order", async () => {
    const registry = await loadBuiltinConfigRegistry();

    expect(registry.packs.map((pack) => pack.id)).toEqual([
      "claude",
      "core",
      "cursor",
      "kiro",
      "opencode",
    ]);
    expect(registry.scan.project).toEqual(
      expect.arrayContaining([
        ".claude/skills/**/SKILL.md",
        "CLAUDE.md",
        "AGENTS.md",
        ".cursor/rules/**/*.mdc",
        ".cursor/mcp.json",
        ".opencode/**/*",
        "mcp.json",
        "*helper.md",
        "*script.md",
        "*tool.md",
        "package.json",
      ])
    );
    expect(registry.probes.safeCommands).toEqual(
      expect.arrayContaining([
        "git",
        "gh",
        "rg",
        "jq",
        "curl",
        "wget",
        "node",
        "python",
        "docker",
        "kubectl",
        "aws",
        "npx",
      ])
    );
    expect(registry.inference.env).toEqual(
      expect.arrayContaining(["GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"])
    );
    expect(registry.linkTargets).toEqual(
      expect.objectContaining({
        claude: expect.objectContaining({
          hooks: {
            mode: "claude-settings-hooks",
            settings: ".claude/settings.json",
            allowedExtensions: [".json"],
          },
          capabilities: expect.objectContaining({
            skill: expect.objectContaining({ root: ".claude/skills" }),
            agent: expect.objectContaining({ root: ".claude/agents" }),
            mcp: expect.objectContaining({ output: ".mcp.json" }),
          }),
        }),
        codex: expect.objectContaining({
          instructions: { mode: "agents-md-section", output: "AGENTS.md", kinds: ["agent"] },
          capabilities: expect.objectContaining({
            skill: expect.objectContaining({
              mode: "directory-symlink",
              root: ".agents/skills",
              entry: "SKILL.md",
              nameFrom: "aliasOrCapabilityId",
            }),
            mcp: expect.objectContaining({
              mode: "mcp-toml-merge",
              output: ".codex/config.toml",
              tablePath: ["mcp_servers"],
            }),
          }),
        }),
        kiro: expect.objectContaining({
          capabilities: expect.objectContaining({
            skill: expect.objectContaining({ root: ".kiro/skills" }),
            agent: expect.objectContaining({ root: ".kiro/agents" }),
            mcp: expect.objectContaining({ output: ".kiro/mcp.json" }),
          }),
        }),
        opencode: expect.objectContaining({
          allowLegacySkillFileRecords: true,
          hooks: {
            mode: "opencode-plugin",
            root: ".opencode/plugins",
            allowedExtensions: [".js", ".mjs"],
          },
          capabilities: expect.objectContaining({
            skill: expect.objectContaining({ root: ".opencode/skills" }),
            agent: expect.objectContaining({ root: ".opencode/agents" }),
            mcp: expect.objectContaining({
              output: ".opencode/opencode.json",
              keyPath: ["mcp"],
              defaults: { $schema: "https://opencode.ai/config.json" },
            }),
          }),
        }),
      })
    );
    expect(registry.linkTargets.kiro.hooks).toBeUndefined();
    expect(registry.linkTargets["generic-markdown"]).toBeUndefined();
  });

  test("exposes ordered classification rules for current source tools", async () => {
    const registry = await loadBuiltinConfigRegistry();

    expect(registry.classify).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          sourceTool: "claude",
          nameFrom: "parentDirectory",
        }),
        expect.objectContaining({ kind: "rule", sourceTool: "cursor", nameFrom: "fileStem" }),
        expect.objectContaining({ kind: "profile", sourceTool: "claude", nameFrom: "fileStem" }),
        expect.objectContaining({
          kind: "mcp-server",
          sourceTool: "cursor",
          nameFrom: "constant",
          name: "mcp",
        }),
      ])
    );
  });

  test("loads codex link target config", async () => {
    const registry = await loadBuiltinConfigRegistry();

    expect(getLinkTargetConfig(registry, "codex")).toMatchObject({
      displayName: "Codex",
      instructions: { mode: "agents-md-section", output: "AGENTS.md", kinds: ["agent"] },
      capabilities: {
        skill: {
          mode: "directory-symlink",
          root: ".agents/skills",
          entry: "SKILL.md",
          nameFrom: "aliasOrCapabilityId",
        },
        mcp: { mode: "mcp-toml-merge", output: ".codex/config.toml", tablePath: ["mcp_servers"] },
      },
    });
  });

  test("built-in hook configs explicitly declare allowed extensions in source YAML", async () => {
    const claudeRules = parseYaml(
      await readFile(join(import.meta.dirname, "../config/packs/claude/rules.yaml"), "utf8")
    );
    const opencodeRules = parseYaml(
      await readFile(join(import.meta.dirname, "../config/packs/opencode/rules.yaml"), "utf8")
    );

    expect(claudeRules.linkTargets.claude.hooks.allowedExtensions).toEqual([".json"]);
    expect(opencodeRules.linkTargets.opencode.hooks.allowedExtensions).toEqual([".js", ".mjs"]);
  });

  test("rejects unsafe codex mcp output path", () => {
    const registry = {
      linkTargets: {
        codex: {
          displayName: "Codex",
          allowLegacySkillFileRecords: false,
          capabilities: {
            mcp: { mode: "mcp-toml-merge", output: "../escape.toml", tablePath: ["mcp_servers"] },
          },
        },
      },
    } as unknown as ConfigRegistry;

    expect(() => getLinkTargetConfig(registry, "codex")).toThrow(
      "Unsafe link target path for codex: ../escape.toml"
    );
  });

  test("rejects unsafe hook target paths", () => {
    const registry = {
      linkTargets: {
        opencode: {
          displayName: "OpenCode",
          allowLegacySkillFileRecords: true,
          hooks: { mode: "opencode-plugin", root: "../escape", allowedExtensions: [".js"] },
          capabilities: {},
        },
      },
    } as unknown as ConfigRegistry;

    expect(() => getLinkTargetConfig(registry, "opencode")).toThrow(
      "Unsafe link target path for opencode: ../escape"
    );
  });
});
