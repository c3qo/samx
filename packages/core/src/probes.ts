import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Finding, Requirements } from "@c3qo/samx-schemas";
import { execa } from "execa";

import { loadBuiltinConfigRegistry } from "./config/loader.js";
import type { ConfigRegistry } from "./config/types.js";

interface ProbeCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export type ProbeRunner = (command: string, args: string[]) => Promise<ProbeCommandResult>;

interface CommandProbeResult {
  name: string;
  available: boolean;
  path?: string;
  version?: string;
  skipped?: boolean;
  reason?: string;
}

interface EnvProbeResult {
  name: string;
  present: boolean;
}

interface PathProbeResult {
  path: string;
  exists: boolean;
  resolvedPath: string;
}

export interface ProbeResult {
  commands: CommandProbeResult[];
  env: EnvProbeResult[];
  paths: PathProbeResult[];
  findings: Finding[];
}

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  runner?: ProbeRunner;
  pathExists?: (path: string) => Promise<boolean>;
  registry?: ConfigRegistry;
}

export async function probeRequirements(
  requirements: Requirements,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const registry = options.registry ?? (await loadBuiltinConfigRegistry());
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? defaultRunner;
  const pathExists = options.pathExists ?? defaultPathExists;
  const safeCommands = new Set(registry.probes.safeCommands);

  const commands: CommandProbeResult[] = [];
  for (const command of unique(requirements.commands)) {
    commands.push(await probeCommand(command, runner, safeCommands));
  }
  const envResults = unique(requirements.env).map((name) => ({
    name,
    present: Boolean(env[name]),
  }));
  const pathResults = await Promise.all(
    unique(requirements.paths).map(async (pathName) => {
      const resolvedPath = resolveProbePath(pathName, cwd);
      return { path: pathName, exists: await pathExists(resolvedPath), resolvedPath };
    })
  );

  return {
    commands,
    env: envResults,
    paths: pathResults,
    findings: [
      ...commands.flatMap(commandFinding),
      ...envResults.flatMap(envFinding),
      ...pathResults.flatMap(pathFinding),
    ],
  };
}

async function probeCommand(
  name: string,
  runner: ProbeRunner,
  safeCommands: Set<string>
): Promise<CommandProbeResult> {
  if (!safeCommands.has(name)) {
    return {
      name,
      available: false,
      skipped: true,
      reason: "Unknown command is not safe to probe",
    };
  }

  const whichResult = await runner("which", [name]);
  const versionResult = await runner(name, ["--version"]);
  if (whichResult.exitCode !== 0) {
    return { name, available: false, reason: resultReason(whichResult) };
  }

  return {
    name,
    available: true,
    path: firstLine(whichResult.stdout),
    version: versionResult.exitCode === 0 ? firstLine(versionResult.stdout) : undefined,
  };
}

async function defaultRunner(command: string, args: string[]): Promise<ProbeCommandResult> {
  try {
    const result = await execa(command, args, { reject: false });
    return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function defaultPathExists(pathName: string): Promise<boolean> {
  try {
    await access(pathName);
    return true;
  } catch {
    return false;
  }
}

function resolveProbePath(pathName: string, cwd: string): string {
  if (pathName === "~") {
    return homedir();
  }

  if (pathName.startsWith("~/")) {
    return path.join(homedir(), pathName.slice(2));
  }

  return path.isAbsolute(pathName) ? pathName : path.resolve(cwd, pathName);
}

function commandFinding(command: CommandProbeResult): Finding[] {
  if (command.available) {
    return [];
  }

  return [
    {
      id: `probe:command:${slug(command.name)}`,
      severity: command.skipped ? "medium" : "high",
      status: command.skipped ? "warning" : "blocked",
      category: "dependency",
      title: command.skipped
        ? `Skipped unsafe command probe ${command.name}`
        : `Missing command ${command.name}`,
      message: command.reason ?? `${command.name} is not available on PATH.`,
      source: command.name,
      confidence: "high",
      evidence: [{ file: command.name, source: "probed", confidence: "high" }],
    },
  ];
}

function envFinding(env: EnvProbeResult): Finding[] {
  if (env.present) {
    return [];
  }

  return [
    {
      id: `probe:env:${slug(env.name)}`,
      severity: "high",
      status: "blocked",
      category: "secret",
      title: `Missing environment variable ${env.name}`,
      message: `${env.name} is not present in the environment.`,
      source: env.name,
      confidence: "high",
      evidence: [{ file: env.name, source: "probed", confidence: "high" }],
    },
  ];
}

function pathFinding(result: PathProbeResult): Finding[] {
  if (result.exists) {
    return [];
  }

  return [
    {
      id: `probe:path:${slug(result.path)}`,
      severity: "medium",
      status: "blocked",
      category: "filesystem",
      title: `Missing path ${result.path}`,
      message: `${result.path} was not found at ${result.resolvedPath}.`,
      source: result.path,
      confidence: "high",
      evidence: [{ file: result.resolvedPath, source: "probed", confidence: "high" }],
    },
  ];
}

function firstLine(value?: string): string | undefined {
  return value?.split("\n")[0]?.trim() || undefined;
}

function resultReason(result: ProbeCommandResult): string {
  return (
    firstLine(result.stderr) ?? firstLine(result.stdout) ?? `Command exited with ${result.exitCode}`
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "unknown"
  );
}
