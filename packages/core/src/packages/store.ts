import type { RecipeLock, SamxPackage } from "@c3qo/samx-schemas";
import { recipeLockSchema } from "@c3qo/samx-schemas";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { samxPaths } from "../store/paths.js";
import { listLocalPackages } from "./local.js";

export interface PackageStoreOptions {
  samxHome?: string;
}

export interface PackageIdOptions extends PackageStoreOptions {
  id: string;
}

export async function listPackages(options: PackageStoreOptions = {}): Promise<SamxPackage[]> {
  return sortedPackages([
    ...(await listFormulaPackages(options)),
    ...(await listLocalPackages(options)),
  ]);
}

export async function hasPackage(options: PackageIdOptions): Promise<boolean> {
  const packages = await listPackages({ samxHome: options.samxHome });
  return packages.some((pkg) => pkg.id === options.id);
}

export async function getPackage(options: PackageIdOptions): Promise<SamxPackage> {
  requirePackageId(options.id);
  const found = (await listPackages(options)).find((pkg) => pkg.id === options.id);
  if (!found) {
    throw new Error(`Package not found: ${options.id}`);
  }
  return found;
}

async function listFormulaPackages(options: PackageStoreOptions): Promise<SamxPackage[]> {
  const paths = samxPaths(options.samxHome);
  const packages: SamxPackage[] = [];
  for (const registry of await safeReaddir(paths.packagesDir)) {
    for (const formula of await listPackageFormulaIds(paths.packageRoot(registry))) {
      const recipe = await readRecipeLock(paths.recipeLock(registry, formula));
      if (!recipe) continue;
      const source =
        recipe.source.type === "git"
          ? recipe.source.url
          : recipe.source.origin?.type === "remote"
            ? recipe.source.origin.url
            : recipe.id;
      const basePackage = {
        id: recipe.id,
        source,
        installKind: "formula" as const,
        requirements: recipe.requirements,
        advisories: recipe.advisories,
      };
      packages.push(
        recipe.source.type === "git"
          ? {
              ...basePackage,
              type: "git",
              ref: recipe.source.revision,
              path: resolve(paths.packageRoot(registry, formula), "source"),
            }
          : { ...basePackage, type: "virtual" }
      );
    }
  }
  return packages;
}

async function listPackageFormulaIds(root: string, prefix = ""): Promise<string[]> {
  const formulas: string[] = [];
  for (const entry of await safeReaddir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (await readRecipeLock(join(root, entry.name, "recipe.lock.json"))) {
        formulas.push(relativePath);
      } else {
        formulas.push(...(await listPackageFormulaIds(join(root, entry.name), relativePath)));
      }
    }
  }
  return formulas.sort((a, b) => a.localeCompare(b));
}

async function readRecipeLock(path: string): Promise<RecipeLock | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return recipeLockSchema.parse(raw);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

async function safeReaddir(path: string): Promise<string[]>;
async function safeReaddir(
  path: string,
  options: { withFileTypes: true }
): Promise<import("node:fs").Dirent[]>;
async function safeReaddir(
  path: string,
  options?: { withFileTypes: true }
): Promise<string[] | import("node:fs").Dirent[]> {
  try {
    return options ? await readdir(path, options) : await readdir(path);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}

function requirePackageId(id: string): void {
  if (id.length === 0) {
    throw new Error("Package id is required");
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sortedPackages(packages: SamxPackage[]): SamxPackage[] {
  return [...packages].sort((a, b) => a.id.localeCompare(b.id));
}
