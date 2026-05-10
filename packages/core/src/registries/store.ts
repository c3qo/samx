import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import {
  addTrustedRegistry,
  readSamxLock,
  removeRegistryFromSamxLock,
} from "../locks/workspace.js";
import { atomicWriteJson, readJsonFile } from "../store/atomic.js";
import { samxPaths, validateStoreId } from "../store/paths.js";

export interface RegistryStoreOptions {
  samxHome?: string;
}

export interface RegistryIdOptions extends RegistryStoreOptions {
  id: string;
}

export interface AddRegistryOptions extends RegistryIdOptions {
  url: string;
}

export interface RemoveRegistryOptions extends RegistryIdOptions {
  force?: boolean;
}

export interface RemoveRegistryResult {
  installedPackagesRemaining: boolean;
}

export interface RegistryRecord {
  id: string;
  url: string;
}

export interface ListedRegistryRecord extends RegistryRecord {
  trusted: boolean;
}

const registryRecordSchema = z
  .object({
    id: z.string().superRefine((id, ctx) => {
      try {
        validateStoreId(id);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "Invalid store id",
        });
      }
    }),
    url: z.string().superRefine((url, ctx) => {
      try {
        parseRegistryUrl(url);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "Invalid registry URL",
        });
      }
    }),
  })
  .strict();

const registryManifestSchema = z
  .object({
    registries: z.array(registryRecordSchema),
  })
  .strict();

type RegistryManifest = z.infer<typeof registryManifestSchema>;

const defaultRegistry: RegistryRecord = {
  id: "default",
  url: "https://github.com/c3qo/samx-registry.git",
};

export function registryManifestPath(samxHome?: string): string {
  return join(samxPaths(samxHome).root, "registries.json");
}

export async function ensureDefaultRegistry(
  options: RegistryStoreOptions = {}
): Promise<RegistryRecord> {
  const manifest = await readRegistryManifest(options);
  await atomicWriteJson(registryManifestPath(options.samxHome), {
    registries: manifest.registries,
  });
  return defaultRegistry;
}

export async function addRegistry(options: AddRegistryOptions): Promise<RegistryRecord> {
  validateStoreId(options.id);
  if (options.id === defaultRegistry.id) {
    throw new Error("Cannot replace built-in registry: default");
  }
  const registry = { id: options.id, url: parseRegistryUrl(options.url) };
  const manifest = await readRegistryManifest(options);
  const registries = withDefaultRegistry([
    ...manifest.registries.filter((entry) => entry.id !== registry.id),
    registry,
  ]);
  await atomicWriteJson(registryManifestPath(options.samxHome), { registries });
  return registry;
}

export async function removeRegistry(
  options: RemoveRegistryOptions
): Promise<RemoveRegistryResult> {
  validateStoreId(options.id);
  if (options.id === defaultRegistry.id) {
    throw new Error("Cannot remove built-in registry: default");
  }
  await getRegistry(options);
  const lock = await readSamxLock(options);
  const usedPackage = lock.formulas.find((formula) => formula.id.startsWith(`${options.id}/`));
  if (usedPackage && options.force !== true) {
    throw new Error(`Registry is used by package: ${usedPackage.id}`);
  }
  const manifest = await readRegistryManifest(options);
  await atomicWriteJson(registryManifestPath(options.samxHome), {
    registries: withDefaultRegistry(
      manifest.registries.filter((registry) => registry.id !== options.id)
    ),
  });
  await rm(samxPaths(options.samxHome).registryRoot(options.id), { recursive: true, force: true });
  await removeRegistryFromSamxLock({ samxHome: options.samxHome, registry: options.id });
  return { installedPackagesRemaining: usedPackage !== undefined };
}

export function parseRegistryUrl(value: string): string {
  let url;
  try {
    url = new URL(value);
  } catch {
    if (isAbsolute(value)) return value;
    throw new Error("Registry URL must use https, git, ssh, or file protocol");
  }
  if (!["https:", "git:", "ssh:", "file:"].includes(url.protocol)) {
    throw new Error("Registry URL must use https, git, ssh, or file protocol");
  }
  return value;
}

export async function listRegistries(
  options: RegistryStoreOptions = {}
): Promise<ListedRegistryRecord[]> {
  const manifest = await readRegistryManifest(options);
  const lock = await readSamxLock(options);
  return sortedRegistries(manifest.registries).map((registry) => ({
    ...registry,
    trusted: lock.trustedRegistries.includes(registry.id),
  }));
}

export async function getRegistry(options: RegistryIdOptions): Promise<RegistryRecord> {
  validateStoreId(options.id);
  const found = (await readRegistryManifest(options)).registries.find(
    (registry) => registry.id === options.id
  );
  if (!found) {
    throw new Error(`Registry not found: ${options.id}`);
  }
  return found;
}

export async function trustRegistry(options: RegistryIdOptions): Promise<void> {
  await getRegistry(options);
  await addTrustedRegistry({ samxHome: options.samxHome, registry: options.id });
}

async function readRegistryManifest(options: RegistryStoreOptions): Promise<RegistryManifest> {
  const manifest = registryManifestSchema.parse(
    await readJsonFile(registryManifestPath(options.samxHome), { registries: [defaultRegistry] })
  );
  return { registries: withDefaultRegistry(manifest.registries) };
}

function sortedRegistries(registries: RegistryRecord[]): RegistryRecord[] {
  return [...registries].sort((a, b) => {
    if (a.id === defaultRegistry.id) return -1;
    if (b.id === defaultRegistry.id) return 1;
    return a.id.localeCompare(b.id);
  });
}

function withDefaultRegistry(registries: RegistryRecord[]): RegistryRecord[] {
  return sortedRegistries([
    defaultRegistry,
    ...registries.filter((registry) => registry.id !== defaultRegistry.id),
  ]);
}
