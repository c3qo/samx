import type { Evidence, Finding } from "@c3qo/samx-schemas";
import { readFile, stat } from "node:fs/promises";

const DEFAULT_MAX_REPORT_BYTES = 1024 * 1024;
const DEFAULT_MAX_FINDINGS = 5000;
const DEFAULT_MAX_DEPTH = 32;

export interface AgentScanIngestOptions {
  maxReportBytes?: number;
  maxFindings?: number;
  maxDepth?: number;
}

export class AgentScanReportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentScanReportError";
  }
}

export async function ingestAgentScanFindings(
  report: string | unknown,
  options: AgentScanIngestOptions = {}
): Promise<Finding[]> {
  const limits = normalizeOptions(options);
  const parsedReport = typeof report === "string" ? await readReportFile(report, limits) : report;
  if (exceedsDepth(parsedReport, limits.maxDepth)) {
    throw new AgentScanReportError(
      `Agent Scan report exceeds maximum JSON depth of ${limits.maxDepth}`
    );
  }

  const externalFindings = extractExternalFindings(parsedReport).filter(isRecord);
  if (externalFindings.length > limits.maxFindings) {
    throw new AgentScanReportError(
      `Agent Scan report contains more than ${limits.maxFindings} findings`
    );
  }

  return externalFindings.map(toSamxFinding);
}

async function readReportFile(
  reportPath: string,
  limits: Required<AgentScanIngestOptions>
): Promise<unknown> {
  try {
    const reportStat = await stat(reportPath);
    if (reportStat.size > limits.maxReportBytes) {
      throw new AgentScanReportError(
        `Agent Scan report exceeds maximum size of ${limits.maxReportBytes} bytes: ${reportPath}`
      );
    }
  } catch (error) {
    if (error instanceof AgentScanReportError) {
      throw error;
    }
    throw new AgentScanReportError(`Could not read Agent Scan report: ${reportPath}`, {
      cause: error,
    });
  }

  let content: string;
  try {
    content = await readFile(reportPath, "utf8");
  } catch (error) {
    throw new AgentScanReportError(`Could not read Agent Scan report: ${reportPath}`, {
      cause: error,
    });
  }

  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new AgentScanReportError(`Could not parse Agent Scan report as JSON: ${reportPath}`, {
      cause: error,
    });
  }
}

function extractExternalFindings(report: unknown): unknown[] {
  if (Array.isArray(report)) {
    return report;
  }

  if (!isRecord(report)) {
    return [];
  }

  if (Array.isArray(report.findings)) {
    return report.findings;
  }

  if (Array.isArray(report.results)) {
    return report.results;
  }

  return [];
}

function toSamxFinding(finding: Record<string, unknown>, index: number): Finding {
  const severityResult = mapSeverity(readString(finding.severity));
  const confidence = severityResult.confidence ?? mapConfidence(readString(finding.confidence));
  const title =
    readFirstString(finding.title, finding.name, finding.message, finding.ruleId) ??
    "Agent Scan finding";
  const message =
    readFirstString(finding.message, finding.description, finding.title, finding.name) ?? title;
  const evidence = buildEvidence(finding, confidence);

  return {
    id: `agent-scan:${readFirstString(finding.id, finding.ruleId, finding.rule, finding.checkId) ?? index + 1}`,
    severity: severityResult.severity,
    status: statusForSeverity(severityResult.severity),
    category: "security-scanner",
    title,
    message,
    source: "agent-scan",
    confidence,
    ...(readString(finding.extensionId) ? { extensionId: readString(finding.extensionId) } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(readString(finding.recommendation)
      ? { recommendation: readString(finding.recommendation) }
      : {}),
  };
}

function mapSeverity(severity: string | undefined): {
  severity: Finding["severity"];
  confidence?: Finding["confidence"];
} {
  switch (severity?.toLowerCase()) {
    case "critical":
      return { severity: "critical" };
    case "high":
      return { severity: "high" };
    case "medium":
    case "moderate":
      return { severity: "medium" };
    case "low":
      return { severity: "low" };
    case "info":
    case "informational":
      return { severity: "info" };
    default:
      return { severity: "medium", confidence: "low" };
  }
}

function statusForSeverity(severity: Finding["severity"]): Finding["status"] {
  if (severity === "critical" || severity === "high") {
    return "blocked";
  }

  if (severity === "info") {
    return "ok";
  }

  return "warning";
}

function mapConfidence(confidence: string | undefined): Finding["confidence"] {
  const normalized = confidence?.toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }

  return "high";
}

function buildEvidence(
  finding: Record<string, unknown>,
  confidence: Finding["confidence"]
): Evidence[] {
  const location = isRecord(finding.location) ? finding.location : undefined;
  const file = readFirstString(finding.file, finding.path, location?.file);
  if (!file) {
    return [];
  }

  const line = readPositiveInteger(finding.line) ?? readPositiveInteger(location?.line);
  const snippet = readFirstString(finding.snippet, finding.code, finding.match);

  return [
    {
      file,
      source: "external-scanner",
      confidence,
      ...(line ? { line } : {}),
      ...(snippet ? { snippet } : {}),
    },
  ];
}

function normalizeOptions(options: AgentScanIngestOptions): Required<AgentScanIngestOptions> {
  return {
    maxReportBytes: options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES,
    maxFindings: options.maxFindings ?? DEFAULT_MAX_FINDINGS,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
}

function exceedsDepth(value: unknown, maxDepth: number, currentDepth = 0): boolean {
  if (currentDepth > maxDepth) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => exceedsDepth(entry, maxDepth, currentDepth + 1));
  }

  if (isRecord(value)) {
    return Object.values(value).some((entry) => exceedsDepth(entry, maxDepth, currentDepth + 1));
  }

  return false;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringValue = readString(value);
    if (stringValue) {
      return stringValue;
    }
  }

  return undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
