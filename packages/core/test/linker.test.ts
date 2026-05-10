import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
  addBundleItem,
  addLocalPackage,
  annotateClaudeHooks,
  createBundle,
  fingerprintFile,
  fingerprintJson,
  linkBundle,
  planBundleLink,
  readLinkRecords,
  removeBundle,
  removeBundleItem,
  unlinkBundle,
} from "./internal.js";
import { atomicWriteJson, samxPaths } from "./internal.js";
import { agentsMdBlock, removeAgentsMdBlock } from "../src/links/agents-md.js";

async function seedIndex(root: string) {
  await atomicWriteJson(samxPaths(root).index, {
    skills: [
      {
        id: "superpowers:skills-code-review",
        packageId: "superpowers",
        name: "code-review",
        kind: "skill",
        path: "/tmp/superpowers/skills/code-review/SKILL.md",
        description: "Review code changes.",
        metadata: { body: "# Code Review\n\nReview code changes safely." },
      },
    ],
  });
}

async function seedHookBundle(options: {
  root: string;
  source: string;
  tool: "claude" | "opencode" | "both";
}) {
  const skillPath = join(options.source, "skills", "safe-bash", "SKILL.md");
  const claudeHook = join(options.source, "hooks", "claude.json");
  const opencodeHook = join(options.source, "hooks", "safe-bash.js");
  await mkdir(join(options.source, "skills", "safe-bash"), { recursive: true });
  await mkdir(join(options.source, "hooks"), { recursive: true });
  await writeFile(skillPath, "# Safe Bash\n", "utf8");
  await writeFile(
    claudeHook,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "node safe-bash.js" }] },
        ],
      },
    }),
    "utf8"
  );
  await writeFile(opencodeHook, "export const plugin = true\n", "utf8");
  const hooks = [
    ...(options.tool === "claude" || options.tool === "both"
      ? [
          {
            id: "safe-bash",
            packageId: "pkg",
            tool: "claude" as const,
            file: claudeHook,
            required: true,
            appliesTo: ["skill:safe-bash"],
          },
        ]
      : []),
    ...(options.tool === "opencode" || options.tool === "both"
      ? [
          {
            id: "safe-bash",
            packageId: "pkg",
            tool: "opencode" as const,
            file: opencodeHook,
            required: true,
            appliesTo: ["skill:safe-bash"],
          },
        ]
      : []),
  ];
  await atomicWriteJson(samxPaths(options.root).index, {
    capabilities: [
      {
        id: "pkg:skills-safe-bash",
        packageId: "pkg",
        name: "safe-bash",
        kind: "skill",
        path: skillPath,
        description: "Checks bash commands.",
        metadata: { body: "# Safe Bash\n" },
        hooks,
      },
    ],
  });
  await createBundle({ samxHome: options.root, id: "coding" });
  await addBundleItem({
    samxHome: options.root,
    bundleId: "coding",
    itemId: "pkg:skills-safe-bash",
    kind: "skill",
  });
  return { skillPath, claudeHook, opencodeHook };
}

async function indexFormulaFixture(root: string, packageId: string, packageRoot: string) {
  const [registry = "fixtures", ...formulaParts] = packageId.includes("/")
    ? packageId.split("/")
    : ["fixtures", packageId];
  const formula = formulaParts.join("/");
  const capabilities = [];
  for (const [dir, kind] of [
    ["skills", "skill"],
    ["agents", "agent"],
    ["mcp", "mcp"],
  ] as const) {
    try {
      for (const name of await readdir(join(packageRoot, dir))) {
        const path = join(packageRoot, dir, name);
        capabilities.push({
          id: `${packageId}:${dir}-${name}`,
          packageId,
          name,
          kind,
          path,
          ...(kind === "mcp"
            ? { serverName: name, config: { command: "node" } }
            : { metadata: { body: `# ${name}\n` }, hooks: [] }),
        });
      }
    } catch {}
  }
  await mkdir(join(root, "packages", registry, formula), { recursive: true });
  await symlink(packageRoot, join(root, "packages", registry, formula, "source"));
  await atomicWriteJson(samxPaths(root).recipeLock(registry, formula), {
    schemaVersion: 1,
    id: packageId,
    formula: {
      registry,
      path: `formulas/${formula}.yaml`,
      registryUrl: "https://example.test/fixtures.git",
      registryCommit: "reg123",
      formulaHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    source: {
      type: "git",
      url: "https://example.test/fixture.git",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    capabilities: [
      {
        id: `${packageId}:fixture`,
        formulaCapabilityId: "fixture",
        kind: "skill",
        path: "skills/fixture",
      },
    ],
  });
  await atomicWriteJson(samxPaths(root).index, { capabilities });
}

test("dry-run link plans formula hook inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-link-formula-hook-risk-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-project-"));
  const packageRoot = join(root, "formula-source");
  await mkdir(join(packageRoot, "skills", "review"), { recursive: true });
  await mkdir(join(packageRoot, "hooks"), { recursive: true });
  await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  await writeFile(join(packageRoot, "hooks", "safe-bash.js"), "export default {}\n", "utf8");
  await indexFormulaFixture(root, "pkg", packageRoot);
  await atomicWriteJson(samxPaths(root).index, {
    capabilities: [
      {
        id: "pkg:skills-review",
        packageId: "pkg",
        name: "review",
        kind: "skill",
        path: join(packageRoot, "skills", "review"),
        metadata: { body: "# Review\n" },
        hooks: [
          {
            id: "safe-bash",
            packageId: "pkg",
            tool: "opencode",
            file: join(packageRoot, "hooks", "safe-bash.js"),
            required: false,
            appliesTo: ["skill:review"],
          },
        ],
      },
    ],
  });
  await createBundle({ samxHome: root, id: "coding" });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:skills-review",
    kind: "skill",
  });

  const result = await linkBundle({
    samxHome: root,
    bundleId: "coding",
    tool: "opencode",
    projectRoot,
    dryRun: true,
  });

  expect(result.plan.hookWarnings).toEqual([]);
  expect(result.plan.hooks).toEqual([
    expect.objectContaining({ packageId: "pkg", id: "safe-bash" }),
  ]);
});

test("link plan surfaces advisories from selected formula packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-link-formula-advisories-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-project-"));
  const packageRoot = join(root, "formula-source");
  await mkdir(join(packageRoot, "skills", "review"), { recursive: true });
  await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  await indexFormulaFixture(root, "default/obra/superpowers", packageRoot);
  await atomicWriteJson(samxPaths(root).recipeLock("default", "obra/superpowers"), {
    schemaVersion: 1,
    id: "default/obra/superpowers",
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
      {
        id: "default/obra/superpowers:skills-review",
        formulaCapabilityId: "skills-review",
        kind: "skill",
        path: "skills/review",
      },
    ],
    advisories: [
      {
        id: "optional-opencode-plugin",
        severity: "info",
        category: "linking",
        message: "This formula includes an optional OpenCode plugin link target.",
        paths: [".opencode/plugins/superpowers.js"],
        effect:
          "The plugin is linked only when the user explicitly links this package to OpenCode.",
      },
    ],
  });
  await createBundle({ samxHome: root, id: "coding" });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "default/obra/superpowers:skills-review",
    kind: "skill",
  });

  const plan = await planBundleLink({
    samxHome: root,
    bundleId: "coding",
    tool: "opencode",
    projectRoot,
  });

  expect(plan.advisories).toEqual([
    expect.objectContaining({
      packageId: "default/obra/superpowers",
      id: "optional-opencode-plugin",
      severity: "info",
    }),
  ]);
});

test("link plan surfaces env reminders without advisories", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-link-formula-env-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-project-"));
  const packageRoot = join(root, "formula-source");
  await mkdir(join(packageRoot, "skills", "review"), { recursive: true });
  await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  await indexFormulaFixture(root, "default/obra/superpowers", packageRoot);
  await atomicWriteJson(samxPaths(root).recipeLock("default", "obra/superpowers"), {
    schemaVersion: 1,
    id: "default/obra/superpowers",
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
      {
        id: "default/obra/superpowers:skills-review",
        formulaCapabilityId: "skills-review",
        kind: "skill",
        path: "skills/review",
      },
    ],
    requirements: { env: ["ANTHROPIC_API_KEY"] },
  });
  await createBundle({ samxHome: root, id: "coding" });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "default/obra/superpowers:skills-review",
    kind: "skill",
  });

  const plan = await planBundleLink({
    samxHome: root,
    bundleId: "coding",
    tool: "opencode",
    projectRoot,
  });
  const result = await linkBundle({
    samxHome: root,
    bundleId: "coding",
    tool: "opencode",
    projectRoot,
    dryRun: true,
  });

  expect(plan.environmentReminders).toEqual([
    { packageId: "default/obra/superpowers", env: ["ANTHROPIC_API_KEY"] },
  ]);
  expect(plan.advisories).toEqual([]);
  expect(result.plan.environmentReminders).toEqual(plan.environmentReminders);
});

test("codex link plan writes instructions and TOML MCP merge only", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-codex-plan-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-codex-plan-project-"));
  await atomicWriteJson(samxPaths(root).index, {
    capabilities: [
      {
        id: "pkg:skills-review",
        packageId: "pkg",
        name: "review",
        kind: "skill",
        path: "/tmp/pkg/skills/review/SKILL.md",
        description: "Review code.",
        metadata: { body: "# Review\n" },
        hooks: [],
      },
      {
        id: "pkg:agents-reviewer",
        packageId: "pkg",
        name: "reviewer",
        kind: "agent",
        path: "/tmp/pkg/agents/reviewer/AGENT.md",
        description: "Review agent.",
        metadata: { body: "# Reviewer\n" },
        hooks: [],
      },
      {
        id: "pkg:mcp-github",
        packageId: "pkg",
        name: "github",
        kind: "mcp",
        path: "/tmp/pkg/mcp/github/mcp.json",
        serverName: "github",
        config: { command: "node", args: ["github.js"] },
      },
    ],
  });
  await createBundle({ samxHome: root, id: "coding" });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:skills-review",
    kind: "skill",
  });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:agents-reviewer",
    kind: "agent",
  });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:mcp-github",
    kind: "mcp",
  });

  const plan = await planBundleLink({
    samxHome: root,
    bundleId: "coding",
    tool: "codex",
    projectRoot,
  });

  expect(plan.instructionBlocks).toEqual([
    expect.objectContaining({ path: join(projectRoot, "AGENTS.md") }),
  ]);
  expect(plan.tomlMerges).toEqual([
    expect.objectContaining({ path: join(projectRoot, ".codex/config.toml") }),
  ]);
  expect(plan.symlinks).toEqual([
    expect.objectContaining({ path: join(projectRoot, ".agents/skills/pkg-skills-review") }),
  ]);
});

test("codex skill-only link plan symlinks native skills and does not write AGENTS.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-codex-skill-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-codex-skill-project-"));
  await atomicWriteJson(samxPaths(root).index, {
    capabilities: [
      {
        id: "pkg:skills-review",
        packageId: "pkg",
        name: "review",
        kind: "skill",
        path: "/tmp/pkg/skills/review/SKILL.md",
        description: "Review code.",
        metadata: { body: "# Review\n" },
        hooks: [],
      },
    ],
  });
  await createBundle({ samxHome: root, id: "coding" });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:skills-review",
    kind: "skill",
  });

  const plan = await planBundleLink({
    samxHome: root,
    bundleId: "coding",
    tool: "codex",
    projectRoot,
  });

  expect(plan.symlinks).toEqual([
    expect.objectContaining({ path: join(projectRoot, ".agents/skills/pkg-skills-review") }),
  ]);
  expect(plan.instructionBlocks).toEqual([]);
  expect(plan.tomlMerges).toEqual([]);
});

test("codex agent-only link plan writes AGENTS.md managed instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-codex-agent-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-codex-agent-project-"));
  await atomicWriteJson(samxPaths(root).index, {
    capabilities: [
      {
        id: "pkg:agents-reviewer",
        packageId: "pkg",
        name: "reviewer",
        kind: "agent",
        path: "/tmp/pkg/agents/reviewer/AGENT.md",
        description: "Review agent.",
        metadata: { body: "# Reviewer\n" },
        hooks: [],
      },
    ],
  });
  await createBundle({ samxHome: root, id: "coding" });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:agents-reviewer",
    kind: "agent",
  });

  const plan = await planBundleLink({
    samxHome: root,
    bundleId: "coding",
    tool: "codex",
    projectRoot,
  });

  expect(plan.symlinks).toEqual([]);
  expect(plan.instructionBlocks).toEqual([
    expect.objectContaining({ path: join(projectRoot, "AGENTS.md") }),
  ]);
});

test("codex link plan ignores required hooks for other tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-codex-non-codex-hooks-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-codex-non-codex-hooks-project-"));
  await seedHookBundle({
    root,
    source: await mkdtemp(join(tmpdir(), "samx-codex-non-codex-hooks-source-")),
    tool: "both",
  });

  const plan = await planBundleLink({
    samxHome: root,
    bundleId: "coding",
    tool: "codex",
    projectRoot,
  });

  expect(plan.hooks).toEqual([]);
  expect(plan.instructionBlocks).toEqual([]);
});

test("codex link leaves AGENTS.md unchanged for skill-only bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-codex-agents-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-codex-agents-project-"));
  await writeFile(
    join(projectRoot, "AGENTS.md"),
    "# User instructions\n\nKeep this text.\n",
    "utf8"
  );
  await atomicWriteJson(samxPaths(root).index, {
    capabilities: [
      {
        id: "pkg:skills-review",
        packageId: "pkg",
        name: "review",
        kind: "skill",
        path: "/tmp/pkg/skills/review/SKILL.md",
        description: "Review code.",
        metadata: { body: "# Review\n" },
        hooks: [],
      },
    ],
  });
  await createBundle({ samxHome: root, id: "coding" });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:skills-review",
    kind: "skill",
  });

  await linkBundle({ samxHome: root, bundleId: "coding", tool: "codex", projectRoot });

  expect(await readFile(join(projectRoot, "AGENTS.md"), "utf8")).toBe(
    "# User instructions\n\nKeep this text.\n"
  );
  await unlinkBundle({ samxHome: root, bundleId: "coding", tool: "codex", projectRoot });
  expect(await readFile(join(projectRoot, "AGENTS.md"), "utf8")).not.toContain("SAMX:BEGIN");
  expect(await readFile(join(projectRoot, "AGENTS.md"), "utf8")).toContain("# User instructions");
});

