import { z } from "zod";

import { capabilityTypeSchema, extensionKindSchema, findingSchema } from "./types.js";
import { relativePathSchema } from "./relative-path.js";

export const relativeLinkPathSchema = relativePathSchema;

export const pluginManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().min(1),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const nameFromSchema = z.enum(["constant", "fileStem", "parentDirectory"]);
export type NameFrom = z.infer<typeof nameFromSchema>;

export const classifyWhenSchema = z.object({
  fileName: z.string().optional(),
  extension: z.string().optional(),
  relativePath: z.string().optional(),
  pathPrefix: z.string().optional(),
  packageHasBin: z.boolean().optional(),
});

export type ClassifyWhen = z.infer<typeof classifyWhenSchema>;

export const classifyRuleSchema = z.object({
  when: classifyWhenSchema,
  kind: extensionKindSchema,
  sourceTool: z.string().optional(),
  nameFrom: nameFromSchema.default("fileStem"),
  name: z.string().optional(),
});

export type ClassifyRule = z.infer<typeof classifyRuleSchema>;

export const groupWhenSchema = z.object({
  sourceTool: z.string().optional(),
  kind: extensionKindSchema.optional(),
  pathIncludes: z.string().optional(),
  pathPrefix: z.string().optional(),
  fileName: z.string().optional(),
});

export type GroupWhen = z.infer<typeof groupWhenSchema>;

export const groupRuleSchema = z.object({
  label: z.string().min(1),
  when: groupWhenSchema,
});

export type GroupRule = z.infer<typeof groupRuleSchema>;

export const patternRuleSchema = z.object({
  value: z.string().min(1),
  pattern: z.string().min(1),
});

export type PatternRule = z.infer<typeof patternRuleSchema>;

export const shellRiskRuleSchema = patternRuleSchema.extend({
  severity: findingSchema.shape.severity,
});

export type ShellRiskRule = z.infer<typeof shellRiskRuleSchema>;

export const parseRulesSchema = z
  .object({
    markdownFrontmatterKinds: z.array(extensionKindSchema).default([]),
    mcpJsonKinds: z.array(extensionKindSchema).default([]),
    profileKinds: z.array(extensionKindSchema).default([]),
    packageJsonKinds: z.array(extensionKindSchema).default([]),
  })
  .default({});

export type ParseRules = z.infer<typeof parseRulesSchema>;

export const inferenceRulesSchema = z
  .object({
    commands: z.array(z.string()).default([]),
    env: z.array(z.string()).default([]),
    filesystem: z.array(patternRuleSchema).default([]),
    shellRisks: z.array(shellRiskRuleSchema).default([]),
    broadMcpFilesystemRoots: z.array(z.string()).default([]),
    networkCommands: z.array(z.string()).default([]),
  })
  .default({});

export type InferenceRules = z.infer<typeof inferenceRulesSchema>;

export const probeRulesSchema = z
  .object({
    safeCommands: z.array(z.string()).default([]),
  })
  .default({});

export type ProbeRules = z.infer<typeof probeRulesSchema>;

export const directorySymlinkLinkTargetRuleSchema = z.object({
  mode: z.literal("directory-symlink"),
  root: relativeLinkPathSchema,
  entry: z.string().min(1).optional(),
  nameFrom: z.literal("aliasOrCapabilityId").default("aliasOrCapabilityId"),
});

export const mcpJsonMergeLinkTargetRuleSchema = z.object({
  mode: z.literal("mcp-json-merge"),
  output: relativeLinkPathSchema,
  keyPath: z.array(z.string().min(1)).optional(),
  defaults: z.record(z.unknown()).optional(),
});

export const agentsMdSectionLinkTargetRuleSchema = z.object({
  mode: z.literal("agents-md-section"),
  output: relativeLinkPathSchema,
  kinds: z.array(z.enum(["skill", "agent"])).optional(),
});

export const mcpTomlMergeLinkTargetRuleSchema = z.object({
  mode: z.literal("mcp-toml-merge"),
  output: relativeLinkPathSchema,
  tablePath: z.array(z.string().min(1)).default(["mcp_servers"]),
});

export const capabilityLinkTargetRuleSchema = z.discriminatedUnion("mode", [
  directorySymlinkLinkTargetRuleSchema,
  mcpJsonMergeLinkTargetRuleSchema,
  mcpTomlMergeLinkTargetRuleSchema,
]);

export const claudeSettingsHooksLinkTargetConfigSchema = z.object({
  mode: z.literal("claude-settings-hooks"),
  settings: relativeLinkPathSchema,
  allowedExtensions: z.array(z.literal(".json")).default([".json"]),
});

export const opencodePluginHooksLinkTargetConfigSchema = z.object({
  mode: z.literal("opencode-plugin"),
  root: relativeLinkPathSchema,
  allowedExtensions: z.array(z.enum([".js", ".mjs"])).default([".js", ".mjs"]),
});

export const hookLinkTargetConfigSchema = z.discriminatedUnion("mode", [
  claudeSettingsHooksLinkTargetConfigSchema,
  opencodePluginHooksLinkTargetConfigSchema,
]);

export const linkTargetConfigSchema = z.object({
  displayName: z.string().min(1).optional(),
  allowLegacySkillFileRecords: z.boolean().default(false),
  hooks: hookLinkTargetConfigSchema.optional(),
  instructions: agentsMdSectionLinkTargetRuleSchema.optional(),
  capabilities: z.record(capabilityTypeSchema, capabilityLinkTargetRuleSchema).default({}),
});

export type LinkTargetConfig = z.infer<typeof linkTargetConfigSchema>;
export type CapabilityLinkTargetRule = z.infer<typeof capabilityLinkTargetRuleSchema>;
export type HookLinkTargetConfig = z.infer<typeof hookLinkTargetConfigSchema>;

export const pluginRulesSchema = z.object({
  scan: z
    .object({
      project: z.array(z.string()).default([]),
      home: z.array(z.string()).default([]),
      ignoredDirectories: z.array(z.string()).default([]),
    })
    .default({}),
  classify: z.array(classifyRuleSchema).default([]),
  groups: z.array(groupRuleSchema).default([]),
  parse: parseRulesSchema,
  inference: inferenceRulesSchema,
  probes: probeRulesSchema,
  linkTargets: z.record(linkTargetConfigSchema).default({}),
});

export type PluginRules = z.infer<typeof pluginRulesSchema>;

export interface PluginConfig extends PluginManifest {
  rules: Omit<PluginRules, "linkTargets"> & Partial<Pick<PluginRules, "linkTargets">>;
}
