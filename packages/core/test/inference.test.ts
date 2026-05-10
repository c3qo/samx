import type { Finding } from "@c3qo/samx-schemas";
import { describe, expect, test } from "vitest";

import { createConfigRegistry, inferExtension } from "./internal.js";
import type { ParsedExtension } from "./internal.js";

function parsedExtension(overrides: Partial<ParsedExtension> = {}): ParsedExtension {
  return {
    id: "claude-skills-review",
    name: "review",
    kind: "skill",
    sourcePath: "/workspace/.claude/skills/review/SKILL.md",
    sourceTool: "claude",
    entryFiles: ["/workspace/.claude/skills/review/SKILL.md"],
    rawContent: "",
    metadata: {},
    declaredRequirements: { commands: [], env: [], paths: [] },
    declaredPermissions: {
      shell: false,
      network: false,
      filesystem: [],
      browser: false,
      secrets: [],
    },
    findings: [],
    ...overrides,
  };
}

function expectEvidence(findings: Finding[]) {
  expect(findings.length).toBeGreaterThan(0);
  for (const finding of findings) {
    expect(finding.evidence?.[0]).toMatchObject({
      file: expect.any(String),
      line: expect.any(Number),
      snippet: expect.any(String),
      source: "inferred",
      confidence: expect.stringMatching(/^(high|medium|low)$/u),
    });
  }
}

