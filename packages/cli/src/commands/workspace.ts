import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  addBundleItem,
  addFormulaPackage,
  atomicWriteText,
  createBundle,
  getBundle,
  getCapability,
  hasPackage,
  listBundles,
  linkBundle,
  planBundleLink,
  readFormula,
  readLinkRecords,
  removeBundleItem,
  resolveBundleItem,
  samxPaths,
  searchFormulas,
  unlinkBundle,
} from "@c3qo/samx-core";

import type { CliContext, SamxCli } from "../index.js";
import {
  resolveCapabilityId,
  resolveFormulaIdFromRegistries,
  toVisibleCapabilityId,
  toVisibleFormulaId,
} from "../formula-ids.js";
import { renderLinkPlan, renderUnlinkPlan } from "./link-plan-renderer.js";

interface WorkspaceCommandOptions {
  as?: string;
  tool?: string;
  bundle?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  allowAdvisories?: boolean;
}

interface WorkspaceSelection {
  bundleId: string;
  tool: string;
  projectRoot: string;
}

interface WorkspaceBundleItem {
  id: string;
  alias?: string;
}

export function registerWorkspaceCommands(cli: SamxCli, context: CliContext): void {
  cli
    .command(
      "add <formula-or-capability-id>",
      "Install and link a capability into the current project"
    )
    .option("--as <alias>", "Alias for bundle add output")
    .option("--tool <tool>", "Link target")
    .option("--bundle <bundle-id>", "Bundle id")
    .option("--dry-run", "Preview without writing")
    .option("--overwrite", "Overwrite existing generated files")
    .option("--allow-advisories", "Apply link even when selected formula packages have advisories")
    .action((capabilityId: string, options: WorkspaceCommandOptions) => {
      context.setAction(handleWorkspaceAdd(context, capabilityId, options));
    });

  cli
    .command(
      "remove [capability-id-or-alias]",
      "Unlink and remove a capability from the current project"
    )
    .option("--tool <tool>", "Link target")
    .option("--bundle <bundle-id>", "Bundle id")
    .option("--dry-run", "Preview without writing")
    .option("--overwrite", "Overwrite existing generated files when relinking remaining items")
    .option("--allow-advisories", "Apply link even when remaining formula packages have advisories")
    .action((capabilityId: string | undefined, options: WorkspaceCommandOptions) => {
      context.setAction(handleWorkspaceRemove(context, capabilityId, options));
    });
}

async function handleWorkspaceAdd(
  context: CliContext,
  capabilityId: string,
  options: WorkspaceCommandOptions
): Promise<void> {
  const requestedCapabilityIds = await resolveAddCapabilityInput(context, capabilityId);
  const selection = await resolveWorkspaceSelection(context, options, "add");
  if (options.as && requestedCapabilityIds.length > 1) {
    throw new Error("--as can only be used when adding one capability.");
  }
  const resolvedCapabilities: Array<{ id: string; kind: "skill" | "agent" | "mcp" }> = [];
  for (const requestedCapabilityId of requestedCapabilityIds) {
    let resolvedCapabilityId = await maybeResolveInstalledCapability(
      context,
      requestedCapabilityId
    );
    if (!resolvedCapabilityId) {
      const formulaId = await resolveFormulaIdFromCapabilityInput(context, requestedCapabilityId);
      await assertFormulaHasCapability(context, formulaId, requestedCapabilityId);
      if (!(await hasInstalledPackage(context, formulaId))) {
        if (options.dryRun === true) {
          context.writeOut(`Would install package: ${toVisibleFormulaId(formulaId)}\n`);
          return;
        }
        await addFormulaPackage({ samxHome: context.samxHome, id: formulaId });
        context.writeOut(`Installed package: ${toVisibleFormulaId(formulaId)}\n`);
      }
      resolvedCapabilityId = await resolveCapabilityId({
        samxHome: context.samxHome,
        id: requestedCapabilityId,
      });
    }
    const capability = await getCapability({
      samxHome: context.samxHome,
      id: resolvedCapabilityId,
    });
    resolvedCapabilities.push({ id: resolvedCapabilityId, kind: capability.kind });
  }

  if (options.dryRun === true) {
    for (const capability of resolvedCapabilities) {
      context.writeOut(
        `Would add to bundle: ${selection.bundleId} <- ${toVisibleCapabilityId(capability.id)}\n`
      );
    }
    return;
  }
  for (const capability of resolvedCapabilities) {
    await addBundleItem({
      samxHome: context.samxHome,
      bundleId: selection.bundleId,
      itemId: capability.id,
      kind: capability.kind,
      alias: options.as,
    });
  }

  const base = {
    samxHome: context.samxHome,
    bundleId: selection.bundleId,
    tool: selection.tool,
    projectRoot: selection.projectRoot,
    overwrite: options.overwrite,
  };
  const preview = await planBundleLink(base);
  context.writeOut(renderLinkPlan(preview));
  await linkBundle({ ...base, allowAdvisories: options.allowAdvisories === true });
  for (const capability of resolvedCapabilities) {
    context.writeOut(
      `Added to bundle: ${selection.bundleId} <- ${toVisibleCapabilityId(capability.id)}\n`
    );
  }
}

