import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { classifyExtension, parseExtensionFile } from "./internal.js";

async function makeTempWorkspace() {
  return mkdtemp(join(tmpdir(), "samx-parsers-"));
}

async function writeFixture(filePath: string, content: string) {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content);
}

describe("parseExtensionFile", () => {
  test("parses Claude skill frontmatter and body", async () => {
    const cwd = await makeTempWorkspace();
    const skillPath = join(cwd, ".claude", "skills", "review", "SKILL.md");
    const content = `---
name: GitHub review
description: Review pull requests
requirements:
  commands:
    - gh
  env:
    - GITHUB_TOKEN
permissions:
  shell: true
  network: true
---
# GitHub Review

Review the active pull request.
`;
    await writeFixture(skillPath, content);

    const parsed = await parseExtensionFile(await classifyExtension(skillPath, { cwd }));

    expect(parsed).toMatchObject({
      id: "claude-skills-review",
      kind: "skill",
      rawContent: content,
      metadata: {
        name: "GitHub review",
        description: "Review pull requests",
        body: "# GitHub Review\n\nReview the active pull request.\n",
      },
      declaredRequirements: {
        commands: ["gh"],
        env: ["GITHUB_TOKEN"],
        paths: [],
      },
      declaredPermissions: {
        shell: true,
        network: true,
        filesystem: [],
        browser: false,
        secrets: [],
      },
      findings: [],
    });
  });

  test("parses Cursor rule frontmatter", async () => {
    const cwd = await makeTempWorkspace();
    const rulePath = join(cwd, ".cursor", "rules", "security.mdc");
    await writeFixture(
      rulePath,
      `---
description: Security checks
globs:
  - "**/*.ts"
alwaysApply: true
---
Always check authorization boundaries.
`
    );

    const parsed = await parseExtensionFile(await classifyExtension(rulePath, { cwd }));

    expect(parsed.metadata).toMatchObject({
      description: "Security checks",
      globs: ["**/*.ts"],
      alwaysApply: true,
      body: "Always check authorization boundaries.\n",
    });
    expect(parsed.declaredRequirements).toEqual({ commands: [], env: [], paths: [] });
    expect(parsed.findings).toEqual([]);
  });

  test("parses MCP JSON server configs", async () => {
    const cwd = await makeTempWorkspace();
    const mcpPath = join(cwd, "mcp.json");
    const content = JSON.stringify(
      {
        mcpServers: {
          github: {
            command: "node",
            args: ["server.js"],
            env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
          },
        },
      },
      null,
      2
    );
    await writeFixture(mcpPath, content);

    const parsed = await parseExtensionFile(await classifyExtension(mcpPath, { cwd }));

    expect(parsed.rawContent).toBe(content);
    expect(parsed.metadata).toMatchObject({
      servers: {
        github: {
          command: "node",
          args: ["server.js"],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
        },
      },
    });
    expect(parsed.declaredRequirements).toEqual({
      commands: ["node"],
      env: ["GITHUB_TOKEN"],
      paths: [],
    });
    expect(parsed.findings).toEqual([]);
  });

  test("parses AGENTS.md project instructions as profile content", async () => {
    const cwd = await makeTempWorkspace();
    const agentsPath = join(cwd, "AGENTS.md");
    const content = "# Project Instructions\n\nAlways run tests before committing.\n";
    await writeFixture(agentsPath, content);

    const parsed = await parseExtensionFile(await classifyExtension(agentsPath, { cwd }));

    expect(parsed).toMatchObject({
      kind: "profile",
      rawContent: content,
      metadata: {
        title: "Project Instructions",
        body: content,
      },
      declaredRequirements: { commands: [], env: [], paths: [] },
      findings: [],
    });
  });

  test("parses package.json metadata with bin entries", async () => {
    const cwd = await makeTempWorkspace();
    const packagePath = join(cwd, "tools", "helper", "package.json");
    const content = JSON.stringify(
      {
        name: "samx-helper",
        version: "1.2.3",
        bin: { "samx-helper": "bin/helper.js" },
        scripts: { test: "vitest run" },
      },
      null,
      2
    );
    await writeFixture(packagePath, content);

    const parsed = await parseExtensionFile(await classifyExtension(packagePath, { cwd }));

    expect(parsed.metadata).toEqual({
      name: "samx-helper",
      version: "1.2.3",
      bin: { "samx-helper": "bin/helper.js" },
      scripts: { test: "vitest run" },
    });
    expect(parsed.declaredRequirements).toEqual({
      commands: [],
      env: [],
      paths: ["bin/helper.js"],
    });
    expect(parsed.findings).toEqual([]);
  });

  test("reports malformed YAML frontmatter without throwing", async () => {
    const cwd = await makeTempWorkspace();
    const skillPath = join(cwd, ".claude", "skills", "broken", "SKILL.md");
    await writeFixture(
      skillPath,
      `---
name: [broken
---
# Broken
`
    );

    const parsed = await parseExtensionFile(await classifyExtension(skillPath, { cwd }));

    expect(parsed.metadata).toEqual({ body: "# Broken\n" });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      severity: "low",
      status: "warning",
      category: "inventory",
      title: "Could not parse YAML frontmatter",
      confidence: "low",
    });
  });

  test("reports malformed JSON without throwing", async () => {
    const cwd = await makeTempWorkspace();
    const mcpPath = join(cwd, "mcp.json");
    await writeFixture(mcpPath, '{"mcpServers":');

    const parsed = await parseExtensionFile(await classifyExtension(mcpPath, { cwd }));

    expect(parsed.metadata).toEqual({});
    expect(parsed.declaredRequirements).toEqual({ commands: [], env: [], paths: [] });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      severity: "low",
      status: "warning",
      category: "inventory",
      title: "Could not parse JSON file",
      confidence: "low",
    });
  });
});
