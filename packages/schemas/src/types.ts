import { z } from "zod";

import { hookAppliesToSchema, hookTargetSchema } from "./package-manifest.js";
import { formulaAdvisorySchema } from "./registry.js";

export const extensionKindSchema = z.enum([
  "skill",
  "rule",
  "mcp-server",
  "profile",
  "bundle",
  "script",
  "unknown",
]);

export type ExtensionKind = z.infer<typeof extensionKindSchema>;

export const evidenceSchema = z.object({
  file: z.string(),
  line: z.number().int().positive().optional(),
  snippet: z.string().optional(),
  source: z.enum(["declared", "inferred", "probed", "external-scanner"]),
  confidence: z.enum(["high", "medium", "low"]),
});

export type Evidence = z.infer<typeof evidenceSchema>;

export const requirementsSchema = z.object({
  commands: z.array(z.string()).default([]),
  env: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
});

export type Requirements = z.infer<typeof requirementsSchema>;

export const permissionsSchema = z.object({
  shell: z.boolean().default(false),
  network: z.boolean().default(false),
  filesystem: z.array(z.string()).default([]),
  browser: z.boolean().default(false),
  secrets: z.array(z.string()).default([]),
});

export type Permissions = z.infer<typeof permissionsSchema>;

export const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  status: z.enum(["ok", "warning", "blocked"]),
  category: z.enum([
    "inventory",
    "dependency",
    "permission",
    "secret",
    "mcp",
    "filesystem",
    "shell",
    "network",
    "security-scanner",
    "export",
    "migration",
    "unknown",
  ]),
  extensionId: z.string().optional(),
  title: z.string(),
  message: z.string(),
  source: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(evidenceSchema).optional(),
  recommendation: z.string().optional(),
  fixCommand: z.string().optional(),
});

export type Finding = z.infer<typeof findingSchema>;

export const normalizedExtensionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: extensionKindSchema,
  sourcePath: z.string(),
  sourceTool: z.string().optional(),
  entryFiles: z.array(z.string()),
  declaredRequirements: requirementsSchema,
  inferredRequirements: requirementsSchema,
  declaredPermissions: permissionsSchema,
  inferredPermissions: permissionsSchema,
  risks: z.array(findingSchema),
  metadata: z.record(z.unknown()).default({}),
});

export type NormalizedExtension = z.infer<typeof normalizedExtensionSchema>;

export const readinessSchema = z.enum(["ready", "needs_review", "blocked", "unknown"]);

export type Readiness = z.infer<typeof readinessSchema>;

export const linkTargetSchema = z.string().min(1);

export type LinkTarget = z.infer<typeof linkTargetSchema>;

export const capabilityTypeSchema = z.enum(["skill", "agent", "mcp"]);

export type CapabilityType = z.infer<typeof capabilityTypeSchema>;

const baseSamxPackageSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  installKind: z.enum(["formula", "local"]).optional(),
  ref: z.string().optional(),
  lastSyncedAt: z.string().optional(),
  requirements: z.object({ env: z.array(z.string()).default([]) }).default({}),
  advisories: z.array(formulaAdvisorySchema).default([]),
});

export const samxPackageSchema = z.discriminatedUnion("type", [
  baseSamxPackageSchema.extend({ type: z.literal("git"), path: z.string().min(1) }),
  baseSamxPackageSchema.extend({ type: z.literal("local"), path: z.string().min(1) }),
  baseSamxPackageSchema.extend({ type: z.literal("virtual") }),
]);

export type SamxPackage = z.infer<typeof samxPackageSchema>;

export const packageManifestSchema = z.object({
  packages: z.array(samxPackageSchema).default([]),
});

export type PackageManifest = z.infer<typeof packageManifestSchema>;

export const indexedHookAttachmentSchema = z.object({
  id: z.string().min(1),
  packageId: z.string().min(1),
  description: z.string().optional(),
  tool: hookTargetSchema,
  file: z.string().min(1),
  required: z.boolean(),
  appliesTo: z.array(hookAppliesToSchema).min(1),
});

export type IndexedHookAttachment = z.infer<typeof indexedHookAttachmentSchema>;

export const indexedSkillSchema = z.object({
  id: z.string().min(1),
  packageId: z.string().min(1),
  name: z.string().min(1),
  kind: z.literal("skill"),
  path: z.string().min(1),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
  hooks: z.array(indexedHookAttachmentSchema).default([]),
});

export type IndexedSkill = z.infer<typeof indexedSkillSchema>;

export const indexedAgentSchema = z.object({
  id: z.string().min(1),
  packageId: z.string().min(1),
  name: z.string().min(1),
  kind: z.literal("agent"),
  path: z.string().min(1),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
  hooks: z.array(indexedHookAttachmentSchema).default([]),
});

export type IndexedAgent = z.infer<typeof indexedAgentSchema>;

export const mcpSourceFormatSchema = z.enum(["claude-local", "opencode", "claude-api", "direct"]);
export const mcpTransportSchema = z.enum(["stdio", "remote"]);