async function handleWorkspaceRemove(
  context: CliContext,
  capabilityId: string | undefined,
  options: WorkspaceCommandOptions
): Promise<void> {
  const selection = await resolveWorkspaceSelection(context, options, "remove");
  const items = capabilityId
    ? await resolveWorkspaceBundleItems(context, selection.bundleId, capabilityId)
    : await resolveWorkspaceBundleItemsForRemove(context, selection.bundleId);
  const removeIds = new Set(items.map((item) => item.id));
  const base = {
    samxHome: context.samxHome,
    bundleId: selection.bundleId,
    tool: selection.tool,
    projectRoot: selection.projectRoot,
  };

  const unlinkPreview = await unlinkBundle({ ...base, dryRun: true });
  context.writeOut(renderUnlinkPlan(unlinkPreview.plan));
  if (options.dryRun === true) {
    for (const item of items) {
      context.writeOut(
        `Would remove from bundle: ${selection.bundleId} <- ${toVisibleCapabilityId(item.id)}\n`
      );
    }
    return;
  }

  const current = await getBundle({ samxHome: context.samxHome, id: selection.bundleId });
  if (current.items.length > items.length) {
    const bundlePath = samxPaths(context.samxHome).bundleFile(selection.bundleId);
    const bundleBefore = await readFile(bundlePath, "utf8");
    await atomicWriteText(
      bundlePath,
      JSON.stringify(
        { ...current, items: current.items.filter((bundleItem) => !removeIds.has(bundleItem.id)) },
        null,
        2
      ),
      { overwrite: true }
    );
    try {
      const preflight = await planBundleLink(base);
      if (preflight.advisories.length > 0 && options.allowAdvisories !== true) {
        throw new Error(
          "Bundle has formula advisories. Re-run with --allow-advisories to link anyway."
        );
      }
    } finally {
      await atomicWriteText(bundlePath, bundleBefore, { overwrite: true });
    }
  }

  await unlinkBundle({ ...base, dryRun: false });
  for (const item of items) {
    await removeBundleItem({
      samxHome: context.samxHome,
      bundleId: selection.bundleId,
      itemId: item.id,
    });
  }

  const updated = await getBundle({ samxHome: context.samxHome, id: selection.bundleId });
  if (updated.items.length === 0) {
    for (const item of items) {
      context.writeOut(
        `Removed from bundle: ${selection.bundleId} <- ${toVisibleCapabilityId(item.id)}\n`
      );
    }
    context.writeOut(`Bundle is empty: ${selection.bundleId}. Project left unlinked.\n`);
    return;
  }

  const preview = await planBundleLink(base);
  context.writeOut(renderLinkPlan(preview));
  await linkBundle({
    ...base,
    overwrite: options.overwrite,
    allowAdvisories: options.allowAdvisories === true,
  });
  for (const item of items) {
    context.writeOut(
      `Removed from bundle: ${selection.bundleId} <- ${toVisibleCapabilityId(item.id)}\n`
    );
  }
  context.writeOut(`Relinked bundle: ${selection.bundleId}\n`);
}

async function resolveWorkspaceBundleItemsForRemove(
  context: CliContext,
  bundleId: string
): Promise<WorkspaceBundleItem[]> {
  const bundle = await getBundle({ samxHome: context.samxHome, id: bundleId });
  if (bundle.items.length === 0) throw new Error(`Bundle has no capabilities: ${bundleId}`);
  if (!context.isTty) {
    throw new Error(
      `Capability required. Re-run with one of:\n${renderRemoveChoices(bundle.items)}`
    );
  }
  const selected = await selectBundleItems(context, bundleId, bundle.items);
  if (!selected || selected.length === 0) throw new Error("Capability selection cancelled.");
  context.writeOut(
    `Selected removals: ${selected.map((item) => toVisibleCapabilityId(item)).join(", ")}\n`
  );
  return Promise.all(
    selected.map((item) => resolveExactWorkspaceBundleItem(context, bundleId, item))
  );
}

