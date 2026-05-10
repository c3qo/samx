import type { Evidence, Finding, Permissions, Requirements } from "@c3qo/samx-schemas";

import { loadBuiltinConfigRegistrySync } from "./config/loader.js";
import type { ConfigRegistry } from "./config/types.js";
import type { ParsedExtension } from "./parsers.js";

export interface InferredExtension extends ParsedExtension {
  inferredRequirements: Requirements;
  inferredPermissions: Permissions;
}

export interface InferExtensionOptions {
  registry?: ConfigRegistry;
}

type FindingCategory = Finding["category"];
type FindingSeverity = Finding["severity"];

interface Signal {
  value: string;
  evidence: Evidence;
}

interface PatternDefinition {
  value: string;
  pattern: RegExp;
}

export function inferExtension(
  parsed: ParsedExtension,
  options: InferExtensionOptions = {}
): InferredExtension {
  const registry = options.registry ?? loadBuiltinConfigRegistrySync();
  const cliTools = registry.inference.commands;
  const envVars = registry.inference.env;
  const filesystemPaths = registry.inference.filesystem.map((rule) => ({
    value: rule.value,
    pattern: new RegExp(rule.pattern, "u"),
  }));
  const riskyShell = registry.inference.shellRisks.map((rule) => ({
    value: rule.value,
    pattern: new RegExp(rule.pattern, "iu"),
    severity: rule.severity,
  }));
  const broadMcpFilesystemRoots = new Set(registry.inference.broadMcpFilesystemRoots);
  const networkCommands = new Set(registry.inference.networkCommands);
  const text = searchableText(parsed);
  const commandSignals = uniqueSignals([
    ...findCliTools(parsed, text, cliTools),
    ...mcpCommandSignals(parsed),
  ]);
  const envSignals = uniqueSignals([
    ...findPatternValues(
      parsed,
      text,
      envVars.map((value) => ({ value, pattern: new RegExp(escapeRegex(value), "u") }))
    ),
    ...mcpEnvSignals(parsed),
  ]);
  const pathSignals = uniqueSignals([
    ...findPatternValues(parsed, text, filesystemPaths),
    ...mcpPathSignals(parsed, filesystemPaths),
  ]);
  const shellSignals = findRiskyShell(parsed, text, riskyShell);
  const mcpSignals = mcpFindings(parsed, broadMcpFilesystemRoots);

  const findings = [
    ...parsed.findings,
    ...envSignals.map((signal) =>
      finding(
        parsed,
        "secret",
        "medium",
        `Secret environment variable ${signal.value}`,
        `References ${signal.value}.`,
        signal.evidence
      )
    ),
    ...pathSignals.map((signal) =>
      finding(
        parsed,
        "filesystem",
        "medium",
        `Filesystem access ${signal.value}`,
        `References filesystem path ${signal.value}.`,
        signal.evidence
      )
    ),
    ...shellSignals.map((signal) =>
      finding(
        parsed,
        "shell",
        signal.severity,
        `Risky shell pattern ${signal.value}`,
        `References risky shell pattern ${signal.value}.`,
        signal.evidence
      )
    ),
    ...mcpSignals,
  ];

  const commandValues = unique(commandSignals.map((signal) => signal.value));
  const envValues = unique(envSignals.map((signal) => signal.value));
  const pathValues = unique(pathSignals.map((signal) => signal.value));
  const hasShell = shellSignals.length > 0 || mcpSignals.length > 0;
  const hasNetwork =
    commandValues.some((command) => networkCommands.has(command)) ||
    parsed.declaredPermissions.network ||
    hasMcpNpxYes(parsed) ||
    /https?:\/\//iu.test(text);

  return {
    ...parsed,
    inferredRequirements: {
      commands: commandValues,
      env: envValues,
      paths: pathValues,
    },
    inferredPermissions: {
      shell: hasShell,
      network: hasNetwork,
      filesystem: pathValues,
      browser: false,
      secrets: envValues,
    },
    findings: dedupeFindings(findings),
  };
}

function searchableText(parsed: ParsedExtension): string {
  return [
    parsed.rawContent,
    JSON.stringify(parsed.metadata),
    JSON.stringify(parsed.declaredRequirements),
    JSON.stringify(parsed.declaredPermissions),
  ].join("\n");
}

function findCliTools(parsed: ParsedExtension, text: string, cliTools: string[]): Signal[] {
  return uniqueSignals(
    cliTools.flatMap((tool) => {
      const evidence = findEvidence(
        parsed,
        text,
        new RegExp(`(^|[^\\w-])${escapeRegex(tool)}([^\\w-]|$)`, "u")
      );
      return evidence ? [{ value: tool, evidence }] : [];
    })
  );
}

function findPatternValues(
  parsed: ParsedExtension,
  text: string,
  definitions: PatternDefinition[]
): Signal[] {
  return uniqueSignals(
    definitions.flatMap((definition) => {
      const evidence = findEvidence(parsed, text, definition.pattern);
      return evidence ? [{ value: definition.value, evidence }] : [];
    })
  );
}

