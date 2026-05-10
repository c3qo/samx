import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { RecipeLock } from "@c3qo/samx-schemas";
import { recipeLockSchema } from "@c3qo/samx-schemas";

import { regenerateCapabilities, validateRecipeCapabilities } from "../capabilities/index.js";
import { listBundles } from "../bundles/store.js";
import { resolveFormula } from "../formulas/resolve.js";
import { readLinkRecords } from "../links/records.js";
import { splitFormulaId } from "../formulas/read.js";
import { removeFormulaFromSamxLock, upsertFormulaInSamxLock } from "../locks/workspace.js";
import { gitHead } from "../registries/git.js";
import { getRegistry } from "../registries/store.js";
import { samxPaths } from "../store/paths.js";
import { writeRecipeLocks } from "./audit.js";

interface MaterializeFormulaPackageOptions {
  source: string;
  revision: string;
  destination: string;
}

type MaterializeFormulaPackage = (options: MaterializeFormulaPackageOptions) => Promise<void>;

export type FormulaPackageUpdateChange =
  | {
      field: "formulaHash" | "registryCommit" | "source.revision" | "source.type" | "source.url";
      before: string;
      after: string;
    }
  | { field: "capabilities.added" | "capabilities.removed"; values: string[] };

export interface FormulaPackageUpdatePreview {
  id: string;
  installed: RecipeLock;
  candidate: RecipeLock;
  changes: FormulaPackageUpdateChange[];
}

export interface AddFormulaPackageOptions {
  samxHome?: string;
  id: string;
  registryCommit?: string;
  sourceRevision?: string;
  sourceHead?: boolean;
  sourceRef?: string;
  now?: Date;
  materialize?: MaterializeFormulaPackage;
}

export interface RemoveFormulaPackageOptions {
  samxHome?: string;
  id: string;
  force?: boolean;
}