test("codex link writes TOML MCP tables and unlink removes only recorded table", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-codex-mcp-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-codex-mcp-project-"));
  await mkdir(join(projectRoot, ".codex"), { recursive: true });
  await writeFile(
    join(projectRoot, ".codex/config.toml"),
    'model = "gpt-5"\n\n[profiles.default]\napproval_policy = "never"\n',
    "utf8"
  );
  await atomicWriteJson(samxPaths(root).index, {
    capabilities: [
      {
        id: "pkg:mcp-github",
        packageId: "pkg",
        name: "github",
        kind: "mcp",
        path: "/tmp/pkg/mcp/github/mcp.json",
        serverName: "github",
        config: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          env: { TOKEN: "${TOKEN}" },
        },
      },
      {
        id: "pkg:mcp-figma",
        packageId: "pkg",
        name: "figma",
        kind: "mcp",
        path: "/tmp/pkg/mcp/figma/mcp.json",
        serverName: "figma",
        config: {
          type: "url",
          url: "https://mcp.figma.com/mcp",
          authorization_token: "${FIGMA_TOKEN}",
        },
      },
    ],
  });
  await createBundle({ samxHome: root, id: "coding" });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:mcp-github",
    kind: "mcp",
  });
  await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:mcp-figma", kind: "mcp" });

  await linkBundle({ samxHome: root, bundleId: "coding", tool: "codex", projectRoot });
  await linkBundle({ samxHome: root, bundleId: "coding", tool: "codex", projectRoot });

  const linked = await readFile(join(projectRoot, ".codex/config.toml"), "utf8");
  expect(linked).toContain('model = "gpt-5"\n\n[profiles.default]\napproval_policy = "never"');
  expect(linked).toContain('# SAMX:BEGIN mcp_server="github"');
  expect(linked).toContain("[mcp_servers.github]");
  expect(linked).toContain('command = "npx"');
  expect(linked).toContain('args = ["-y", "@upstash/context7-mcp"]');
  expect(linked).toContain('env = { TOKEN = "${TOKEN}" }');
  expect(linked).toContain("[mcp_servers.figma]");
  expect(linked).toContain('bearer_token_env_var = "FIGMA_TOKEN"');
  expect(linked.match(/\[mcp_servers\.github\]/g)).toHaveLength(1);

  await unlinkBundle({ samxHome: root, bundleId: "coding", tool: "codex", projectRoot });

  const unlinked = await readFile(join(projectRoot, ".codex/config.toml"), "utf8");
  expect(unlinked).toBe('model = "gpt-5"\n\n[profiles.default]\napproval_policy = "never"\n');
});

test("codex mixed link applies native skill symlink, agent instructions, and MCP TOML then unlinks managed outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-codex-mixed-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-codex-mixed-project-"));
  const source = await mkdtemp(join(tmpdir(), "samx-codex-mixed-source-"));
  const skillRoot = join(source, "skills", "review");
  const agentRoot = join(source, "agents", "reviewer");
  await mkdir(skillRoot, { recursive: true });
  await mkdir(agentRoot, { recursive: true });
  await mkdir(join(projectRoot, ".agents", "skills", "unrelated"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "# Review\n", "utf8");
  await writeFile(join(agentRoot, "AGENT.md"), "# Reviewer\n", "utf8");
  await writeFile(
    join(projectRoot, "AGENTS.md"),
    "# User instructions\n\nKeep this text.\n",
    "utf8"
  );
  await atomicWriteJson(samxPaths(root).index, {
    capabilities: [
      {
        id: "pkg:skills-review",
        packageId: "pkg",
        name: "review",
        kind: "skill",
        path: skillRoot,
        description: "Review code.",
        metadata: { body: "# Review\n" },
        hooks: [],
      },
      {
        id: "pkg:agents-reviewer",
        packageId: "pkg",
        name: "reviewer",
        kind: "agent",
        path: agentRoot,
        description: "Review agent.",
        metadata: { body: "# Reviewer\n" },
        hooks: [],
      },
      {
        id: "pkg:mcp-github",
        packageId: "pkg",
        name: "github",
        kind: "mcp",
        path: join(source, "mcp", "github", "mcp.json"),
        serverName: "github",
        config: { command: "node", args: ["github.js"] },
      },
    ],
  });
  await createBundle({ samxHome: root, id: "coding" });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:skills-review",
    kind: "skill",
  });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:agents-reviewer",
    kind: "agent",
  });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:mcp-github",
    kind: "mcp",
  });

  await linkBundle({ samxHome: root, bundleId: "coding", tool: "codex", projectRoot });

  expect(
    (await lstat(join(projectRoot, ".agents/skills/pkg-skills-review"))).isSymbolicLink()
  ).toBe(true);
  const linkedAgents = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
  expect(linkedAgents).toContain("SAMX:BEGIN");
  expect(linkedAgents).toContain("## agent: reviewer");
  expect(linkedAgents).toContain("Review agent.");
  expect(linkedAgents).not.toContain("# Review\n");
  expect(await readFile(join(projectRoot, ".codex/config.toml"), "utf8")).toContain(
    "[mcp_servers.github]"
  );

  await unlinkBundle({ samxHome: root, bundleId: "coding", tool: "codex", projectRoot });

  await expect(lstat(join(projectRoot, ".agents/skills/pkg-skills-review"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await stat(join(projectRoot, ".agents", "skills", "unrelated"))).toBeTruthy();
  const unlinkedAgents = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
  expect(unlinkedAgents).not.toContain("SAMX:BEGIN");
  expect(unlinkedAgents).toContain("# User instructions");
  expect(unlinkedAgents).toContain("Keep this text.");
  expect(await readFile(join(projectRoot, ".codex/config.toml"), "utf8")).not.toContain(
    "[mcp_servers."
  );
});

test("codex TOML MCP tables quote server and field keys safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "samx-codex-mcp-quoted-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-codex-mcp-quoted-project-"));
  await atomicWriteJson(samxPaths(root).index, {
    capabilities: [
      {
        id: "pkg:mcp-special",
        packageId: "pkg",
        name: "special",
        kind: "mcp",
        path: "/tmp/pkg/mcp/special/mcp.json",
        serverName: 'github.com] \"prod\"\n[mcp_servers.evil]',
        config: { command: "node", args: ["server.js"], env: { "BAD.KEY": "value" } },
      },
    ],
  });
  await createBundle({ samxHome: root, id: "coding" });
  await addBundleItem({
    samxHome: root,
    bundleId: "coding",
    itemId: "pkg:mcp-special",
    kind: "mcp",
  });

  await linkBundle({ samxHome: root, bundleId: "coding", tool: "codex", projectRoot });

  const linked = await readFile(join(projectRoot, ".codex/config.toml"), "utf8");
  expect(linked).toContain('# SAMX:BEGIN mcp_server="github.com] \\"prod\\"\\n[mcp_servers.evil]"');
  expect(linked).toContain('[mcp_servers."github.com] \\"prod\\"\\n[mcp_servers.evil]"]');
  expect(linked).toContain('command = "node"');
  expect(linked).toContain('env = { "BAD.KEY" = "value" }');
  expect(linked).not.toContain("\n[mcp_servers.evil]\n");
  await unlinkBundle({ samxHome: root, bundleId: "coding", tool: "codex", projectRoot });
  expect(await readFile(join(projectRoot, ".codex/config.toml"), "utf8")).toBe("");
});

test("codex AGENTS.md block removal preserves adjacent user text separator", () => {
  const block = agentsMdBlock("coding", "codex", "# Review\n");

  expect(removeAgentsMdBlock(`user before\n${block}\nuser after`, "coding", "codex")).toBe(
    "user before\nuser after"
  );
});

test("codex AGENTS.md sentinels encode bundle ids safely", () => {
  const bundleId = "coding tool=claude -->\n# injected";
  const block = agentsMdBlock(bundleId, "codex", "# Review\n");

  expect(block).toContain('bundle="coding tool=claude -->\\n# injected"');
  expect(block).not.toContain(`bundle=${bundleId}`);
  expect(removeAgentsMdBlock(`user before\n${block}\nuser after`, bundleId, "codex")).toBe(
    "user before\nuser after"
  );
});

describe("link hook helpers", () => {
  test("annotation adds _samx and _samxFingerprint", () => {
    const hooks = {
      hooks: {
        Stop: [
          { matcher: ".*", hooks: [{ type: "command", command: "pnpm test" }] },
          { hooks: [{ type: "command", command: "pnpm lint" }] },
        ],
      },
    };

    const annotated = annotateClaudeHooks(hooks, {
      packageId: "pkg",
      hookId: "quality",
      bundleId: "coding",
      tool: "claude",
    }) as typeof hooks;

    expect(annotated.hooks.Stop).toEqual([
      expect.objectContaining({
        _samx: "pkg:quality:coding:claude",
        _samxFingerprint: fingerprintJson(hooks.hooks.Stop[0]),
      }),
      expect.objectContaining({
        _samx: "pkg:quality:coding:claude",
        _samxFingerprint: fingerprintJson(hooks.hooks.Stop[1]),
      }),
    ]);
  });

  test("annotation rejects malformed event groups with targeted errors", () => {
    expect(() =>
      annotateClaudeHooks(
        { hooks: { PreToolUse: { hooks: [] } } },
        { packageId: "pkg", hookId: "quality", bundleId: "coding", tool: "claude" }
      )
    ).toThrow("Invalid Claude hooks: event PreToolUse must be a group[]");
    expect(() =>
      annotateClaudeHooks(
        { hooks: { PreToolUse: ["not-a-group"] } },
        { packageId: "pkg", hookId: "quality", bundleId: "coding", tool: "claude" }
      )
    ).toThrow("Invalid Claude hooks: event PreToolUse group 0 must be an object");
    expect(() =>
      annotateClaudeHooks(
        { hooks: { PreToolUse: [{ matcher: ".*" }] } },
        { packageId: "pkg", hookId: "quality", bundleId: "coding", tool: "claude" }
      )
    ).toThrow("Invalid Claude hooks: event PreToolUse group 0 must contain hooks[]");
    expect(() =>
      annotateClaudeHooks(
        {
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [] },
              { matcher: "Bash", hooks: [] },
            ],
          },
        },
        { packageId: "pkg", hookId: "quality", bundleId: "coding", tool: "claude" }
      )
    ).toThrow("Invalid Claude hooks: event PreToolUse has duplicate matcher: Bash");
  });

  test("fingerprint ignores _samx metadata and is stable across object key order", () => {
    const first = fingerprintJson({ b: 2, a: { d: 4, c: 3 }, _samx: "pkg:old:coding:claude" });
    const second = fingerprintJson({ a: { _samxFingerprint: "old", c: 3, d: 4 }, b: 2 });

    expect(first).toBe(second);
  });

  test("fingerprintFile throws unreadable message on missing path", async () => {
    const path = join(tmpdir(), "samx-missing-hook-source.json");

    await expect(fingerprintFile(path)).rejects.toThrow(`Hook source file unreadable: ${path}`);
  });
});

