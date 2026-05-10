import type { LinkPlan, LinkResult } from "@c3qo/samx-core";
import {
  addFormulaPackage,
  addLocalPackage,
  addRegistry,
  addBundleItem,
  cloneOrFetchRegistry,
  createBundle,
  ensureDefaultRegistry,
  getBundle,
  getCapability,
  getRegistry,
  linkBundle,
  listBundles,
  listCapabilities,
  listPackages,
  listRegistries,
  loadBuiltinConfigRegistry,
  previewFormulaPackageUpdate,
  parseRegistryUrl,
  readLinkRecords,
  readFormula,
  readSamxLock,
  removeFormulaPackage,
  removeBundle,
  removeBundleItem,
  removeLocalPackage,
  removeRegistry,
  runBundleCheck,
  samxPaths,
  searchFormulas,
  trustRegistry,
  updateFormulaPackage,
  validateStoreId,
  unlinkBundle,
} from "@c3qo/samx-core";
import type { FormulaPackageUpdateChange } from "@c3qo/samx-core";

import {
  resolveFormulaIdFromRegistries,
  resolveInstalledFormulaId,
  toVisibleFormulaId,
} from "../formula-ids.js";
import { renderPreviewJson } from "./format.js";

export interface TuiApiOptions {
  samxHome?: string;
  projectRoot: string;
}

export interface DashboardData {
  packages: number;
  bundles: number;
  linkedBundles: number;
  capabilities: { total: number; skill: number; agent: number; mcp: number };
}

export interface PackageRow {
  id: string;
  source: string;
  type: string;
  ref?: string;
}

export interface RegistryRow {
  id: string;
  url: string;
  trusted: boolean;
}

interface RegistryRemoveResult {
  installedPackagesRemaining: boolean;
}

export interface FormulaRow {
  id: string;
  canonicalId: string;
  name: string;
  description?: string;
}

export interface FormulaDetail extends FormulaRow {
  capabilities: Array<{ id: string; kind: string }>;
}

interface PackageUpdatePreviewRow {
  id: string;
  changes: FormulaPackageUpdateChange[];
  error?: string;
}

export interface CapabilityRow {
  id: string;
  name: string;
  kind: "skill" | "agent" | "mcp";
  packageId: string;
  path?: string;
  description?: string;
  preview?: string;
}

export interface BundleRow {
  id: string;
  itemCount: number;
}

export interface BundleDetail extends BundleRow {
  items: Array<{ id: string; kind: string; alias?: string }>;
}

interface LinkTargetRow {
  id: string;
  label: string;
}

interface BundleCheckReport {
  bundleId: string;
  status: "ready" | "blocked";
  missingItems: string[];
  hookBlockers: string[];
  hooks: { required: number; optional: number };
  hookCandidates: Array<{
    id: string;
    packageId: string;
    relativeFile: string;
    appliesTo: string[];
  }>;
  enabledAdjacentHooks: Array<{ id: string; packageId: string; drift: boolean }>;
  warnings: string[];
}

interface HookCandidateReportRow {
  id: string;
  packageId: string;
  relativeFile: string;
  appliesTo: string[];
}

export interface LinkInput {
  bundleId: string;
  tool: string;
  overwrite?: boolean;
  adjacentHooks?:
    | { mode: "unspecified" }
    | { mode: "none" }
    | { mode: "all" }
    | { mode: "selected"; ids: string[] };
  allowAdvisories?: boolean;
}

interface ManagedHookPreview {
  id: string;
  tool: string;
  required: boolean;
  appliesTo: string[];
  output: string;
  risk: string;
  drift: boolean;
}

export interface LinkPreview {
  plan: LinkPlan;
  symlinkPaths: string[];
  generatedFiles: string[];
  instructionBlockPaths: string[];
  tomlMergeEntries: string[];
  managedMcpKeys: string[];
  mcpPreview: string[];
  managedHooks: ManagedHookPreview[];
  hookDecisionRequired: boolean;
  hookCandidates: Array<{
    id: string;
    packageId: string;
    relativeFile: string;
    appliesTo: string[];
  }>;
  advisories: Array<{
    packageId: string;
    id: string;
    severity: string;
    category: string;
    message: string;
    paths: string[];
    reason?: string;
    effect?: string;
    action?: string;
  }>;
}

export interface LinkRecordRow {
  id: string;
  bundleId: string;
  tool: string;
  projectRoot: string;
  generatedFiles: string[];
  managedJsonEntries: Array<{ path: string; keyPath: string[]; key: string }>;
}

