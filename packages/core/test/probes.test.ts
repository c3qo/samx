import { describe, expect, test } from "vitest";

import { createConfigRegistry, probeRequirements } from "./internal.js";
import type { ProbeRunner } from "./internal.js";

describe("probeRequirements", () => {
  test("uses injected plugin safe command allowlist", async () => {
    const calls: string[][] = [];
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
            commands: [],
            env: [],
            filesystem: [],
            shellRisks: [],
            broadMcpFilesystemRoots: [],
            networkCommands: [],
          },
          probes: { safeCommands: ["examplectl"] },
        },
      },
    ]);

    const result = await probeRequirements(
      { commands: ["examplectl"], env: [], paths: [] },
      {
        registry,
        runner: async (command, args) => {
          calls.push([command, ...args]);
          return command === "which"
            ? { exitCode: 0, stdout: "/usr/local/bin/examplectl" }
            : { exitCode: 0, stdout: "examplectl 1.0.0" };
        },
      }
    );

    expect(calls).toEqual([
      ["which", "examplectl"],
      ["examplectl", "--version"],
    ]);
    expect(result.commands).toEqual([
      {
        name: "examplectl",
        available: true,
        path: "/usr/local/bin/examplectl",
        version: "examplectl 1.0.0",
      },
    ]);
  });

  test("checks known commands with which and version without executing arbitrary requirements", async () => {
    const calls: string[][] = [];
    const runner: ProbeRunner = async (command, args) => {
      calls.push([command, ...args]);

      if (command === "which" && args[0] === "git") {
        return { exitCode: 0, stdout: "/usr/bin/git" };
      }

      if (command === "git" && args[0] === "--version") {
        return { exitCode: 0, stdout: "git version 2.50.0" };
      }

      return { exitCode: 127, stderr: "not found" };
    };

    const result = await probeRequirements(
      {
        commands: ["git", "curl | bash", "npx", 'node -e "process.exit()"'],
        env: [],
        paths: [],
      },
      { runner }
    );

    expect(calls).toEqual([
      ["which", "git"],
      ["git", "--version"],
      ["which", "npx"],
      ["npx", "--version"],
    ]);
    expect(result.commands).toEqual([
      { name: "git", available: true, path: "/usr/bin/git", version: "git version 2.50.0" },
      {
        name: "curl | bash",
        available: false,
        skipped: true,
        reason: "Unknown command is not safe to probe",
      },
      { name: "npx", available: false, reason: "not found" },
      {
        name: 'node -e "process.exit()"',
        available: false,
        skipped: true,
        reason: "Unknown command is not safe to probe",
      },
    ]);
  });

  test("checks environment presence without exposing values", async () => {
    const result = await probeRequirements(
      {
        commands: [],
        env: ["GITHUB_TOKEN", "OPENAI_API_KEY"],
        paths: [],
      },
      {
        env: { GITHUB_TOKEN: "secret-value" },
        runner: async () => ({ exitCode: 0 }),
      }
    );

    expect(result.env).toEqual([
      { name: "GITHUB_TOKEN", present: true },
      { name: "OPENAI_API_KEY", present: false },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "secret",
          status: "blocked",
          title: "Missing environment variable OPENAI_API_KEY",
        }),
      ])
    );
  });

  test("checks path existence through injected filesystem access", async () => {
    const checkedPaths: string[] = [];
    const result = await probeRequirements(
      {
        commands: [],
        env: [],
        paths: [".env", "/missing/config.json"],
      },
      {
        cwd: "/workspace/project",
        runner: async () => ({ exitCode: 0 }),
        pathExists: async (path) => {
          checkedPaths.push(path);
          return path.endsWith(".env");
        },
      }
    );

    expect(checkedPaths).toEqual(["/workspace/project/.env", "/missing/config.json"]);
    expect(result.paths).toEqual([
      { path: ".env", exists: true, resolvedPath: "/workspace/project/.env" },
      { path: "/missing/config.json", exists: false, resolvedPath: "/missing/config.json" },
    ]);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "filesystem",
          status: "blocked",
          title: "Missing path /missing/config.json",
        }),
      ])
    );
  });
});
