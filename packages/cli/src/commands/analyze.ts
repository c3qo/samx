import { resolve } from "node:path";

import {
  renderAnalyzeJsonReport,
  renderAnalyzeMarkdownReport,
  renderAnalyzeTerminalReport,
  runAnalyze,
} from "@c3qo/samx-core";

import type { CliContext, SamxCli } from "../index.js";

interface AnalyzeOptions {
  json?: boolean;
  format?: string;
  paths?: boolean;
  inventory?: boolean;
  show?: string;
}

export function registerAnalyzeCommand(cli: SamxCli, context: CliContext): void {
  cli
    .command("analyze [projectRoot]", "Analyze SAMX-managed packages, capabilities, bundles, and links")
    .option("--json", "Render JSON output")
    .option("--format <format>", "Render output format")
    .option("--paths", "Print SAMX-managed package, capability, and link paths only")
    .option("--inventory", "Print SAMX-managed inventory only")
    .option("--show <item-id>", "Show one package, capability, bundle, or link as JSON")
    .action((projectRoot: string | undefined, options: AnalyzeOptions) => {
      context.setAction(handleAnalyze(context, projectRoot, options));
    });
}

async function handleAnalyze(
  context: CliContext,
  explicitProjectRoot: string | undefined,
  options: AnalyzeOptions
): Promise<void> {
  validateAnalyzeOptions(options);
  const projectRoot = explicitProjectRoot ? resolve(context.cwd, explicitProjectRoot) : undefined;
  const report = await runAnalyze({ samxHome: context.samxHome, projectRoot });

  if (options.paths) {
    context.writeOut(`${analyzePaths(report).join("\n")}\n`);
    return;
  }

  if (options.inventory) {
    context.writeOut(`${analyzeInventory(report).join("\n")}\n`);
    return;
  }

  if (options.show) {
    const item = findAnalyzeItem(report, options.show);
    if (!item) {
      throw new Error(`Analyze item not found: ${options.show}`);
    }
    context.writeOut(`${JSON.stringify(item, null, 2)}\n`);
    return;
  }

  context.writeOut(`${renderAnalyzeReport(report, options)}\n`);
}

function validateAnalyzeOptions(options: AnalyzeOptions): void {
  if (options.format !== undefined && options.format !== "json" && options.format !== "markdown") {
    throw new Error(`Unsupported analyze format: ${options.format}`);
  }
}

function renderAnalyzeReport(
  report: Parameters<typeof renderAnalyzeTerminalReport>[0],
  options: AnalyzeOptions
): string {
  if (options.json || options.format === "json") {
    return renderAnalyzeJsonReport(report);
  }
  if (options.format === "markdown") {
    return renderAnalyzeMarkdownReport(report);
  }
  return renderAnalyzeTerminalReport(report);
}

function analyzePaths(report: Parameters<typeof renderAnalyzeTerminalReport>[0]): string[] {
  return sortedUnique([
    ...report.packages.flatMap((pkg) => ("path" in pkg && pkg.path ? [pkg.path] : [])),
    ...report.capabilities.flatMap((capability) => (capability.path ? [capability.path] : [])),
    ...report.links.flatMap((link) => link.outputs),
  ]);
}

function analyzeInventory(report: Parameters<typeof renderAnalyzeTerminalReport>[0]): string[] {
  return [
    ...report.packages.map((pkg) => `package\t${pkg.id}\t${pkg.type}`),
    ...report.capabilities.map((capability) => `capability\t${capability.id}\t${capability.kind}`),
    ...report.bundles.map((bundle) => `bundle\t${bundle.id}\t${bundle.readiness}`),
    ...report.links.map((link) => `link\t${link.id}\t${link.tool}`),
  ];
}

function findAnalyzeItem(
  report: Parameters<typeof renderAnalyzeTerminalReport>[0],
  id: string
): unknown {
  return (
    report.packages.find((item) => item.id === id) ??
    report.capabilities.find((item) => item.id === id) ??
    report.bundles.find((item) => item.id === id) ??
    report.links.find((item) => item.id === id) ??
    report.findings.find((item) => item.id === id)
  );
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
