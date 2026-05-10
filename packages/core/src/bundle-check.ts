import {
  linkRecordSchema,
  type HookTarget,
  type IndexedHookAttachment,
  type LinkRecord,
} from "@c3qo/samx-schemas";

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { getBundle } from "./bundles/store.js";
import { readCapabilityIndex } from "./capabilities/index.js";
import { annotateClaudeHooks, fingerprintFile, hookExtensionAllowed } from "./links/hooks.js";
import { loadLinkTargetConfig } from "./links/targets.js";
import type {
  AdjacentHookAppliesTo,
  AdjacentHookCandidate,
  TopLevelOpenCodeHookCandidate,
} from "./packages/hook-candidates.js";
import {
  discoverAdjacentHookCandidates,
  discoverTopLevelOpenCodeHookCandidates,
  filterAdjacentHookCandidates,
} from "./packages/hook-candidates.js";
import { listPackages } from "./packages/store.js";
import { readJsonFile } from "./store/atomic.js";
import { samxPaths } from "./store/paths.js";

export interface BundleCheckOptions {
  samxHome?: string;
  bundleId: string;
  tool: string;
  projectRoot?: string;
}

interface BundleCheckEnabledHook {
  id: string;
  packageId: string;
  tool: HookTarget;
  sourcePath: string;
  fingerprint: string;
  drift: boolean;
}

export interface BundleCheckReport {
  bundleId: string;
  status: "ready" | "blocked";
  missingItems: string[];
  hookBlockers: string[];
  hooks: { required: number; optional: number };
  hookCandidates: AdjacentHookCandidate[];
  environmentReminders?: BundleCheckEnvironmentReminder[];
  inferredHooks?: BundleCheckInferredHook[];
  hookWarnings?: string[];
  enabledAdjacentHooks: BundleCheckEnabledHook[];
  warnings: string[];
}

interface BundleCheckEnvironmentReminder {
  packageId: string;
  env: string[];
}

interface BundleCheckInferredHook {
  id: string;
  packageId: string;
  relativeFile: string;
  sourcePath: string;
  appliesTo: AdjacentHookAppliesTo[];
  inference: "top-level" | "adjacent";
}

