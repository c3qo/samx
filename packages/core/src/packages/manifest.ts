import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative } from "node:path";

import type {
  HookTarget,
  IndexedCapability,
  IndexedHookAttachment,
  SamxPackage,
  SamxPackageManifest,
} from "@c3qo/samx-schemas";
import { samxPackageManifestSchema } from "@c3qo/samx-schemas";
import { annotateClaudeHooks, hookExtensionAllowed } from "../links/hooks.js";

export async function attachPackageHooks(
  pkg: SamxPackage,
  capabilities: IndexedCapability[]
): Promise<IndexedCapability[]> {
  detectDuplicateCapabilityIds(pkg, capabilities);
  if (pkg.type === "virtual") return capabilities;

  const manifest = await readPackageManifest(pkg);
  if (!manifest || manifest.hooks.length === 0) {
    return capabilities;
  }

  const refs = capabilityRefs(capabilities);
  const hooksByCapability = new Map<string, IndexedHookAttachment[]>();

  for (const hook of manifest.hooks) {
    assertNoDuplicates(hook.appliesTo, `Duplicate hook appliesTo entry for ${hook.id}`);

    for (const ref of hook.appliesTo) {
      if (!refs.has(ref)) {
        throw new Error(`Hook ${hook.id} applies to unknown capability: ${ref}`);
      }
    }

    for (const file of hook.files) {
      const target = file.target;
      const relativeFile = normalizeManifestPath(file.path);

      const absoluteFile = join(pkg.path, relativeFile);
      await validateHookFile(pkg.path, hook.id, target, relativeFile, absoluteFile);

      for (const ref of hook.appliesTo) {
        const capabilityId = refs.get(ref);
        if (!capabilityId) {
          continue;
        }

        hooksByCapability.set(capabilityId, [
          ...(hooksByCapability.get(capabilityId) ?? []),
          {
            id: hook.id,
            packageId: pkg.id,
            description: hook.description,
            tool: target,
            file: absoluteFile,
            required: hook.required,
            appliesTo: hook.appliesTo,
          },
        ]);
      }
    }
  }

  return capabilities.map((capability) => {
    if (capability.kind !== "skill" && capability.kind !== "agent") {
      return capability;
    }

    return { ...capability, hooks: hooksByCapability.get(capability.id) ?? capability.hooks ?? [] };
  });
}

export async function declaredHookFiles(pkg: SamxPackage): Promise<Set<string>> {
  if (pkg.type === "virtual") return new Set();
  const manifest = await readPackageManifest(pkg);
  const files = new Set<string>();
  for (const hook of manifest?.hooks ?? []) {
    for (const file of hook.files) {
      files.add(normalizeManifestPath(file.path));
    }
  }
  return files;
}

function normalizeManifestPath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  return normalized === "." ? "" : normalized.replace(/^\.\//u, "");
}

function detectDuplicateCapabilityIds(pkg: SamxPackage, capabilities: IndexedCapability[]): void {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (seen.has(capability.id)) {
      throw new Error(`Duplicate capability id in package ${pkg.id}: ${capability.id}`);
    }
    seen.add(capability.id);
  }
}

async function readPackageManifest(pkg: SamxPackage): Promise<SamxPackageManifest | undefined> {
  if (pkg.type === "virtual") return undefined;
  const path = join(pkg.path, "samx.package.json");
  try {
    const raw = await readFile(path, "utf8");
    return samxPackageManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse samx.package.json: ${detail}`);
  }
}

function capabilityRefs(capabilities: IndexedCapability[]): Map<string, string> {
  const refs = new Map<string, string>();
  for (const capability of capabilities) {
    if (capability.kind === "skill" || capability.kind === "agent") {
      const ref = `${capability.kind}:${capability.name}`;
      if (refs.has(ref)) {
        throw new Error(`Hook appliesTo reference is ambiguous: ${ref}`);
      }
      refs.set(ref, capability.id);
    }
  }
  return refs;
}

async function validateHookFile(
  packageRoot: string,
  id: string,
  target: HookTarget,
  relativeFile: string,
  absoluteFile: string
): Promise<void> {
  const stats = await hookFileStats(id, target, relativeFile, absoluteFile);
  await assertInsidePackageRoot(packageRoot, id, target, absoluteFile, relativeFile);

  if (target === "opencode" && !stats.isFile()) {
    throw new Error(`OpenCode hook file must be a regular file: ${relativeFile}`);
  }

  if (target === "opencode" && !hookExtensionAllowed(relativeFile, [".js", ".mjs"])) {
    throw new Error(`OpenCode hook file must be .js or .mjs: ${relativeFile}`);
  }

  if (target === "claude") {
    const parsed = JSON.parse(await readFile(absoluteFile, "utf8")) as unknown;
    annotateClaudeHooks(parsed, {
      packageId: "package-sync",
      hookId: id,
      bundleId: "package-sync",
      tool: "claude",
    });
  }
}

async function hookFileStats(
  id: string,
  target: HookTarget,
  relativeFile: string,
  absoluteFile: string
): Promise<Awaited<ReturnType<typeof stat>>> {
  try {
    return await stat(absoluteFile);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new Error(`Hook file not found for ${id} target ${target}: ${relativeFile}`);
    }
    throw error;
  }
}

async function assertInsidePackageRoot(
  packageRoot: string,
  id: string,
  target: HookTarget,
  absoluteFile: string,
  relativeFile: string
): Promise<void> {
  const packageRealPath = await realpath(packageRoot);
  const fileRealPath = await realpath(absoluteFile);
  const relativePath = relative(packageRealPath, fileRealPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(
      `Hook ${id} target ${target} path must stay inside package root: ${relativeFile}`
    );
  }
}

function assertNoDuplicates<T>(values: T[], message: string): void {
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${message}: ${String(value)}`);
    }
    seen.add(value);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