export const indexedMcpSchema = z.object({
  id: z.string().min(1),
  packageId: z.string().min(1),
  name: z.string().min(1),
  kind: z.literal("mcp"),
  path: z.string().min(1).optional(),
  serverName: z.string().min(1),
  config: z.record(z.unknown()),
  sourceFormat: mcpSourceFormatSchema.optional(),
  transport: mcpTransportSchema.optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type IndexedMcp = z.infer<typeof indexedMcpSchema>;

export const indexedCapabilitySchema = z.discriminatedUnion("kind", [
  indexedSkillSchema,
  indexedAgentSchema,
  indexedMcpSchema,
]);

export type IndexedCapability = z.infer<typeof indexedCapabilitySchema>;

export const capabilityIndexSchema = z.object({
  capabilities: z.array(indexedCapabilitySchema).default([]),
});

export type CapabilityIndex = z.infer<typeof capabilityIndexSchema>;

export const skillIndexSchema = z.object({
  skills: z.array(indexedSkillSchema).default([]),
});

export type SkillIndex = z.infer<typeof skillIndexSchema>;

export const bundleItemSchema = z.object({
  id: z.string().min(1),
  kind: capabilityTypeSchema,
  alias: z.string().min(1).optional(),
});

export type SamxBundleItem = z.infer<typeof bundleItemSchema>;

export const bundleSchema = z.object({
  id: z.string().min(1),
  items: z.array(bundleItemSchema).default([]),
});

export type SamxBundle = z.infer<typeof bundleSchema>;

export const enabledAdjacentHookSchema = z.object({
  id: z.string().min(1),
  packageId: z.string().min(1),
  tool: hookTargetSchema,
  sourcePath: z.string().min(1),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  appliesTo: z.array(hookAppliesToSchema).min(1),
});

export type EnabledAdjacentHook = z.infer<typeof enabledAdjacentHookSchema>;

export const linkRecordSchema = z.object({
  id: z.string().min(1),
  bundleId: z.string().min(1),
  tool: linkTargetSchema,
  projectRoot: z.string().min(1),
  generatedFiles: z.array(z.string().min(1)),
  managedJsonEntries: z
    .array(
      z.object({
        path: z.string().min(1),
        keyPath: z.array(z.string().min(1)),
        key: z.string().min(1),
      })
    )
    .default([]),
  managedTomlEntries: z
    .array(
      z.object({
        path: z.string().min(1),
        tablePath: z.array(z.string().min(1)),
        key: z.string().min(1),
      })
    )
    .default([])
    .optional(),
  managedInstructionBlocks: z
    .array(
      z.object({
        path: z.string().min(1),
        bundleId: z.string().min(1),
        tool: z.string().min(1),
      })
    )
    .default([])
    .optional(),
  managedHooks: z
    .array(
      z.object({
        id: z.string().min(1),
        packageId: z.string().min(1),
        tool: hookTargetSchema,
        kind: z.enum(["jsonMerge", "symlink"]),
        outputs: z.array(z.string().min(1)),
        sentinels: z.array(z.string().min(1)),
        fingerprints: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/u)),
        sourcePath: z.string().min(1).optional(),
        appliesTo: z.array(hookAppliesToSchema).optional(),
        inference: z.enum(["top-level", "adjacent"]).optional(),
      })
    )
    .default([]),
  adjacentHooks: z.array(enabledAdjacentHookSchema).default([]),
  createdAt: z.string(),
});

export type LinkRecord = z.infer<typeof linkRecordSchema>;

export const linkRecordSetSchema = z.object({
  links: z.array(linkRecordSchema).default([]),
});

export type LinkRecordSet = z.infer<typeof linkRecordSetSchema>;

export type AnalyzeReadiness = Readiness;

export const analyzeFindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  status: z.enum(["ok", "warning", "blocked"]),
  category: z.enum(["package", "capability", "bundle", "link", "advisory", "unknown"]),
  title: z.string().min(1),
  message: z.string().min(1),
  source: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  recommendation: z.string().optional(),
});

export type AnalyzeFinding = z.infer<typeof analyzeFindingSchema>;

export const analyzePackageSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["git", "local", "virtual"]),
  installKind: z.enum(["formula", "local"]).optional(),
  source: z.string().min(1),
  path: z.string().min(1).optional(),
  ref: z.string().optional(),
  advisories: z.number().int().nonnegative(),
});

export type AnalyzePackage = z.infer<typeof analyzePackageSchema>;

export const analyzeCapabilitySchema = z.object({
  id: z.string().min(1),
  packageId: z.string().min(1),
  kind: capabilityTypeSchema,
  name: z.string().min(1),
  path: z.string().min(1).optional(),
  serverName: z.string().min(1).optional(),
  transport: mcpTransportSchema.optional(),
});

export type AnalyzeCapability = z.infer<typeof analyzeCapabilitySchema>;

export const analyzeBundleSchema = z.object({
  id: z.string().min(1),
  items: z.number().int().nonnegative(),
  readiness: readinessSchema,
  missingItems: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});

export type AnalyzeBundle = z.infer<typeof analyzeBundleSchema>;

export const analyzeLinkSchema = z.object({
  id: z.string().min(1),
  bundleId: z.string().min(1),
  tool: z.string().min(1),
  projectRoot: z.string().min(1),
  outputs: z.array(z.string()).default([]),
});

export type AnalyzeLink = z.infer<typeof analyzeLinkSchema>;

export const analyzeReportSchema = z.object({
  generatedAt: z.string(),
  projectRoot: z.string().optional(),
  summary: z.object({
    packages: z.number().int().nonnegative(),
    capabilities: z.number().int().nonnegative(),
    bundles: z.number().int().nonnegative(),
    links: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative(),
    readiness: readinessSchema,
  }),
  packages: z.array(analyzePackageSchema),
  capabilities: z.array(analyzeCapabilitySchema),
  bundles: z.array(analyzeBundleSchema),
  links: z.array(analyzeLinkSchema),
  findings: z.array(analyzeFindingSchema),
  recommendations: z.array(z.string()),
});

export type AnalyzeReport = z.infer<typeof analyzeReportSchema>;