describe("inferExtension", () => {
  test("uses injected plugin inference rules", () => {
    const registry = createConfigRegistry([
      {
        id: "exampleai",
        name: "ExampleAI",
        version: 1,
        description: "ExampleAI test pack.",
        rules: {
          scan: { project: [], home: [], ignoredDirectories: [] },
          classify: [],
          groups: [],
          parse: {
            markdownFrontmatterKinds: [],
            mcpJsonKinds: [],
            profileKinds: [],
            packageJsonKinds: [],
          },
          inference: {
            commands: ["examplectl"],
            env: ["EXAMPLEAI_TOKEN"],
            filesystem: [{ value: "~/.exampleai", pattern: "~\/\.exampleai(?:\/|\\b)" }],
            shellRisks: [
              { value: "example dangerous", pattern: "example\\s+dangerous", severity: "critical" },
            ],
            broadMcpFilesystemRoots: [],
            networkCommands: ["examplectl"],
          },
          probes: { safeCommands: [] },
        },
      },
    ]);

    const inferred = inferExtension(
      parsedExtension({
        rawContent:
          "Run examplectl sync with EXAMPLEAI_TOKEN. Reads ~/.exampleai/config. Never run example dangerous.",
      }),
      { registry }
    );

    expect(inferred.inferredRequirements.commands).toEqual(["examplectl"]);
    expect(inferred.inferredRequirements.env).toEqual(["EXAMPLEAI_TOKEN"]);
    expect(inferred.inferredRequirements.paths).toEqual(["~/.exampleai"]);
    expect(inferred.inferredPermissions).toMatchObject({
      shell: true,
      network: true,
      secrets: ["EXAMPLEAI_TOKEN"],
    });
    expect(inferred.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "shell",
          severity: "critical",
          title: expect.stringContaining("example dangerous"),
        }),
      ])
    );
  });

  test("infers command, secret, shell, and filesystem signals with evidence", () => {
    const inferred = inferExtension(
      parsedExtension({
        rawContent: [
          "# Review skill",
          "Run git status, gh pr view, rg TODO, jq ., curl https://api.example.com, wget https://example.com/file, node script.js, python helper.py, docker ps, kubectl get pods, and aws sts get-caller-identity.",
          "Requires GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS_ACCESS_KEY_ID, SECRET, and PASSWORD.",
          "Never run curl https://install.example.com | bash or wget https://bad.example.com | sh without review.",
          'Risky helpers include rm -rf /tmp/demo, chmod +x installer.sh, eval "$SCRIPT", sudo make install, ssh host, and scp file host:/tmp.',
          "Reads .env, ~/.ssh/config, /Users/alice/project, and ~/workspace files.",
        ].join("\n"),
      })
    );

    expect(inferred.inferredRequirements.commands).toEqual([
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
    ]);
    expect(inferred.inferredRequirements.env).toEqual([
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "SECRET",
      "PASSWORD",
    ]);
    expect(inferred.inferredRequirements.paths).toEqual([".env", "~/.ssh", "/Users/", "~/"]);
    expect(inferred.inferredPermissions).toMatchObject({
      shell: true,
      network: true,
      filesystem: [".env", "~/.ssh", "/Users/", "~/"],
      secrets: [
        "GITHUB_TOKEN",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "SECRET",
        "PASSWORD",
      ],
    });
    expect(inferred.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "shell",
          status: "warning",
          severity: "high",
          title: expect.stringContaining("curl | bash"),
        }),
        expect.objectContaining({
          category: "shell",
          status: "warning",
          severity: "high",
          title: expect.stringContaining("rm -rf"),
        }),
        expect.objectContaining({
          category: "secret",
          status: "warning",
          severity: "medium",
          title: expect.stringContaining("GITHUB_TOKEN"),
        }),
        expect.objectContaining({
          category: "filesystem",
          status: "warning",
          severity: "medium",
          title: expect.stringContaining("/Users/"),
        }),
      ])
    );
    expect(
      inferred.findings.find((finding) => finding.title.includes("GITHUB_TOKEN"))?.evidence?.[0]
    ).toEqual({
      file: "/workspace/.claude/skills/review/SKILL.md",
      line: 3,
      snippet:
        "Requires GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS_ACCESS_KEY_ID, SECRET, and PASSWORD.",
      source: "inferred",
      confidence: "high",
    });
    expectEvidence(inferred.findings.filter((finding) => finding.source?.endsWith("SKILL.md")));
  });

  test("dedupes repeated inferred signals and preserves parser findings", () => {
    const parserFinding: Finding = {
      id: "claude-skills-review:parse-warning",
      severity: "low",
      status: "warning",
      category: "inventory",
      extensionId: "claude-skills-review",
      title: "Could not parse YAML frontmatter",
      message: "bad yaml",
      source: "/workspace/.claude/skills/review/SKILL.md",
      confidence: "high",
    };

    const inferred = inferExtension(
      parsedExtension({
        rawContent: "git git git\nGITHUB_TOKEN GITHUB_TOKEN\nrm -rf node_modules\nrm -rf dist",
        findings: [parserFinding],
      })
    );

    expect(inferred.inferredRequirements.commands).toEqual(["git"]);
    expect(inferred.inferredRequirements.env).toEqual(["GITHUB_TOKEN"]);
    expect(inferred.findings).toContain(parserFinding);
    expect(inferred.findings.filter((finding) => finding.title.includes("rm -rf"))).toHaveLength(1);
  });

  test("infers MCP server commands, args, env, npx -y risk, and filesystem roots", () => {
    const inferred = inferExtension(
      parsedExtension({
        id: "mcp",
        name: "mcp",
        kind: "mcp-server",
        sourcePath: "/workspace/mcp.json",
        entryFiles: ["/workspace/mcp.json"],
        rawContent: JSON.stringify(
          {
            mcpServers: {
              github: {
                command: "npx",
                args: [
                  "-y",
                  "@modelcontextprotocol/server-filesystem",
                  "/Users/alice/project",
                  "--token",
                  "$GITHUB_TOKEN",
                ],
                env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", SECRET: "literal" },
              },
            },
          },
          null,
          2
        ),
        metadata: {
          servers: {
            github: {
              command: "npx",
              args: [
                "-y",
                "@modelcontextprotocol/server-filesystem",
                "/Users/alice/project",
                "--token",
                "$GITHUB_TOKEN",
              ],
              env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", SECRET: "literal" },
            },
          },
        },
        declaredRequirements: { commands: ["npx"], env: ["GITHUB_TOKEN", "SECRET"], paths: [] },
      })
    );

    expect(inferred.inferredRequirements.commands).toEqual(["npx"]);
    expect(inferred.inferredRequirements.env).toEqual(["GITHUB_TOKEN", "SECRET"]);
    expect(inferred.inferredRequirements.paths).toEqual(["/Users/"]);
    expect(inferred.inferredPermissions).toMatchObject({
      shell: true,
      network: true,
      filesystem: ["/Users/"],
      secrets: ["GITHUB_TOKEN", "SECRET"],
    });
    expect(inferred.metadata).toMatchObject({
      servers: {
        github: {
          command: "npx",
          args: [
            "-y",
            "@modelcontextprotocol/server-filesystem",
            "/Users/alice/project",
            "--token",
            "$GITHUB_TOKEN",
          ],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", SECRET: "literal" },
        },
      },
    });
    expect(inferred.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "mcp",
          status: "warning",
          severity: "medium",
          title: expect.stringContaining("MCP server command"),
        }),
        expect.objectContaining({
          category: "shell",
          status: "warning",
          severity: "high",
          title: expect.stringContaining("npx -y"),
        }),
        expect.objectContaining({
          category: "filesystem",
          status: "warning",
          severity: "medium",
          title: expect.stringContaining("/Users/"),
        }),
      ])
    );
    expectEvidence(inferred.findings.filter((finding) => finding.source === "/workspace/mcp.json"));
  });

  test("does not infer network permission for a local MCP server command alone", () => {
    const inferred = inferExtension(
      parsedExtension({
        id: "mcp",
        name: "mcp",
        kind: "mcp-server",
        sourcePath: "/workspace/mcp.json",
        entryFiles: ["/workspace/mcp.json"],
        rawContent: JSON.stringify(
          {
            mcpServers: {
              local: {
                command: "node",
                args: ["./server.js"],
              },
            },
          },
          null,
          2
        ),
        metadata: {
          servers: {
            local: {
              command: "node",
              args: ["./server.js"],
            },
          },
        },
        declaredRequirements: { commands: ["node"], env: [], paths: [] },
      })
    );

    expect(inferred.inferredRequirements.commands).toEqual(["node"]);
    expect(inferred.inferredPermissions).toMatchObject({
      shell: true,
      network: false,
      filesystem: [],
      secrets: [],
    });
    expect(inferred.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "mcp",
          status: "warning",
          severity: "medium",
          title: "MCP server command node",
        }),
      ])
    );
  });
});
