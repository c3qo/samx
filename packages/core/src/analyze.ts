import type {
  AnalyzeBundle,
  AnalyzeCapability,
  AnalyzeFinding,
  AnalyzeLink,
  AnalyzePackage,
  AnalyzeReadiness,
  AnalyzeReport,
  IndexedCapability,
  LinkRecord,
  SamxBundle,
  SamxPackage,
} from "@c3qo/samx-schemas";
import { analyzeReportSchema } from "@c3qo/samx-schemas";
import { resolve } from "node:path";

import { runBundleCheck } from "./bundle-check.js";
import { listBundles } from "./bundles/store.js";
import { listCapabilities } from "./capabilities/index.js";
import { readLinkRecords } from "./links/records.js";
import { listPackages } from "./packages/store.js";

export interface RunAnalyzeOptions {
  samxHome?: string;
  projectRoot?: string;
}

export async function runAnalyze(options: RunAnalyzeOptions = {}): Promise<AnalyzeReport> {
  const [packages, capabilities, bundles, linkRecords] = await Promise.all([
    listPackages({ samxHome: options.samxHome }),
    listCapabilities({ samxHome: options.samxHome }),
    listBundles({ samxHome: options.samxHome }),
    readLinkRecords({ samxHome: options.samxHome }),
  ]);
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : undefined;
  const links = projectRoot
    ? linkRecords.links.filter((link) => resolve(link.projectRoot) === projectRoot)
    : linkRecords.links;
  const analyzedBundleIds = projectRoot ? new Set(links.map((link) => link.bundleId)) : undefined;
  const analyzedBundles = analyzedBundleIds
    ? bundles.filter((bundle) => analyzedBundleIds.has(bundle.id))
    : bundles;
  const findings: AnalyzeFinding[] = [];
  const capabilitiesById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const bundleMissing = new Map<string, string[]>();
  const bundleWarnings = new Map<string, string[]>();
  const bundleBlocked = new Set<string>();

  for (const pkg of packages) {
    pkg.advisories.forEach((advisory, index) => {
      findings.push({
        id: `package:${pkg.id}:advisory:${index}`,
        severity: "medium",
        status: "warning",
        category: "advisory",
        title: advisory.id,
        message: advisory.message,
        source: pkg.id,
        confidence: "high",
        recommendation: "Review package advisories before linking.",
      });
    });
  }

  if (
    packages.length === 0 &&
    capabilities.length === 0 &&
    analyzedBundles.length === 0 &&
    links.length === 0
  ) {
    findings.push({
      id: "inventory:empty",
      severity: "info",
      status: "warning",
      category: "unknown",
      title: "SAMX inventory is empty",
      message: "No packages, capabilities, bundles, or links are installed.",
      confidence: "low",
      recommendation: "Install a package or create a bundle before linking capabilities.",
    });
  }

  for (const bundle of analyzedBundles) {
    const missing = sortedUnique(
      bundle.items.map((item) => item.id).filter((itemId) => !capabilitiesById.has(itemId))
    );
    bundleMissing.set(bundle.id, missing);
    if (missing.length > 0) bundleBlocked.add(bundle.id);
    for (const itemId of missing) {
      findings.push({
        id: `bundle:${bundle.id}:missing:${itemId}`,
        severity: "high",
        status: "blocked",
        category: "bundle",
        title: "Bundle item is missing",
        message: `Bundle ${bundle.id} references missing capability ${itemId}.`,
        source: bundle.id,
        confidence: "high",
        recommendation: "Remove the missing item or reinstall the package that provides it.",
      });
    }
  }

  for (const link of links) {
    try {
      const check = await runBundleCheck({
        samxHome: options.samxHome,
        bundleId: link.bundleId,
        tool: link.tool,
        projectRoot: link.projectRoot,
      });
      const warnings = [...check.warnings, ...(check.hookWarnings ?? [])];
      if (warnings.length > 0) {
        bundleWarnings.set(link.bundleId, [
          ...(bundleWarnings.get(link.bundleId) ?? []),
          ...warnings,
        ]);
      }
      warnings.forEach((warning, index) => {
        findings.push({
          id: `link:${link.id}:warning:${index}`,
          severity: "medium",
          status: "warning",
          category: "link",
          title: "Link warning",
          message: warning,
          source: link.id,
          confidence: "high",
        });
      });
      check.hookBlockers.forEach((blocker, index) => {
        bundleBlocked.add(link.bundleId);
        findings.push({
          id: `link:${link.id}:hook-blocker:${index}`,
          severity: "high",
          status: "blocked",
          category: "link",
          title: "Link hook blocker",
          message: blocker,
          source: link.id,
          confidence: "high",
        });
      });
    } catch (error) {
      const message = errorMessage(error);
      bundleBlocked.add(link.bundleId);
      findings.push({
        id: `link:${link.id}:check-error`,
        severity: "high",
        status: "blocked",
        category: "link",
        title: "Link readiness check failed",
        message,
        source: link.id,
        confidence: "high",
      });
    }
  }

  const mappedPackages = packages.map(mapPackage);
  const mappedCapabilities = capabilities.map(mapCapability);
  const mappedBundles = analyzedBundles.map((bundle) =>
    mapBundle(bundle, bundleMissing.get(bundle.id) ?? [], bundleWarnings.get(bundle.id) ?? [], bundleBlocked)
  );
  const mappedLinks = links.map(mapLink).sort((left, right) => left.id.localeCompare(right.id));
  const readiness = reportReadiness(findings);
  const report = {
    generatedAt: new Date().toISOString(),
    ...(projectRoot ? { projectRoot } : {}),
    summary: {
      packages: mappedPackages.length,
      capabilities: mappedCapabilities.length,
      bundles: mappedBundles.length,
      links: mappedLinks.length,
      findings: findings.length,
      readiness,
    },
    packages: mappedPackages,
    capabilities: mappedCapabilities,
    bundles: mappedBundles,
    links: mappedLinks,
    findings: findings.sort((left, right) => left.id.localeCompare(right.id)),
    recommendations: recommendationsFor(findings),
  };
  return analyzeReportSchema.parse(report);
}