export interface TuiApi {
  getDashboard(): Promise<DashboardData>;
  listPackages(): Promise<PackageRow[]>;
  installFormulaPackage(id: string): Promise<string>;
  installLocalPackage(id: string, source: string): Promise<string>;
  previewPackageUpdates(id?: string): Promise<PackageUpdatePreviewRow[]>;
  applyPackageUpdates(id?: string): Promise<number>;
  uninstallPackage(id: string, force?: boolean): Promise<void>;
  listRegistries(): Promise<RegistryRow[]>;
  addRegistry(id: string, url: string, clone?: boolean): Promise<void>;
  syncRegistry(id?: string): Promise<number>;
  trustRegistry(id: string): Promise<void>;
  removeRegistry(id: string, force?: boolean): Promise<RegistryRemoveResult>;
  searchFormulas(query: string): Promise<FormulaRow[]>;
  getFormula(id: string): Promise<FormulaDetail>;
  listCapabilities(filter?: {
    type?: "skill" | "agent" | "mcp";
    search?: string;
  }): Promise<CapabilityRow[]>;
  listBundles(): Promise<BundleRow[]>;
  getBundle(id: string): Promise<BundleDetail>;
  createBundle(id: string): Promise<void>;
  destroyBundle(id: string): Promise<void>;
  addCapabilityToBundle(bundleId: string, capabilityId: string): Promise<void>;
  removeCapabilityFromBundle(bundleId: string, capabilityId: string): Promise<void>;
  listLinkTargets(): Promise<LinkTargetRow[]>;
  checkBundle(bundleId: string, tool: string): Promise<BundleCheckReport>;
  previewLink(input: LinkInput): Promise<LinkPreview>;
  applyLink(input: LinkInput): Promise<LinkResult>;
  listLinkRecords(): Promise<LinkRecordRow[]>;
  unlink(record: LinkRecordRow): Promise<LinkResult>;
}