async function selectBundleItems(
  context: CliContext,
  bundleId: string,
  items: WorkspaceBundleItem[]
): Promise<string[] | undefined> {
  if (context.bundleItemSelector) return context.bundleItemSelector(bundleId, items);
  const { renderBundleItemPicker } = await import("../tui/bundle-item-picker.js");
  return renderBundleItemPicker(bundleId, items);
}

function renderRemoveChoices(items: WorkspaceBundleItem[]): string {
  return items
    .map((item) =>
      item.alias
        ? `- ${item.alias} (${toVisibleCapabilityId(item.id)})`
        : `- ${toVisibleCapabilityId(item.id)}`
    )
    .join("\n");
}

async function resolveWorkspaceBundleItems(
  context: CliContext,
  bundleId: string,
  idOrAlias: string
): Promise<WorkspaceBundleItem[]> {
  let canonicalId: string | undefined;
  if (idOrAlias.includes(":")) {
    canonicalId = await resolveCapabilityId({ samxHome: context.samxHome, id: idOrAlias });
  }
  try {
    return [
      await resolveBundleItem({ samxHome: context.samxHome, bundleId, idOrAlias, canonicalId }),
    ];
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("Bundle item not found in ") ||
      idOrAlias.includes(":")
    )
      throw error;
    const matches = await fuzzyBundleItemMatches(context, bundleId, idOrAlias);
    if (matches.length === 0) {
      await throwIfBundleId(context, idOrAlias);
      throw error;
    }
    if (matches.length > 1) {
      if (context.isTty) {
        const selected = await selectBundleItems(context, bundleId, matches);
        if (!selected || selected.length === 0) throw new Error("Capability selection cancelled.");
        return Promise.all(
          selected.map((item) => resolveExactWorkspaceBundleItem(context, bundleId, item))
        );
      }
      throw new Error(
        `Multiple bundle items match: ${idOrAlias}\nRe-run with one of:\n${renderRemoveChoices(matches)}`
      );
    }
    const [match] = matches;
    if (!match) throw error;
    if (!context.isTty) {
      const visible = match.alias
        ? `${match.alias} (${toVisibleCapabilityId(match.id)})`
        : toVisibleCapabilityId(match.id);
      const rerun = match.alias ?? toVisibleCapabilityId(match.id);
      throw new Error(
        `Matched one bundle item: ${visible}\nRe-run with exact id or alias to confirm: samx remove ${rerun}`
      );
    }
    const selected = await selectBundleItems(context, bundleId, matches);
    if (!selected || selected.length === 0) throw new Error("Capability selection cancelled.");
    return Promise.all(
      selected.map((item) => resolveExactWorkspaceBundleItem(context, bundleId, item))
    );
  }
}

async function resolveExactWorkspaceBundleItem(
  context: CliContext,
  bundleId: string,
  idOrAlias: string
): Promise<WorkspaceBundleItem> {
  let canonicalId: string | undefined;
  if (idOrAlias.includes(":")) {
    canonicalId = await resolveCapabilityId({ samxHome: context.samxHome, id: idOrAlias });
  }
  return resolveBundleItem({ samxHome: context.samxHome, bundleId, idOrAlias, canonicalId });
}

async function throwIfBundleId(context: CliContext, idOrAlias: string): Promise<void> {
  try {
    await getBundle({ samxHome: context.samxHome, id: idOrAlias });
  } catch {
    return;
  }
  throw new Error(
    `"${idOrAlias}" is a bundle id, not a capability id or alias.\nTo choose capabilities from this bundle, run:\n  samx remove --bundle ${idOrAlias}\nTo unlink all generated outputs, run:\n  samx unlink ${idOrAlias} --tool <tool>\nTo delete the bundle definition, run:\n  samx bundle destroy ${idOrAlias}`
  );
}