function mapPackage(pkg: SamxPackage): AnalyzePackage {
  return {
    id: pkg.id,
    type: pkg.type,
    ...(pkg.installKind ? { installKind: pkg.installKind } : {}),
    source: pkg.source,
    ...("path" in pkg ? { path: pkg.path } : {}),
    ...(pkg.ref ? { ref: pkg.ref } : {}),
    advisories: pkg.advisories.length,
  };
}

function mapCapability(capability: IndexedCapability): AnalyzeCapability {
  return {
    id: capability.id,
    packageId: capability.packageId,
    kind: capability.kind,
    name: capability.name,
    ...(capability.path ? { path: capability.path } : {}),
    ...(capability.kind === "mcp" ? { serverName: capability.serverName } : {}),
    ...(capability.kind === "mcp" && capability.transport ? { transport: capability.transport } : {}),
  };
}

function mapBundle(
  bundle: SamxBundle,
  missingItems: string[],
  warnings: string[],
  blockedBundles: Set<string>
): AnalyzeBundle {
  return {
    id: bundle.id,
    items: bundle.items.length,
    readiness: blockedBundles.has(bundle.id) ? "blocked" : warnings.length > 0 ? "needs_review" : "ready",
    missingItems,
    warnings: sortedUnique(warnings),
  };
}

function mapLink(link: LinkRecord): AnalyzeLink {
  return {
    id: link.id,
    bundleId: link.bundleId,
    tool: link.tool,
    projectRoot: link.projectRoot,
    outputs: sortedUnique([
      ...link.generatedFiles,
      ...link.managedJsonEntries.map((entry) => entry.path),
      ...(link.managedTomlEntries ?? []).map((entry) => entry.path),
      ...(link.managedInstructionBlocks ?? []).map((entry) => entry.path),
      ...link.managedHooks.flatMap((hook) => hook.outputs),
    ]),
  };
}

function reportReadiness(findings: AnalyzeFinding[]): AnalyzeReadiness {
  if (findings.some((finding) => finding.status === "blocked")) return "blocked";
  if (findings.some((finding) => finding.confidence === "low")) return "unknown";
  if (findings.some((finding) => finding.status === "warning")) return "needs_review";
  return "ready";
}

function recommendationsFor(findings: AnalyzeFinding[]): string[] {
  const recommendations: string[] = [];
  if (findings.some((finding) => finding.status === "blocked")) {
    recommendations.push("Resolve blocked bundle or link issues before applying links.");
  }
  if (findings.some((finding) => finding.category === "advisory")) {
    recommendations.push("Review package advisories before linking.");
  }
  if (findings.some((finding) => finding.status === "warning")) {
    recommendations.push("Review warnings before relying on linked capabilities.");
  }
  return recommendations.length > 0 ? sortedUnique(recommendations) : ["No blocking issues detected."];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
