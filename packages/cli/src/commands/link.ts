import { resolve } from "node:path";

import { linkBundle, planBundleLink, unlinkBundle } from "@c3qo/samx-core";
import type { AdjacentHookDecision } from "@c3qo/samx-core";

import type { CliContext, SamxCli } from "../index.js";
import { renderLinkPlan, renderUnlinkPlan } from "./link-plan-renderer.js";

interface LinkOptions {
  tool?: string;
  project?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  noHooks?: boolean;
  hooks?: boolean;
  enableHook?: string | string[];
  enableHooks?: string;
  allowAdvisories?: boolean;
}

export function registerLinkCommands(cli: SamxCli, context: CliContext): void {
  cli
    .command("link <bundle-id>", "Generate tool files for a bundle")
    .option("--tool <tool>", "Link target")
    .option("--project <path>", "Project root")
    .option("--dry-run", "Preview generated files without writing")
    .option("--overwrite", "Overwrite existing generated files")
    .option("--no-hooks", "Link without hooks")
    .option("--enable-hook <hook-id>", "Deprecated; hooks link by default")
    .option("--enable-hooks <mode>", "Deprecated; hooks link by default")
    .option("--allow-advisories", "Apply link even when selected formula packages have advisories")
    .action((bundleId: string, options: LinkOptions) => {
      context.setAction(handleLink(context, bundleId, options));
    });

  cli
    .command("unlink <bundle-id>", "Remove generated tool files for a bundle")
    .option("--tool <tool>", "Link target")
    .option("--project <path>", "Project root")
    .option("--dry-run", "Preview generated files without writing")
    .option("--overwrite", "Accepted for parity with link")
    .action((bundleId: string, options: LinkOptions) => {
      context.setAction(handleUnlink(context, bundleId, options));
    });
}

async function handleLink(
  context: CliContext,
  bundleId: string,
  options: LinkOptions
): Promise<void> {
  const tool = linkTarget(options.tool);
  warnDeprecatedHookOptions(context, options);
  const base = {
    samxHome: context.samxHome,
    bundleId,
    tool,
    projectRoot: projectRoot(context, options.project),
    overwrite: options.overwrite,
    adjacentHooks: adjacentHookDecision(options),
  };
  const preview = await planBundleLink({ ...base });
  context.writeOut(renderLinkPlan(preview));
  if (options.dryRun === true) return;
  await linkBundle({ ...base, allowAdvisories: options.allowAdvisories === true });
}

async function handleUnlink(
  context: CliContext,
  bundleId: string,
  options: LinkOptions
): Promise<void> {
  const tool = linkTarget(options.tool);
  const root = projectRoot(context, options.project);
  const base = {
    samxHome: context.samxHome,
    bundleId,
    tool,
    projectRoot: root,
  };
  const preview = await unlinkBundle({ ...base, dryRun: true });
  context.writeOut(renderUnlinkPlan(preview.plan));
  if (options.dryRun === true) return;
  await unlinkBundle({ ...base, dryRun: false });
}

function linkTarget(tool: string | undefined): string {
  if (!tool) {
    throw new Error("Missing required option: --tool");
  }
  return tool;
}

function projectRoot(context: CliContext, project: string | undefined): string {
  return resolve(context.cwd, project ?? context.cwd);
}

function adjacentHookDecision(options: LinkOptions): AdjacentHookDecision {
  const enabledHookIds = optionValues(options.enableHook);
  const hasEnableHooks = options.enableHooks !== undefined;
  const noHooks = options.noHooks === true || options.hooks === false;
  if (noHooks && (enabledHookIds.length > 0 || hasEnableHooks)) {
    throw new Error("--no-hooks cannot be used with --enable-hook or --enable-hooks");
  }
  if (noHooks) {
    return { mode: "none" };
  }
  return { mode: "unspecified" };
}

function warnDeprecatedHookOptions(context: CliContext, options: LinkOptions): void {
  if (optionValues(options.enableHook).length > 0) {
    context.writeErr(
      "Warning: --enable-hook is deprecated; OpenCode hooks link by default. Use --no-hooks to disable hooks.\n"
    );
  }
  if (options.enableHooks !== undefined) {
    context.writeErr(
      "Warning: --enable-hooks is deprecated; OpenCode hooks link by default. Use --no-hooks to disable hooks.\n"
    );
  }
}

function optionValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
