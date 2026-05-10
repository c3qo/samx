import { lstat, mkdir, readFile, readdir, readlink, rm, rmdir, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { LinkTargetConfig } from "@c3qo/samx-schemas";

import type {
  LinkPlan,
  LinkPlanHook,
  LinkPlanInstructionBlock,
  LinkPlanJsonMerge,
  LinkPlanTomlMerge,
  LinkResult,
} from "../linkers/types.js";
import { atomicWriteJson, atomicWriteText } from "../store/atomic.js";
import { mergeAgentsMd, removeAgentsMdBlock } from "./agents-md.js";
import {
  assertClaudeHookSettingsMergeable,
  hookFingerprints,
  hookSentinels,
  mergeClaudeHookSettings,
  removeClaudeHookSentinels,
} from "./hooks.js";
import type { AdjacentHookDecision } from "./planner.js";
import { planBundleLink } from "./planner.js";
import { readLinkRecords, removeLinkRecord, upsertLinkRecord } from "./records.js";
import { displayLinkTarget, loadLinkTargetConfig } from "./targets.js";
import { mergeCodexMcpTables, removeCodexMcpTables } from "./toml.js";

export interface LinkBundleOptions {
  samxHome?: string;
  bundleId: string;
  tool: string;
  projectRoot: string;
  dryRun?: boolean;
  overwrite?: boolean;
  adjacentHooks?: AdjacentHookDecision;
  allowAdvisories?: boolean;
}

export interface UnlinkBundleOptions {
  samxHome?: string;
  bundleId: string;
  tool: string;
  projectRoot: string;
  dryRun?: boolean;
}

export async function linkBundle(options: LinkBundleOptions): Promise<LinkResult> {
  const targetConfig = await loadLinkTargetConfig(options.tool);
  const plan = await planBundleLink(options);
  if (plan.hookDecisionRequired && options.dryRun !== true) {
    throw new Error(
      "Hook decision required: use --no-hooks, --enable-hook <id>, or --enable-hooks all"
    );
  }
  if (options.dryRun === true) {
    return { plan, written: [] };
  }
  if (plan.advisories.length > 0 && options.allowAdvisories !== true) {
    throw new Error(linkAdvisoryError(plan));
  }

  const id = linkRecordId(options.bundleId, options.tool, options.projectRoot);
  const previousRecord = (await readLinkRecords({ samxHome: options.samxHome })).links.find(
    (link) => link.id === id
  );
  const previousFiles = previousRecord
    ? validatedGeneratedFiles(
        previousRecord.generatedFiles,
        options.projectRoot,
        options.tool,
        targetConfig
      )
    : [];
  await assertSafeRemovableGeneratedFiles(
    previousFiles,
    options.tool,
    targetConfig,
    options.projectRoot
  );
  const currentFiles = new Set(plan.generatedFiles.map((file) => resolve(file)));
  const previousFilesToReplace = previousFiles.filter((file) => {
    const destination = recordedDestinationPath(
      file,
      options.tool,
      targetConfig,
      options.projectRoot
    );
    return resolve(file) !== resolve(destination) && currentFiles.has(resolve(destination));
  });
  await assertSafeLegacyReplacementDirectories(
    previousFilesToReplace,
    options.tool,
    targetConfig,
    options.projectRoot
  );
  const previousManagedDestinations = new Set(
    previousFiles.map((file) =>
      resolve(recordedDestinationPath(file, options.tool, targetConfig, options.projectRoot))
    )
  );
  const replaceDestinations = new Set(
    previousFilesToReplace.map((file) =>
      resolve(recordedDestinationPath(file, options.tool, targetConfig, options.projectRoot))
    )
  );
  const idempotentDestinations = await matchingManagedSymlinkDestinations(
    plan,
    previousManagedDestinations
  );
  const ignoredDestinations = new Set([...replaceDestinations, ...idempotentDestinations]);
  await assertPlanDestinationsDoNotExist(plan, options.overwrite === true, ignoredDestinations);
  await assertJsonMergeConflicts(plan.jsonMerges, options.overwrite === true);
  await assertClaudeHookConflicts(plan.hooks, options.overwrite === true);
  await assertSafeSymlinkDestinationParents(plan, options.projectRoot);
  if (options.overwrite === true) {
    await assertSafeOverwriteDestinations(plan, targetConfig, ignoredDestinations);
    await removePlanDestinations(plan, ignoredDestinations);
  }
  for (const file of previousFilesToReplace) {
    await removeGeneratedFile(file, options.tool, targetConfig, options.projectRoot);
  }

  const written: string[] = [];
  for (const file of plan.files) {
    await atomicWriteText(file.path, file.content, { overwrite: options.overwrite === true });
    written.push(file.path);
  }
  for (const link of plan.symlinks) {
    if (
      idempotentDestinations.has(resolve(link.path)) &&
      (await existingMatchingSymlink(link.path, link.target))
    )
      continue;
    await assertSafeSymlinkDestinationParent(options.projectRoot, link.path);
    await mkdir(dirname(link.path), { recursive: true });
    await symlink(link.target, link.path, "dir");
    written.push(link.path);
  }
  for (const merge of plan.jsonMerges) {
    await applyJsonMerge(merge);
    written.push(merge.path);
  }
  for (const merge of plan.tomlMerges) {
    await applyTomlMerge(merge);
    written.push(merge.path);
  }
  for (const block of plan.instructionBlocks) {
    await applyInstructionBlock(block);
    written.push(block.path);
  }
  for (const hook of plan.hooks) {
    if (hook.kind === "jsonMerge") {
      if (!hook.settingsPath) throw new Error(`Claude hook missing settings path: ${hook.id}`);
      await mergeClaudeHookSettings(hook.settingsPath, hook.preview);
      written.push(hook.settingsPath);
    } else {
      if (!hook.outputPath) throw new Error(`OpenCode hook missing output path: ${hook.id}`);
      if (
        idempotentDestinations.has(resolve(hook.outputPath)) &&
        (await existingMatchingSymlink(hook.outputPath, hook.sourcePath))
      )
        continue;
      await assertSafeSymlinkDestinationParent(options.projectRoot, hook.outputPath);
      await mkdir(dirname(hook.outputPath), { recursive: true });
      await symlink(hook.sourcePath, hook.outputPath, "file");
      written.push(hook.outputPath);
    }
  }

  for (const file of previousFiles) {
    if (
      !currentFiles.has(
        resolve(recordedDestinationPath(file, options.tool, targetConfig, options.projectRoot))
      )
    ) {
      await removeGeneratedFile(file, options.tool, targetConfig, options.projectRoot);
    }
  }
  if (previousRecord) {
    await removeStaleManagedJsonEntries(previousRecord.managedJsonEntries, plan.jsonMerges);
    await removeStaleManagedTomlEntries(previousRecord.managedTomlEntries ?? [], plan.tomlMerges);
    await removeStaleManagedInstructionBlocks(
      previousRecord.managedInstructionBlocks ?? [],
      managedInstructionBlocksForPlan(plan)
    );
    await removeStaleManagedHooks(previousRecord.managedHooks, managedHooksForPlan(plan));
  }

  await upsertLinkRecord(
    { samxHome: options.samxHome },
    {
      id,
      bundleId: options.bundleId,
      tool: plan.tool,
      projectRoot: resolve(options.projectRoot),
      generatedFiles: plan.generatedFiles,
      managedJsonEntries: managedJsonEntriesForPlan(plan),
      managedTomlEntries: managedTomlEntriesForPlan(plan),
      managedInstructionBlocks: managedInstructionBlocksForPlan(plan),
      managedHooks: managedHooksForPlan(plan),
      adjacentHooks: plan.enabledAdjacentHooks.map((hook) => ({
        id: hook.id,
        packageId: hook.packageId,
        tool: hook.tool,
        sourcePath: hook.file,
        fingerprint: hook.fingerprint,
        appliesTo: hook.appliesTo,
      })),
      createdAt: new Date().toISOString(),
    }
  );

  return { plan, written };
}

function linkAdvisoryError(plan: LinkPlan): string {
  return [
    "Bundle has formula advisories. Re-run with --allow-advisories to link anyway.",
    ...plan.advisories.map(
      (advisory) => `- ${advisory.packageId} ${advisory.id}: ${advisory.message}`
    ),
  ].join("\n");
}

async function existingMatchingSymlink(path: string, target: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink()) return false;
    return resolve(dirname(path), await readlink(path)) === resolve(target);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function matchingManagedSymlinkDestinations(
  plan: LinkPlan,
  managedDestinations: Set<string>
): Promise<Set<string>> {
  const ignored = new Set<string>();
  for (const link of plan.symlinks) {
    if (
      managedDestinations.has(resolve(link.path)) &&
      (await existingMatchingSymlink(link.path, link.target))
    )
      ignored.add(resolve(link.path));
  }
  for (const hook of plan.hooks) {
    if (
      hook.kind === "symlink" &&
      hook.outputPath &&
      managedDestinations.has(resolve(hook.outputPath)) &&
      (await existingMatchingSymlink(hook.outputPath, hook.sourcePath))
    ) {
      ignored.add(resolve(hook.outputPath));
    }
  }
  return ignored;
}

async function assertSafeSymlinkDestinationParents(
  plan: LinkPlan,
  projectRoot: string
): Promise<void> {
  for (const link of plan.symlinks) {
    await assertSafeSymlinkDestinationParent(projectRoot, link.path);
  }
  for (const hook of plan.hooks) {
    if (hook.kind === "symlink" && hook.outputPath) {
      await assertSafeSymlinkDestinationParent(projectRoot, hook.outputPath);
    }
  }
}

async function assertSafeLegacyReplacementDirectories(
  files: string[],
  tool: string,
  targetConfig: LinkTargetConfig,
  projectRoot: string
): Promise<void> {
  for (const file of files) {
    if (!isLegacySkillFileRecord(file, tool, targetConfig, projectRoot)) {
      continue;
    }

    const directory = dirname(file);
    let entries;
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }

    const unmanagedEntries = entries.filter((entry) => entry !== basename(file));
    if (unmanagedEntries.length > 0) {
      throw new Error(
        `Refusing to replace legacy OpenCode directory containing unmanaged files: ${directory}`
      );
    }
  }
}