describe("opencode linker", () => {
  test("auto-links opencode top-level and adjacent hooks from formula packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-auto-hooks-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-opencode-auto-hooks-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-auto-hooks-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await mkdir(join(packageRoot, "agents", "reviewer", "hooks"), { recursive: true });
    await mkdir(join(packageRoot, "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(join(packageRoot, "agents", "reviewer", "AGENT.md"), "# Reviewer\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      'export default { adjacent: "skill" }\n',
      "utf8"
    );
    await writeFile(
      join(packageRoot, "agents", "reviewer", "hooks", "opencode.mjs"),
      'export default { adjacent: "agent" }\n',
      "utf8"
    );
    await writeFile(
      join(packageRoot, "hooks", "safe-bash.js"),
      "export default { top: true }\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:agents-reviewer",
      kind: "agent",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
    });

    expect(result.plan.hookDecisionRequired).toBe(false);
    expect(result.plan.hookCandidates).toEqual([]);
    expect(result.plan.hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageId: "pkg", id: "safe-bash", inference: "top-level" }),
        expect.objectContaining({ packageId: "pkg", id: "review-opencode", inference: "adjacent" }),
        expect.objectContaining({
          packageId: "pkg",
          id: "reviewer-opencode",
          inference: "adjacent",
        }),
      ])
    );
    await expect(
      lstat(join(projectRoot, ".opencode", "plugins", "pkg-safe-bash.js"))
    ).resolves.toBeTruthy();
    await expect(
      lstat(join(projectRoot, ".opencode", "plugins", "pkg-review-opencode.js"))
    ).resolves.toBeTruthy();
    await expect(
      lstat(join(projectRoot, ".opencode", "plugins", "pkg-reviewer-opencode.mjs"))
    ).resolves.toBeTruthy();
    const records = await readLinkRecords({ samxHome: root });
    expect(records.links[0]?.managedHooks).toHaveLength(3);
  });

  test("auto-links opencode hooks from formula packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-trusted-hooks-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-opencode-trusted-hooks-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-trusted-hooks-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await mkdir(join(packageRoot, "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default { adjacent: true }\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "hooks", "safe-bash.js"),
      "export default { top: true }\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
    });

    expect(result.plan.hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageId: "pkg", id: "safe-bash", inference: "top-level" }),
        expect.objectContaining({ packageId: "pkg", id: "review-opencode", inference: "adjacent" }),
      ])
    );
    await expect(
      lstat(join(projectRoot, ".opencode", "plugins", "pkg-safe-bash.js"))
    ).resolves.toBeTruthy();
    await expect(
      lstat(join(projectRoot, ".opencode", "plugins", "pkg-review-opencode.js"))
    ).resolves.toBeTruthy();
  });

  test("auto-links opencode hooks from local packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-local-hooks-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-opencode-local-hooks-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-local-hooks-project-"));
    await mkdir(join(packageRoot, "skills", "review"), { recursive: true });
    await mkdir(join(packageRoot, "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "hooks", "safe-bash.js"),
      "export default { top: true }\n",
      "utf8"
    );
    await addLocalPackage({ samxHome: root, id: "local-tools", source: packageRoot });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "local-tools:skills-review",
      kind: "skill",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
    });

    expect(result.plan.hooks).toEqual([
      expect.objectContaining({
        packageId: "local-tools",
        id: "safe-bash",
        inference: "top-level",
      }),
    ]);
    await expect(
      lstat(join(projectRoot, ".opencode", "plugins", "local-tools-safe-bash.js"))
    ).resolves.toBeTruthy();
  });

  test("no-hooks disables automatic opencode hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-auto-hooks-none-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-opencode-auto-hooks-none-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-auto-hooks-none-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await mkdir(join(packageRoot, "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default {}\n",
      "utf8"
    );
    await writeFile(join(packageRoot, "hooks", "safe-bash.js"), "export default {}\n", "utf8");
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      adjacentHooks: { mode: "none" },
    });

    expect(result.plan.hooks).toEqual([]);
    expect(result.plan.skippedHooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageId: "pkg", id: "safe-bash", reason: "--no-hooks" }),
        expect.objectContaining({ packageId: "pkg", id: "review-opencode", reason: "--no-hooks" }),
      ])
    );
    await expect(
      stat(join(projectRoot, ".opencode", "plugins", "pkg-safe-bash.js"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(projectRoot, ".opencode", "plugins", "pkg-review-opencode.js"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports top-level opencode hook warnings for mcp-only formula packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-only-hooks-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-only-hooks-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-only-hooks-project-"));
    await mkdir(join(packageRoot, "mcp", "github"), { recursive: true });
    await mkdir(join(packageRoot, "hooks"), { recursive: true });
    await writeFile(
      join(packageRoot, "mcp", "github", "mcp.json"),
      JSON.stringify({ mcpServers: { github: { command: "node" } } }),
      "utf8"
    );
    await writeFile(join(packageRoot, "hooks", "safe-bash.js"), "export default {}\n", "utf8");
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    const result = await planBundleLink({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
    });

    expect(result.hooks).toEqual([]);
    expect(result.hookWarnings).toEqual([
      "Top-level hook skipped: hooks/safe-bash.js (no selected skill or agent capability from package pkg)",
    ]);
  });

  test("auto-links package opencode plugin hooks from formula packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-package-plugin-home-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-opencode-package-plugin-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-package-plugin-project-"));
    await mkdir(join(packageRoot, "skills", "review"), { recursive: true });
    await mkdir(join(packageRoot, ".opencode", "plugins"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, ".opencode", "plugins", "superpowers.js"),
      "export default {}\n",
      "utf8"
    );
    await indexFormulaFixture(root, "superpowers", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-review",
      kind: "skill",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
    });

    expect(result.plan.hooks).toEqual([
      expect.objectContaining({
        packageId: "superpowers",
        id: "superpowers",
        inference: "top-level",
      }),
    ]);
    await expect(
      lstat(join(projectRoot, ".opencode", "plugins", "superpowers-superpowers.js"))
    ).resolves.toBeTruthy();
  });

  test("opencode mcp merge uses package-scoped server keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-scoped-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-scoped-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "superpowers:mcp-github",
          packageId: "superpowers",
          name: "github",
          kind: "mcp",
          path: "/tmp/superpowers/mcp/github/mcp.json",
          serverName: "github",
          config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        },
        {
          id: "@org/pkg:mcp-github/server",
          packageId: "@org/pkg",
          name: "github/server",
          kind: "mcp",
          path: "/tmp/org-pkg/mcp/github-server/mcp.json",
          serverName: "github-server",
          config: { command: "node", args: ["org-github.js"] },
        },
        {
          id: "default/obra/superpowers:mcp-github",
          packageId: "default/obra/superpowers",
          name: "mcp-github",
          kind: "mcp",
          path: "/tmp/default-superpowers/mcp/github/mcp.json",
          serverName: "github",
          config: { command: "node", args: ["default-obra-superpowers-github.js"] },
        },
        {
          id: "tools:mcp-github",
          packageId: "tools",
          name: "github",
          kind: "mcp",
          path: "/tmp/tools/mcp/github/mcp.json",
          serverName: "github",
          config: { command: "node", args: ["github.js"] },
        },
        {
          id: "default/hex.tech/hex:hex",
          packageId: "default/hex.tech/hex",
          name: "hex",
          kind: "mcp",
          path: "/tmp/default-hex/mcp/hex/mcp.json",
          serverName: "hex",
          config: { command: "node", args: ["hex.js"] },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:mcp-github",
      kind: "mcp",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "@org/pkg:mcp-github/server",
      kind: "mcp",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "default/obra/superpowers:mcp-github",
      kind: "mcp",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "tools:mcp-github",
      kind: "mcp",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "default/hex.tech/hex:hex",
      kind: "mcp",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    expect(result.plan.jsonMerges[0]?.entries.map((entry) => entry.key).sort()).toEqual([
      "hex.tech-hex",
      "obra-superpowers-github",
      "org-pkg-github-server",
      "superpowers-github",
      "tools-github",
    ]);
    const mcp = JSON.parse(await readFile(join(project, ".opencode", "opencode.json"), "utf8"));
    expect(mcp.$schema).toBe("https://opencode.ai/config.json");
    expect(mcp.mcp["org-pkg-github-server"]).toEqual({
      type: "local",
      command: ["node", "org-github.js"],
    });
    expect(mcp.mcp["obra-superpowers-github"]).toEqual({
      type: "local",
      command: ["node", "default-obra-superpowers-github.js"],
    });
    expect(mcp.mcp["hex.tech-hex"]).toEqual({ type: "local", command: ["node", "hex.js"] });
    expect(mcp.mcp["superpowers-github"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
    });
    expect(mcp.mcp["tools-github"]).toEqual({ type: "local", command: ["node", "github.js"] });
    expect((await readLinkRecords({ samxHome: root })).links[0]?.generatedFiles).toContain(
      join(project, ".opencode", "opencode.json")
    );
  });

  test("opencode mcp merge preserves existing opencode config and mcp servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-preserve-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-preserve-project-"));
    const configPath = join(projectRoot, ".opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "anthropic/claude-sonnet-4-6",
        mcp: { local: { type: "remote", url: "https://local.example", enabled: true } },
      }),
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          config: { type: "remote", url: "https://github.example", enabled: true },
          metadata: {},
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.model).toBe("anthropic/claude-sonnet-4-6");
    expect(config.mcp.local).toEqual({
      type: "remote",
      url: "https://local.example",
      enabled: true,
    });
    expect(config.mcp["pkg-github"]).toEqual({
      type: "remote",
      url: "https://github.example",
      enabled: true,
    });
  });

  test("transforms Claude local mcp source when linking to opencode", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-transform-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-transform-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          sourceFormat: "claude-local",
          config: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "token" },
          },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    const config = JSON.parse(
      await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8")
    );
    expect(config.mcp["pkg-github"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      environment: { GITHUB_TOKEN: "token" },
    });
  });

  test("detects MCP conflicts after transforming source config for target", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-mcp-transform-conflict-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-mcp-transform-conflict-project-"));
    const configPath = join(projectRoot, ".opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ mcp: { "pkg-github": { type: "local", command: ["node", "other.js"] } } }),
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          sourceFormat: "claude-local",
          transport: "stdio",
          config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
          metadata: {},
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot })
    ).rejects.toThrow("MCP server already exists with different config: pkg-github");
  });

  test("transforms OpenCode local mcp source when linking to claude", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-mcp-transform-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-claude-mcp-transform-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          sourceFormat: "opencode",
          config: {
            type: "local",
            command: ["npx", "-y", "@modelcontextprotocol/server-github"],
            environment: { GITHUB_TOKEN: "token" },
          },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "claude", projectRoot });

    const config = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf8"));
    expect(config.mcpServers["pkg-github"]).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "token" },
    });
  });

  test("passes through OpenCode mcp source when linking to opencode", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-pass-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-pass-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          sourceFormat: "opencode",
          config: {
            type: "local",
            command: ["npx", "-y", "@modelcontextprotocol/server-github"],
            environment: { GITHUB_TOKEN: "token" },
          },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    const config = JSON.parse(
      await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8")
    );
    expect(config.mcp["pkg-github"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      environment: { GITHUB_TOKEN: "token" },
    });
  });

  test("transforms Claude API mcp source when linking to opencode", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-api-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-api-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          sourceFormat: "claude-api",
          transport: "remote",
          config: { type: "url", url: "https://github.example/mcp", authorization_token: "token" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    const config = JSON.parse(
      await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8")
    );
    expect(config.mcp["pkg-github"]).toEqual({
      type: "remote",
      url: "https://github.example/mcp",
      enabled: true,
      headers: { Authorization: "Bearer token" },
    });
  });

  test("passes through typed direct remote mcp source when linking to opencode", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-direct-remote-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-direct-remote-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          sourceFormat: "direct",
          transport: "remote",
          config: { type: "remote", url: "https://example.test/mcp" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    const config = JSON.parse(
      await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8")
    );
    expect(config.mcp["pkg-github"]).toEqual({ type: "remote", url: "https://example.test/mcp" });
  });

  test("maps SSE MCP direct config to OpenCode remote config", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-sse-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-sse-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-weather",
          packageId: "pkg",
          name: "weather",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "weather",
          config: { type: "sse", url: "https://weather.example/sse" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-weather",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    const config = JSON.parse(
      await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8")
    );
    expect(config.mcp["pkg-weather"]).toEqual({
      type: "remote",
      url: "https://weather.example/sse",
    });
  });

  test("maps SSE MCP direct config to Codex remote config", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-codex-mcp-sse-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-codex-mcp-sse-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-weather",
          packageId: "pkg",
          name: "weather",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "weather",
          config: { type: "sse", url: "https://weather.example/sse" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-weather",
      kind: "mcp",
    });

    const plan = await planBundleLink({
      samxHome: root,
      bundleId: "coding",
      tool: "codex",
      projectRoot,
    });

    expect(plan.tomlMerges[0].entries).toEqual([
      { key: "weather", value: { url: "https://weather.example/sse" } },
    ]);
  });

  test("rejects non-HTTPS SSE MCP direct config when linking to OpenCode", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-sse-http-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-sse-http-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-weather",
          packageId: "pkg",
          name: "weather",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "weather",
          config: { type: "sse", url: "http://weather.example/sse" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-weather",
      kind: "mcp",
    });

    await expect(
      planBundleLink({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot })
    ).rejects.toThrow("Invalid remote MCP URL: URL must start with https://");
  });

  test("rejects non-HTTPS SSE MCP direct config when linking to Codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-codex-mcp-sse-http-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-codex-mcp-sse-http-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-weather",
          packageId: "pkg",
          name: "weather",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "weather",
          config: { type: "sse", url: "http://weather.example/sse" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-weather",
      kind: "mcp",
    });

    await expect(
      planBundleLink({ samxHome: root, bundleId: "coding", tool: "codex", projectRoot })
    ).rejects.toThrow("Invalid remote MCP URL: URL must start with https://");
  });

  test("transforms HTTP mcp source when linking to opencode", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-http-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-http-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-airtable",
          packageId: "pkg",
          name: "airtable",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "airtable",
          sourceFormat: "claude-local",
          transport: "remote",
          config: { type: "http", url: "https://mcp.airtable.com/mcp" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-airtable",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    const config = JSON.parse(
      await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8")
    );
    expect(config.mcp["pkg-airtable"]).toEqual({
      type: "remote",
      url: "https://mcp.airtable.com/mcp",
    });
  });

  test("infers legacy HTTP mcp source when linking to opencode", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-legacy-http-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-legacy-http-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-airtable",
          packageId: "pkg",
          name: "airtable",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "airtable",
          config: { type: "http", url: "https://mcp.airtable.com/mcp" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-airtable",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    const config = JSON.parse(
      await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8")
    );
    expect(config.mcp["pkg-airtable"]).toEqual({
      type: "remote",
      url: "https://mcp.airtable.com/mcp",
    });
  });

  test("infers legacy named HTTP mcp source when linking to opencode", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-legacy-named-http-home-"));
    const projectRoot = await mkdtemp(
      join(tmpdir(), "samx-opencode-mcp-legacy-named-http-project-")
    );
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-airtable",
          packageId: "pkg",
          name: "airtable",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "airtable",
          config: { airtable: { type: "http", url: "https://mcp.airtable.com/mcp" } },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-airtable",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    const config = JSON.parse(
      await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8")
    );
    expect(config.mcp["pkg-airtable"]).toEqual({
      type: "remote",
      url: "https://mcp.airtable.com/mcp",
    });
  });

  test("infers legacy Claude API mcp source when linking to opencode", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-legacy-api-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-legacy-api-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          config: { type: "url", url: "https://example.test/mcp", authorization_token: "TOKEN" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    const config = JSON.parse(
      await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8")
    );
    expect(config.mcp["pkg-github"]).toEqual({
      type: "remote",
      url: "https://example.test/mcp",
      enabled: true,
      headers: { Authorization: "Bearer TOKEN" },
    });
  });

  test("passes through Claude local mcp source when linking to claude and kiro", async () => {
    for (const tool of ["claude", "kiro"]) {
      const root = await mkdtemp(join(tmpdir(), `samx-${tool}-mcp-pass-home-`));
      const projectRoot = await mkdtemp(join(tmpdir(), `samx-${tool}-mcp-pass-project-`));
      await atomicWriteJson(samxPaths(root).index, {
        capabilities: [
          {
            id: "pkg:mcp-github",
            packageId: "pkg",
            name: "github",
            kind: "mcp",
            path: "/tmp/mcp.json",
            serverName: "github",
            sourceFormat: "claude-local",
            config: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: { GITHUB_TOKEN: "token" },
            },
          },
        ],
      });
      await createBundle({ samxHome: root, id: "coding" });
      await addBundleItem({
        samxHome: root,
        bundleId: "coding",
        itemId: "pkg:mcp-github",
        kind: "mcp",
      });

      await linkBundle({ samxHome: root, bundleId: "coding", tool, projectRoot });

      const config = JSON.parse(
        await readFile(join(projectRoot, tool === "kiro" ? ".kiro/mcp.json" : ".mcp.json"), "utf8")
      );
      const key = tool === "kiro" ? "github" : "pkg-github";
      expect(config.mcpServers[key]).toEqual({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "token" },
      });
    }
  });

  test("transforms remote mcp sources when linking to claude", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-mcp-remote-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-claude-mcp-remote-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          sourceFormat: "claude-api",
          transport: "remote",
          config: { type: "url", url: "https://github.example/mcp" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "claude", projectRoot });

    const config = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf8"));
    expect(config.mcpServers["pkg-github"]).toEqual({
      type: "http",
      url: "https://github.example/mcp",
    });
  });

  test("rejects remote mcp sources when linking to kiro", async () => {
    for (const tool of ["kiro"] as const) {
      const root = await mkdtemp(join(tmpdir(), `samx-${tool}-mcp-remote-home-`));
      const projectRoot = await mkdtemp(join(tmpdir(), `samx-${tool}-mcp-remote-project-`));
      await atomicWriteJson(samxPaths(root).index, {
        capabilities: [
          {
            id: "pkg:mcp-github",
            packageId: "pkg",
            name: "github",
            kind: "mcp",
            path: "/tmp/mcp.json",
            serverName: "github",
            sourceFormat: "claude-api",
            transport: "remote",
            config: { type: "url", url: "https://github.example/mcp" },
          },
        ],
      });
      await createBundle({ samxHome: root, id: "coding" });
      await addBundleItem({
        samxHome: root,
        bundleId: "coding",
        itemId: "pkg:mcp-github",
        kind: "mcp",
      });

      await expect(
        planBundleLink({ samxHome: root, bundleId: "coding", tool, projectRoot })
      ).rejects.toThrow(
        `Unsupported MCP transform for ${tool}: remote servers cannot be linked to ${tool}`
      );
    }
  });

  test("maps SSE MCP direct config to Claude HTTP config", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-mcp-sse-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-claude-mcp-sse-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-weather",
          packageId: "pkg",
          name: "weather",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "weather",
          config: { type: "sse", url: "https://weather.example/sse" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-weather",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "claude", projectRoot });

    const config = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf8"));
    expect(config.mcpServers["pkg-weather"]).toEqual({
      type: "http",
      url: "https://weather.example/sse",
    });
  });

  test("scopes Claude MCP output keys to avoid duplicate server name collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-mcp-duplicate-server-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-claude-mcp-duplicate-server-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "local/airtable/skills:airtable",
          packageId: "local/airtable/skills",
          name: "airtable",
          kind: "mcp",
          serverName: "airtable",
          sourceFormat: "claude-local",
          transport: "remote",
          config: { type: "http", url: "https://mcp.airtable.com/mcp" },
        },
        {
          id: "local/airtable/skills:airtable-2",
          packageId: "local/airtable/skills",
          name: "airtable-2",
          kind: "mcp",
          serverName: "airtable",
          sourceFormat: "direct",
          transport: "remote",
          config: { type: "http", url: "https://mcp.airtable.com/mcp" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "local/airtable/skills:airtable",
      kind: "mcp",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "local/airtable/skills:airtable-2",
      kind: "mcp",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "claude", projectRoot });

    const config = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf8"));
    expect(config.mcpServers["local-airtable-skills-airtable"]).toEqual({
      type: "http",
      url: "https://mcp.airtable.com/mcp",
    });
    expect(config.mcpServers["local-airtable-skills-airtable-2"]).toEqual({
      type: "http",
      url: "https://mcp.airtable.com/mcp",
    });
  });

  test("rejects SSE MCP direct config when linking to kiro", async () => {
    for (const tool of ["kiro"] as const) {
      const root = await mkdtemp(join(tmpdir(), `samx-${tool}-mcp-sse-home-`));
      const projectRoot = await mkdtemp(join(tmpdir(), `samx-${tool}-mcp-sse-project-`));
      await atomicWriteJson(samxPaths(root).index, {
        capabilities: [
          {
            id: "pkg:mcp-weather",
            packageId: "pkg",
            name: "weather",
            kind: "mcp",
            path: "/tmp/mcp.json",
            serverName: "weather",
            config: { type: "sse", url: "https://weather.example/sse" },
          },
        ],
      });
      await createBundle({ samxHome: root, id: "coding" });
      await addBundleItem({
        samxHome: root,
        bundleId: "coding",
        itemId: "pkg:mcp-weather",
        kind: "mcp",
      });

      await expect(
        planBundleLink({ samxHome: root, bundleId: "coding", tool, projectRoot })
      ).rejects.toThrow(
        `Unsupported MCP transform for ${tool}: remote servers cannot be linked to ${tool}`
      );
    }
  });

  test("does not infer direct url mcp source as remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-direct-url-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-opencode-mcp-direct-url-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          sourceFormat: "direct",
          config: { url: "https://github.example/mcp" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });

    await expect(
      planBundleLink({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot })
    ).rejects.toThrow("Invalid Claude local MCP server: command must be a string");
  });

  test("surfaces clear mcp transform validation errors", async () => {
    const cases = [
      {
        tool: "opencode",
        capability: { sourceFormat: "claude-local", config: { args: ["-y"] } },
        message: "Invalid Claude local MCP server: command must be a string",
      },
      {
        tool: "opencode",
        capability: { sourceFormat: "opencode", config: { type: "local", command: "npx" } },
        message: "Invalid OpenCode MCP server: local command must be string[]",
      },
      {
        tool: "claude",
        capability: { sourceFormat: "opencode", config: { type: "local", command: [] } },
        message: "Invalid OpenCode MCP server: local command must be string[]",
      },
      {
        tool: "claude",
        capability: { sourceFormat: "opencode", config: { type: "local", command: "npx" } },
        message: "Invalid OpenCode MCP server: local command must be string[]",
      },
      {
        tool: "opencode",
        capability: {
          sourceFormat: "claude-api",
          config: { type: "stdio", url: "https://github.example/mcp" },
        },
        message: "Invalid Claude API MCP server: type must be url and url must be a string",
      },
      {
        tool: "opencode",
        capability: {
          sourceFormat: "claude-api",
          config: { type: "url", url: "http://github.example/mcp" },
        },
        message: "Invalid remote MCP URL: URL must start with https://",
      },
    ] as const;
    for (const entry of cases) {
      const root = await mkdtemp(join(tmpdir(), "samx-mcp-validation-home-"));
      const projectRoot = await mkdtemp(join(tmpdir(), "samx-mcp-validation-project-"));
      await atomicWriteJson(samxPaths(root).index, {
        capabilities: [
          {
            id: "pkg:mcp-github",
            packageId: "pkg",
            name: "github",
            kind: "mcp",
            path: "/tmp/mcp.json",
            serverName: "github",
            ...entry.capability,
          },
        ],
      });
      await createBundle({ samxHome: root, id: "coding" });
      await addBundleItem({
        samxHome: root,
        bundleId: "coding",
        itemId: "pkg:mcp-github",
        kind: "mcp",
      });

      await expect(
        planBundleLink({ samxHome: root, bundleId: "coding", tool: entry.tool, projectRoot })
      ).rejects.toThrow(entry.message);
    }
  });

  test("dry run auto-plans adjacent opencode hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-link-adjacent-dry-run-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default {}\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    const plan = await planBundleLink({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
    });

    expect(plan.hooks).toEqual([
      expect.objectContaining({ packageId: "pkg", id: "review-opencode", inference: "adjacent" }),
    ]);
    expect(plan.hookDecisionRequired).toBe(false);
    expect(plan.hookCandidates).toEqual([]);
  });

  test("selected adjacent hooks become normal hook plan entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-link-adjacent-enable-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-enable-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-enable-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default {}\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    const plan = await planBundleLink({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      adjacentHooks: { mode: "selected", ids: ["review-opencode"] },
    });

    expect(plan.hookDecisionRequired).toBe(false);
    expect(plan.hooks).toEqual([
      expect.objectContaining({ packageId: "pkg", id: "review-opencode", inference: "adjacent" }),
    ]);
  });

  test("apply auto-links adjacent opencode hooks without an explicit decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-link-adjacent-required-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-required-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-required-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default {}\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });

    await expect(
      lstat(join(projectRoot, ".opencode", "plugins", "pkg-review-opencode.js"))
    ).resolves.toBeTruthy();
  });

  test("records enabled adjacent hooks after successful link apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-link-adjacent-record-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-record-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-record-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default {}\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      adjacentHooks: { mode: "all" },
    });

    const records = await readLinkRecords({ samxHome: root });
    expect(records.links[0]?.managedHooks).toEqual([
      expect.objectContaining({ packageId: "pkg", id: "review-opencode", inference: "adjacent" }),
    ]);
    expect(records.links[0]?.adjacentHooks).toEqual([]);
  });

  test("does not record adjacent hooks masked by declared manifest hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-link-adjacent-masked-record-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-masked-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-masked-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await mkdir(join(packageRoot, "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default { adjacent: true }\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "hooks", "review-opencode.js"),
      "export default { declared: true }\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "samx.package.json"),
      JSON.stringify({
        hooks: [
          {
            id: "review-opencode",
            appliesTo: ["skill:review"],
            files: [{ target: "opencode", path: "hooks/review-opencode.js" }],
            required: false,
          },
        ],
      }),
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      adjacentHooks: { mode: "all" },
    });

    const records = await readLinkRecords({ samxHome: root });
    expect(records.links[0]?.managedHooks).toEqual([
      expect.objectContaining({ packageId: "pkg", id: "review-opencode", inference: "adjacent" }),
    ]);
    expect(records.links[0]?.adjacentHooks).toEqual([]);
  });

  test("relink reuse ignores adjacent hook candidates masked by declared hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-link-adjacent-masked-reuse-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-masked-reuse-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-masked-reuse-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await mkdir(join(packageRoot, "skills", "test", "hooks"), { recursive: true });
    await mkdir(join(packageRoot, "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(join(packageRoot, "skills", "test", "SKILL.md"), "# Test\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default { adjacent: true }\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "skills", "test", "hooks", "opencode.js"),
      "export default { adjacent: true }\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "hooks", "review-opencode.js"),
      "export default { declared: true }\n",
      "utf8"
    );
    await writeFile(
      join(packageRoot, "samx.package.json"),
      JSON.stringify({
        hooks: [
          {
            id: "review-opencode",
            appliesTo: ["skill:review"],
            files: [{ target: "opencode", path: "hooks/review-opencode.js" }],
            required: false,
          },
        ],
      }),
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-test",
      kind: "skill",
    });

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      adjacentHooks: { mode: "all" },
    });

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "opencode",
        projectRoot,
        overwrite: true,
      })
    ).resolves.toEqual(
      expect.objectContaining({ plan: expect.objectContaining({ hookDecisionRequired: false }) })
    );
    const record = (await readLinkRecords({ samxHome: root })).links[0];
    expect(record?.managedHooks).toHaveLength(2);
    expect(record?.adjacentHooks).toEqual([]);
  });

  test("records no adjacent hooks when applying with hooks disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-link-adjacent-none-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-none-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-none-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default {}\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      adjacentHooks: { mode: "none" },
    });

    await expect(
      stat(join(projectRoot, ".opencode", "plugins", "pkg-review-opencode.js"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLinkRecords({ samxHome: root })).links[0]?.adjacentHooks).toEqual([]);
  });

  test("relinks selected adjacent hooks without a repeated decision when the record still matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-link-adjacent-reuse-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-reuse-package-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-link-adjacent-reuse-project-"));
    await mkdir(join(packageRoot, "skills", "review", "hooks"), { recursive: true });
    await writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(
      join(packageRoot, "skills", "review", "hooks", "opencode.js"),
      "export default {}\n",
      "utf8"
    );
    await indexFormulaFixture(root, "pkg", packageRoot);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      adjacentHooks: { mode: "selected", ids: ["review-opencode"] },
    });
    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      overwrite: true,
    });

    const records = await readLinkRecords({ samxHome: root });
    expect(records.links[0]?.managedHooks).toEqual([
      expect.objectContaining({ packageId: "pkg", id: "review-opencode", inference: "adjacent" }),
    ]);
    expect(records.links[0]?.adjacentHooks).toEqual([]);
  });

  test("dry-run link plans claude and opencode hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-hook-plan-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-hook-plan-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-hook-plan-source-"));
    const skillPath = join(source, "skills", "safe-bash", "SKILL.md");
    const claudeHook = join(source, "hooks", "claude.json");
    const opencodeHook = join(source, "hooks", "safe-bash.js");
    await mkdir(join(source, "skills", "safe-bash"), { recursive: true });
    await mkdir(join(source, "hooks"), { recursive: true });
    await writeFile(skillPath, "# Safe Bash\n", "utf8");
    await writeFile(
      claudeHook,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "node safe-bash.js" }] },
          ],
        },
      }),
      "utf8"
    );
    await writeFile(opencodeHook, "export const plugin = true\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-safe-bash",
          packageId: "pkg",
          name: "safe-bash",
          kind: "skill",
          path: skillPath,
          description: "Checks bash commands.",
          metadata: { body: "# Safe Bash\n" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "claude",
              file: claudeHook,
              required: true,
              appliesTo: ["skill:safe-bash"],
            },
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "opencode",
              file: opencodeHook,
              required: true,
              appliesTo: ["skill:safe-bash"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-safe-bash",
      kind: "skill",
    });

    const claude = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "claude",
      projectRoot: project,
      dryRun: true,
    });
    const opencode = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
      dryRun: true,
    });

    const settingsPath = join(project, ".claude", "settings.json");
    const outputPath = join(project, ".opencode", "plugins", "pkg-safe-bash.js");
    expect(claude.plan.hooks).toEqual([
      expect.objectContaining({
        id: "safe-bash",
        packageId: "pkg",
        kind: "jsonMerge",
        tool: "claude",
        sourcePath: claudeHook,
        settingsPath,
        required: true,
        appliesTo: ["skill:safe-bash"],
      }),
    ]);
    expect(claude.plan.generatedFiles).toContain(settingsPath);
    expect(opencode.plan.hooks).toEqual([
      expect.objectContaining({
        id: "safe-bash",
        packageId: "pkg",
        kind: "symlink",
        tool: "opencode",
        sourcePath: opencodeHook,
        outputPath,
        required: true,
        appliesTo: ["skill:safe-bash"],
        preview: { file: opencodeHook },
      }),
    ]);
    expect(opencode.plan.hooks[0]?.fingerprint).toMatch(/^sha256:/);
    expect(opencode.plan.symlinks).not.toContainEqual({ path: outputPath, target: opencodeHook });
    expect(opencode.plan.generatedFiles).toContain(outputPath);
    expect(claude.written).toEqual([]);
    expect(opencode.written).toEqual([]);
    await expect(stat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("relink removes stale opencode MCP server keys when output key changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-mcp-relink-key-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-mcp-relink-key-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          config: { command: "node", args: ["old.js"] },
          metadata: {},
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });
    await linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot });
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github-renamed",
          kind: "mcp",
          path: "/tmp/mcp.json",
          serverName: "github",
          config: { command: "node", args: ["new.js"] },
          metadata: {},
        },
      ],
    });

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot,
      overwrite: true,
    });

    const mcp = JSON.parse(await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8"));
    expect(mcp.mcp).toEqual({
      "pkg-github-renamed": { type: "local", command: ["node", "new.js"] },
    });
  });

  test("dry-run hook planning reports unreadable claude hook sources consistently", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-hook-missing-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-hook-missing-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-hook-missing-source-"));
    const skillPath = join(source, "skills", "safe-bash", "SKILL.md");
    const missingHook = join(source, "hooks", "missing.json");
    await mkdir(join(source, "skills", "safe-bash"), { recursive: true });
    await writeFile(skillPath, "# Safe Bash\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-safe-bash",
          packageId: "pkg",
          name: "safe-bash",
          kind: "skill",
          path: skillPath,
          metadata: { body: "# Safe Bash\n" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "claude",
              file: missingHook,
              required: true,
              appliesTo: ["skill:safe-bash"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-safe-bash",
      kind: "skill",
    });

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "claude",
        projectRoot: project,
        dryRun: true,
      })
    ).rejects.toThrow(`Hook source file unreadable: ${missingHook}`);
  });

  test("dry-run hook planning deduplicates shared hook attachments across capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-hook-dedupe-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-hook-dedupe-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-hook-dedupe-source-"));
    const hookPath = join(source, "hooks", "claude.json");
    await mkdir(join(source, "skills", "safe-bash"), { recursive: true });
    await mkdir(join(source, "skills", "safe-edit"), { recursive: true });
    await mkdir(join(source, "hooks"), { recursive: true });
    await writeFile(join(source, "skills", "safe-bash", "SKILL.md"), "# Safe Bash\n", "utf8");
    await writeFile(join(source, "skills", "safe-edit", "SKILL.md"), "# Safe Edit\n", "utf8");
    await writeFile(
      hookPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "node safe-bash.js" }] },
          ],
        },
      }),
      "utf8"
    );
    const sharedHook = {
      id: "safe-bash",
      packageId: "pkg",
      tool: "claude",
      file: hookPath,
      required: true,
      appliesTo: ["skill:safe-bash"],
    };
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-safe-bash",
          packageId: "pkg",
          name: "safe-bash",
          kind: "skill",
          path: join(source, "skills", "safe-bash", "SKILL.md"),
          metadata: { body: "# Safe Bash\n" },
          hooks: [sharedHook],
        },
        {
          id: "pkg:skills-safe-edit",
          packageId: "pkg",
          name: "safe-edit",
          kind: "skill",
          path: join(source, "skills", "safe-edit", "SKILL.md"),
          metadata: { body: "# Safe Edit\n" },
          hooks: [sharedHook],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-safe-bash",
      kind: "skill",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-safe-edit",
      kind: "skill",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "claude",
      projectRoot: project,
      dryRun: true,
    });

    expect(result.plan.hooks).toHaveLength(1);
    expect(result.plan.hooks[0]).toEqual(
      expect.objectContaining({ id: "safe-bash", packageId: "pkg", tool: "claude" })
    );
  });

  test("dry-run hook planning rejects required hooks for targets without hook support", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-hook-unsupported-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-hook-unsupported-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-hook-unsupported-source-"));
    const skillPath = join(source, "skills", "safe-bash", "SKILL.md");
    const hookPath = join(source, "hooks", "safe-bash.js");
    await mkdir(join(source, "skills", "safe-bash"), { recursive: true });
    await mkdir(join(source, "hooks"), { recursive: true });
    await writeFile(skillPath, "# Safe Bash\n", "utf8");
    await writeFile(hookPath, "export const plugin = true\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-safe-bash",
          packageId: "pkg",
          name: "safe-bash",
          kind: "skill",
          path: skillPath,
          metadata: { body: "# Safe Bash\n" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "opencode",
              file: hookPath,
              required: true,
              appliesTo: ["skill:safe-bash"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-safe-bash",
      kind: "skill",
    });

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "kiro",
        projectRoot: project,
        dryRun: true,
      })
    ).rejects.toThrow("Required hook target unsupported: safe-bash (kiro)");
  });

  test("dry-run opencode hook planning rejects output-name collisions before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-hook-collision-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-hook-collision-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-hook-collision-source-"));
    const firstSkill = join(source, "skills", "first", "SKILL.md");
    const secondSkill = join(source, "skills", "second", "SKILL.md");
    const firstHook = join(source, "hooks", "first.js");
    const secondHook = join(source, "hooks", "second.js");
    await mkdir(join(source, "skills", "first"), { recursive: true });
    await mkdir(join(source, "skills", "second"), { recursive: true });
    await mkdir(join(source, "hooks"), { recursive: true });
    await writeFile(firstSkill, "# First\n", "utf8");
    await writeFile(secondSkill, "# Second\n", "utf8");
    await writeFile(firstHook, "export const first = true\n", "utf8");
    await writeFile(secondHook, "export const second = true\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:first",
          packageId: "pkg:a/b",
          name: "first",
          kind: "skill",
          path: firstSkill,
          metadata: { body: "# First\n" },
          hooks: [
            {
              id: "hook",
              packageId: "pkg:a/b",
              tool: "opencode",
              file: firstHook,
              required: true,
              appliesTo: ["skill:first"],
            },
          ],
        },
        {
          id: "pkg:second",
          packageId: "pkg:a:b",
          name: "second",
          kind: "skill",
          path: secondSkill,
          metadata: { body: "# Second\n" },
          hooks: [
            {
              id: "hook",
              packageId: "pkg:a:b",
              tool: "opencode",
              file: secondHook,
              required: true,
              appliesTo: ["skill:second"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:first", kind: "skill" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:second",
      kind: "skill",
    });
    const outputPath = join(project, ".opencode", "plugins", "pkg-a-b-hook.js");

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "opencode",
        projectRoot: project,
        dryRun: true,
      })
    ).rejects.toThrow(`OpenCode hook output path collision: ${outputPath}`);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("opencode hook planning rejects disallowed file extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-hook-extension-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-hook-extension-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-hook-extension-source-"));
    const skillPath = join(source, "skills", "safe-bash", "SKILL.md");
    const hookPath = join(source, "hooks", "safe-bash.ts");
    await mkdir(join(source, "skills", "safe-bash"), { recursive: true });
    await mkdir(join(source, "hooks"), { recursive: true });
    await writeFile(skillPath, "# Safe Bash\n", "utf8");
    await writeFile(hookPath, "export const plugin = true\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-safe-bash",
          packageId: "pkg",
          name: "safe-bash",
          kind: "skill",
          path: skillPath,
          metadata: { body: "# Safe Bash\n" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "opencode",
              file: hookPath,
              required: true,
              appliesTo: ["skill:safe-bash"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-safe-bash",
      kind: "skill",
    });

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "opencode",
        projectRoot: project,
        dryRun: true,
      })
    ).rejects.toThrow("OpenCode hook file extension is not allowed: safe-bash");
    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "opencode",
        projectRoot: project,
        dryRun: true,
      })
    ).rejects.not.toThrow(hookPath);
  });

  test("opencode hook planning accepts configured extensions case-insensitively", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-hook-extension-case-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-hook-extension-case-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-hook-extension-case-source-"));
    const skillPath = join(source, "skills", "safe-bash", "SKILL.md");
    const hookPath = join(source, "hooks", "safe-bash.MJS");
    await mkdir(join(source, "skills", "safe-bash"), { recursive: true });
    await mkdir(join(source, "hooks"), { recursive: true });
    await writeFile(skillPath, "# Safe Bash\n", "utf8");
    await writeFile(hookPath, "export const plugin = true\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-safe-bash",
          packageId: "pkg",
          name: "safe-bash",
          kind: "skill",
          path: skillPath,
          metadata: { body: "# Safe Bash\n" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "opencode",
              file: hookPath,
              required: true,
              appliesTo: ["skill:safe-bash"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-safe-bash",
      kind: "skill",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
      dryRun: true,
    });

    expect(result.plan.hooks[0]).toEqual(
      expect.objectContaining({
        outputPath: join(project, ".opencode", "plugins", "pkg-safe-bash.MJS"),
      })
    );
  });

  test("claude hook planning rejects disallowed file extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-hook-extension-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-claude-hook-extension-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-claude-hook-extension-source-"));
    const skillPath = join(source, "skills", "safe-bash", "SKILL.md");
    const hookPath = join(source, "hooks", "safe-bash.yaml");
    await mkdir(join(source, "skills", "safe-bash"), { recursive: true });
    await mkdir(join(source, "hooks"), { recursive: true });
    await writeFile(skillPath, "# Safe Bash\n", "utf8");
    await writeFile(
      hookPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "node safe-bash.js" }] },
          ],
        },
      }),
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-safe-bash",
          packageId: "pkg",
          name: "safe-bash",
          kind: "skill",
          path: skillPath,
          metadata: { body: "# Safe Bash\n" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "claude",
              file: hookPath,
              required: true,
              appliesTo: ["skill:safe-bash"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-safe-bash",
      kind: "skill",
    });

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "claude",
        projectRoot: project,
        dryRun: true,
      })
    ).rejects.toThrow("Claude hook file extension is not allowed: safe-bash");
    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "claude",
        projectRoot: project,
        dryRun: true,
      })
    ).rejects.not.toThrow(hookPath);
  });

  test("claude hook link merges settings, preserves unrelated values, and records managedHooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-hook-link-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-claude-hook-link-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-claude-hook-link-source-"));
    await seedHookBundle({ root, source, tool: "claude" });
    const settingsPath = join(project, ".claude", "settings.json");
    await atomicWriteJson(settingsPath, {
      permissions: { allow: ["Bash(git status)"] },
      hooks: { Stop: [{ matcher: ".*", hooks: [{ type: "command", command: "echo keep" }] }] },
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "claude", projectRoot: project });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Bash(git status)"] });
    expect(settings.hooks.Stop).toEqual([
      { matcher: ".*", hooks: [{ type: "command", command: "echo keep" }] },
    ]);
    expect(settings.hooks.PreToolUse).toEqual([
      expect.objectContaining({
        matcher: "Bash",
        _samx: "pkg:safe-bash:coding:claude",
        hooks: [{ type: "command", command: "node safe-bash.js" }],
      }),
    ]);
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([
      expect.objectContaining({
        generatedFiles: expect.arrayContaining([settingsPath]),
        managedHooks: [
          expect.objectContaining({
            id: "safe-bash",
            packageId: "pkg",
            tool: "claude",
            kind: "jsonMerge",
            outputs: [settingsPath],
            sentinels: ["pkg:safe-bash:coding:claude"],
            fingerprints: [expect.stringMatching(/^sha256:/)],
          }),
        ],
      }),
    ]);
  });

  test("claude hook unlink removes only recorded sentinel entry and leaves unrelated hooks and settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-hook-unlink-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-claude-hook-unlink-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-claude-hook-unlink-source-"));
    await seedHookBundle({ root, source, tool: "claude" });
    const settingsPath = join(project, ".claude", "settings.json");
    await linkBundle({ samxHome: root, bundleId: "coding", tool: "claude", projectRoot: project });
    await atomicWriteJson(settingsPath, {
      env: { KEEP: "1" },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo user" }] },
          {
            matcher: "Bash",
            _samx: "pkg:safe-bash:coding:claude",
            _samxFingerprint:
              "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            hooks: [{ type: "command", command: "node safe-bash.js" }],
          },
        ],
      },
    });

    await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "claude",
      projectRoot: project,
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings).toEqual({
      env: { KEEP: "1" },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user" }] }],
      },
    });
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([]);
  });

  test("claude hook re-link does not duplicate the same sentinel", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-hook-relink-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-claude-hook-relink-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-claude-hook-relink-source-"));
    await seedHookBundle({ root, source, tool: "claude" });
    const settingsPath = join(project, ".claude", "settings.json");

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "claude", projectRoot: project });
    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "claude",
      projectRoot: project,
      overwrite: true,
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(
      settings.hooks.PreToolUse.filter(
        (group: { _samx?: string }) => group._samx === "pkg:safe-bash:coding:claude"
      )
    ).toHaveLength(1);
  });

  test("claude hook re-link refuses drifted managed hooks without overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-hook-drift-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-claude-hook-drift-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-claude-hook-drift-source-"));
    await seedHookBundle({ root, source, tool: "claude" });
    const settingsPath = join(project, ".claude", "settings.json");
    await linkBundle({ samxHome: root, bundleId: "coding", tool: "claude", projectRoot: project });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.hooks.PreToolUse[0]._samxFingerprint =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    settings.hooks.PreToolUse[0].hooks = [{ type: "command", command: "echo changed" }];
    await atomicWriteJson(settingsPath, settings);
    await rm(join(project, ".claude", "skills", "pkg-skills-safe-bash"), {
      force: true,
      recursive: true,
    });

    const preview = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "claude",
      projectRoot: project,
      dryRun: true,
    });
    expect(preview.plan.hooks[0]?.drift).toEqual([
      expect.objectContaining({ sentinel: "pkg:safe-bash:coding:claude" }),
    ]);
    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "claude", projectRoot: project })
    ).rejects.toThrow("Claude hook managed entry drifted: pkg:safe-bash:coding:claude");

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "claude",
      projectRoot: project,
      overwrite: true,
    });

    const updated = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(updated.hooks.PreToolUse).toEqual([
      expect.objectContaining({
        _samx: "pkg:safe-bash:coding:claude",
        hooks: [{ type: "command", command: "node safe-bash.js" }],
      }),
    ]);
  });

  test("claude hook link rejects non-SAMX same event and matcher conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-hook-conflict-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-claude-hook-conflict-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-claude-hook-conflict-source-"));
    await seedHookBundle({ root, source, tool: "claude" });
    const settingsPath = join(project, ".claude", "settings.json");
    await atomicWriteJson(settingsPath, {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user" }] }],
      },
    });

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "claude",
        projectRoot: project,
        overwrite: true,
      })
    ).rejects.toThrow("Claude hook already exists for event PreToolUse and matcher Bash");
  });

  test("opencode hook link creates plugin symlink and unlink removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-hook-link-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-hook-link-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-hook-link-source-"));
    const { opencodeHook } = await seedHookBundle({ root, source, tool: "opencode" });
    const outputPath = join(project, ".opencode", "plugins", "pkg-safe-bash.js");

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    expect((await lstat(outputPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(outputPath)).toBe(opencodeHook);
    expect((await readLinkRecords({ samxHome: root })).links[0]).toEqual(
      expect.objectContaining({ generatedFiles: expect.arrayContaining([outputPath]) })
    );

    await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("opencode relink keeps unchanged managed hook symlinks without overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-hook-idempotent-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-hook-idempotent-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-hook-idempotent-source-"));
    const { opencodeHook } = await seedHookBundle({ root, source, tool: "opencode" });
    const outputPath = join(project, ".opencode", "plugins", "pkg-safe-bash.js");

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });
    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).resolves.toEqual(
      expect.objectContaining({ plan: expect.objectContaining({ bundleId: "coding" }) })
    );

    expect((await lstat(outputPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(outputPath)).toBe(opencodeHook);
  });

  test("opencode hook link refuses symlinked plugin parent escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-hook-parent-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-hook-parent-project-"));
    const outside = await mkdtemp(join(tmpdir(), "samx-opencode-hook-parent-outside-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-hook-parent-source-"));
    await seedHookBundle({ root, source, tool: "opencode" });
    await mkdir(join(project, ".opencode"), { recursive: true });
    await symlink(outside, join(project, ".opencode", "plugins"), "dir");

    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow(
      `Refusing to write through symlinked parent: ${join(project, ".opencode", "plugins")}`
    );
    await expect(stat(join(outside, "pkg-safe-bash.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("opencode hook overwrite refuses symlinked plugin parent before deleting outside symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-hook-overwrite-parent-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-hook-overwrite-parent-project-"));
    const outside = await mkdtemp(join(tmpdir(), "samx-opencode-hook-overwrite-parent-outside-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-hook-overwrite-parent-source-"));
    const existingTarget = join(outside, "existing-hook.js");
    const outsideOutput = join(outside, "pkg-safe-bash.js");
    await seedHookBundle({ root, source, tool: "opencode" });
    await writeFile(existingTarget, "export const existing = true\n", "utf8");
    await symlink(existingTarget, outsideOutput, "file");
    await mkdir(join(project, ".opencode"), { recursive: true });
    await symlink(outside, join(project, ".opencode", "plugins"), "dir");

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "opencode",
        projectRoot: project,
        overwrite: true,
      })
    ).rejects.toThrow(
      `Refusing to write through symlinked parent: ${join(project, ".opencode", "plugins")}`
    );
    expect((await lstat(outsideOutput)).isSymbolicLink()).toBe(true);
    expect(await readlink(outsideOutput)).toBe(existingTarget);
  });

  test("opencode hook parent preflight prevents earlier skill and MCP writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-hook-preflight-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-hook-preflight-project-"));
    const outside = await mkdtemp(join(tmpdir(), "samx-opencode-hook-preflight-outside-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-hook-preflight-source-"));
    const skillPath = join(source, "skills", "safe-bash", "SKILL.md");
    const hookPath = join(source, "hooks", "safe-bash.js");
    await mkdir(join(source, "skills", "safe-bash"), { recursive: true });
    await mkdir(join(source, "hooks"), { recursive: true });
    await writeFile(skillPath, "# Safe Bash\n", "utf8");
    await writeFile(hookPath, "export const plugin = true\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-safe-bash",
          packageId: "pkg",
          name: "safe-bash",
          kind: "skill",
          path: skillPath,
          metadata: { body: "# Safe Bash\n" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "opencode",
              file: hookPath,
              required: true,
              appliesTo: ["skill:safe-bash"],
            },
          ],
        },
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: join(source, "mcp", "github", "mcp.json"),
          serverName: "github",
          config: { command: "npx" },
          metadata: {},
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-safe-bash",
      kind: "skill",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });
    await mkdir(join(project, ".opencode"), { recursive: true });
    await symlink(outside, join(project, ".opencode", "plugins"), "dir");

    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow(
      `Refusing to write through symlinked parent: ${join(project, ".opencode", "plugins")}`
    );
    await expect(
      stat(join(project, ".opencode", "skills", "pkg-skills-safe-bash"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(project, ".opencode", "opencode.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(outside, "pkg-safe-bash.js"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([]);
  });

  test("dry-run returns planned skill files without writing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-dry-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-dry-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-code-review",
          packageId: "superpowers",
          name: "code-review",
          kind: "skill",
          path: "/tmp/superpowers/skills/code-review/SKILL.md",
          description: "Review code changes.",
          metadata: { body: "# Code Review\n\nReview code changes safely." },
        },
        {
          id: "superpowers:skills-debugging",
          packageId: "superpowers",
          name: "debugging",
          kind: "skill",
          path: "/tmp/superpowers/skills/debugging/SKILL.md",
          description: "Debug systematically.",
          metadata: { body: "# Debugging\n\nFind root causes." },
        },
      ],
    });
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
      itemId: "superpowers:skills-debugging",
      kind: "skill",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
      dryRun: true,
    });

    const codeReview = join(project, ".opencode", "skills", "superpowers-skills-code-review");
    const debugging = join(project, ".opencode", "skills", "superpowers-skills-debugging");
    expect(result.written).toEqual([]);
    expect(result.plan.generatedFiles).toEqual([codeReview, debugging]);
    await expect(stat(codeReview)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(debugging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("writes planned skill file content", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-apply-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-apply-project-"));
    const skillRoot = await mkdtemp(join(tmpdir(), "samx-opencode-source-"));
    await mkdir(join(skillRoot, "skills", "code-review"), { recursive: true });
    await writeFile(
      join(skillRoot, "skills", "code-review", "SKILL.md"),
      "# Code Review\n\nReview code changes safely.\n",
      "utf8"
    );
    await writeFile(
      join(skillRoot, "skills", "code-review", "helper.js"),
      "export const helper = true\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-code-review",
          packageId: "superpowers",
          name: "code-review",
          kind: "skill",
          path: join(skillRoot, "skills", "code-review", "SKILL.md"),
          description: "Review code changes.",
          metadata: { body: "# Code Review\n\nReview code changes safely." },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    const skillDir = join(project, ".opencode", "skills", "superpowers-skills-code-review");
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(skillDir)).toBe(join(skillRoot, "skills", "code-review"));
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(
      "# Code Review\n\nReview code changes safely.\n"
    );
    expect(await readFile(join(skillDir, "helper.js"), "utf8")).toBe(
      "export const helper = true\n"
    );
  });

  test("opencode relink keeps unchanged managed symlinks without overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-idempotent-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-idempotent-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-idempotent-source-"));
    await mkdir(join(source, "skills", "review"), { recursive: true });
    await writeFile(join(source, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-review",
          packageId: "pkg",
          name: "review",
          kind: "skill",
          path: join(source, "skills", "review", "SKILL.md"),
          metadata: { body: "# Review\n" },
          hooks: [],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });
    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).resolves.toEqual(
      expect.objectContaining({ plan: expect.objectContaining({ bundleId: "coding" }) })
    );
  });

  test("opencode link rejects foreign symlink to same target without overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-foreign-symlink-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-foreign-symlink-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-foreign-symlink-source-"));
    await mkdir(join(source, "skills", "review"), { recursive: true });
    await writeFile(join(source, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-review",
          packageId: "pkg",
          name: "review",
          kind: "skill",
          path: join(source, "skills", "review", "SKILL.md"),
          metadata: { body: "# Review\n" },
          hooks: [],
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-review",
      kind: "skill",
    });
    const skillDir = join(project, ".opencode", "skills", "pkg-skills-review");
    await mkdir(dirname(skillDir), { recursive: true });
    await symlink(join(source, "skills", "review"), skillDir, "dir");

    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow(`File already exists: ${skillDir}`);
  });

  test("opencode skill link refuses symlinked target root parent escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-skill-parent-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-skill-parent-project-"));
    const outside = await mkdtemp(join(tmpdir(), "samx-opencode-skill-parent-outside-"));
    const skillRoot = await mkdtemp(join(tmpdir(), "samx-opencode-skill-parent-source-"));
    await mkdir(join(skillRoot, "skills", "code-review"), { recursive: true });
    await writeFile(
      join(skillRoot, "skills", "code-review", "SKILL.md"),
      "# Code Review\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-code-review",
          packageId: "superpowers",
          name: "code-review",
          kind: "skill",
          path: join(skillRoot, "skills", "code-review", "SKILL.md"),
          metadata: { body: "# Code Review\n" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });
    await mkdir(join(project, ".opencode"), { recursive: true });
    await symlink(outside, join(project, ".opencode", "skills"), "dir");

    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow(
      `Refusing to write through symlinked parent: ${join(project, ".opencode", "skills")}`
    );
    await expect(stat(join(outside, "superpowers-skills-code-review"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("opencode skill overwrite refuses symlinked target root parent before deleting outside symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-skill-overwrite-parent-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-skill-overwrite-parent-project-"));
    const outside = await mkdtemp(join(tmpdir(), "samx-opencode-skill-overwrite-parent-outside-"));
    const skillRoot = await mkdtemp(join(tmpdir(), "samx-opencode-skill-overwrite-parent-source-"));
    const existingTarget = await mkdtemp(join(tmpdir(), "samx-opencode-skill-overwrite-existing-"));
    const outsideOutput = join(outside, "superpowers-skills-code-review");
    await mkdir(join(skillRoot, "skills", "code-review"), { recursive: true });
    await writeFile(
      join(skillRoot, "skills", "code-review", "SKILL.md"),
      "# Code Review\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-code-review",
          packageId: "superpowers",
          name: "code-review",
          kind: "skill",
          path: join(skillRoot, "skills", "code-review", "SKILL.md"),
          metadata: { body: "# Code Review\n" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });
    await symlink(existingTarget, outsideOutput, "dir");
    await mkdir(join(project, ".opencode"), { recursive: true });
    await symlink(outside, join(project, ".opencode", "skills"), "dir");

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "opencode",
        projectRoot: project,
        overwrite: true,
      })
    ).rejects.toThrow(
      `Refusing to write through symlinked parent: ${join(project, ".opencode", "skills")}`
    );
    expect((await lstat(outsideOutput)).isSymbolicLink()).toBe(true);
    expect(await readlink(outsideOutput)).toBe(existingTarget);
  });

  test("uses bundle item alias as the opencode symlink name", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-alias-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-alias-project-"));
    const skillRoot = await mkdtemp(join(tmpdir(), "samx-opencode-alias-source-"));
    await mkdir(join(skillRoot, "skills", "code-review"), { recursive: true });
    await writeFile(
      join(skillRoot, "skills", "code-review", "SKILL.md"),
      "# Code Review\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-code-review",
          packageId: "superpowers",
          name: "code-review",
          kind: "skill",
          path: join(skillRoot, "skills", "code-review", "SKILL.md"),
          description: "Review code changes.",
          metadata: { body: "# Code Review\n" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
      alias: "review-code",
    });

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    const skillDir = join(project, ".opencode", "skills", "review-code");
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(skillDir)).toBe(join(skillRoot, "skills", "code-review"));
    await expect(
      stat(join(project, ".opencode", "skills", "superpowers-skills-code-review"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("relink removes previously tracked opencode skill files that are no longer generated", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-relink-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-relink-project-"));
    const skillRoot = await mkdtemp(join(tmpdir(), "samx-opencode-relink-source-"));
    await mkdir(join(skillRoot, "skills", "code-review"), { recursive: true });
    await mkdir(join(skillRoot, "skills", "debugging"), { recursive: true });
    await writeFile(
      join(skillRoot, "skills", "code-review", "SKILL.md"),
      "# Code Review\n",
      "utf8"
    );
    await writeFile(join(skillRoot, "skills", "debugging", "SKILL.md"), "# Debugging\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-code-review",
          packageId: "superpowers",
          name: "code-review",
          kind: "skill",
          path: join(skillRoot, "skills", "code-review", "SKILL.md"),
          description: "Review code changes.",
          metadata: { body: "# Code Review\n" },
        },
        {
          id: "superpowers:skills-debugging",
          packageId: "superpowers",
          name: "debugging",
          kind: "skill",
          path: join(skillRoot, "skills", "debugging", "SKILL.md"),
          description: "Debug systematically.",
          metadata: { body: "# Debugging\n" },
        },
      ],
    });
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
      itemId: "superpowers:skills-debugging",
      kind: "skill",
    });
    const codeReview = join(project, ".opencode", "skills", "superpowers-skills-code-review");
    const debugging = join(project, ".opencode", "skills", "superpowers-skills-debugging");

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });
    await removeBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-debugging",
    });
    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
      overwrite: true,
    });

    expect(await readFile(join(codeReview, "SKILL.md"), "utf8")).toContain("Code Review");
    await expect(stat(debugging)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([
      expect.objectContaining({ generatedFiles: [codeReview] }),
    ]);
  });

  test("preflights opencode output collisions before writing any generated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-preflight-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-preflight-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-code-review",
          packageId: "superpowers",
          name: "code-review",
          kind: "skill",
          path: "/tmp/superpowers/skills/code-review/SKILL.md",
          description: "Review code changes.",
          metadata: { body: "# Code Review\n" },
        },
        {
          id: "superpowers:skills-debugging",
          packageId: "superpowers",
          name: "debugging",
          kind: "skill",
          path: "/tmp/superpowers/skills/debugging/SKILL.md",
          description: "Debug systematically.",
          metadata: { body: "# Debugging\n" },
        },
      ],
    });
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
      itemId: "superpowers:skills-debugging",
      kind: "skill",
    });
    const codeReview = join(project, ".opencode", "skills", "superpowers-skills-code-review");
    const debugging = join(project, ".opencode", "skills", "superpowers-skills-debugging");
    await mkdir(debugging, { recursive: true });
    await writeFile(join(debugging, "SKILL.md"), "existing", "utf8");

    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow(`File already exists: ${debugging}`);
    await expect(stat(codeReview)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([]);
  });

  test("relink preserves previous generated files and records when a later preflight fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-relink-preflight-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-relink-preflight-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-code-review",
          packageId: "superpowers",
          name: "code-review",
          kind: "skill",
          path: "/tmp/superpowers/skills/code-review/SKILL.md",
          metadata: { body: "# Code Review\n" },
        },
        {
          id: "superpowers:skills-debugging",
          packageId: "superpowers",
          name: "debugging",
          kind: "skill",
          path: "/tmp/superpowers/skills/debugging/SKILL.md",
          metadata: { body: "# Debugging\n" },
        },
      ],
    });
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
      itemId: "superpowers:skills-debugging",
      kind: "skill",
    });
    const codeReview = join(project, ".opencode", "skills", "superpowers-skills-code-review");
    const codeReviewLegacyFile = join(codeReview, "SKILL.md");
    const debugging = join(project, ".opencode", "skills", "superpowers-skills-debugging");
    const previousRecord = {
      id: `coding:opencode:${resolve(project)}`,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: resolve(project),
      generatedFiles: [codeReviewLegacyFile],
      managedJsonEntries: [],
      managedHooks: [],
      adjacentHooks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await mkdir(codeReview, { recursive: true });
    await writeFile(codeReviewLegacyFile, "legacy skill file", "utf8");
    await mkdir(debugging, { recursive: true });
    await writeFile(join(debugging, "SKILL.md"), "conflict", "utf8");
    await atomicWriteJson(samxPaths(root).linkRecords, { links: [previousRecord] });

    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow(`File already exists: ${debugging}`);
    expect(await readFile(codeReviewLegacyFile, "utf8")).toBe("legacy skill file");
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([previousRecord]);
  });

  test("overwrite refuses to replace real opencode skill directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-overwrite-real-dir-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-overwrite-real-dir-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-overwrite-real-dir-source-"));
    await mkdir(join(source, "skills", "code-review"), { recursive: true });
    await writeFile(join(source, "skills", "code-review", "SKILL.md"), "# Code Review\n", "utf8");
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-code-review",
          packageId: "superpowers",
          name: "code-review",
          kind: "skill",
          path: join(source, "skills", "code-review", "SKILL.md"),
          description: "Review code changes.",
          metadata: { body: "# Code Review\n" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });
    const destination = join(project, ".opencode", "skills", "superpowers-skills-code-review");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "do not delete real directory", "utf8");

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "opencode",
        projectRoot: project,
        overwrite: true,
      })
    ).rejects.toThrow("Refusing to overwrite OpenCode path that is not a symlink");
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe(
      "do not delete real directory"
    );
  });

  test("uses summary fallback when skill body is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-fallback-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-fallback-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-summary-only",
          packageId: "superpowers",
          name: "summary-only",
          kind: "skill",
          path: "/tmp/superpowers/skills/summary-only/SKILL.md",
          description: "Use this summary.",
          metadata: { body: "" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-summary-only",
      kind: "skill",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
      dryRun: true,
    });

    expect(result.plan.generatedFiles).toEqual([
      join(project, ".opencode", "skills", "superpowers-skills-summary-only"),
    ]);
  });

  test("sanitizes odd skill ids safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-safe-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-safe-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "../ strange:id//\n***",
          packageId: "unsafe",
          name: "unsafe",
          kind: "skill",
          path: "/tmp/unsafe/SKILL.md",
          description: "Unsafe id.",
          metadata: { body: "Safe content." },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "../ strange:id//\n***",
      kind: "skill",
    });

    const result = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
      dryRun: true,
    });

    expect(result.plan.generatedFiles).toEqual([
      join(project, ".opencode", "skills", "strange-id"),
    ]);
  });

  test("rejects skill ids that sanitize to the same output path", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-collision-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-collision-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "pkg:a/b",
          packageId: "pkg",
          name: "slash",
          kind: "skill",
          path: "/tmp/pkg/skills/slash/SKILL.md",
          description: "Slash skill.",
          metadata: { body: "Slash content." },
        },
        {
          id: "pkg:a:b",
          packageId: "pkg",
          name: "colon",
          kind: "skill",
          path: "/tmp/pkg/skills/colon/SKILL.md",
          description: "Colon skill.",
          metadata: { body: "Colon content." },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:a/b", kind: "skill" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:a:b", kind: "skill" });

    const collidingPath = join(project, ".opencode", "skills", "pkg-a-b");
    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "opencode",
        projectRoot: project,
        dryRun: true,
      })
    ).rejects.toThrow(`OpenCode skill output path collision: ${collidingPath}`);
  });

  test("unlink removes only tracked generated skill files and link record", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-project-"));
    await seedIndex(root);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });
    await mkdir(join(project, ".opencode"), { recursive: true });
    await writeFile(join(project, ".opencode", "user-file.md"), "keep", "utf8");

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });
    await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    await expect(
      stat(join(project, ".opencode", "skills", "superpowers-skills-code-review"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(project, ".opencode", "user-file.md"), "utf8")).toBe("keep");
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([]);
  });

  test("unlink errors when no link record exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-missing-record-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-missing-record-project-"));

    await expect(
      unlinkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow("Link record not found for bundle coding and tool opencode");
  });

  test("dry-run unlink reports only recorded managed MCP entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-recorded-mcp-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-recorded-mcp-project-"));
    const mcpPath = join(project, ".opencode", "opencode.json");
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/pkg/mcp/github/mcp.json",
          serverName: "github",
          config: { command: "npx" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `coding:opencode:${resolve(project)}`,
          bundleId: "coding",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [mcpPath],
          managedJsonEntries: [],
          managedHooks: [],
          adjacentHooks: [],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
      dryRun: true,
    });

    expect(result.plan.generatedFiles).toEqual([mcpPath]);
    expect(result.plan.jsonMerges).toEqual([]);
  });

  test("dry-run unlink deduplicates recorded managed MCP entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-dedupe-mcp-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-dedupe-mcp-project-"));
    const mcpPath = join(project, ".opencode", "opencode.json");
    const managedEntry = { path: mcpPath, keyPath: ["mcp"], key: "pkg-github" };
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `coding:opencode:${resolve(project)}`,
          bundleId: "coding",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [mcpPath],
          managedJsonEntries: [managedEntry, managedEntry],
          managedHooks: [],
          adjacentHooks: [],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
      dryRun: true,
    });

    expect(result.plan.jsonMerges).toEqual([
      { path: mcpPath, keyPath: ["mcp"], entries: [{ key: "pkg-github", value: {} }] },
    ]);
  });

  test("unlink removes tracked generated skill files after bundle deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-stale-bundle-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-stale-bundle-project-"));
    await seedIndex(root);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });
    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });
    await removeBundle({ samxHome: root, id: "coding" });

    await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    await expect(
      stat(join(project, ".opencode", "skills", "superpowers-skills-code-review"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([]);
  });

  test("unlink removes tracked generated skill files after skill index removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-stale-index-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-stale-index-project-"));
    await seedIndex(root);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });
    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });
    await atomicWriteJson(samxPaths(root).index, { skills: [] });

    await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    await expect(
      stat(join(project, ".opencode", "skills", "superpowers-skills-code-review"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([]);
  });

  test("dry-run unlink reports stale tracked skill files without deleting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-stale-dry-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-stale-dry-project-"));
    const skillFile = join(project, ".opencode", "skills", "superpowers-skills-code-review");
    await seedIndex(root);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });
    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });
    await removeBundle({ samxHome: root, id: "coding" });
    await atomicWriteJson(samxPaths(root).index, { skills: [] });

    const result = await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
      dryRun: true,
    });

    expect(result.plan.generatedFiles).toEqual([skillFile]);
    expect((await lstat(skillFile)).isSymbolicLink()).toBe(true);
    expect((await readLinkRecords({ samxHome: root })).links).toHaveLength(1);
  });

  test("unlink refuses tracked files outside opencode skills directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-escape-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-escape-project-"));
    const outsideSkills = join(project, ".opencode", "outside.md");
    await mkdir(join(project, ".opencode"), { recursive: true });
    await writeFile(outsideSkills, "do not delete", "utf8");
    await seedIndex(root);
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `coding:opencode:${resolve(project)}`,
          bundleId: "coding",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [outsideSkills],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await expect(
      unlinkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow("Refusing to unlink unexpected OpenCode generated file shape");
    expect(await readFile(outsideSkills, "utf8")).toBe("do not delete");
  });

  test("unlink refuses tracked files nested below an opencode skill directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-nested-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-nested-project-"));
    const nested = join(project, ".opencode", "skills", "nested", "path");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "SKILL.md"), "do not delete", "utf8");
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `coding:opencode:${resolve(project)}`,
          bundleId: "coding",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [nested],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await expect(
      unlinkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow("Refusing to unlink unexpected OpenCode generated file shape");
    expect(await readFile(join(nested, "SKILL.md"), "utf8")).toBe("do not delete");
  });

  test("unlink refuses recorded files inside an opencode skill symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-symlink-file-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-symlink-file-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-symlink-file-source-"));
    const skillDir = join(project, ".opencode", "skills", "review-code");
    await mkdir(join(project, ".opencode", "skills"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "do not delete source", "utf8");
    await symlink(source, skillDir, "dir");
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `coding:opencode:${resolve(project)}`,
          bundleId: "coding",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [join(skillDir, "SKILL.md")],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await expect(
      unlinkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow("Refusing to unlink legacy OpenCode file through symlink");
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe("do not delete source");
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true);
  });

  test("unlink refuses legacy opencode records that are not regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-legacy-dir-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-legacy-dir-project-"));
    const legacyFilePath = join(project, ".opencode", "skills", "review-code", "SKILL.md");
    await mkdir(legacyFilePath, { recursive: true });
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `coding:opencode:${resolve(project)}`,
          bundleId: "coding",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [legacyFilePath],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await expect(
      unlinkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow("Refusing to unlink legacy OpenCode path that is not a regular file");
  });

  test("relink migrates missing legacy opencode copy records to symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-missing-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-missing-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-missing-source-"));
    await mkdir(join(source, "skills", "brainstorming"), { recursive: true });
    await writeFile(
      join(source, "skills", "brainstorming", "SKILL.md"),
      "# Brainstorming\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-brainstorming",
          packageId: "superpowers",
          name: "brainstorming",
          kind: "skill",
          path: join(source, "skills", "brainstorming", "SKILL.md"),
          description: "Brainstorm.",
          metadata: { body: "# Brainstorming\n" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "sp" });
    await addBundleItem({
      samxHome: root,
      bundleId: "sp",
      itemId: "superpowers:skills-brainstorming",
      kind: "skill",
    });
    const skillDir = join(project, ".opencode", "skills", "superpowers-skills-brainstorming");
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `sp:opencode:${resolve(project)}`,
          bundleId: "sp",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [join(skillDir, "SKILL.md")],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await linkBundle({ samxHome: root, bundleId: "sp", tool: "opencode", projectRoot: project });

    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(skillDir)).toBe(join(source, "skills", "brainstorming"));
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([
      expect.objectContaining({ generatedFiles: [skillDir] }),
    ]);
  });

  test("relink migrates existing legacy opencode copy records to symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-existing-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-existing-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-existing-source-"));
    await mkdir(join(source, "skills", "brainstorming"), { recursive: true });
    await writeFile(
      join(source, "skills", "brainstorming", "SKILL.md"),
      "# Brainstorming Source\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-brainstorming",
          packageId: "superpowers",
          name: "brainstorming",
          kind: "skill",
          path: join(source, "skills", "brainstorming", "SKILL.md"),
          description: "Brainstorm.",
          metadata: { body: "# Brainstorming Source\n" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "sp" });
    await addBundleItem({
      samxHome: root,
      bundleId: "sp",
      itemId: "superpowers:skills-brainstorming",
      kind: "skill",
    });
    const skillDir = join(project, ".opencode", "skills", "superpowers-skills-brainstorming");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Legacy Copy\n", "utf8");
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `sp:opencode:${resolve(project)}`,
          bundleId: "sp",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [join(skillDir, "SKILL.md")],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await linkBundle({ samxHome: root, bundleId: "sp", tool: "opencode", projectRoot: project });

    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(skillDir)).toBe(join(source, "skills", "brainstorming"));
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe("# Brainstorming Source\n");
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([
      expect.objectContaining({ generatedFiles: [skillDir] }),
    ]);
  });

  test("relink migrates existing legacy opencode copy records to symlinks with overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-overwrite-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-overwrite-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-overwrite-source-"));
    await mkdir(join(source, "skills", "brainstorming"), { recursive: true });
    await writeFile(
      join(source, "skills", "brainstorming", "SKILL.md"),
      "# Brainstorming Source\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-brainstorming",
          packageId: "superpowers",
          name: "brainstorming",
          kind: "skill",
          path: join(source, "skills", "brainstorming", "SKILL.md"),
          description: "Brainstorm.",
          metadata: { body: "# Brainstorming Source\n" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "sp" });
    await addBundleItem({
      samxHome: root,
      bundleId: "sp",
      itemId: "superpowers:skills-brainstorming",
      kind: "skill",
    });
    const skillDir = join(project, ".opencode", "skills", "superpowers-skills-brainstorming");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Legacy Copy\n", "utf8");
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `sp:opencode:${resolve(project)}`,
          bundleId: "sp",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [join(skillDir, "SKILL.md")],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await linkBundle({
      samxHome: root,
      bundleId: "sp",
      tool: "opencode",
      projectRoot: project,
      overwrite: true,
    });

    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(skillDir)).toBe(join(source, "skills", "brainstorming"));
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe("# Brainstorming Source\n");
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([
      expect.objectContaining({ generatedFiles: [skillDir] }),
    ]);
  });

  test("relink refuses legacy opencode replacement when recorded file is missing but directory has user content", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-missing-user-home-"));
    const project = await mkdtemp(
      join(tmpdir(), "samx-opencode-relink-legacy-missing-user-project-")
    );
    const source = await mkdtemp(
      join(tmpdir(), "samx-opencode-relink-legacy-missing-user-source-")
    );
    await mkdir(join(source, "skills", "brainstorming"), { recursive: true });
    await writeFile(
      join(source, "skills", "brainstorming", "SKILL.md"),
      "# Brainstorming Source\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-brainstorming",
          packageId: "superpowers",
          name: "brainstorming",
          kind: "skill",
          path: join(source, "skills", "brainstorming", "SKILL.md"),
          description: "Brainstorm.",
          metadata: { body: "# Brainstorming Source\n" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "sp" });
    await addBundleItem({
      samxHome: root,
      bundleId: "sp",
      itemId: "superpowers:skills-brainstorming",
      kind: "skill",
    });
    const skillDir = join(project, ".opencode", "skills", "superpowers-skills-brainstorming");
    const userFile = join(skillDir, "notes.md");
    const previousRecord = {
      id: `sp:opencode:${resolve(project)}`,
      bundleId: "sp",
      tool: "opencode",
      projectRoot: resolve(project),
      generatedFiles: [join(skillDir, "SKILL.md")],
      managedJsonEntries: [],
      managedHooks: [],
      adjacentHooks: [],
      createdAt: new Date().toISOString(),
    };
    await mkdir(skillDir, { recursive: true });
    await writeFile(userFile, "user content", "utf8");
    await atomicWriteJson(samxPaths(root).linkRecords, { links: [previousRecord] });

    await expect(
      linkBundle({ samxHome: root, bundleId: "sp", tool: "opencode", projectRoot: project })
    ).rejects.toThrow(
      `Refusing to replace legacy OpenCode directory containing unmanaged files: ${skillDir}`
    );
    expect(await readFile(userFile, "utf8")).toBe("user content");
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([previousRecord]);
  });

  test("relink refuses legacy opencode replacement when directory has managed and user content", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-relink-legacy-managed-user-home-"));
    const project = await mkdtemp(
      join(tmpdir(), "samx-opencode-relink-legacy-managed-user-project-")
    );
    const source = await mkdtemp(
      join(tmpdir(), "samx-opencode-relink-legacy-managed-user-source-")
    );
    await mkdir(join(source, "skills", "brainstorming"), { recursive: true });
    await writeFile(
      join(source, "skills", "brainstorming", "SKILL.md"),
      "# Brainstorming Source\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-brainstorming",
          packageId: "superpowers",
          name: "brainstorming",
          kind: "skill",
          path: join(source, "skills", "brainstorming", "SKILL.md"),
          description: "Brainstorm.",
          metadata: { body: "# Brainstorming Source\n" },
        },
      ],
    });
    await createBundle({ samxHome: root, id: "sp" });
    await addBundleItem({
      samxHome: root,
      bundleId: "sp",
      itemId: "superpowers:skills-brainstorming",
      kind: "skill",
    });
    const skillDir = join(project, ".opencode", "skills", "superpowers-skills-brainstorming");
    const legacyFile = join(skillDir, "SKILL.md");
    const userFile = join(skillDir, "notes.md");
    const previousRecord = {
      id: `sp:opencode:${resolve(project)}`,
      bundleId: "sp",
      tool: "opencode",
      projectRoot: resolve(project),
      generatedFiles: [legacyFile],
      managedJsonEntries: [],
      managedHooks: [],
      adjacentHooks: [],
      createdAt: new Date().toISOString(),
    };
    await mkdir(skillDir, { recursive: true });
    await writeFile(legacyFile, "# Legacy Copy\n", "utf8");
    await writeFile(userFile, "user content", "utf8");
    await atomicWriteJson(samxPaths(root).linkRecords, { links: [previousRecord] });

    await expect(
      linkBundle({ samxHome: root, bundleId: "sp", tool: "opencode", projectRoot: project })
    ).rejects.toThrow(
      `Refusing to replace legacy OpenCode directory containing unmanaged files: ${skillDir}`
    );
    expect(await readFile(legacyFile, "utf8")).toBe("# Legacy Copy\n");
    expect(await readFile(userFile, "utf8")).toBe("user content");
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([previousRecord]);
  });

  test("unlink safely removes legacy opencode copy records", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-legacy-copy-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-legacy-copy-project-"));
    const skillDir = join(project, ".opencode", "skills", "review-code");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "legacy copy", "utf8");
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `coding:opencode:${resolve(project)}`,
          bundleId: "coding",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [join(skillDir, "SKILL.md")],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    await expect(stat(join(skillDir, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(skillDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLinkRecords({ samxHome: root })).links).toEqual([]);
  });

  test("unlink refuses recorded opencode paths that are real directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-real-dir-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-opencode-unlink-real-dir-project-"));
    const skillDir = join(project, ".opencode", "skills", "review-code");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "do not delete real directory", "utf8");
    await atomicWriteJson(samxPaths(root).linkRecords, {
      links: [
        {
          id: `coding:opencode:${resolve(project)}`,
          bundleId: "coding",
          tool: "opencode",
          projectRoot: resolve(project),
          generatedFiles: [skillDir],
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await expect(
      unlinkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow("Refusing to unlink OpenCode path that is not a symlink");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe("do not delete real directory");
  });
});

describe("skill directory symlink targets", () => {
  async function seedSingleSkill(root: string, title: string) {
    const source = await mkdtemp(join(tmpdir(), "samx-symlink-source-"));
    await mkdir(join(source, "skills", "code-review"), { recursive: true });
    await writeFile(join(source, "skills", "code-review", "SKILL.md"), `# ${title}\n`, "utf8");
    await writeFile(
      join(source, "skills", "code-review", "helper.js"),
      "export const helper = true\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      skills: [
        {
          id: "superpowers:skills-code-review",
          packageId: "superpowers",
          name: "code-review",
          kind: "skill",
          path: join(source, "skills", "code-review", "SKILL.md"),
          description: "Review code changes.",
          metadata: { body: `# ${title}\n` },
        },
      ],
    });
    return source;
  }

  test("claude links skill directories under .claude/skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-claude-link-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-claude-link-project-"));
    const source = await seedSingleSkill(root, "Code Review");
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
      alias: "review-code",
    });

    await linkBundle({ samxHome: root, bundleId: "coding", tool: "claude", projectRoot: project });

    const skillDir = join(project, ".claude", "skills", "review-code");
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(skillDir)).toBe(join(source, "skills", "code-review"));
    expect(await readFile(join(skillDir, "helper.js"), "utf8")).toBe(
      "export const helper = true\n"
    );
    await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "claude",
      projectRoot: project,
    });
    await expect(stat(skillDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(source, "skills", "code-review", "SKILL.md"), "utf8")).toBe(
      "# Code Review\n"
    );
  });

  test("kiro links skill directories under .kiro/skills and rejects real directory overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-kiro-link-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-kiro-link-project-"));
    await seedSingleSkill(root, "Code Review");
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "superpowers:skills-code-review",
      kind: "skill",
    });
    const skillDir = join(project, ".kiro", "skills", "superpowers-skills-code-review");

    const dryRun = await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "kiro",
      projectRoot: project,
      dryRun: true,
    });
    expect(dryRun.plan.generatedFiles).toEqual([skillDir]);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "do not delete real directory", "utf8");

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "kiro",
        projectRoot: project,
        overwrite: true,
      })
    ).rejects.toThrow("Refusing to overwrite Kiro path that is not a symlink");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe("do not delete real directory");
  });
});

