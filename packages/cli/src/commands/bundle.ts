import {
  addBundleItem,
  createBundle,
  getBundle,
  getCapability,
  listBundles,
  removeBundle,
  removeBundleItem,
  runBundleCheck,
} from "@c3qo/samx-core";

import type { CliContext, SamxCli } from "../index.js";
import { resolveCapabilityId, toVisibleCapabilityId } from "../formula-ids.js";

interface BundleOptions {
  as?: string;
  tool?: string;
}

export function registerBundleCommand(cli: SamxCli, context: CliContext): void {
  cli
    .command("bundle <command> [...args]", "Manage SAMX bundles")
    .option("--as <alias>", "Alias for bundle add output")
    .option("--tool <tool>", "Tool target for bundle check")
    .action((command: string, args: string[], options: BundleOptions) => {
      context.setAction(handleBundle(context, command, args, options));
    });
}

async function handleBundle(
  context: CliContext,
  command: string,
  args: string[],
  options: BundleOptions = {}
): Promise<void> {
  const [arg1, arg2] = args;
  if (command === "create" && arg1) return handleBundleCreate(context, arg1);
  if (command === "add" && arg1 && arg2) return handleBundleAdd(context, arg1, arg2, options.as);
  if (command === "remove" && arg1 && arg2) return handleBundleRemove(context, arg1, arg2);
  if (command === "destroy" && arg1) return handleBundleDestroy(context, arg1);
  if (command === "show" && arg1) return handleBundleShow(context, arg1);
  if (command === "check") return handleBundleCheck(context, arg1, options.tool);
  if (command === "list") return handleBundleList(context);
  throw new Error(`Unsupported bundle command: ${command}`);
}

async function handleBundleDestroy(context: CliContext, id: string): Promise<void> {
  await removeBundle({ samxHome: context.samxHome, id });
  context.writeOut(`Destroyed bundle: ${id}\n`);
}

async function handleBundleCreate(context: CliContext, id: string): Promise<void> {
  await createBundle({ samxHome: context.samxHome, id });
  context.writeOut(`Created bundle: ${id}\n`);
}

async function handleBundleAdd(
  context: CliContext,
  bundleId: string,
  capabilityId: string,
  alias: string | undefined
): Promise<void> {
  capabilityId = await resolveCapabilityId({ samxHome: context.samxHome, id: capabilityId });
  const capability = await getCapability({ samxHome: context.samxHome, id: capabilityId });
  await addBundleItem({
    samxHome: context.samxHome,
    bundleId,
    itemId: capabilityId,
    kind: capability.kind,
    alias,
  });
  context.writeOut(`Added to bundle: ${bundleId} <- ${toVisibleCapabilityId(capabilityId)}\n`);
}

async function handleBundleRemove(
  context: CliContext,
  bundleId: string,
  capabilityId: string
): Promise<void> {
  capabilityId = await resolveCapabilityId({ samxHome: context.samxHome, id: capabilityId });
  await removeBundleItem({ samxHome: context.samxHome, bundleId, itemId: capabilityId });
  context.writeOut(`Removed from bundle: ${bundleId} <- ${toVisibleCapabilityId(capabilityId)}\n`);
}

async function handleBundleShow(context: CliContext, id: string): Promise<void> {
  const bundle = await getBundle({ samxHome: context.samxHome, id });
  context.writeOut(
    `Bundle: ${bundle.id}\n${bundle.items.map((item) => `${item.kind}: ${toVisibleCapabilityId(item.id)}`).join("\n")}\n`
  );
}

async function handleBundleList(context: CliContext): Promise<void> {
  const bundles = await listBundles({ samxHome: context.samxHome });
  context.writeOut(
    `Bundles: ${bundles.length}\n${bundles.map((bundle) => bundle.id).join("\n")}\n`
  );
}

async function handleBundleCheck(
  context: CliContext,
  bundleId: string | undefined,
  tool: string | undefined
): Promise<void> {
  if (!bundleId) {
    throw new Error("bundle check requires <bundle-id>.");
  }
  if (!tool) {
    throw new Error("bundle check requires --tool.");
  }
  const report = await runBundleCheck({
    samxHome: context.samxHome,
    bundleId,
    tool,
    projectRoot: context.cwd,
  });
  const hookCount = report.hooks.required + report.hooks.optional;
  const hookWarnings = [
    ...(report.hookWarnings ?? []),
    ...report.warnings,
    ...(hookCount > 0 || (report.inferredHooks?.length ?? 0) > 0
      ? ["Hooks install executable behavior; review link preview before applying."]
      : []),
  ];
  const enabledAdjacentHooks = report.enabledAdjacentHooks ?? [];
  const inferredHooks = report.inferredHooks ?? [];
  const environmentReminders = report.environmentReminders ?? [];
  const inferredTopLevelCount = inferredHooks.filter(
    (hook) => hook.inference === "top-level"
  ).length;
  const inferredAdjacentCount = inferredHooks.filter(
    (hook) => hook.inference === "adjacent"
  ).length;
  const inferredHookLines = inferredHooks.flatMap((hook) => [
    `- ${hook.id}`,
    `  source: ${hook.relativeFile}`,
    `  applies to: ${hook.appliesTo.join(", ")}`,
    "  status: will link",
    "  risk: executable behavior",
  ]);
  context.writeOut(
    `${[
      `Bundle: ${report.bundleId}`,
      `Status: ${report.status}`,
      ...(report.missingItems.length > 0
        ? [`Missing items: ${report.missingItems.join(", ")}`]
        : []),
      ...(report.hookBlockers.length > 0
        ? [`Hook blockers: ${report.hookBlockers.join(", ")}`]
        : []),
      ...(environmentReminders.length > 0
        ? [
            "Environment reminders:",
            ...environmentReminders.map(
              (reminder) => `- ${reminder.packageId} requires ${reminder.env.join(", ")}`
            ),
          ]
        : []),
      ...(hookCount > 0 || inferredHooks.length > 0
        ? [
            "Hooks:",
            `- required manifest: ${report.hooks.required}`,
            `- optional manifest: ${report.hooks.optional}`,
            `- inferred top-level: ${inferredTopLevelCount}`,
            `- inferred adjacent: ${inferredAdjacentCount}`,
          ]
        : []),
      ...(inferredHookLines.length > 0 ? ["Inferred hooks:", ...inferredHookLines] : []),
      ...(enabledAdjacentHooks.length > 0
        ? [
            "Previously linked hooks:",
            ...enabledAdjacentHooks.map(
              (hook) => `- ${hook.id}${hook.drift ? " (source changed)" : ""}`
            ),
          ]
        : []),
      ...(hookWarnings.length > 0
        ? ["Hook warnings:", ...hookWarnings.map((warning) => `- ${warning}`)]
        : []),
    ].join("\n")}\n`
  );
}