async function assertSafeSymlinkDestinationParent(
  projectRoot: string,
  destination: string
): Promise<void> {
  const root = resolve(projectRoot);
  const resolvedDestination = resolve(destination);
  const parent = resolve(dirname(destination));
  if (!isInsideDirectory(resolvedDestination, root)) {
    throw new Error(`Refusing to write outside project root: ${destination}`);
  }

  const relativeParent = relative(root, parent);
  if (relativeParent === "") return;

  let current = root;
  for (const part of relativeParent.split(/[\\/]/)) {
    current = join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to write through symlinked parent: ${current}`);
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

async function assertPlanDestinationsDoNotExist(
  plan: LinkPlan,
  overwrite: boolean,
  ignoredDestinations = new Set<string>()
): Promise<void> {
  if (overwrite) {
    return;
  }

  for (const path of planDestinationPaths(plan)) {
    if (ignoredDestinations.has(resolve(path))) {
      continue;
    }
    if (await fileExists(path)) {
      throw new Error(`File already exists: ${path}`);
    }
  }
}

async function removePlanDestinations(
  plan: LinkPlan,
  ignoredDestinations = new Set<string>()
): Promise<void> {
  for (const path of planDestinationPaths(plan)) {
    if (ignoredDestinations.has(resolve(path))) {
      continue;
    }
    await rm(path, { force: true, recursive: true });
  }
}

async function assertSafeOverwriteDestinations(
  plan: LinkPlan,
  targetConfig: LinkTargetConfig,
  ignoredDestinations = new Set<string>()
): Promise<void> {
  for (const link of plan.symlinks) {
    if (ignoredDestinations.has(resolve(link.path))) {
      continue;
    }
    await assertSafeOverwriteSymlinkDestination(link.path, plan.tool, targetConfig);
  }
  for (const hook of plan.hooks) {
    if (hook.kind === "symlink" && hook.outputPath) {
      if (ignoredDestinations.has(resolve(hook.outputPath))) {
        continue;
      }
      await assertSafeOverwriteSymlinkDestination(hook.outputPath, plan.tool, targetConfig);
    }
  }
}

async function assertSafeOverwriteSymlinkDestination(
  path: string,
  tool: string,
  targetConfig: LinkTargetConfig
): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!stats.isSymbolicLink()) {
    throw new Error(
      `Refusing to overwrite ${displayLinkTarget(tool, targetConfig)} path that is not a symlink: ${path}`
    );
  }
}

function planDestinationPaths(plan: LinkPlan): string[] {
  return [
    ...plan.files.map((file) => file.path),
    ...plan.symlinks.map((link) => link.path),
    ...plan.hooks
      .filter((hook) => hook.kind === "symlink" && hook.outputPath)
      .map((hook) => hook.outputPath as string),
  ];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertSafeRemovableGeneratedFiles(
  paths: string[],
  tool: string,
  targetConfig: LinkTargetConfig,
  projectRoot: string
): Promise<void> {
  for (const path of paths) {
    if (isMcpJsonOutput(path, projectRoot, targetConfig)) {
      continue;
    }
    if (isClaudeHookSettingsOutput(path, projectRoot, targetConfig)) {
      continue;
    }
    if (isLegacySkillFileRecord(path, tool, targetConfig, projectRoot)) {
      await assertLegacyOpenCodeFileIsSafe(path);
      continue;
    }

    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    if (!stats.isSymbolicLink()) {
      throw new Error(
        `Refusing to unlink ${displayLinkTarget(tool, targetConfig)} path that is not a symlink: ${path}`
      );
    }
  }
}

async function assertLegacyOpenCodeFileIsSafe(path: string): Promise<void> {
  const parent = dirname(path);
  try {
    const parentStats = await lstat(parent);
    if (parentStats.isSymbolicLink()) {
      throw new Error(`Refusing to unlink legacy OpenCode file through symlink: ${path}`);
    }
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(
        `Refusing to unlink legacy OpenCode path that is not a regular file: ${path}`
      );
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function unlinkBundle(options: UnlinkBundleOptions): Promise<LinkResult> {
  const targetConfig = await loadLinkTargetConfig(options.tool);

  const id = linkRecordId(options.bundleId, options.tool, options.projectRoot);
  const record = (await readLinkRecords({ samxHome: options.samxHome })).links.find(
    (link) => link.id === id
  );
  if (!record) {
    throw new Error(
      `Link record not found for bundle ${options.bundleId} and tool ${options.tool} at ${resolve(options.projectRoot)}`
    );
  }

  const generatedFiles = validatedGeneratedFiles(
    record.generatedFiles,
    options.projectRoot,
    options.tool,
    targetConfig
  );
  await assertSafeRemovableGeneratedFiles(
    generatedFiles,
    options.tool,
    targetConfig,
    options.projectRoot
  );
  const unlinkPlan = {
    ...emptyPlan(options),
    generatedFiles,
    jsonMerges: jsonMergesForManagedEntries(record.managedJsonEntries),
    tomlMerges: tomlMergesForManagedEntries(record.managedTomlEntries ?? []),
  };

  if (options.dryRun === true) {
    return { plan: unlinkPlan, written: [] };
  }

  for (const file of generatedFiles) {
    await removeGeneratedFile(file, options.tool, targetConfig, options.projectRoot);
  }
  await removeStaleManagedJsonEntries(record.managedJsonEntries, []);
  await removeStaleManagedTomlEntries(record.managedTomlEntries ?? [], []);
  await removeStaleManagedInstructionBlocks(record.managedInstructionBlocks ?? [], []);
  await removeStaleManagedHooks(record.managedHooks, []);
  await removeLinkRecord({ samxHome: options.samxHome }, id);

  return { plan: unlinkPlan, written: [] };
}

async function removeGeneratedFile(
  file: string,
  tool: string,
  targetConfig: LinkTargetConfig,
  projectRoot: string
): Promise<void> {
  if (isMcpJsonOutput(file, projectRoot, targetConfig)) {
    return;
  }
  if (isClaudeHookSettingsOutput(file, projectRoot, targetConfig)) {
    return;
  }
  if (isLegacySkillFileRecord(file, tool, targetConfig, projectRoot)) {
    await rm(file, { force: true });
    await removeEmptyDirectory(dirname(file));
    return;
  }

  await rm(file, { force: true, recursive: true });
}

function recordedDestinationPath(
  file: string,
  tool: string,
  targetConfig: LinkTargetConfig,
  projectRoot: string
): string {
  if (isLegacySkillFileRecord(file, tool, targetConfig, projectRoot)) {
    return dirname(file);
  }
  return file;
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EEXIST")
    ) {
      return;
    }
    throw error;
  }
}

function linkRecordId(bundleId: string, tool: string, projectRoot: string): string {
  return `${bundleId}:${tool}:${resolve(projectRoot)}`;
}

function emptyPlan(options: UnlinkBundleOptions): LinkPlan {
  return {
    tool: options.tool,
    bundleId: options.bundleId,
    projectRoot: resolve(options.projectRoot),
    generatedFiles: [],
    files: [],
    symlinks: [],
    jsonMerges: [],
    instructionBlocks: [],
    tomlMerges: [],
    hooks: [],
    skippedHooks: [],
    hookWarnings: [],
    environmentReminders: [],
    advisories: [],
    hookCandidates: [],
    hookDecisionRequired: false,
    enabledAdjacentHooks: [],
  };
}

function validatedGeneratedFiles(
  files: string[],
  projectRoot: string,
  tool: string,
  targetConfig: LinkTargetConfig
): string[] {
  const root = resolve(projectRoot);
  const resolvedFiles = files.map((file) => resolve(file));
  const resolved = new Set(resolvedFiles);

  if (resolved.size !== resolvedFiles.length) {
    throw new Error("Refusing to unlink unexpected generated file set");
  }

  for (const file of resolvedFiles) {
    if (!isInsideDirectory(file, root)) {
      throw new Error(`Refusing to unlink generated file outside project root: ${file}`);
    }
    if (isMcpJsonOutput(file, root, targetConfig)) {
      continue;
    }
    if (isClaudeHookSettingsOutput(file, root, targetConfig)) {
      continue;
    }
    if (!isAnyDirectoryGeneratedPath(file, root, tool, targetConfig)) {
      throw new Error(
        `Refusing to unlink unexpected ${displayLinkTarget(tool, targetConfig)} generated file shape: ${file}`
      );
    }
  }

  return resolvedFiles;
}

function isInsideDirectory(file: string, directory: string): boolean {
  const child = resolve(file);
  const parent = resolve(directory);
  const path = relative(parent, child);
  return path === "" || (path.length > 0 && !path.startsWith("..") && !isAbsolute(path));
}

function isAnyDirectoryGeneratedPath(
  file: string,
  projectRoot: string,
  tool: string,
  targetConfig: LinkTargetConfig
): boolean {
  return (
    isDirectorySymlinkPath(
      file,
      projectRoot,
      targetConfig.capabilities.skill?.mode === "directory-symlink"
        ? targetConfig.capabilities.skill.root
        : undefined
    ) ||
    isDirectorySymlinkPath(
      file,
      projectRoot,
      targetConfig.capabilities.agent?.mode === "directory-symlink"
        ? targetConfig.capabilities.agent.root
        : undefined
    ) ||
    isDirectorySymlinkPath(
      file,
      projectRoot,
      targetConfig.hooks?.mode === "opencode-plugin" ? targetConfig.hooks.root : undefined
    ) ||
    isLegacySkillFileRecord(file, tool, targetConfig, projectRoot)
  );
}

function isDirectorySymlinkPath(
  file: string,
  projectRoot: string,
  root: string | undefined
): boolean {
  if (!root) return false;
  const path = relative(join(resolve(projectRoot), root), resolve(file));
  const parts = path.split(/[\\/]/);
  return (
    parts.length === 1 && parts[0].length > 0 && !parts[0].startsWith("..") && !isAbsolute(path)
  );
}

function isLegacySkillFileRecord(
  file: string,
  _tool: string,
  targetConfig: LinkTargetConfig,
  projectRoot: string
): boolean {
  return (
    targetConfig.allowLegacySkillFileRecords === true &&
    targetConfig.capabilities.skill?.mode === "directory-symlink" &&
    isLegacySkillFile(
      file,
      projectRoot,
      targetConfig.capabilities.skill.root,
      targetConfig.capabilities.skill.entry ?? "SKILL.md"
    )
  );
}

function isLegacySkillFile(
  file: string,
  projectRoot: string,
  root: string,
  entry: string
): boolean {
  const path = relative(join(resolve(projectRoot), root), resolve(file));
  const parts = path.split(/[\\/]/);
  return parts.length === 2 && parts[0].length > 0 && parts[1] === entry;
}

function isMcpJsonOutput(
  file: string,
  projectRoot: string,
  targetConfig: LinkTargetConfig
): boolean {
  const rule = targetConfig.capabilities.mcp;
  return (
    rule?.mode === "mcp-json-merge" &&
    (resolve(file) === resolve(projectRoot, rule.output) ||
      (targetConfig.allowLegacySkillFileRecords === true &&
        resolve(file) === resolve(projectRoot, ".opencode/mcp.json")))
  );
}

function isClaudeHookSettingsOutput(
  file: string,
  projectRoot: string,
  targetConfig: LinkTargetConfig
): boolean {
  const rule = targetConfig.hooks;
  return (
    rule?.mode === "claude-settings-hooks" && resolve(file) === resolve(projectRoot, rule.settings)
  );
}

async function assertClaudeHookConflicts(hooks: LinkPlanHook[], overwrite: boolean): Promise<void> {
  for (const hook of hooks) {
    if (hook.kind !== "jsonMerge") continue;
    if (!hook.settingsPath) throw new Error(`Claude hook missing settings path: ${hook.id}`);
    if (!overwrite && hook.drift && hook.drift.length > 0) {
      throw new Error(`Claude hook managed entry drifted: ${hook.drift[0]?.sentinel ?? hook.id}`);
    }
    await assertClaudeHookSettingsMergeable(hook.settingsPath, hook.preview);
  }
}

async function assertJsonMergeConflicts(
  merges: LinkPlanJsonMerge[],
  overwrite: boolean
): Promise<void> {
  for (const merge of merges) {
    const root = await readJsonObject(merge.path);
    const target = objectAtPath(root, merge.keyPath, { create: false });
    if (!target) continue;
    for (const entry of merge.entries) {
      const current = target[entry.key];
      if (
        current !== undefined &&
        JSON.stringify(current) !== JSON.stringify(entry.value) &&
        !overwrite
      ) {
        throw new Error(`MCP server already exists with different config: ${entry.key}`);
      }
    }
  }
}

async function applyJsonMerge(merge: LinkPlanJsonMerge): Promise<void> {
  const root = await readJsonObject(merge.path);
  for (const [key, value] of Object.entries(merge.defaults ?? {})) {
    if (root[key] === undefined) root[key] = value;
  }
  const target = objectAtPath(root, merge.keyPath, { create: true });
  if (!target) throw new Error(`Could not create JSON merge path: ${merge.keyPath.join(".")}`);
  for (const entry of merge.entries) {
    target[entry.key] = entry.value;
  }
  await atomicWriteJson(merge.path, root);
}

async function applyTomlMerge(merge: LinkPlanTomlMerge): Promise<void> {
  const existing = await readTextFile(merge.path);
  await atomicWriteText(merge.path, mergeCodexMcpTables(existing, merge.entries, merge.tablePath), {
    overwrite: true,
  });
}

async function applyInstructionBlock(block: LinkPlanInstructionBlock): Promise<void> {
  const existing = await readTextFile(block.path);
  await atomicWriteText(
    block.path,
    mergeAgentsMd(existing, block.marker.bundleId, block.marker.tool, block.content),
    { overwrite: true }
  );
}

async function removeStaleManagedJsonEntries(
  entries: Array<{ path: string; keyPath: string[]; key: string }>,
  currentMerges: LinkPlanJsonMerge[]
): Promise<void> {
  const keep = new Set(
    currentMerges.flatMap((merge) =>
      merge.entries.map((entry) => jsonEntryId(merge.path, merge.keyPath, entry.key))
    )
  );
  for (const entry of entries) {
    if (keep.has(jsonEntryId(entry.path, entry.keyPath, entry.key))) {
      continue;
    }
    const root = await readJsonObject(entry.path);
    const target = objectAtPath(root, entry.keyPath, { create: false });
    if (target && Object.prototype.hasOwnProperty.call(target, entry.key)) {
      delete target[entry.key];
      await atomicWriteJson(entry.path, root);
    }
  }
}

function managedJsonEntriesForPlan(
  plan: LinkPlan
): Array<{ path: string; keyPath: string[]; key: string }> {
  return plan.jsonMerges.flatMap((merge) =>
    merge.entries.map((entry) => ({ path: merge.path, keyPath: merge.keyPath, key: entry.key }))
  );
}

function managedTomlEntriesForPlan(
  plan: LinkPlan
): Array<{ path: string; tablePath: string[]; key: string }> {
  return plan.tomlMerges.flatMap((merge) =>
    merge.entries.map((entry) => ({ path: merge.path, tablePath: merge.tablePath, key: entry.key }))
  );
}

async function removeStaleManagedTomlEntries(
  entries: Array<{ path: string; tablePath: string[]; key: string }>,
  currentMerges: LinkPlanTomlMerge[]
): Promise<void> {
  const keep = new Set(
    currentMerges.flatMap((merge) =>
      merge.entries.map((entry) => tomlEntryId(merge.path, merge.tablePath, entry.key))
    )
  );
  for (const entry of entries) {
    if (keep.has(tomlEntryId(entry.path, entry.tablePath, entry.key))) continue;
    const existing = await readTextFile(entry.path);
    await atomicWriteText(
      entry.path,
      removeCodexMcpTables(existing, [entry.key], entry.tablePath),
      { overwrite: true }
    );
  }
}

function managedInstructionBlocksForPlan(
  plan: LinkPlan
): Array<{ path: string; bundleId: string; tool: string }> {
  return plan.instructionBlocks.map((block) => ({
    path: block.path,
    bundleId: block.marker.bundleId,
    tool: block.marker.tool,
  }));
}

async function removeStaleManagedInstructionBlocks(
  previousBlocks: Array<{ path: string; bundleId: string; tool: string }>,
  currentBlocks: Array<{ path: string; bundleId: string; tool: string }>
): Promise<void> {
  const keep = new Set(currentBlocks.map((block) => instructionBlockId(block)));
  for (const block of previousBlocks) {
    if (keep.has(instructionBlockId(block))) continue;
    const existing = await readTextFile(block.path);
    await atomicWriteText(block.path, removeAgentsMdBlock(existing, block.bundleId, block.tool), {
      overwrite: true,
    });
  }
}

function jsonMergesForManagedEntries(
  entries: Array<{ path: string; keyPath: string[]; key: string }>
): LinkPlanJsonMerge[] {
  const byPath = new Map<string, LinkPlanJsonMerge>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = `${resolve(entry.path)}\0${entry.keyPath.join("\0")}`;
    const entryId = `${id}\0${entry.key}`;
    if (seen.has(entryId)) continue;
    seen.add(entryId);
    const merge = byPath.get(id) ?? { path: entry.path, keyPath: entry.keyPath, entries: [] };
    merge.entries.push({ key: entry.key, value: {} });
    byPath.set(id, merge);
  }
  return [...byPath.values()];
}

function tomlMergesForManagedEntries(
  entries: Array<{ path: string; tablePath: string[]; key: string }>
): LinkPlanTomlMerge[] {
  const byPath = new Map<string, LinkPlanTomlMerge>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = `${resolve(entry.path)}\0${entry.tablePath.join("\0")}`;
    const entryId = `${id}\0${entry.key}`;
    if (seen.has(entryId)) continue;
    seen.add(entryId);
    const merge = byPath.get(id) ?? { path: entry.path, tablePath: entry.tablePath, entries: [] };
    merge.entries.push({ key: entry.key, value: {} });
    byPath.set(id, merge);
  }
  return [...byPath.values()];
}

function managedHooksForPlan(plan: LinkPlan): Array<{
  id: string;
  packageId: string;
  tool: "claude" | "opencode";
  kind: "jsonMerge" | "symlink";
  outputs: string[];
  sentinels: string[];
  fingerprints: string[];
  sourcePath?: string;
  appliesTo?: string[];
  inference?: "top-level" | "adjacent";
}> {
  return plan.hooks.map((hook) => ({
    id: hook.id,
    packageId: hook.packageId,
    tool: hook.tool,
    kind: hook.kind,
    outputs:
      hook.kind === "jsonMerge"
        ? hook.settingsPath
          ? [hook.settingsPath]
          : []
        : hook.outputPath
          ? [hook.outputPath]
          : [],
    sentinels: hookSentinels(hook),
    fingerprints: hookFingerprints(hook),
    sourcePath: hook.sourcePath,
    appliesTo: hook.appliesTo,
    ...(hook.inference ? { inference: hook.inference } : {}),
  }));
}

async function removeStaleManagedHooks(
  previousHooks: Array<{ kind: "jsonMerge" | "symlink"; outputs: string[]; sentinels: string[] }>,
  currentHooks: Array<{ kind: "jsonMerge" | "symlink"; outputs: string[]; sentinels: string[] }>
): Promise<void> {
  const keep = new Set(
    currentHooks.flatMap((hook) =>
      hook.sentinels.map((sentinel) => `${hook.outputs[0] ?? ""}:${sentinel}`)
    )
  );
  for (const hook of previousHooks) {
    if (hook.kind !== "jsonMerge") continue;
    const settingsPath = hook.outputs[0];
    if (!settingsPath) continue;
    const staleSentinels = hook.sentinels.filter(
      (sentinel) => !keep.has(`${settingsPath}:${sentinel}`)
    );
    await removeClaudeHookSentinels(settingsPath, staleSentinels);
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    throw new Error(`JSON file must contain an object: ${path}`);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function instructionBlockId(block: { path: string; bundleId: string; tool: string }): string {
  return `${resolve(block.path)}:${block.bundleId}:${block.tool}`;
}

function objectAtPath(
  root: Record<string, unknown>,
  keyPath: string[],
  options: { create: boolean }
): Record<string, unknown> | undefined {
  let current = root;
  for (const key of keyPath) {
    if (current[key] === undefined && options.create) {
      current[key] = {};
    }
    if (typeof current[key] !== "object" || current[key] === null || Array.isArray(current[key])) {
      return undefined;
    }
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

function jsonEntryId(path: string, keyPath: string[], key: string): string {
  return `${resolve(path)}:${keyPath.join(".")}:${key}`;
}

function tomlEntryId(path: string, tablePath: string[], key: string): string {
  return `${resolve(path)}:${tablePath.join(".")}:${key}`;
}