describe("mixed capability linker", () => {
  async function seedMixedCapabilities(root: string) {
    const source = await mkdtemp(join(tmpdir(), "samx-mixed-source-"));
    await mkdir(join(source, "skills", "code-review"), { recursive: true });
    await mkdir(join(source, "agents", "reviewer"), { recursive: true });
    await writeFile(join(source, "skills", "code-review", "SKILL.md"), "# Code Review\n", "utf8");
    await writeFile(join(source, "agents", "reviewer", "AGENT.md"), "# Reviewer\n", "utf8");
    await writeFile(
      join(source, "agents", "reviewer", "helper.js"),
      "export const agent = true\n",
      "utf8"
    );
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:skills-code-review",
          packageId: "pkg",
          name: "code-review",
          kind: "skill",
          path: join(source, "skills", "code-review", "SKILL.md"),
          metadata: { body: "# Code Review\n" },
        },
        {
          id: "pkg:agents-reviewer",
          packageId: "pkg",
          name: "reviewer",
          kind: "agent",
          path: join(source, "agents", "reviewer", "AGENT.md"),
          metadata: { body: "# Reviewer\n" },
        },
        {
          id: "pkg:mcp-github",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: join(source, "mcp", "github", "mcp.json"),
          serverName: "github",
          config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
          metadata: {},
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:skills-code-review",
      kind: "skill",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:agents-reviewer",
      kind: "agent",
      alias: "reviewer",
    });
    await addBundleItem({
      samxHome: root,
      bundleId: "coding",
      itemId: "pkg:mcp-github",
      kind: "mcp",
    });
    return source;
  }

  test("links agent symlinks and MCP JSON entries without removing user MCP servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-mixed-link-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-mixed-link-project-"));
    const source = await seedMixedCapabilities(root);
    const mcpPath = join(project, ".opencode", "opencode.json");
    await mkdir(join(project, ".opencode"), { recursive: true });
    await writeFile(
      mcpPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: { local: { command: "node" } },
      }),
      "utf8"
    );

    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    const skillDir = join(project, ".opencode", "skills", "pkg-skills-code-review");
    const agentDir = join(project, ".opencode", "agents", "reviewer");
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true);
    expect((await lstat(agentDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(agentDir)).toBe(join(source, "agents", "reviewer"));
    expect(await readFile(join(agentDir, "helper.js"), "utf8")).toBe("export const agent = true\n");
    expect(JSON.parse(await readFile(mcpPath, "utf8"))).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        local: { command: "node" },
        "pkg-github": {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-github"],
        },
      },
    });

    await unlinkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
    });

    await expect(stat(skillDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(mcpPath, "utf8"))).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { local: { command: "node" } },
    });
  });

  test("rejects conflicting MCP servers unless overwrite is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-mixed-mcp-conflict-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-mixed-mcp-conflict-project-"));
    await seedMixedCapabilities(root);
    const mcpPath = join(project, ".opencode", "opencode.json");
    await mkdir(join(project, ".opencode"), { recursive: true });
    await writeFile(
      mcpPath,
      JSON.stringify({ mcp: { "pkg-github": { command: "other" } } }),
      "utf8"
    );

    await expect(
      linkBundle({ samxHome: root, bundleId: "coding", tool: "opencode", projectRoot: project })
    ).rejects.toThrow("MCP server already exists with different config: pkg-github");
    await linkBundle({
      samxHome: root,
      bundleId: "coding",
      tool: "opencode",
      projectRoot: project,
      overwrite: true,
    });

    expect(JSON.parse(await readFile(mcpPath, "utf8")).mcp["pkg-github"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
    });
  });

  test("rejects duplicate package-scoped MCP output keys in one bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "samx-mixed-mcp-duplicate-home-"));
    const project = await mkdtemp(join(tmpdir(), "samx-mixed-mcp-duplicate-project-"));
    await atomicWriteJson(samxPaths(root).index, {
      capabilities: [
        {
          id: "pkg:mcp-a",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/a.json",
          serverName: "github",
          config: { command: "a" },
          metadata: {},
        },
        {
          id: "pkg:mcp-b",
          packageId: "pkg",
          name: "github",
          kind: "mcp",
          path: "/tmp/b.json",
          serverName: "github",
          config: { command: "b" },
          metadata: {},
        },
      ],
    });
    await createBundle({ samxHome: root, id: "coding" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:mcp-a", kind: "mcp" });
    await addBundleItem({ samxHome: root, bundleId: "coding", itemId: "pkg:mcp-b", kind: "mcp" });

    await expect(
      linkBundle({
        samxHome: root,
        bundleId: "coding",
        tool: "opencode",
        projectRoot: project,
        dryRun: true,
      })
    ).rejects.toThrow("OpenCode MCP server output collision: pkg-github");
  });
});
