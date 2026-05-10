import {
  analyzeReportSchema,
  type AnalyzeCapability,
  type AnalyzeFinding,
  type AnalyzeReport,
} from "@c3qo/samx-schemas";

export type { AnalyzeReport };

export function renderAnalyzeTerminalReport(report: AnalyzeReport): string {
  const validReport = analyzeReportSchema.parse(report);
  const lines = [
    "SAMX Analyze Report",
    `Generated: ${terminalText(validReport.generatedAt)}`,
    validReport.projectRoot ? `Project: ${terminalText(validReport.projectRoot)}` : undefined,
    "",
    "Summary",
    `Readiness: ${validReport.summary.readiness}`,
    `Packages: ${validReport.summary.packages}`,
    `Capabilities: ${validReport.summary.capabilities}`,
    `Bundles: ${validReport.summary.bundles}`,
    `Links: ${validReport.summary.links}`,
    `Findings: ${validReport.summary.findings}`,
    "",
    "Packages",
    ...(validReport.packages.length > 0
      ? validReport.packages.map(
          (pkg) =>
            `- ${terminalText(pkg.id)} (${pkg.type}${pkg.installKind ? `/${pkg.installKind}` : ""}) advisories: ${pkg.advisories}`
        )
      : ["No packages."]),
    "",
    "Capabilities",
    ...(validReport.capabilities.length > 0
      ? validReport.capabilities.map((capability) => `- ${terminalText(capabilityLabel(capability))}`)
      : ["No capabilities."]),
    "",
    "Bundles",
    ...(validReport.bundles.length > 0
      ? validReport.bundles.map(
          (bundle) =>
            `- ${terminalText(bundle.id)} items: ${bundle.items} readiness: ${bundle.readiness}${bundle.missingItems.length > 0 ? ` missing: ${bundle.missingItems.map(terminalText).join(", ")}` : ""}${bundle.warnings.length > 0 ? ` warnings: ${bundle.warnings.map(terminalText).join(", ")}` : ""}`
        )
      : ["No bundles."]),
    "",
    "Links",
    ...(validReport.links.length > 0
      ? validReport.links.map(
          (link) =>
            `- ${terminalText(link.id)} bundle: ${terminalText(link.bundleId)} tool: ${terminalText(link.tool)} project: ${terminalText(link.projectRoot)}`
        )
      : ["No links."]),
    "",
    "Top findings",
    ...(topFindings(validReport).length > 0
      ? topFindings(validReport).map(
          (finding) =>
            `- ${finding.severity}/${finding.status} ${terminalText(finding.title)}: ${terminalText(finding.message)}`
        )
      : ["No findings."]),
    "",
    "Next steps",
    ...nextSteps(validReport).map((step) => `- ${terminalText(step)}`),
  ];

  return stripTerminalControls(lines.filter((line): line is string => line !== undefined).join("\n"));
}

export function renderAnalyzeJsonReport(report: AnalyzeReport): string {
  return JSON.stringify(analyzeReportSchema.parse(report), null, 2);
}

export function renderAnalyzeMarkdownReport(report: AnalyzeReport): string {
  const validReport = analyzeReportSchema.parse(report);
  const lines = [
    "# SAMX Analyze Report",
    "",
    `Generated: ${markdownInline(validReport.generatedAt)}`,
    validReport.projectRoot ? `Project: ${markdownInline(validReport.projectRoot)}` : undefined,
    "",
    "## Summary",
    "",
    `- Readiness: ${markdownInline(validReport.summary.readiness)}`,
    `- Packages: ${validReport.summary.packages}`,
    `- Capabilities: ${validReport.summary.capabilities}`,
    `- Bundles: ${validReport.summary.bundles}`,
    `- Links: ${validReport.summary.links}`,
    `- Findings: ${validReport.summary.findings}`,
    "",
    "## Packages",
    "",
    ...(validReport.packages.length > 0
      ? validReport.packages.map(
          (pkg) =>
            `- ${markdownInline(pkg.id)} (${markdownInline(pkg.type)}${pkg.installKind ? `/${markdownInline(pkg.installKind)}` : ""}) advisories: ${pkg.advisories}`
        )
      : ["No packages."]),
    "",
    "## Capabilities",
    "",
    ...(validReport.capabilities.length > 0
      ? validReport.capabilities.map((capability) => `- ${markdownInline(capabilityLabel(capability))}`)
      : ["No capabilities."]),
    "",
    "## Bundles",
    "",
    ...(validReport.bundles.length > 0
      ? validReport.bundles.map(
          (bundle) =>
            `- ${markdownInline(bundle.id)} items: ${bundle.items} readiness: ${markdownInline(bundle.readiness)}${bundle.missingItems.length > 0 ? ` missing: ${bundle.missingItems.map(markdownInline).join(", ")}` : ""}${bundle.warnings.length > 0 ? ` warnings: ${bundle.warnings.map(markdownInline).join(", ")}` : ""}`
        )
      : ["No bundles."]),
    "",
    "## Links",
    "",
    ...(validReport.links.length > 0
      ? validReport.links.map(
          (link) =>
            `- ${markdownInline(link.id)} bundle: ${markdownInline(link.bundleId)} tool: ${markdownInline(link.tool)} project: ${markdownInline(link.projectRoot)}`
        )
      : ["No links."]),
    "",
    "## Top findings",
    "",
    ...(topFindings(validReport).length > 0
      ? topFindings(validReport).flatMap(markdownFinding)
      : ["No findings."]),
    "",
    "## Next steps",
    "",
    ...nextSteps(validReport).map((step) => `- ${markdownInline(step)}`),
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function capabilityLabel(capability: AnalyzeCapability): string {
  return [capability.id, capability.kind, capability.name].join(" ");
}

function topFindings(report: AnalyzeReport): AnalyzeFinding[] {
  return [...report.findings].sort(compareFindings).slice(0, 5);
}

function markdownFinding(finding: AnalyzeFinding): string[] {
  const lines = [
    `- **${markdownInline(finding.title)}** (${markdownInline(finding.severity)}/${markdownInline(finding.status)}, ${markdownInline(finding.category)})`,
    `  - ${markdownInline(finding.message)}`,
  ];

  if (finding.source) {
    lines.push(`  - Source: ${markdownInline(finding.source)}`);
  }

  if (finding.recommendation) {
    lines.push(`  - Recommendation: ${markdownInline(finding.recommendation)}`);
  }

  return lines;
}

function nextSteps(report: AnalyzeReport): string[] {
  const steps = unique([
    ...topFindings(report).flatMap((finding) =>
      finding.recommendation ? [finding.recommendation] : []
    ),
    ...report.recommendations,
  ]);

  return steps.length > 0 ? steps : ["No next steps required."];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function terminalText(value: string): string {
  return stripTerminalControls(value).replace(/\s+/g, " ").trim();
}

function markdownInline(value: string): string {
  return escapeMarkdownInline(escapeHtml(terminalText(value)));
}

function stripTerminalControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/[\\`*_[\]|]/g, "\\$&");
}

function compareFindings(a: AnalyzeFinding, b: AnalyzeFinding): number {
  const severity = severityRank(b.severity) - severityRank(a.severity);
  if (severity !== 0) return severity;

  const status = statusRank(b.status) - statusRank(a.status);
  if (status !== 0) return status;

  return a.title.localeCompare(b.title);
}

function severityRank(severity: AnalyzeFinding["severity"]): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[severity];
}

function statusRank(status: AnalyzeFinding["status"]): number {
  return { ok: 0, warning: 1, blocked: 2 }[status];
}
