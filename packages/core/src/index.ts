/**
 * Public API for the `samx` CLI package.
 *
 * `@c3qo/samx-core` is an internal workspace package. Keep this root module as the
 * documented CLI-facing facade; implementation modules may export additional
 * helpers for core's own tests and internals, but they are intentionally not
 * re-exported here.
 */

/** Analyze SAMX-managed package, capability, bundle, and link state. */
export { runAnalyze } from "./analyze.js";
export {
  renderAnalyzeJsonReport,
  renderAnalyzeMarkdownReport,
  renderAnalyzeTerminalReport,
} from "./reports.js";
export { scanForExtensionFiles } from "./scanner.js";
export { ingestAgentScanFindings } from "./security/agent-scan.js";
export type { ProbeRunner } from "./probes.js";

/** Registry and formula operations used by CLI commands and the TUI facade. */
export { loadBuiltinConfigRegistry } from "./config/loader.js";
export { readFormula, searchFormulas } from "./formulas/read.js";
export { validateFormulaFiles } from "./formulas/validate.js";
export { generateFormulaDraft } from "./formulas/generate.js";
export {
  discoverMcpServersFromWeb,
  readMcpDiscoveryDocument,
  writeMcpDiscoveryFormulas,
} from "./formulas/mcp-list.js";
export {
  addRegistry,
  ensureDefaultRegistry,
  getRegistry,
  listRegistries,
  parseRegistryUrl,
  removeRegistry,
  trustRegistry,
} from "./registries/store.js";
export { cloneOrFetchRegistry } from "./registries/git.js";

/** Installed package and capability operations. */
export {
  addFormulaPackage,
  previewFormulaPackageUpdate,
  removeFormulaPackage,
  updateFormulaPackage,
} from "./packages/install.js";
export type { FormulaPackageUpdateChange } from "./packages/install.js";
export { addLocalPackage, removeLocalPackage } from "./packages/local.js";
export { hasPackage, listPackages } from "./packages/store.js";
export { getCapability, listCapabilities, readCapabilityIndex } from "./capabilities/index.js";

/** Bundle composition, readiness checks, and link application. */
export {
  addBundleItem,
  createBundle,
  getBundle,
  listBundles,
  removeBundle,
  removeBundleItem,
  resolveBundleItem,
} from "./bundles/store.js";
export { runBundleCheck } from "./bundle-check.js";
export { linkBundle, unlinkBundle } from "./links/link.js";
export { planBundleLink } from "./links/planner.js";
export type { AdjacentHookDecision } from "./links/planner.js";
export { readLinkRecords } from "./links/records.js";
export type { LinkPlan, LinkResult } from "./linkers/types.js";
export type { AdjacentHookCandidate } from "./packages/hook-candidates.js";

/** Store paths, project lock metadata, and write helper needed by CLI flows. */
export { readSamxLock } from "./locks/workspace.js";
export { atomicWriteJson, atomicWriteText } from "./store/atomic.js";
export { samxPaths, validateStoreId } from "./store/paths.js";