async function fuzzyBundleItemMatches(
  context: CliContext,
  bundleId: string,
  query: string
): Promise<WorkspaceBundleItem[]> {
  const bundle = await getBundle({ samxHome: context.samxHome, id: bundleId });
  const normalized = query.toLowerCase();
  return bundle.items.filter((item) => {
    const visible = toVisibleCapabilityId(item.id);
    const values = [item.id, visible, item.alias ?? "", ...visible.replace(":", "/").split("/")];
    return values.some((value) => value.toLowerCase().includes(normalized));
  });
}

async function resolveWorkspaceSelection(
  context: CliContext,
  options: WorkspaceCommandOptions,
  mode: "add" | "remove"
): Promise<WorkspaceSelection> {
  const projectRoot = resolve(context.cwd);
  const bundleId = await resolveBundleId(context, options.bundle, projectRoot, mode);
  const tool = await resolveTool(context, options.tool, bundleId, projectRoot);
  return { bundleId, tool, projectRoot };
}

async function resolveBundleId(
  context: CliContext,
  explicit: string | undefined,
  projectRoot: string,
  mode: "add" | "remove"
): Promise<string> {
  if (explicit) {
    await getBundle({ samxHome: context.samxHome, id: explicit });
    return explicit;
  }

  const records = await readLinkRecords({ samxHome: context.samxHome });
  const bundleIds = [
    ...new Set(
      records.links
        .filter((link) => resolve(link.projectRoot) === projectRoot)
        .map((link) => link.bundleId)
    ),
  ];
  const defaultBundleId = await availableProjectBundleId(context, projectRoot);
  if (bundleIds.length === 0) {
    if (mode === "remove") {
      throw new Error(
        "No project bundle linked. Re-run with --bundle to remove from a specific bundle."
      );
    }
    const bundleId = await createProjectBundle(context, defaultBundleId);
    context.writeOut(`Created project bundle: ${bundleId}\n`);
    return bundleId;
  }
  if (bundleIds.length === 1) {
    context.writeOut(`Using project bundle: ${bundleIds[0]}\n`);
    return bundleIds[0];
  }
  if (bundleIds.length > 1) {
    if (context.isTty) {
      const selected = await selectBundle(context, bundleIds, defaultBundleId);
      if (!selected) throw new Error("Bundle selection cancelled.");
      if (!bundleIds.includes(selected)) {
        await createBundle({ samxHome: context.samxHome, id: selected });
        context.writeOut(`Created project bundle: ${selected}\n`);
      } else {
        context.writeOut(`Using project bundle: ${selected}\n`);
      }
      return selected;
    }
    throw new Error(
      `Ambiguous project bundle. Re-run with --bundle. Candidates: ${bundleIds.join(", ")}`
    );
  }
  throw new Error("Missing required option: --bundle");
}

async function availableProjectBundleId(context: CliContext, projectRoot: string): Promise<string> {
  const existing = new Set(
    (await listBundles({ samxHome: context.samxHome })).map((bundle) => bundle.id)
  );
  const baseId = sanitizeBundleId(basename(projectRoot));
  let bundleId = baseId;
  for (let suffix = 2; existing.has(bundleId); suffix += 1) {
    bundleId = `${baseId}-${suffix}`;
  }
  return bundleId;
}

async function createProjectBundle(context: CliContext, bundleId: string): Promise<string> {
  await createBundle({ samxHome: context.samxHome, id: bundleId });
  return bundleId;
}

async function selectBundle(
  context: CliContext,
  bundleIds: string[],
  defaultBundleId: string
): Promise<string | undefined> {
  if (context.bundleSelector) return context.bundleSelector(bundleIds, defaultBundleId);
  const { renderBundlePicker } = await import("../tui/bundle-picker.js");
  return renderBundlePicker(bundleIds, defaultBundleId);
}

function sanitizeBundleId(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "project";
}

async function resolveTool(
  context: CliContext,
  explicit: string | undefined,
  bundleId: string,
  projectRoot: string
): Promise<string> {
  if (explicit) return explicit;

  const records = await readLinkRecords({ samxHome: context.samxHome });
  const tools = [
    ...new Set(
      records.links
        .filter((link) => link.bundleId === bundleId && resolve(link.projectRoot) === projectRoot)
        .map((link) => link.tool)
    ),
  ];
  if (tools.length === 1) return tools[0];
  if (tools.length > 1)
    throw new Error(`Ambiguous project tool. Re-run with --tool. Candidates: ${tools.join(", ")}`);
  throw new Error("Missing required option: --tool");
}

