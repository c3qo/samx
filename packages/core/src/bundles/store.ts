import type { SamxBundle, SamxBundleItem } from "@c3qo/samx-schemas";
import { bundleSchema } from "@c3qo/samx-schemas";
import { readdir, readFile, rm } from "node:fs/promises";
import { parse, stringify } from "yaml";

import { atomicWriteText } from "../store/atomic.js";
import { samxPaths, validateStoreId } from "../store/paths.js";

export interface BundleStoreOptions {
  samxHome?: string;
}

export interface BundleIdOptions extends BundleStoreOptions {
  id: string;
}

export interface AddBundleItemOptions extends BundleStoreOptions {
  bundleId: string;
  itemId: string;
  kind: SamxBundleItem["kind"];
  alias?: string;
}

export interface RemoveBundleItemOptions extends BundleStoreOptions {
  bundleId: string;
  itemId: string;
}

export interface ResolveBundleItemOptions extends BundleStoreOptions {
  bundleId: string;
  idOrAlias: string;
  canonicalId?: string;
}

export async function createBundle(options: BundleIdOptions): Promise<SamxBundle> {
  requireBundleId(options.id);
  const bundle = bundleSchema.parse({ id: options.id, items: [] });
  try {
    await writeBundle(options.samxHome, bundle, { overwrite: false });
  } catch (error) {
    if (errorMessage(error).startsWith("File already exists:")) {
      throw new Error(`Bundle already exists: ${options.id}`);
    }
    throw error;
  }
  return bundle;
}

export async function getBundle(options: BundleIdOptions): Promise<SamxBundle> {
  requireBundleId(options.id);
  const paths = samxPaths(options.samxHome);
  const filePath = paths.bundleFile(options.id);
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`Bundle not found: ${options.id}`);
    }
    throw error;
  }

  try {
    const bundle = bundleSchema.parse(parse(contents));
    rejectIdMismatch(options.id, bundle);
    rejectDuplicateItems(bundle);
    return bundle;
  } catch (error) {
    throw new Error(`Could not parse bundle file: ${filePath}. ${errorMessage(error)}`);
  }
}

export async function listBundles(options: BundleStoreOptions = {}): Promise<SamxBundle[]> {
  const paths = samxPaths(options.samxHome);
  let files: string[];
  try {
    files = await readdir(paths.bundlesDir);
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const bundles = await Promise.all(
    files
      .filter((file) => file.endsWith(".yaml"))
      .map((file) => getBundle({ samxHome: options.samxHome, id: file.slice(0, -5) }))
  );
  return bundles.sort((a, b) => a.id.localeCompare(b.id));
}

export async function addBundleItem(options: AddBundleItemOptions): Promise<SamxBundle> {
  const bundle = await getBundle({ samxHome: options.samxHome, id: options.bundleId });
  if (bundle.items.some((item) => item.id === options.itemId)) {
    return bundle;
  }

  const updated = bundleSchema.parse({
    ...bundle,
    items: [
      ...bundle.items,
      {
        id: options.itemId,
        kind: options.kind,
        ...(options.alias ? { alias: options.alias } : {}),
      },
    ],
  });
  await writeBundle(options.samxHome, updated);
  return updated;
}

export async function removeBundleItem(options: RemoveBundleItemOptions): Promise<SamxBundle> {
  const bundle = await getBundle({ samxHome: options.samxHome, id: options.bundleId });
  const updated = bundleSchema.parse({
    ...bundle,
    items: bundle.items.filter((item) => item.id !== options.itemId),
  });
  await writeBundle(options.samxHome, updated);
  return updated;
}

export async function resolveBundleItem(
  options: ResolveBundleItemOptions
): Promise<SamxBundleItem> {
  const bundle = await getBundle({ samxHome: options.samxHome, id: options.bundleId });
  const matches = new Map<string, SamxBundleItem>();
  if (options.canonicalId) {
    for (const item of bundle.items) {
      if (item.id === options.canonicalId) matches.set(item.id, item);
    }
  }
  for (const item of bundle.items) {
    if (item.id === options.idOrAlias || item.alias === options.idOrAlias)
      matches.set(item.id, item);
  }
  const items = [...matches.values()];
  if (items.length === 0) {
    throw new Error(`Bundle item not found in ${options.bundleId}: ${options.idOrAlias}`);
  }
  if (items.length > 1) {
    throw new Error(`Ambiguous bundle item in ${options.bundleId}: ${options.idOrAlias}`);
  }
  return items[0];
}

export async function removeBundle(options: BundleIdOptions): Promise<void> {
  requireBundleId(options.id);
  try {
    await rm(samxPaths(options.samxHome).bundleFile(options.id));
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`Bundle not found: ${options.id}`);
    }
    throw error;
  }
}

async function writeBundle(
  samxHome: string | undefined,
  bundle: SamxBundle,
  options: { overwrite?: boolean } = {}
): Promise<void> {
  await atomicWriteText(
    samxPaths(samxHome).bundleFile(bundle.id),
    stringify(bundleSchema.parse(bundle)),
    options
  );
}

function requireBundleId(id: string): void {
  if (id.length === 0) {
    throw new Error("Bundle id is required");
  }
  validateStoreId(id);
}

function rejectIdMismatch(expectedId: string, bundle: SamxBundle): void {
  if (bundle.id !== expectedId) {
    throw new Error(`Bundle id mismatch: expected ${expectedId}, found ${bundle.id}`);
  }
}

function rejectDuplicateItems(bundle: SamxBundle): void {
  const seen = new Set<string>();
  for (const item of bundle.items) {
    if (seen.has(item.id)) {
      throw new Error(`Duplicate bundle item id: ${item.id}`);
    }
    seen.add(item.id);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
