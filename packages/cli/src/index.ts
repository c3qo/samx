#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cac } from "cac";
import type { CAC } from "cac";
import type { ProbeRunner } from "@c3qo/samx-core";

import packageJson from "../package.json" with { type: "json" };
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerBundleCommand } from "./commands/bundle.js";
import { registerCapabilityCommand } from "./commands/capability.js";
import { registerFormulaCommands } from "./commands/formula.js";
import { registerLinkCommands } from "./commands/link.js";
import { registerPkgCommand } from "./commands/pkg.js";
import { registerRegistryCommand } from "./commands/registry.js";
import { registerTuiCommand } from "./commands/tui.js";
import { registerWorkspaceCommands } from "./commands/workspace.js";
import { renderHelp } from "./help.js";
import { cleanTerminalText } from "./output.js";
import { maybeNotifyUpdate } from "./update-notification.js";
import type { UpdateNotificationOptions } from "./update-notification.js";

export interface CliRuntimeOptions {
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  probeRunner?: ProbeRunner;
  formulaGenerateFetch?: typeof fetch;
  isTty?: boolean;
  updateNotifier?: UpdateNotificationOptions["updateNotifier"];
  capabilitySelector?: CapabilitySelector;
  bundleSelector?: BundleSelector;
  bundleItemSelector?: BundleItemSelector;
}

export type CapabilitySelector = (
  formulaId: string,
  capabilities: Array<{ id: string; kind: string; description?: string }>
) => Promise<string[] | undefined>;
export type BundleSelector = (
  bundleIds: string[],
  defaultBundleId: string
) => Promise<string | undefined>;
export type BundleItemSelector = (
  bundleId: string,
  items: Array<{ id: string; alias?: string }>
) => Promise<string[] | undefined>;

export interface CliContext {
  cwd: string;
  homeDir?: string;
  samxHome?: string;
  env?: NodeJS.ProcessEnv;
  probeRunner?: ProbeRunner;
  formulaGenerateFetch?: typeof fetch;
  capabilitySelector?: CapabilitySelector;
  bundleSelector?: BundleSelector;
  bundleItemSelector?: BundleItemSelector;
  isTty: boolean;
  writeOut(chunk: string): void;
  writeErr(chunk: string): void;
  setAction(action: Promise<void>): void;
}

export type SamxCli = CAC;

export async function runCli(
  args = process.argv.slice(2),
  options: CliRuntimeOptions = {}
): Promise<number> {
  const cli = cac("samx");
  let action: Promise<void> | undefined;
  const env = options.env ?? process.env;
  const context: CliContext = {
    cwd: options.cwd ?? defaultCwd(env),
    homeDir: options.homeDir,
    samxHome: env.SAMX_HOME,
    env,
    probeRunner: options.probeRunner,
    formulaGenerateFetch: options.formulaGenerateFetch,
    capabilitySelector: options.capabilitySelector,
    bundleSelector: options.bundleSelector,
    bundleItemSelector: options.bundleItemSelector,
    isTty: options.isTty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true),
    writeOut: options.stdout ?? ((chunk) => process.stdout.write(chunk)),
    writeErr: options.stderr ?? ((chunk) => process.stderr.write(chunk)),
    setAction(nextAction) {
      action = nextAction;
    },
  };

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    context.writeOut(`${packageJson.version}\n`);
    return 0;
  }

  const customHelp = renderHelp(args);
  if (customHelp) {
    context.writeOut(`${customHelp.trimEnd()}\n`);
    return 0;
  }

  registerAnalyzeCommand(cli, context);
  registerRegistryCommand(cli, context);
  registerFormulaCommands(cli, context);
  registerPkgCommand(cli, context);
  registerCapabilityCommand(cli, context);
  registerBundleCommand(cli, context);
  registerLinkCommands(cli, context);
  registerWorkspaceCommands(cli, context);
  registerTuiCommand(cli, context);
  cli.version(packageJson.version);
  cli.option("--no-update-check", "Skip update notification check");
  cli.help();

  try {
    maybeNotifyUpdate({
      args,
      env,
      writeErr: context.writeErr,
      updateNotifier: options.updateNotifier,
    });
    cli.parse(["node", "samx", ...args]);
    await action;
    return 0;
  } catch (error) {
    context.writeErr(
      `${cleanTerminalText(error instanceof Error ? error.message : String(error))}\n`
    );
    return 1;
  }
}

function defaultCwd(env: NodeJS.ProcessEnv): string {
  const candidate = env.INIT_CWD ?? env.PWD ?? process.cwd();
  return workspaceRootForFilteredPackage(candidate) ?? candidate;
}

function workspaceRootForFilteredPackage(cwd: string): string | undefined {
  const packageJson = resolve(cwd, "package.json");
  if (!existsSync(packageJson)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
    if (parsed.name !== "@c3qo/samx") {
      return undefined;
    }
  } catch {
    return undefined;
  }

  for (let current = resolve(cwd); dirname(current) !== current; current = dirname(current)) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) {
      return current;
    }
  }

  return undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
