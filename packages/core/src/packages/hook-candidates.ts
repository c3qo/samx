import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

import type { HookTarget, SamxPackage } from "@c3qo/samx-schemas";
import { fingerprintFile } from "../links/hooks.js";
import { declaredHookFiles } from "./manifest.js";

export type AdjacentHookAppliesTo = `${"skill" | "agent"}:${string}`;

export interface AdjacentHookCandidate {
  id: string;
  packageId: string;
  tool: HookTarget;
  relativeFile: string;
  file: string;
  fingerprint: string;
  appliesTo: AdjacentHookAppliesTo[];
}

export interface TopLevelOpenCodeHookCandidate {
  id: string;
  packageId: string;
  tool: "opencode";
  relativeFile: string;
  file: string;
  fingerprint: string;
}

interface AdjacentHookCandidateCollision {
  id: string;
  candidates: Array<
    Pick<
      AdjacentHookCandidate,
      "packageId" | "tool" | "relativeFile" | "file" | "appliesTo" | "fingerprint"
    >
  >;
}

interface AdjacentHookDiscoveryDiagnostic {
  reason:
    | "outside-package-root"
    | "not-regular-file"
    | "ambiguous-capability-ref"
    | "undeclared-top-level-hook";
  relativeFile: string;
  file: string;
  resolvedFile?: string;
  appliesTo?: AdjacentHookAppliesTo;
}

interface AdjacentHookDiscoveryResult {
  candidates: AdjacentHookCandidate[];
  collisions: AdjacentHookCandidateCollision[];
  diagnostics: AdjacentHookDiscoveryDiagnostic[];
}

export interface AdjacentHookCandidateFilter {
  appliesTo?: AdjacentHookAppliesTo | readonly AdjacentHookAppliesTo[];
  tool?: HookTarget;
}

interface RawAdjacentHookCandidate extends Omit<AdjacentHookCandidate, "id"> {
  defaultId: string;
  fallbackId: string;
  disambiguatedFallbackId: string;
}

interface RawAdjacentHookDiscoveryResult {
  capabilityRefs: AdjacentHookAppliesTo[];
  candidates: RawAdjacentHookCandidate[];
  diagnostics: AdjacentHookDiscoveryDiagnostic[];
}

const HOOK_FILES: Array<{ fileName: string; tool: HookTarget; idSegment: string }> = [
  { fileName: "claude.json", tool: "claude", idSegment: "claude" },
  { fileName: "opencode.js", tool: "opencode", idSegment: "opencode" },
  { fileName: "opencode.mjs", tool: "opencode", idSegment: "opencode" },
];

export async function discoverAdjacentHookCandidates(
  pkg: SamxPackage
): Promise<AdjacentHookCandidate[]> {
  return (await discoverAdjacentHookCandidateReport(pkg)).candidates;
}

export async function discoverTopLevelOpenCodeHookCandidates(
  pkg: SamxPackage
): Promise<TopLevelOpenCodeHookCandidate[]> {
  if (pkg.type === "virtual") return [];
  const packageRealPath = await realPackagePath(pkg.path);
  if (!packageRealPath) return [];
  const declaredFiles = await declaredHookFiles(pkg);
  return [
    ...(await discoverTopLevelOpenCodeHookCandidatesInRoot(
      pkg,
      packageRealPath,
      "hooks",
      declaredFiles
    )),
    ...(await discoverTopLevelOpenCodeHookCandidatesInRoot(
      pkg,
      packageRealPath,
      ".opencode/plugins",
      declaredFiles
    )),
  ].sort((left, right) => left.relativeFile.localeCompare(right.relativeFile));
}

async function discoverTopLevelOpenCodeHookCandidatesInRoot(
  pkg: Extract<SamxPackage, { path: string }>,
  packageRealPath: string,
  rootRelativePath: string,
  declaredFiles: Set<string>
): Promise<TopLevelOpenCodeHookCandidate[]> {
  const hooksRoot = join(pkg.path, rootRelativePath);
  let entries;
  try {
    entries = await readdir(hooksRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
    throw error;
  }

  const candidates: TopLevelOpenCodeHookCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".mjs")) continue;
    const relativeFile = `${rootRelativePath}/${entry.name}`;
    if (declaredFiles.has(relativeFile)) continue;
    const file = join(hooksRoot, entry.name);
    const resolvedFile = await realpath(file);
    if (!isInsideRoot(packageRealPath, resolvedFile)) continue;
    if (!(await isRegularFile(file))) continue;
    candidates.push({
      id: entry.name.replace(/\.(mjs|js)$/u, ""),
      packageId: pkg.id,
      tool: "opencode",
      relativeFile,
      file,
      fingerprint: await fingerprintFile(file),
    });
  }
  return candidates;
}