export function createTuiApi(options: TuiApiOptions): TuiApi {
  const base = { samxHome: options.samxHome };

  return {
    async getDashboard() {
      const [packages, capabilities, bundles, records] = await Promise.all([
        listFormulaPackages(base.samxHome),
        listCapabilities(base),
        listBundles(base),
        readLinkRecords(base),
      ]);
      return {
        packages: packages.length,
        bundles: bundles.length,
        linkedBundles: records.links.length,
        capabilities: {
          total: capabilities.length,
          skill: capabilities.filter((capability) => capability.kind === "skill").length,
          agent: capabilities.filter((capability) => capability.kind === "agent").length,
          mcp: capabilities.filter((capability) => capability.kind === "mcp").length,
        },
      };
    },
    async listPackages() {
      return listFormulaPackages(base.samxHome);
    },
    async installFormulaPackage(id) {
      const formulaId = await resolveFormulaIdFromRegistries({ samxHome: base.samxHome, id });
      await addFormulaPackage({ samxHome: base.samxHome, id: formulaId });
      return toVisibleFormulaId(formulaId);
    },
    async installLocalPackage(id, source) {
      await addLocalPackage({ samxHome: base.samxHome, id, source });
      return id;
    },
    async previewPackageUpdates(id) {
      const lock = await readSamxLock({ samxHome: base.samxHome });
      const formulas = id
        ? [await resolveInstalledFormulaId({ samxHome: base.samxHome, id })]
        : lock.formulas.map((formula) => formula.id);
      const previews = await Promise.all(
        formulas.map((formula) => previewPackageUpdateRow(base.samxHome, lock, formula))
      );
      return previews.filter((preview) => preview.changes.length > 0 || preview.error);
    },
    async applyPackageUpdates(id) {
      const lock = await readSamxLock({ samxHome: base.samxHome });
      const formulas = id
        ? [await resolveInstalledFormulaId({ samxHome: base.samxHome, id })]
        : lock.formulas.map((formula) => formula.id);
      const previews = await Promise.all(
        formulas.map((formula) => previewPackageUpdateRow(base.samxHome, lock, formula))
      );
      const changed = previews.filter((preview) => preview.changes.length > 0 && !preview.error);
      for (const preview of changed)
        await updateFormulaPackage({ samxHome: base.samxHome, id: preview.canonicalId });
      return changed.length;
    },
    async uninstallPackage(id, force = false) {
      if (id.includes("/"))
        await removeFormulaPackage({
          samxHome: base.samxHome,
          id: await resolveInstalledFormulaId({ samxHome: base.samxHome, id }),
          force,
        });
      else await removeLocalPackage({ samxHome: base.samxHome, id, force });
    },
    async listRegistries() {
      return listRegistries({ samxHome: base.samxHome });
    },
    async addRegistry(id, url, clone = true) {
      validateStoreId(id);
      if (id === "default") throw new Error("Cannot replace built-in registry: default");
      const parsedUrl = parseRegistryUrl(url);
      if (clone) await cloneOrFetchRegistry(parsedUrl, samxPaths(base.samxHome).registryRoot(id));
      await addRegistry({ samxHome: base.samxHome, id, url: parsedUrl });
    },
    async syncRegistry(id) {
      if (!id) await ensureDefaultRegistry({ samxHome: base.samxHome });
      const registries = id
        ? [await getRegistry({ samxHome: base.samxHome, id })]
        : await listRegistries({ samxHome: base.samxHome });
      for (const registry of registries)
        await cloneOrFetchRegistry(
          registry.url,
          samxPaths(base.samxHome).registryRoot(registry.id)
        );
      return registries.length;
    },
    async trustRegistry(id) {
      await trustRegistry({ samxHome: base.samxHome, id });
    },
    async removeRegistry(id, force = false) {
      return removeRegistry({ samxHome: base.samxHome, id, force });
    },
    async searchFormulas(query) {
      const formulas = await searchFormulas({ samxHome: base.samxHome, query });
      return formulas.map((formula) => ({
        ...formula,
        id: toVisibleFormulaId(formula.id),
        canonicalId: formula.id,
      }));
    },
    async getFormula(id) {
      const formulaId = await resolveFormulaIdFromRegistries({ samxHome: base.samxHome, id });
      const formula = await readFormula({ samxHome: base.samxHome, id: formulaId });
      return {
        id: toVisibleFormulaId(formulaId),
        canonicalId: formulaId,
        name: formula.name,
        description: formula.description,
        capabilities: formula.capabilities.map((capability) => ({
          id: capability.id,
          kind: capability.kind,
        })),
      };
    },
    async listCapabilities(filter = {}) {
      const capabilities = await listCapabilities({
        ...base,
        ...(filter.type ? { type: filter.type } : {}),
      });
      const search = filter.search?.toLowerCase().trim();
      return capabilities
        .filter(
          (capability) =>
            !search ||
            capability.id.toLowerCase().includes(search) ||
            capability.name.toLowerCase().includes(search)
        )
        .map((capability) => ({
          id: capability.id,
          name: capability.name,
          kind: capability.kind,
          packageId: capability.packageId,
          path: capability.path,
          description: capability.description,
          preview:
            capability.kind === "mcp"
              ? renderPreviewJson({ [capability.serverName]: capability.config }, 600)
              : undefined,
        }));
    },
    async listBundles() {
      return (await listBundles(base)).map((bundle) => ({
        id: bundle.id,
        itemCount: bundle.items.length,
      }));
    },
    async getBundle(id) {
      const bundle = await getBundle({ ...base, id });
      return { id: bundle.id, itemCount: bundle.items.length, items: bundle.items };
    },
    async createBundle(id) {
      await createBundle({ ...base, id });
    },
    async destroyBundle(id) {
      await removeBundle({ ...base, id });
    },
    async addCapabilityToBundle(bundleId, capabilityId) {
      const capability = await getCapability({ ...base, id: capabilityId });
      await addBundleItem({ ...base, bundleId, itemId: capabilityId, kind: capability.kind });
    },
    async removeCapabilityFromBundle(bundleId, capabilityId) {
      await removeBundleItem({ ...base, bundleId, itemId: capabilityId });
    },
    async listLinkTargets() {
      const registry = await loadBuiltinConfigRegistry();
      return Object.entries(registry.linkTargets)
        .map(([id, config]) => ({ id, label: config.displayName ?? id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    async checkBundle(bundleId, tool) {
      const report = await runBundleCheck({
        ...base,
        bundleId,
        tool,
        projectRoot: options.projectRoot,
      });
      const hookCandidates =
        (report as typeof report & { hookCandidates?: HookCandidateReportRow[] }).hookCandidates ??
        [];
      return {
        ...report,
        hookCandidates: hookCandidates.map((candidate) => ({
          id: candidate.id,
          packageId: candidate.packageId,
          relativeFile: candidate.relativeFile,
          appliesTo: candidate.appliesTo,
        })),
        enabledAdjacentHooks: report.enabledAdjacentHooks.map((hook) => ({
          id: hook.id,
          packageId: hook.packageId,
          drift: hook.drift,
        })),
      };
    },
    async previewLink(input) {
      const result = await linkBundle({
        ...base,
        bundleId: input.bundleId,
        tool: input.tool,
        projectRoot: options.projectRoot,
        dryRun: true,
        overwrite: input.overwrite,
        adjacentHooks: input.adjacentHooks ?? { mode: "unspecified" },
      });
      return previewFromPlan(result.plan);
    },
    async applyLink(input) {
      return linkBundle({
        ...base,
        bundleId: input.bundleId,
        tool: input.tool,
        projectRoot: options.projectRoot,
        overwrite: input.overwrite,
        adjacentHooks: input.adjacentHooks ?? { mode: "unspecified" },
        allowAdvisories: input.allowAdvisories === true,
      });
    },
    async listLinkRecords() {
      const records = await readLinkRecords(base);
      return records.links.map((record) => ({
        id: record.id,
        bundleId: record.bundleId,
        tool: record.tool,
        projectRoot: record.projectRoot,
        generatedFiles: record.generatedFiles,
        managedJsonEntries: record.managedJsonEntries,
      }));
    },
    async unlink(record) {
      return unlinkBundle({
        ...base,
        bundleId: record.bundleId,
        tool: record.tool,
        projectRoot: record.projectRoot,
      });
    },
  };
}

async function listFormulaPackages(samxHome: string | undefined): Promise<PackageRow[]> {
  const packages = await listPackages({ samxHome });
  return packages.map((pkg) => ({
    id: pkg.installKind === "formula" ? toVisibleFormulaId(pkg.id) : pkg.id,
    source: pkg.source,
    type: pkg.type,
    ...(pkg.type === "git" ? { ref: pkg.ref } : {}),
  }));
}

function previewFromPlan(plan: LinkPlan): LinkPreview {
  return {
    plan,
    symlinkPaths: plan.symlinks.map((link) => link.path),
    generatedFiles: plan.generatedFiles,
    instructionBlockPaths: plan.instructionBlocks.map((block) => block.path),
    tomlMergeEntries: plan.tomlMerges.flatMap((merge) =>
      merge.entries.map((entry) => `${merge.path} ${merge.tablePath.join(".")}.${entry.key}`)
    ),
    managedMcpKeys: plan.jsonMerges.flatMap((merge) =>
      merge.entries.map((entry) => `${merge.path} ${merge.keyPath.join(".")}.${entry.key}`)
    ),
    mcpPreview: plan.jsonMerges.flatMap((merge) =>
      merge.entries.map((entry) => `${entry.key}\n${renderPreviewJson(entry.value, 600)}`)
    ),
    managedHooks: plan.hooks.map((hook) => ({
      id: hook.id,
      tool: hook.tool,
      required: hook.required,
      appliesTo: hook.appliesTo,
      output: hook.settingsPath ?? hook.outputPath ?? "<managed by SAMX>",
      risk: "executable behavior",
      drift:
        Array.isArray((hook as { drift?: unknown }).drift) &&
        ((hook as { drift?: unknown[] }).drift?.length ?? 0) > 0,
    })),
    hookDecisionRequired: plan.hookDecisionRequired,
    hookCandidates: plan.hookCandidates.map((candidate) => ({
      id: candidate.id,
      packageId: candidate.packageId,
      relativeFile: candidate.relativeFile,
      appliesTo: candidate.appliesTo,
    })),
    advisories: plan.advisories,
  };
}

async function previewPackageUpdateRow(
  samxHome: string | undefined,
  lock: Awaited<ReturnType<typeof readSamxLock>>,
  formula: string
): Promise<PackageUpdatePreviewRow & { canonicalId: string }> {
  try {
    const registry = formula.split("/")[0];
    const preview = await previewFormulaPackageUpdate({
      samxHome,
      id: formula,
      registryCommit: registry ? lock.registries[registry]?.commit : undefined,
    });
    return {
      id: toVisibleFormulaId(preview.id),
      canonicalId: preview.id,
      changes: preview.changes,
    };
  } catch (error) {
    return {
      id: toVisibleFormulaId(formula),
      canonicalId: formula,
      changes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
