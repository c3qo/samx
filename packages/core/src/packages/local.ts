import { mkdir, realpath, stat } from "node:fs/promises";
import type { PackageManifest, SamxPackage } from "@c3qo/samx-schemas";
import { packageManifestSchema } from "@c3qo/samx-schemas";

import { regenerateCapabilities } from "../capabilities/index.js";
import { listBundles } from "../bundles/store.js";
import { readLinkRecords } from "../links/records.js";
import { atomicWriteJson, readJsonFile } from "../store/atomic.js";
import { samxPaths, validateStoreId } from "../store/paths.js";

export type LocalSamxPackage = Extract<SamxPackage, { type: "local" }>;

export interface AddLocalPackageOptions {
  samxHome?: string;
  id: string;
  source: string;
}

export interface RemoveLocalPackageOptions {
  samxHome?: string;
  id: string;
  force?: boolean;
}

export async function addLocalPackage(options: AddLocalPackageOptions): Promise<SamxPackage> {
  validateStoreId(options.id);
  const stats = await stat(options.source);
  if (!stats.isDirectory()) {
    throw new Error(`Local package source must be a directory: ${options.source}`);
  }
  const source = await realpath(options.source);
  const pkg: SamxPackage = {
    id: options.id,
    source,
    type: "local",
    installKind: "local",
    path: source,
    requirements: { env: [] },
    advisories: [],
  };
  const manifest = await readLocalPackageManifest({ samxHome: options.samxHome });
  await mkdir(samxPaths(options.samxHome).root, { recursive: true });
  await atomicWriteJson(samxPaths(options.samxHome).localPackages, {
    packages: [...manifest.packages.filter((entry) => entry.id !== pkg.id), pkg].sort((a, b) =>
      a.id.localeCompare(b.id)
    ),
  });
  await regenerateCapabilities({ samxHome: options.samxHome });
  return pkg;
}

export async function removeLocalPackage(options: RemoveLocalPackageOptions): Promise<void> {
  validateStoreId(options.id);
  await rejectLocalPackageInUse(options.samxHome, options.id);
  if (options.force !== true) await rejectPackageLinked(options.samxHome, options.id);
  const manifest = await readLocalPackageManifest({ samxHome: options.samxHome });
  await atomicWriteJson(samxPaths(options.samxHome).localPackages, {
    packages: manifest.packages.filter((pkg) => pkg.id !== options.id),
  });
  await regenerateCapabilities({ samxHome: options.samxHome });
}

async function rejectLocalPackageInUse(samxHome: string | undefined, id: string): Promise<void> {
  const prefix = `${id}:`;
  for (const bundle of await listBundles({ samxHome })) {
    if (bundle.items.some((item) => item.id.startsWith(prefix))) {
      throw new Error(`Package is used by bundle: ${bundle.id}`);
    }
  }
}

async function rejectPackageLinked(samxHome: string | undefined, id: string): Promise<void> {
  for (const link of (await readLinkRecords({ samxHome })).links) {
    const linked =
      link.managedHooks.some((hook) => hook.packageId === id) ||
      link.adjacentHooks.some((hook) => hook.packageId === id);
    if (linked) throw new Error(`Package is linked: ${link.id}`);
  }
}

export async function listLocalPackages(
  options: { samxHome?: string } = {}
): Promise<LocalSamxPackage[]> {
  return (await readLocalPackageManifest(options)).packages.filter(
    (pkg): pkg is LocalSamxPackage => pkg.type === "local"
  );
}

async function readLocalPackageManifest(options: { samxHome?: string } = {}): Promise<PackageManifest> {
  return packageManifestSchema.parse(
    await readJsonFile(samxPaths(options.samxHome).localPackages, { packages: [] })
  );
}