async function discoverAdjacentHookCandidateReport(
  pkg: SamxPackage
): Promise<AdjacentHookDiscoveryResult> {
  if (pkg.type === "virtual") return { candidates: [], collisions: [], diagnostics: [] };
  const packageRealPath = await realPackagePath(pkg.path);
  if (!packageRealPath) return { candidates: [], collisions: [], diagnostics: [] };
  const agentResults = await discoverAdjacentHookCandidatesForType(
    pkg,
    packageRealPath,
    "agents",
    "agent"
  );
  const skillResults = await discoverAdjacentHookCandidatesForType(
    pkg,
    packageRealPath,
    "skills",
    "skill"
  );
  const rawCandidates = [...agentResults.candidates, ...skillResults.candidates];
  const capabilityRefCounts = counts([
    ...agentResults.capabilityRefs,
    ...skillResults.capabilityRefs,
  ]);
  const ambiguousRefs = new Set(
    [...capabilityRefCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([ref]) => ref as AdjacentHookAppliesTo)
  );
  const ambiguityDiagnostics = ambiguousCapabilityDiagnostics(rawCandidates, ambiguousRefs);
  const resolvedRawCandidates = rawCandidates.filter(
    (candidate) => !ambiguousRefs.has(candidate.appliesTo[0])
  );
  const diagnostics = [
    ...agentResults.diagnostics,
    ...skillResults.diagnostics,
    ...ambiguityDiagnostics,
    ...(await undeclaredTopLevelHookDiagnostics(pkg)),
  ];

  const defaultIds = counts(resolvedRawCandidates.map((candidate) => candidate.defaultId));
  const candidates = resolvedRawCandidates.map((candidate) => ({
    candidate,
    resolved: toCandidate(
      candidate,
      defaultIds.get(candidate.defaultId) === 1 ? candidate.defaultId : candidate.fallbackId
    ),
  }));

  const finalIds = counts(candidates.map(({ resolved }) => resolved.id));
  const disambiguatedIds = counts(
    candidates.map(({ candidate, resolved }) =>
      finalIds.get(resolved.id) === 1 ? resolved.id : candidate.disambiguatedFallbackId
    )
  );
  const collisions: AdjacentHookCandidateCollision[] = [];
  const resolvedCandidates: AdjacentHookCandidate[] = [];

  for (const { candidate, resolved } of candidates) {
    if (finalIds.get(resolved.id) === 1) {
      resolvedCandidates.push(resolved);
      continue;
    }

    if (disambiguatedIds.get(candidate.disambiguatedFallbackId) === 1) {
      resolvedCandidates.push(toCandidate(candidate, candidate.disambiguatedFallbackId));
      continue;
    }

    if (!collisions.some((collision) => collision.id === resolved.id)) {
      collisions.push({
        id: resolved.id,
        candidates: candidates
          .filter((other) => other.resolved.id === resolved.id)
          .map(({ resolved: { id: _id, ...other } }) => other),
      });
    }
  }

  return {
    candidates: sortCandidates(resolvedCandidates),
    collisions: collisions.sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: diagnostics.sort((left, right) =>
      left.relativeFile.localeCompare(right.relativeFile)
    ),
  };
}

async function realPackagePath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return undefined;
    throw error;
  }
}

async function undeclaredTopLevelHookDiagnostics(
  pkg: SamxPackage
): Promise<AdjacentHookDiscoveryDiagnostic[]> {
  if (pkg.type === "virtual") return [];
  const declaredFiles = await declaredHookFiles(pkg);
  return [
    ...(await topLevelHookDiagnosticsInRoot(pkg, "hooks", declaredFiles)),
    ...(await topLevelHookDiagnosticsInRoot(pkg, ".opencode/plugins", declaredFiles)),
  ];
}

