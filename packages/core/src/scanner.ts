import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";

import fastGlob from "fast-glob";

import { loadBuiltinConfigRegistry } from "./config/loader.js";
import type { ConfigRegistry } from "./config/types.js";

type ScanScope = "project" | "home" | "all";

export interface ScanForExtensionFilesOptions {
  cwd: string;
  scope?: ScanScope;
  explicitPath?: string;
  homeDir?: string;
  registry?: ConfigRegistry;
}

export async function scanForExtensionFiles(
  options: ScanForExtensionFilesOptions
): Promise<string[]> {
  const cwd = resolve(options.cwd);
  const registry = options.registry ?? (await loadBuiltinConfigRegistry());

  if (options.explicitPath) {
    return scanExplicitPath(
      resolve(cwd, options.explicitPath),
      registry.scan.project,
      registry.scan.ignoredDirectories
    );
  }

  const scope = options.scope ?? "project";
  const homeRoot = resolve(options.homeDir ?? homedir());
  const roots =
    scope === "all"
      ? [
          { root: cwd, patterns: registry.scan.project },
          { root: homeRoot, patterns: registry.scan.home },
        ]
      : [
          scope === "home"
            ? { root: homeRoot, patterns: registry.scan.home }
            : { root: cwd, patterns: registry.scan.project },
        ];

  const files = await Promise.all(
    roots.map(({ root, patterns }) =>
      scanDirectory(root, patterns, registry.scan.ignoredDirectories)
    )
  );
  return uniqueSorted(files.flat());
}

async function scanExplicitPath(
  explicitPath: string,
  patterns: string[],
  ignoredDirectories: string[]
): Promise<string[]> {
  const pathStat = await stat(explicitPath);

  if (pathStat.isFile()) {
    return isIgnoredPath(explicitPath) ? [] : [explicitPath];
  }

  return scanDirectory(explicitPath, patterns, ignoredDirectories);
}

async function scanDirectory(
  root: string,
  patterns: string[],
  ignoredDirectories: string[]
): Promise<string[]> {
  const matches = await fastGlob(patterns, {
    absolute: true,
    cwd: root,
    dot: true,
    followSymbolicLinks: false,
    ignore: ignoredDirectories,
    onlyFiles: true,
    unique: true,
  });

  const containedMatches = await containedFiles(root, matches);
  const extensionFiles = await filterScannableFiles(containedMatches);
  return uniqueSorted(extensionFiles);
}

async function filterScannableFiles(files: string[]): Promise<string[]> {
  const scannable: string[] = [];
  for (const file of files) {
    if (basename(file) !== "package.json" || (await packageHasBin(file))) {
      scannable.push(file);
    }
  }

  return scannable;
}

async function packageHasBin(packagePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { bin?: unknown };
    return (
      typeof parsed.bin === "string" || (typeof parsed.bin === "object" && parsed.bin !== null)
    );
  } catch {
    return false;
  }
}

async function containedFiles(root: string, files: string[]): Promise<string[]> {
  const realRoot = await realpath(root);
  const contained: string[] = [];

  for (const file of files) {
    let realFile;
    try {
      realFile = await realpath(file);
    } catch {
      continue;
    }
    if (realFile === realRoot || realFile.startsWith(`${realRoot}${sep}`)) {
      contained.push(file);
    }
  }

  return contained;
}

function isIgnoredPath(filePath: string): boolean {
  const normalized = filePath.split("\\").join("/");
  return [
    "/node_modules/",
    "/.git/",
    "/.pnpm-store/",
    "/.yarn/",
    "/.cache/",
    "/dist/",
    "/build/",
    "/coverage/",
    "/.next/",
    "/out/",
    "/generated/",
  ].some((segment) => normalized.includes(segment));
}

function uniqueSorted(files: string[]): string[] {
  return [...new Set(files.map((file) => resolve(file)))].sort();
}
