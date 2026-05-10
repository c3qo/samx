import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { classifyExtension, createConfigRegistry } from "./internal.js";

async function makeTempWorkspace() {
  return mkdtemp(join(tmpdir(), "samx-classifier-"));
}

async function writeFixture(filePath: string, content: string) {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content);
}

describe("classifyExtension", () => {
  test("uses injected plugin classification rules", async () => {
    const cwd = await makeTempWorkspace();
    const rulePath = join(cwd, ".exampleai", "rules", "review.md");
    await writeFixture(rulePath, "# Review");
    const registry = createConfigRegistry([
      {
        id: "exampleai",
        name: "ExampleAI",
        version: 1,
        description: "ExampleAI test pack.",
        rules: {
          scan: { project: [], home: [], ignoredDirectories: [] },
          classify: [
            {
              when: { pathPrefix: ".exampleai/rules/", extension: ".md" },
              kind: "rule",
              sourceTool: "exampleai",
              nameFrom: "fileStem",
            },
          ],
          groups: [],
          parse: {
            markdownFrontmatterKinds: [],
            mcpJsonKinds: [],
            profileKinds: [],
            packageJsonKinds: [],
          },
          inference: {
            commands: [],
            env: [],
            filesystem: [],
            shellRisks: [],
            broadMcpFilesystemRoots: [],
            networkCommands: [],
          },
          probes: { safeCommands: [] },
        },
      },
    ]);

    const extension = await classifyExtension(rulePath, { cwd, registry });

    expect(extension).toMatchObject({
      id: "exampleai-rules-review",
      name: "review",
      kind: "rule",
      sourceTool: "exampleai",
      entryFiles: [rulePath],
    });
  });

  test("classifies Claude SKILL.md files as skills with stable relative IDs", async () => {
    const cwd = await makeTempWorkspace();
    const skillPath = join(cwd, ".claude", "skills", "review", "SKILL.md");
    await writeFixture(skillPath, "# Review skill");

    const extension = await classifyExtension(skillPath, { cwd });

    expect(extension).toMatchObject({
      id: "claude-skills-review",
      name: "review",
      kind: "skill",
      sourcePath: skillPath,
      sourceTool: "claude",
      entryFiles: [skillPath],
    });
    expect(extension.id).not.toContain(cwd);
  });

  test("classifies OpenCode SKILL.md files without labeling them Claude", async () => {
    const cwd = await makeTempWorkspace();
    const projectSkillPath = join(cwd, ".opencode", "agents", "review", "SKILL.md");
    const homeSkillPath = join(cwd, ".config", "opencode", "agents", "review", "SKILL.md");
    await writeFixture(projectSkillPath, "# Review skill");
    await writeFixture(homeSkillPath, "# Home review skill");

    await expect(classifyExtension(projectSkillPath, { cwd })).resolves.toMatchObject({
      kind: "skill",
      sourceTool: "opencode",
      entryFiles: [projectSkillPath],
    });
    await expect(classifyExtension(homeSkillPath, { cwd })).resolves.toMatchObject({
      kind: "skill",
      sourceTool: "opencode",
      entryFiles: [homeSkillPath],
    });
  });

  test("classifies generic SKILL.md files without a known source tool", async () => {
    const cwd = await makeTempWorkspace();
    const skillPath = join(cwd, "tools", "review", "SKILL.md");
    await writeFixture(skillPath, "# Generic skill");

    const extension = await classifyExtension(skillPath, { cwd });

    expect(extension).toMatchObject({
      kind: "skill",
      entryFiles: [skillPath],
    });
    expect(extension.sourceTool).toBeUndefined();
  });

  test("classifies Cursor rule files as rules", async () => {
    const cwd = await makeTempWorkspace();
    const rulePath = join(cwd, ".cursor", "rules", "security.mdc");
    await writeFixture(rulePath, "always check auth");

    const extension = await classifyExtension(rulePath, { cwd });

    expect(extension).toMatchObject({
      id: "cursor-rules-security",
      name: "security",
      kind: "rule",
      sourceTool: "cursor",
      entryFiles: [rulePath],
    });
  });

  test("classifies root and Cursor MCP config files as MCP servers", async () => {
    const cwd = await makeTempWorkspace();
    const rootMcpPath = join(cwd, "mcp.json");
    const cursorMcpPath = join(cwd, ".cursor", "mcp.json");
    await writeFixture(rootMcpPath, '{"mcpServers":{}}');
    await writeFixture(cursorMcpPath, '{"mcpServers":{}}');

    await expect(classifyExtension(rootMcpPath, { cwd })).resolves.toMatchObject({
      id: "mcp",
      name: "mcp",
      kind: "mcp-server",
      entryFiles: [rootMcpPath],
    });
    await expect(classifyExtension(cursorMcpPath, { cwd })).resolves.toMatchObject({
      id: "cursor-mcp",
      name: "mcp",
      kind: "mcp-server",
      sourceTool: "cursor",
      entryFiles: [cursorMcpPath],
    });
  });

  test("classifies AGENTS.md and CLAUDE.md as profiles", async () => {
    const cwd = await makeTempWorkspace();
    const agentsPath = join(cwd, "AGENTS.md");
    const claudePath = join(cwd, "CLAUDE.md");
    await writeFixture(agentsPath, "# Agents");
    await writeFixture(claudePath, "# Claude");

    await expect(classifyExtension(agentsPath, { cwd })).resolves.toMatchObject({
      id: "agents",
      name: "AGENTS",
      kind: "profile",
      entryFiles: [agentsPath],
    });
    await expect(classifyExtension(claudePath, { cwd })).resolves.toMatchObject({
      id: "claude",
      name: "CLAUDE",
      kind: "profile",
      sourceTool: "claude",
      entryFiles: [claudePath],
    });
  });

  test("classifies package.json files with bin entries as bundles", async () => {
    const cwd = await makeTempWorkspace();
    const packagePath = join(cwd, "tools", "samx-helper", "package.json");
    await writeFixture(packagePath, '{"name":"samx-helper","bin":{"samx-helper":"bin.js"}}');

    const extension = await classifyExtension(packagePath, { cwd });

    expect(extension).toMatchObject({
      id: "tools-samx-helper-package",
      name: "samx-helper",
      kind: "bundle",
      entryFiles: [packagePath],
    });
  });

  test("classifies unknown Markdown as unknown", async () => {
    const cwd = await makeTempWorkspace();
    const markdownPath = join(cwd, "notes", "helper.md");
    await writeFixture(markdownPath, "# Helper");

    const extension = await classifyExtension(markdownPath, { cwd });

    expect(extension).toMatchObject({
      id: "notes-helper",
      name: "helper",
      kind: "unknown",
      entryFiles: [markdownPath],
    });
  });
});