async function topLevelHookDiagnosticsInRoot(
  pkg: Extract<SamxPackage, { path: string }>,
  rootRelativePath: string,
  declaredFiles: Set<string>
): Promise<AdjacentHookDiscoveryDiagnostic[]> {
  const hooksRoot = join(pkg.path, rootRelativePath);
  let entries;
  try {
    entries = await readdir(hooksRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => ({ entry, relativeFile: `${rootRelativePath}/${entry.name}` }))
    .filter(({ relativeFile }) => !declaredFiles.has(relativeFile))
    .map(({ entry, relativeFile }) => ({
      reason: "undeclared-top-level-hook" as const,
      relativeFile,
      file: join(hooksRoot, entry.name),
    }));
}

export function filterAdjacentHookCandidates(
  candidates: AdjacentHookCandidate[],
  filter: AdjacentHookCandidateFilter
): AdjacentHookCandidate[] {
  const appliesTo =
    filter.appliesTo === undefined
      ? undefined
      : new Set(Array.isArray(filter.appliesTo) ? filter.appliesTo : [filter.appliesTo]);

  return candidates.filter((candidate) => {
    if (filter.tool && candidate.tool !== filter.tool) {
      return false;
    }
    if (appliesTo && !candidate.appliesTo.some((value) => appliesTo.has(value))) {
      return false;
    }
    return true;
  });
}

async function discoverAdjacentHookCandidatesForType(
  pkg: Extract<SamxPackage, { path: string }>,
  packageRealPath: string,
  directory: "agents" | "skills",
  type: "agent" | "skill"
): Promise<RawAdjacentHookDiscoveryResult> {
  const capabilityDirs = await capabilityDirectories(pkg.path, directory, type);
  const capabilityRefs = capabilityDirs.map(
    (capabilityDir) => `${type}:${basename(capabilityDir)}` as AdjacentHookAppliesTo
  );
  const candidates: RawAdjacentHookCandidate[] = [];
  const diagnostics: AdjacentHookDiscoveryDiagnostic[] = [];

  for (const capabilityDir of capabilityDirs) {
    const name = basename(capabilityDir);

    for (const hookFile of HOOK_FILES) {
      const relativeFile = `${capabilityDir}/hooks/${hookFile.fileName}`;
      const file = join(pkg.path, relativeFile);
      if (!(await fileExists(file))) {
        continue;
      }

      const resolvedFile = await realpath(file);
      if (!isInsideRoot(packageRealPath, resolvedFile)) {
        diagnostics.push({ reason: "outside-package-root", relativeFile, file, resolvedFile });
        continue;
      }

      if (!(await isRegularFile(file))) {
        diagnostics.push({ reason: "not-regular-file", relativeFile, file, resolvedFile });
        continue;
      }

      candidates.push({
        packageId: pkg.id,
        tool: hookFile.tool,
        relativeFile,
        file,
        fingerprint: await fingerprintFile(file),
        appliesTo: [`${type}:${name}`],
        defaultId: `${name}-${hookFile.tool}`,
        fallbackId: `${capabilityDir.replaceAll("/", "-")}-hooks-${hookFile.idSegment}`,
        disambiguatedFallbackId: `${capabilityDir.replaceAll("/", "-")}-hooks-${hookFile.idSegment}-${extensionIdSegment(hookFile.fileName)}`,
      });
    }
  }

  return { capabilityRefs, candidates, diagnostics };
}

async function capabilityDirectories(
  packageRoot: string,
  directory: "agents" | "skills",
  type: "agent" | "skill"
): Promise<string[]> {
  const root = join(packageRoot, directory);
  const fileName = type === "agent" ? "AGENT.md" : "SKILL.md";
  const directories: string[] = [];

  await collectCapabilityDirectories(root, directory, fileName, directories);
  return directories.sort();
}

async function collectCapabilityDirectories(
  path: string,
  relativePath: string,
  fileName: string,
  directories: string[]
): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      return;
    }

    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === fileName)) {
      directories.push(relativePath);
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await collectCapabilityDirectories(
          join(path, entry.name),
          `${relativePath}/${entry.name}`,
          fileName,
          directories
        );
      }
    }
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return;
    }
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

function counts(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return result;
}

function ambiguousCapabilityDiagnostics(
  candidates: RawAdjacentHookCandidate[],
  ambiguousRefs: Set<AdjacentHookAppliesTo>
): AdjacentHookDiscoveryDiagnostic[] {
  return candidates
    .filter((candidate) => ambiguousRefs.has(candidate.appliesTo[0]))
    .map((candidate) => ({
      reason: "ambiguous-capability-ref" as const,
      relativeFile: candidate.relativeFile,
      file: candidate.file,
      appliesTo: candidate.appliesTo[0],
    }));
}

function sortCandidates(candidates: AdjacentHookCandidate[]): AdjacentHookCandidate[] {
  return [...candidates].sort((left, right) => left.relativeFile.localeCompare(right.relativeFile));
}

function toCandidate(candidate: RawAdjacentHookCandidate, id: string): AdjacentHookCandidate {
  return {
    id,
    packageId: candidate.packageId,
    tool: candidate.tool,
    relativeFile: candidate.relativeFile,
    file: candidate.file,
    fingerprint: candidate.fingerprint,
    appliesTo: candidate.appliesTo,
  };
}

function isInsideRoot(root: string, file: string): boolean {
  const relativePath = relative(root, file);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function extensionIdSegment(fileName: string): string {
  return fileName.endsWith(".mjs") ? "mjs" : fileName.endsWith(".js") ? "js" : "json";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
