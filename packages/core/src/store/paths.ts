import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface SamxPaths {
  root: string;
  registriesDir: string;
  packagesDir: string;
  index: string;
  capabilities: string;
  localPackages: string;
  samxLock: string;
  bundlesDir: string;
  linkRecords: string;
  registryRoot(id: string): string;
  packageRoot(registry: string, formula?: string): string;
  recipeLock(registry: string, formula: string): string;
  recipeAuditDir(registry: string, formula: string): string;
  bundleFile(id: string): string;
}

function defaultSamxHome(): string {
  return join(homedir(), ".samx");
}

export function samxPaths(root = defaultSamxHome()): SamxPaths {
  const resolvedRoot = resolve(root);
  const registriesDir = join(resolvedRoot, "registries");
  const packagesDir = join(resolvedRoot, "packages");
  const bundlesDir = join(resolvedRoot, "bundles");
  return {
    root: resolvedRoot,
    registriesDir,
    packagesDir,
    index: join(resolvedRoot, "index.json"),
    capabilities: join(resolvedRoot, "capabilities.json"),
    localPackages: join(resolvedRoot, "local-packages.json"),
    samxLock: join(resolvedRoot, "samx.lock"),
    bundlesDir,
    linkRecords: join(resolvedRoot, "links", "project-links.json"),
    registryRoot(id: string) {
      validateStoreId(id);
      return join(registriesDir, id);
    },
    packageRoot(registry: string, formula?: string) {
      validateStoreId(registry);
      if (formula === undefined) {
        return join(packagesDir, registry);
      }
      validateStorePath(formula);
      return join(packagesDir, registry, formula);
    },
    recipeLock(registry: string, formula: string) {
      return join(this.packageRoot(registry, formula), "recipe.lock.json");
    },
    recipeAuditDir(registry: string, formula: string) {
      return join(this.packageRoot(registry, formula), "recipe-locks");
    },
    bundleFile(id: string) {
      validateStoreId(id);
      return join(bundlesDir, `${id}.yaml`);
    },
  };
}

export function validateStoreId(id: string): void {
  if (id === "" || isAbsolute(id) || id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error(`Invalid store id: ${id}`);
  }
}

function validateStorePath(id: string): void {
  if (
    id === "" ||
    isAbsolute(id) ||
    id.includes("..") ||
    id.includes("\\") ||
    id.split("/").some((part) => part === "")
  ) {
    throw new Error(`Invalid store path: ${id}`);
  }
}