export async function runBundleCheck(options: BundleCheckOptions): Promise<BundleCheckReport> {
  const target = await loadLinkTargetConfig(options.tool);

  const bundle = await getBundle({ samxHome: options.samxHome, id: options.bundleId });
  const index = await readCapabilityIndex({ samxHome: options.samxHome });
  const capabilitiesById = new Map(
    index.capabilities.map((capability) => [capability.id, capability])
  );
  const missingItems: string[] = [];
  const hookBlockers: string[] = [];
  const hooks = { required: 0, optional: 0 };
  const bundleRefsByPackage = new Map<string, Set<AdjacentHookAppliesTo>>();
  const selectedPackages = new Set<string>();
  const warnings: string[] = [];
  const seenHooks = new Set<string>();

  for (const item of bundle.items) {
    const capability = capabilitiesById.get(item.id);
    if (!capability) {
      missingItems.push(item.id);
      continue;
    }
    if (capability.kind !== item.kind) {
      warnings.push(`Bundle item kind mismatch: ${item.id} (${item.kind} != ${capability.kind})`);
    }
    if (!target.capabilities[item.kind]) {
      warnings.push(`Unsupported bundle item kind: ${item.kind} (${item.id})`);
    }
    selectedPackages.add(capability.packageId);

    if (capability.kind !== "skill" && capability.kind !== "agent") continue;
    const packageRefs =
      bundleRefsByPackage.get(capability.packageId) ?? new Set<AdjacentHookAppliesTo>();
    packageRefs.add(`${capability.kind}:${capability.name}`);
    bundleRefsByPackage.set(capability.packageId, packageRefs);

    for (const hook of capability.hooks ?? []) {
      const dedupeKey = `${hook.packageId}:${hook.id}:${target.hooks ? hook.tool : options.tool}`;
      if (seenHooks.has(dedupeKey)) continue;
      seenHooks.add(dedupeKey);

      if (!target.hooks) {
        if (hook.required) hooks.required += 1;
        else hooks.optional += 1;
        if (hook.required)
          hookBlockers.push(`Required hook target unsupported: ${hook.id} (${options.tool})`);
        else warnings.push(`Optional hook target unsupported: ${hook.id} (${options.tool})`);
        continue;
      }

      if (hook.tool !== options.tool) continue;

      if (hook.required) hooks.required += 1;
      else hooks.optional += 1;

      if (!hookExtensionAllowed(hook.file, target.hooks.allowedExtensions)) {
        reportHookIssue(
          hook,
          `hook file extension unsupported: ${hook.id} (${hook.tool})`,
          hookBlockers,
          warnings
        );
        continue;
      }

      if (!(await isFile(hook.file))) {
        reportHookIssue(
          hook,
          `hook file missing: ${hook.id} (${hook.tool})`,
          hookBlockers,
          warnings
        );
        continue;
      }

      const claudeError =
        target.hooks.mode === "claude-settings-hooks"
          ? await claudeHooksFileError(hook.file, hook, bundle.id)
          : undefined;
      if (claudeError) {
        reportHookIssue(
          hook,
          `hook invalid: ${hook.id} (${hook.tool}): ${claudeError}`,
          hookBlockers,
          warnings
        );
      }
    }
  }

  const packages = await listPackages({ samxHome: options.samxHome });
  const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const environmentReminders = [...selectedPackages]
    .map((packageId) => ({
      packageId,
      env: [...(packagesById.get(packageId)?.requirements?.env ?? [])].sort((left, right) =>
        left.localeCompare(right)
      ),
    }))
    .filter((reminder) => reminder.env.length > 0)
    .sort((left, right) => left.packageId.localeCompare(right.packageId));
  const hookCandidates = (
    await Promise.all(
      packages.map(async (pkg) => {
        const packageRefs = bundleRefsByPackage.get(pkg.id);
        if (!packageRefs) return [];
        return filterAdjacentHookCandidates(await discoverAdjacentHookCandidates(pkg), {
          appliesTo: [...packageRefs],
          tool: options.tool as HookTarget,
        });
      })
    )
  ).flat();
  const topLevelHooks = await topLevelInferredHooks(options.samxHome, bundleRefsByPackage);
  const inferredHooks =
    options.tool === "opencode"
      ? [
          ...topLevelHooks,
          ...hookCandidates.map((candidate) => ({
            id: candidate.id,
            packageId: candidate.packageId,
            relativeFile: candidate.relativeFile,
            sourcePath: candidate.file,
            appliesTo: candidate.appliesTo,
            inference: "adjacent" as const,
          })),
        ]
      : [];
  const hookWarnings =
    options.tool === "opencode"
      ? await mcpOnlyTopLevelHookWarnings(options.samxHome, selectedPackages, bundleRefsByPackage)
      : [];
  const enabledAdjacentHooks = await enabledAdjacentHookReport(
    options,
    bundle.id,
    hookCandidates,
    warnings
  );

  return {
    bundleId: bundle.id,
    status: missingItems.length === 0 && hookBlockers.length === 0 ? "ready" : "blocked",
    missingItems,
    hookBlockers,
    hooks,
    hookCandidates,
    ...(environmentReminders.length > 0 ? { environmentReminders } : {}),
    ...(inferredHooks.length > 0 ? { inferredHooks } : {}),
    ...(hookWarnings.length > 0 ? { hookWarnings } : {}),
    enabledAdjacentHooks,
    warnings,
  };
}

async function topLevelInferredHooks(
  samxHome: string | undefined,
  bundleRefsByPackage: Map<string, Set<AdjacentHookAppliesTo>>
): Promise<BundleCheckInferredHook[]> {
  return (
    await Promise.all(
      (await listPackages({ samxHome })).map(async (pkg) => {
        const refs = [...(bundleRefsByPackage.get(pkg.id) ?? [])];
        if (refs.length === 0) return [];
        return (await discoverTopLevelOpenCodeHookCandidates(pkg)).map((hook) =>
          toTopLevelInferredHook(hook, refs)
        );
      })
    )
  ).flat();
}