async function hasInstalledPackage(context: CliContext, id: string): Promise<boolean> {
  return hasPackage({ samxHome: context.samxHome, id });
}

async function maybeResolveInstalledCapability(
  context: CliContext,
  id: string
): Promise<string | undefined> {
  try {
    const resolvedId = await resolveCapabilityId({ samxHome: context.samxHome, id });
    await getCapability({ samxHome: context.samxHome, id: resolvedId });
    return resolvedId;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Capability not found:"))
      return undefined;
    throw error;
  }
}

async function resolveAddCapabilityInput(context: CliContext, id: string): Promise<string[]> {
  if (id.includes(":")) return [id];
  const resolved = await resolveFormulaInputForAdd(context, id);
  const formulaId = resolved.id;
  const formula = await readFormula({ samxHome: context.samxHome, id: formulaId });
  if (formula.capabilities.length === 0) {
    throw new Error(`Formula has no capabilities: ${toVisibleFormulaId(formulaId)}`);
  }
  if (formula.capabilities.length > 1 || resolved.requiresConfirmation) {
    if (context.isTty) {
      const selected = await selectCapability(context, formulaId, formula.capabilities);
      if (!selected || selected.length === 0) throw new Error("Capability selection cancelled.");
      const selectedCapabilities = selected.map((capabilityId) => `${formulaId}:${capabilityId}`);
      context.writeOut(
        `Selected capabilities: ${selectedCapabilities.map(toVisibleCapabilityId).join(", ")}\n`
      );
      return selectedCapabilities;
    }
    const choices = formula.capabilities
      .map((capability) => `- ${toVisibleCapabilityId(`${formulaId}:${capability.id}`)}`)
      .join("\n");
    throw new Error(
      `Formula has multiple capabilities: ${toVisibleFormulaId(formulaId)}\nRe-run with one of:\n${choices}`
    );
  }
  return [`${formulaId}:${formula.capabilities[0].id}`];
}

async function resolveFormulaInputForAdd(
  context: CliContext,
  id: string
): Promise<{ id: string; requiresConfirmation: boolean }> {
  try {
    return {
      id: await resolveFormulaIdFromRegistries({ samxHome: context.samxHome, id }),
      requiresConfirmation: false,
    };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("Formula not found:") ||
      id.includes("/")
    )
      throw error;
    const results = await searchFormulas({ samxHome: context.samxHome, query: id });
    const matches = results
      .map((result) => result.id)
      .filter((formulaId) => formulaId.toLowerCase().includes(id.toLowerCase()))
      .sort((left, right) => left.localeCompare(right));
    if (matches.length !== 1) throw error;
    const formulaId = matches[0] ?? id;
    if (!context.isTty) {
      throw new Error(
        `Matched one formula: ${toVisibleFormulaId(formulaId)}\nRe-run with exact id to confirm: samx add ${toVisibleFormulaId(formulaId)}`
      );
    }
    return { id: formulaId, requiresConfirmation: true };
  }
}

async function selectCapability(
  context: CliContext,
  formulaId: string,
  capabilities: Array<{ id: string; kind: string; description?: string }>
): Promise<string[] | undefined> {
  if (context.capabilitySelector) return context.capabilitySelector(formulaId, capabilities);
  const { renderCapabilityPicker } = await import("../tui/capability-picker.js");
  return renderCapabilityPicker(toVisibleFormulaId(formulaId), capabilities);
}

async function resolveFormulaIdFromCapabilityInput(
  context: CliContext,
  id: string
): Promise<string> {
  const packagePart = id.split(":")[0];
  if (!packagePart || !packagePart.includes("/")) {
    throw new Error(`Invalid capability id: ${id}`);
  }
  return resolveFormulaIdFromRegistries({ samxHome: context.samxHome, id: packagePart });
}

async function assertFormulaHasCapability(
  context: CliContext,
  formulaId: string,
  capabilityId: string
): Promise<void> {
  const separator = capabilityId.indexOf(":");
  if (separator === -1 || separator === capabilityId.length - 1) {
    throw new Error(`Invalid capability id: ${capabilityId}`);
  }
  const capabilitySuffix = capabilityId.slice(separator + 1);
  const formula = await readFormula({ samxHome: context.samxHome, id: formulaId });
  if (!formula.capabilities.some((capability) => capability.id === capabilitySuffix)) {
    throw new Error(`Capability not found: ${capabilityId}`);
  }
}
