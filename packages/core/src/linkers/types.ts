import type { IndexedAgent, IndexedCapability, IndexedSkill } from "@c3qo/samx-schemas";
import type { AdjacentHookCandidate } from "../packages/hook-candidates.js";

export type LinkedSkill = IndexedSkill & { linkAlias?: string };

export type LinkedAgent = IndexedAgent & { linkAlias?: string };

export type LinkedCapability = IndexedCapability & { linkAlias?: string };

interface LinkPlanFile {
  path: string;
  content: string;
}

export interface LinkPlanSymlink {
  path: string;
  target: string;
}

export interface LinkPlanJsonMerge {
  path: string;
  keyPath: string[];
  defaults?: Record<string, unknown>;
  entries: Array<{ key: string; value: Record<string, unknown> }>;
}

export interface LinkPlanInstructionBlock {
  path: string;
  marker: { bundleId: string; tool: string };
  content: string;
}

export interface LinkPlanTomlMerge {
  path: string;
  tablePath: string[];
  entries: Array<{ key: string; value: Record<string, unknown> }>;
}

export interface LinkPlanHook {
  id: string;
  packageId: string;
  kind: "jsonMerge" | "symlink";
  tool: "claude" | "opencode";
  description?: string;
  sourcePath: string;
  outputPath?: string;
  settingsPath?: string;
  required: boolean;
  appliesTo: string[];
  fingerprint: string;
  inference?: "top-level" | "adjacent";
  drift?: Array<{ sentinel: string; expected: string; actual: string }>;
  preview: unknown;
}

interface LinkPlanSkippedHook {
  id: string;
  packageId: string;
  relativeFile: string;
  inference: "top-level" | "adjacent";
  reason: "--no-hooks";
}

interface LinkPlanAdvisory {
  packageId: string;
  id: string;
  severity: "info" | "warning" | "error";
  category: string;
  message: string;
  paths: string[];
  reason?: string;
  effect?: string;
  action?: string;
}

interface LinkPlanEnvironmentReminder {
  packageId: string;
  env: string[];
}

export interface LinkPlan {
  tool: string;
  bundleId: string;
  projectRoot: string;
  generatedFiles: string[];
  files: LinkPlanFile[];
  symlinks: LinkPlanSymlink[];
  jsonMerges: LinkPlanJsonMerge[];
  instructionBlocks: LinkPlanInstructionBlock[];
  tomlMerges: LinkPlanTomlMerge[];
  hooks: LinkPlanHook[];
  skippedHooks: LinkPlanSkippedHook[];
  hookWarnings: string[];
  environmentReminders: LinkPlanEnvironmentReminder[];
  advisories: LinkPlanAdvisory[];
  hookCandidates: AdjacentHookCandidate[];
  hookDecisionRequired: boolean;
  enabledAdjacentHooks: AdjacentHookCandidate[];
}

export interface LinkResult {
  plan: LinkPlan;
  written: string[];
}