function findRiskyShell(
  parsed: ParsedExtension,
  text: string,
  definitions: Array<PatternDefinition & { severity: FindingSeverity }>
): Array<Signal & { severity: FindingSeverity }> {
  const signals = definitions.flatMap((definition) => {
    const evidence = findEvidence(parsed, text, definition.pattern);
    return evidence ? [{ value: definition.value, evidence, severity: definition.severity }] : [];
  });

  return uniqueSignals(signals) as Array<Signal & { severity: FindingSeverity }>;
}

function mcpFindings(parsed: ParsedExtension, broadMcpFilesystemRoots: Set<string>): Finding[] {
  return mcpServers(parsed).flatMap(([name, server]) => {
    const command = typeof server.command === "string" ? server.command : undefined;
    const args = Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const results: Finding[] = [];

    if (command) {
      results.push(
        finding(
          parsed,
          "mcp",
          "medium",
          `MCP server command ${command}`,
          `MCP server ${name} declares command ${command}.`,
          mcpEvidence(parsed, command)
        )
      );
    }

    if (command === "npx" && args.includes("-y")) {
      results.push(
        finding(
          parsed,
          "shell",
          "high",
          "Risky shell pattern npx -y",
          `MCP server ${name} dynamically runs package code with npx -y.`,
          mcpEvidence(parsed, "-y")
        )
      );
    }

    for (const root of args.filter((arg) => broadMcpFilesystemRoots.has(arg))) {
      results.push(
        finding(
          parsed,
          "filesystem",
          "high",
          `Broad filesystem MCP root ${root}`,
          `MCP server ${name} exposes broad filesystem root ${root}.`,
          mcpEvidence(parsed, root)
        )
      );
    }

    return results;
  });
}

function mcpEnvSignals(parsed: ParsedExtension): Signal[] {
  return mcpServers(parsed).flatMap(([, server]) => {
    if (!isRecord(server.env)) {
      return [];
    }

    return Object.keys(server.env).map((key) => ({
      value: key,
      evidence: mcpEvidence(parsed, key),
    }));
  });
}

function mcpCommandSignals(parsed: ParsedExtension): Signal[] {
  return mcpServers(parsed).flatMap(([, server]) => {
    if (typeof server.command !== "string" || server.command.length === 0) {
      return [];
    }

    return [{ value: server.command, evidence: mcpEvidence(parsed, server.command) }];
  });
}

function mcpPathSignals(parsed: ParsedExtension, filesystemPaths: PatternDefinition[]): Signal[] {
  return mcpServers(parsed).flatMap(([, server]) => {
    const args = Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const joined = args.join(" ");
    return filesystemPaths.flatMap((definition) =>
      definition.pattern.test(joined)
        ? [
            {
              value: definition.value,
              evidence: mcpEvidence(
                parsed,
                definition.value === "/Users/" ? "/Users/" : definition.value
              ),
            },
          ]
        : []
    );
  });
}

function hasMcpNpxYes(parsed: ParsedExtension): boolean {
  return mcpServers(parsed).some(([, server]) => {
    const args = Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    return server.command === "npx" && args.includes("-y");
  });
}

function mcpServers(parsed: ParsedExtension): Array<[string, Record<string, unknown>]> {
  if (!isRecord(parsed.metadata.servers)) {
    return [];
  }

  return Object.entries(parsed.metadata.servers).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])
  );
}

function findEvidence(
  parsed: ParsedExtension,
  text: string,
  pattern: RegExp
): Evidence | undefined {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) {
      return {
        file: parsed.sourcePath,
        line: index + 1,
        snippet: line.trim(),
        source: "inferred",
        confidence: "high",
      };
    }
  }

  return undefined;
}

function mcpEvidence(parsed: ParsedExtension, needle: string): Evidence {
  const evidence = findEvidence(parsed, parsed.rawContent, new RegExp(escapeRegex(needle), "u"));
  return (
    evidence ?? {
      file: parsed.sourcePath,
      line: 1,
      snippet: needle,
      source: "inferred",
      confidence: "medium",
    }
  );
}

function finding(
  parsed: ParsedExtension,
  category: FindingCategory,
  severity: FindingSeverity,
  title: string,
  message: string,
  evidence: Evidence
): Finding {
  return {
    id: `${parsed.id}:inferred:${slug(title)}`,
    severity,
    status: "warning",
    category,
    extensionId: parsed.id,
    title,
    message,
    source: parsed.sourcePath,
    confidence: evidence.confidence,
    evidence: [evidence],
  };
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const deduped: Finding[] = [];
  for (const item of findings) {
    const key = `${item.category}:${item.title}:${item.source ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  return deduped;
}

function uniqueSignals<T extends Signal>(signals: T[]): T[] {
  const seen = new Set<string>();
  const uniqueValues: T[] = [];
  for (const signal of signals) {
    if (!seen.has(signal.value)) {
      seen.add(signal.value);
      uniqueValues.push(signal);
    }
  }
  return uniqueValues;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