async function mcpOnlyTopLevelHookWarnings(
  samxHome: string | undefined,
  selectedPackages: Set<string>,
  bundleRefsByPackage: Map<string, Set<AdjacentHookAppliesTo>>
): Promise<string[]> {
  return (
    await Promise.all(
      (await listPackages({ samxHome })).map(async (pkg) => {
        if (!selectedPackages.has(pkg.id) || (bundleRefsByPackage.get(pkg.id)?.size ?? 0) > 0)
          return [];
        return (await discoverTopLevelOpenCodeHookCandidates(pkg)).map(
          (hook) =>
            `Top-level hook skipped: ${hook.relativeFile}\n  reason: no selected skill or agent capability from package ${pkg.id}`
        );
      })
    )
  ).flat();
}

function toTopLevelInferredHook(
  hook: TopLevelOpenCodeHookCandidate,
  appliesTo: AdjacentHookAppliesTo[]
): BundleCheckInferredHook {
  return {
    id: hook.id,
    packageId: hook.packageId,
    relativeFile: hook.relativeFile,
    sourcePath: hook.file,
    appliesTo,
    inference: "top-level",
  };
}

async function enabledAdjacentHookReport(
  options: BundleCheckOptions,
  bundleId: string,
  candidates: AdjacentHookCandidate[],
  warnings: string[]
): Promise<BundleCheckEnabledHook[]> {
  if (options.tool !== "opencode" || !options.projectRoot) return [];

  const recordId = `${bundleId}:${options.tool}:${resolve(options.projectRoot)}`;
  const record = await readBundleCheckLinkRecord(options.samxHome, recordId, warnings);
  if (!record) return [];

  const legacyHooks = record.adjacentHooks.filter((hook) => hook.tool === "opencode");
  const managedHooks = record.managedHooks
    .filter((hook) => hook.tool === "opencode" && hook.kind === "symlink" && hook.sourcePath)
    .map((hook) => ({
      id: hook.id,
      packageId: hook.packageId,
      tool: hook.tool,
      sourcePath: hook.sourcePath ?? "",
      fingerprint: hook.fingerprints[0] ?? "",
    }));

  return Promise.all(
    [...legacyHooks, ...managedHooks].map(async (hook) => {
      const candidate = candidates.find(
        (item) =>
          item.packageId === hook.packageId &&
          item.id === hook.id &&
          item.tool === hook.tool &&
          item.file === hook.sourcePath
      );
      let fingerprint = hook.fingerprint;
      let drift = false;
      let driftCause: string | undefined;
      if (!candidate) {
        drift = true;
        driftCause = "candidate missing";
      }
      if (candidate) {
        try {
          fingerprint = await fingerprintFile(candidate.file);
          drift = fingerprint !== hook.fingerprint;
          if (drift) driftCause = "fingerprint changed";
        } catch {
          drift = true;
          driftCause = "source unreadable";
        }
      }
      if (drift) warnings.push(`Enabled OpenCode hook source changed: ${hook.id} (${driftCause})`);
      return {
        id: hook.id,
        packageId: hook.packageId,
        tool: hook.tool,
        sourcePath: hook.sourcePath,
        fingerprint,
        drift,
      };
    })
  );
}

async function readBundleCheckLinkRecord(
  samxHome: string | undefined,
  id: string,
  warnings: string[]
): Promise<LinkRecord | undefined> {
  try {
    const raw = await readJsonFile<{ links?: unknown[] }>(samxPaths(samxHome).linkRecords, {
      links: [],
    });
    const match = (raw.links ?? []).find((link) => isRecord(link) && link.id === id);
    return match ? linkRecordSchema.parse(match) : undefined;
  } catch (error) {
    warnings.push(
      `Could not read link records for bundle check: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

function reportHookIssue(
  hook: IndexedHookAttachment,
  message: string,
  hookBlockers: string[],
  warnings: string[]
): void {
  const prefix = hook.required ? "Required" : "Optional";
  if (hook.required) hookBlockers.push(`${prefix} ${message}`);
  else warnings.push(`${prefix} ${message}`);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function claudeHooksFileError(
  path: string,
  hook: IndexedHookAttachment,
  bundleId: string
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    annotateClaudeHooks(parsed, {
      packageId: hook.packageId,
      hookId: hook.id,
      bundleId,
      tool: "claude",
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
