import type { AdjacentHookCandidate, LinkPlan } from "@c3qo/samx-core";

import { cleanTerminalText } from "../output.js";

export function renderLinkPlan(plan: LinkPlan, displayName = displayTool(plan.tool)): string {
  const lines = [`Link plan for ${displayName}`, ""];
  appendSymlinkSection(
    lines,
    "Skills:",
    plan.symlinks.filter((link) => pathHasSegment(link.path, "skills"))
  );
  appendSymlinkSection(
    lines,
    "Agents:",
    plan.symlinks.filter((link) => pathHasSegment(link.path, "agents"))
  );
  appendInstructionSection(lines, plan);
  appendMcpSection(lines, plan);
  appendTomlSection(lines, plan);
  appendHookSection(lines, plan);
  appendSkippedHooks(lines, plan);
  appendEnvironmentReminders(lines, plan);
  appendAdvisories(lines, plan);
  appendAdjacentCandidates(lines, plan.hookCandidates);
  return `${trimTrailingBlank(lines).join("\n")}\n`;
}

function appendInstructionSection(lines: string[], plan: LinkPlan): void {
  const blocks = plan.instructionBlocks;
  if (blocks.length === 0) return;
  lines.push("Instructions:");
  for (const block of blocks) lines.push(`+ ${block.path}`);
  lines.push("");
}

export function renderUnlinkPlan(plan: LinkPlan, displayName = displayTool(plan.tool)): string {
  const lines = [`Unlink plan for ${displayName}`, "", "Will remove:"];
  const jsonMergePaths = new Set(plan.jsonMerges.map((merge) => merge.path));
  for (const file of plan.generatedFiles) {
    if (!jsonMergePaths.has(file) && !isMcpJsonGeneratedPath(file)) lines.push(`- ${file}`);
  }
  for (const merge of plan.jsonMerges) {
    for (const entry of merge.entries)
      lines.push(`- ${merge.path} ${merge.keyPath.join(".")}.${entry.key}`);
  }
  lines.push("", "SAMX removes only recorded outputs.");
  return `${trimTrailingBlank(lines).join("\n")}\n`;
}

function appendSymlinkSection(lines: string[], title: string, links: LinkPlan["symlinks"]): void {
  if (links.length === 0) return;
  lines.push(title);
  for (const link of links) lines.push(`+ ${link.path} -> ${link.target}`);
  lines.push("");
}

function appendMcpSection(lines: string[], plan: LinkPlan): void {
  const entries = plan.jsonMerges.flatMap((merge) =>
    merge.entries.map((entry) => ({ merge, entry }))
  );
  if (entries.length === 0) return;
  lines.push("MCP:");
  for (const { merge, entry } of entries)
    lines.push(`+ ${merge.path} ${merge.keyPath.join(".")}.${entry.key}`);
  lines.push("");
}

function appendTomlSection(lines: string[], plan: LinkPlan): void {
  const entries = plan.tomlMerges.flatMap((merge) =>
    merge.entries.map((entry) => ({ merge, entry }))
  );
  if (entries.length === 0) return;
  lines.push("MCP TOML:");
  for (const { merge, entry } of entries)
    lines.push(`+ ${merge.path} ${merge.tablePath.join(".")}.${entry.key}`);
  lines.push("");
}

function appendHookSection(lines: string[], plan: LinkPlan): void {
  if (plan.hooks.length === 0) return;
  lines.push("Hooks:");
  for (const hook of plan.hooks) {
    lines.push(
      `+ ${hook.settingsPath ?? hook.outputPath ?? "<managed by SAMX>"} -> ${hook.sourcePath}`
    );
    lines.push(`  id: ${hook.id}`);
    if (hook.inference) lines.push(`  source: ${hook.inference} inferred`);
    lines.push(`  applies to: ${hook.appliesTo.join(", ")}`);
    lines.push("  risk: executable behavior");
    if (Array.isArray(hook.drift) && hook.drift.length > 0)
      lines.push("  drift: managed hook changed outside SAMX");
  }
  lines.push("");
}

function appendSkippedHooks(lines: string[], plan: LinkPlan): void {
  if (plan.skippedHooks.length === 0) return;
  lines.push("Hooks skipped by --no-hooks:");
  for (const hook of plan.skippedHooks) lines.push(`- ${hook.id} ${hook.relativeFile}`);
  lines.push("");
}

function appendEnvironmentReminders(lines: string[], plan: LinkPlan): void {
  if (plan.environmentReminders.length === 0) return;
  lines.push("Environment reminders:");
  for (const reminder of plan.environmentReminders) {
    lines.push(
      `- ${cleanTerminalText(reminder.packageId)} requires ${reminder.env.map(cleanTerminalText).join(", ")}`
    );
  }
  lines.push("");
}

function appendAdjacentCandidates(lines: string[], candidates: AdjacentHookCandidate[]): void {
  if (candidates.length === 0) return;
  lines.push("Adjacent hook candidates:");
  for (const candidate of candidates) {
    lines.push(`- ${candidate.id}`);
    lines.push(`  package: ${candidate.packageId}`);
    lines.push(`  file: ${candidate.relativeFile}`);
    lines.push(`  affects: ${candidate.appliesTo.join(", ")}`);
    lines.push("  status: off");
    lines.push("  risk: executable behavior");
  }
  lines.push("");
}

function appendAdvisories(lines: string[], plan: LinkPlan): void {
  if (plan.advisories.length === 0) return;
  lines.push("Formula advisories:");
  for (const advisory of plan.advisories) {
    lines.push(
      `- ${cleanTerminalText(advisory.packageId)} ${cleanTerminalText(advisory.id)} [${cleanTerminalText(advisory.severity)}]: ${cleanTerminalText(advisory.message)}`
    );
    if (advisory.paths.length > 0)
      lines.push(`  paths: ${advisory.paths.map(cleanTerminalText).join(", ")}`);
    if (advisory.reason) lines.push(`  reason: ${cleanTerminalText(advisory.reason)}`);
    if (advisory.effect) lines.push(`  effect: ${cleanTerminalText(advisory.effect)}`);
    if (advisory.action) lines.push(`  action: ${cleanTerminalText(advisory.action)}`);
  }
  lines.push("");
}

function displayTool(tool: string): string {
  return tool === "opencode" ? "OpenCode" : tool;
}

function pathHasSegment(path: string, segment: string): boolean {
  if (!path) return false;
  return path.replace(/\\/g, "/").split("/").includes(segment);
}

function isMcpJsonGeneratedPath(path: string): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.endsWith("/.opencode/mcp.json") ||
    normalized.endsWith("/.kiro/mcp.json") ||
    normalized.endsWith("/.mcp.json")
  );
}

function trimTrailingBlank(lines: string[]): string[] {
  while (lines.at(-1) === "") lines.pop();
  return lines;
}