export async function addFormulaPackage(options: AddFormulaPackageOptions): Promise<RecipeLock> {
  const { registry, formula } = splitFormulaId(options.id);
  const paths = samxPaths(options.samxHome);
  const registryRecord = await getRegistry({ samxHome: options.samxHome, id: registry });
  const registryCommit = options.registryCommit ?? (await gitHead(paths.registryRoot(registry)));
  const recipe = await resolveFormula({
    samxHome: options.samxHome,
    id: options.id,
    registryCommit,
    sourceRevision: options.sourceRevision,
    sourceHead: options.sourceHead,
    sourceRef: options.sourceRef,
  });
  const packageRoot = paths.packageRoot(registry, formula);
  const sourceRoot = join(packageRoot, "source");
  const tempSourceRoot = join(
    packageRoot,
    `.source-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const backupSourceRoot = join(
    packageRoot,
    `.source-backup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const backupRecipeLockPath = join(
    packageRoot,
    `.recipe.lock.backup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  const backupSamxLockPath = join(
    paths.root,
    `.samx.lock.backup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const packageRootExisted = await pathExists(packageRoot);
  let hasVirtualSourceBackup = false;
  let hasGitSourceBackup = false;
  let hasVirtualRecipeLockBackup = false;
  let hasVirtualSamxLockBackup = false;

  if (recipe.source.type === "virtual") {
    await validateRecipeCapabilities({ sourceRoot, recipe });
    await mkdir(packageRoot, { recursive: true });
    hasVirtualRecipeLockBackup = await copyFileToBackup({
      path: paths.recipeLock(registry, formula),
      backupPath: backupRecipeLockPath,
    });
    hasVirtualSamxLockBackup = await copyFileToBackup({
      path: paths.samxLock,
      backupPath: backupSamxLockPath,
    });
    hasVirtualSourceBackup = await moveSourceRootToBackup({ sourceRoot, backupSourceRoot });
  } else {
    await mkdir(packageRoot, { recursive: true });
    hasVirtualRecipeLockBackup = await copyFileToBackup({
      path: paths.recipeLock(registry, formula),
      backupPath: backupRecipeLockPath,
    });
    hasVirtualSamxLockBackup = await copyFileToBackup({
      path: paths.samxLock,
      backupPath: backupSamxLockPath,
    });
    try {
      await (options.materialize ?? defaultMaterialize)({
        source: recipe.source.url,
        revision: recipe.source.revision,
        destination: tempSourceRoot,
      });
      await validateRecipeCapabilities({ sourceRoot: tempSourceRoot, recipe });
      hasGitSourceBackup = await replaceSourceRoot({
        sourceRoot,
        tempSourceRoot,
        backupSourceRoot,
      });
    } catch (error) {
      await rm(tempSourceRoot, { recursive: true, force: true });
      if (hasGitSourceBackup) await rm(backupSourceRoot, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    await writeRecipeLocks({
      samxHome: options.samxHome,
      registry,
      formula,
      recipe,
      now: options.now,
    });
    await upsertFormulaInSamxLock({
      samxHome: options.samxHome,
      registry: { id: registry, url: registryRecord.url, commit: registryCommit },
      formula: {
        id: options.id,
        formulaPath: recipe.formula.path,
        formulaHash: recipe.formula.formulaHash,
        source: recipe.source,
        capabilities: recipe.capabilities.map((capability) => capability.id).sort(),
      },
    });
    await regenerateCapabilities({ samxHome: options.samxHome });
  } catch (error) {
    if (hasVirtualSourceBackup) {
      await restoreSourceRootBackup({ sourceRoot, backupSourceRoot });
    }
    if (hasVirtualRecipeLockBackup) {
      await copyFile(backupRecipeLockPath, paths.recipeLock(registry, formula));
    }
    if (hasVirtualSamxLockBackup) {
      await copyFile(backupSamxLockPath, paths.samxLock);
    }
    if (recipe.source.type === "git") {
      if (hasGitSourceBackup) await restoreSourceRootBackup({ sourceRoot, backupSourceRoot });
      else await rm(sourceRoot, { recursive: true, force: true });
    }
    if (recipe.source.type === "virtual") {
      if (!hasVirtualRecipeLockBackup)
        await rm(paths.recipeLock(registry, formula), { force: true });
      if (!hasVirtualSamxLockBackup) await rm(paths.samxLock, { force: true });
      if (!packageRootExisted) await rm(packageRoot, { recursive: true, force: true });
    }
    throw error;
  }
  if (hasVirtualSourceBackup) await rm(backupSourceRoot, { recursive: true, force: true });
  if (hasGitSourceBackup) await rm(backupSourceRoot, { recursive: true, force: true });
  if (hasVirtualRecipeLockBackup) await rm(backupRecipeLockPath, { force: true });
  if (hasVirtualSamxLockBackup) await rm(backupSamxLockPath, { force: true });
  return recipe;
}

async function copyFileToBackup(options: { path: string; backupPath: string }): Promise<boolean> {
  try {
    await copyFile(options.path, options.backupPath);
    return true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    return false;
  }
}

async function moveSourceRootToBackup(options: {
  sourceRoot: string;
  backupSourceRoot: string;
}): Promise<boolean> {
  try {
    await rename(options.sourceRoot, options.backupSourceRoot);
    return true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    return false;
  }
}

async function restoreSourceRootBackup(options: {
  sourceRoot: string;
  backupSourceRoot: string;
}): Promise<void> {
  await rm(options.sourceRoot, { recursive: true, force: true });
  await rename(options.backupSourceRoot, options.sourceRoot);
}

async function replaceSourceRoot(options: {
  sourceRoot: string;
  tempSourceRoot: string;
  backupSourceRoot: string;
}): Promise<boolean> {
  let hasBackup = false;
  try {
    await rename(options.sourceRoot, options.backupSourceRoot);
    hasBackup = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  try {
    await rename(options.tempSourceRoot, options.sourceRoot);
  } catch (error) {
    if (hasBackup) {
      await rename(options.backupSourceRoot, options.sourceRoot);
    }
    throw error;
  }

  return hasBackup;
}

export async function updateFormulaPackage(options: AddFormulaPackageOptions): Promise<RecipeLock> {
  const preview = await previewFormulaPackageUpdate(options);
  if (preview.changes.length === 0) return preview.installed;
  return addFormulaPackage(options);
}

export async function previewFormulaPackageUpdate(
  options: AddFormulaPackageOptions
): Promise<FormulaPackageUpdatePreview> {
  const { registry, formula } = splitFormulaId(options.id);
  const paths = samxPaths(options.samxHome);
  const registryCommit = options.registryCommit ?? (await gitHead(paths.registryRoot(registry)));
  const [installed, candidate] = await Promise.all([
    readInstalledRecipe(options.samxHome, registry, formula),
    resolveFormula({
      samxHome: options.samxHome,
      id: options.id,
      registryCommit,
      sourceRevision: options.sourceRevision,
      sourceHead: options.sourceHead,
      sourceRef: options.sourceRef,
    }),
  ]);
  return { id: options.id, installed, candidate, changes: diffRecipeLocks(installed, candidate) };
}

async function readInstalledRecipe(
  samxHome: string | undefined,
  registry: string,
  formula: string
): Promise<RecipeLock> {
  return recipeLockSchema.parse(
    JSON.parse(await readFile(samxPaths(samxHome).recipeLock(registry, formula), "utf8"))
  );
}

function diffRecipeLocks(
  installed: RecipeLock,
  candidate: RecipeLock
): FormulaPackageUpdateChange[] {
  const changes: FormulaPackageUpdateChange[] = [];
  addStringChange(
    changes,
    "formulaHash",
    installed.formula.formulaHash,
    candidate.formula.formulaHash
  );
  addStringChange(
    changes,
    "registryCommit",
    installed.formula.registryCommit,
    candidate.formula.registryCommit
  );
  addStringChange(changes, "source.type", installed.source.type, candidate.source.type);
  if (installed.source.type === "git" && candidate.source.type === "git") {
    addStringChange(changes, "source.url", installed.source.url, candidate.source.url);
    addStringChange(
      changes,
      "source.revision",
      installed.source.revision,
      candidate.source.revision
    );
  }
  const installedCapabilities = installed.capabilities.map((capability) => capability.id).sort();
  const candidateCapabilities = candidate.capabilities.map((capability) => capability.id).sort();
  const added = candidateCapabilities.filter((id) => !installedCapabilities.includes(id));
  const removed = installedCapabilities.filter((id) => !candidateCapabilities.includes(id));
  if (added.length > 0) changes.push({ field: "capabilities.added", values: added });
  if (removed.length > 0) changes.push({ field: "capabilities.removed", values: removed });
  return changes;
}

function addStringChange(
  changes: FormulaPackageUpdateChange[],
  field: "formulaHash" | "registryCommit" | "source.revision" | "source.type" | "source.url",
  before: string,
  after: string
): void {
  if (before !== after) changes.push({ field, before, after });
}

export async function removeFormulaPackage(options: RemoveFormulaPackageOptions): Promise<void> {
  const { registry, formula } = splitFormulaId(options.id);
  await rejectFormulaInUse(options.samxHome, options.id);
  if (options.force !== true) await rejectPackageLinked(options.samxHome, options.id);
  await rm(samxPaths(options.samxHome).packageRoot(registry, formula), {
    recursive: true,
    force: true,
  });
  await removeFormulaFromSamxLock({ samxHome: options.samxHome, id: options.id });
  await regenerateCapabilities({ samxHome: options.samxHome });
}

async function rejectPackageLinked(samxHome: string | undefined, id: string): Promise<void> {
  const packagePathMarker = `/packages/${id}/source`;
  for (const link of (await readLinkRecords({ samxHome })).links) {
    const linked =
      link.managedHooks.some(
        (hook) => hook.packageId === id || hook.sourcePath?.includes(packagePathMarker)
      ) ||
      link.adjacentHooks.some(
        (hook) => hook.packageId === id || hook.sourcePath.includes(packagePathMarker)
      ) ||
      link.generatedFiles.some((file) => file.includes(packagePathMarker));
    if (linked) throw new Error(`Package is linked: ${link.id}`);
  }
}

async function rejectFormulaInUse(samxHome: string | undefined, id: string): Promise<void> {
  const prefix = `${id}:`;
  for (const bundle of await listBundles({ samxHome })) {
    if (bundle.items.some((item) => item.id.startsWith(prefix))) {
      throw new Error(`Package is used by bundle: ${bundle.id}`);
    }
  }
}

async function defaultMaterialize(options: MaterializeFormulaPackageOptions): Promise<void> {
  const gitProtocolConfig = ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=user"];
  await execa("git", [...gitProtocolConfig, "clone", options.source, options.destination]);
  await execa("git", [...gitProtocolConfig, "checkout", "--detach", options.revision, "--"], {
    cwd: options.destination,
  });
  const { stdout: head } = await execa("git", [...gitProtocolConfig, "rev-parse", "HEAD"], {
    cwd: options.destination,
  });
  if (head !== options.revision) {
    throw new Error(`Checked out revision mismatch: expected ${options.revision}, got ${head}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    return false;
  }
}
