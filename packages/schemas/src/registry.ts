import { z } from "zod";

import { samxHookDeclarationSchema } from "./package-manifest.js";
import { relativePathSchema } from "./relative-path.js";

export const capabilityKindSchema = z.enum(["skill", "agent", "mcp"]);

export type CapabilityKind = z.infer<typeof capabilityKindSchema>;

const gitSourceSchema = z
  .object({
    type: z.literal("git"),
    url: z
      .string()
      .url()
      .refine((value) => {
        try {
          return ["https:", "git:", "ssh:", "file:"].includes(new URL(value).protocol);
        } catch {
          return false;
        }
      }, "Git source URL must use https, git, ssh, or file protocol"),
    ref: z.string().min(1).optional(),
    revision: z
      .string()
      .regex(
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u,
        "Git source revision must be a 40 or 64 character hex commit"
      ),
  })
  .strict();

const virtualSourceOriginSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("remote"), url: z.string().url() }).strict(),
  z
    .object({
      type: z.literal("npm"),
      package: z.string().min(1),
      version: z.string().min(1).optional(),
    })
    .strict(),
]);

const virtualSourceSchema = z
  .object({
    type: z.literal("virtual"),
    origin: virtualSourceOriginSchema.optional(),
  })
  .strict();

const formulaSourceSchema = z.discriminatedUnion("type", [gitSourceSchema, virtualSourceSchema]);

const requirementsSchema = z
  .object({
    env: z.array(z.string()).default([]),
  })
  .strict();

const hooksSchema = z
  .object({
    mode: z.literal("explicit"),
    entries: z.array(samxHookDeclarationSchema).default([]),
  })
  .strict();

export const formulaAdvisorySchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    category: z.string().min(1),
    message: z.string().min(1),
    paths: z.array(relativePathSchema).default([]),
    reason: z.string().min(1).optional(),
    effect: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
  })
  .strict();

const formulaIdSchema = z
  .string()
  .min(1)
  .refine((value) => {
    const parts = value.split("/");
    return (
      parts.length === 2 &&
      !value.startsWith("/") &&
      !value.includes("..") &&
      !value.includes("\\") &&
      parts.every((part) => part !== "")
    );
  }, "Formula id must be <owner>/<repo> safe relative path");

const capabilityEntrySchema = z
  .string()
  .min(1)
  .refine((value) => {
    return !value.includes("/") && !value.includes("\\") && value !== "..";
  }, "Capability entry must be a file name");

const knownCapabilityFiles = new Set(["SKILL.md", "AGENT.md", "agent.md", "mcp.json", ".mcp.json"]);

const formulaCapabilityBaseSchema = z
  .object({
    id: z.string().min(1),
    kind: capabilityKindSchema,
    path: relativePathSchema.optional(),
    entry: capabilityEntrySchema.optional(),
    description: z.string().optional(),
    spec: z
      .object({
        serverName: z.string().min(1),
        transport: z.enum(["stdio", "remote"]),
        sourceFormat: z.enum(["claude-local", "opencode", "claude-api", "direct"]),
        config: z.record(z.unknown()),
      })
      .strict()
      .optional(),
  })
  .strict();

const hasStringConfigKey = (config: Record<string, unknown>, key: string) =>
  typeof config[key] === "string" && config[key].length > 0;
const hasStringArrayConfigKey = (config: Record<string, unknown>, key: string) =>
  Array.isArray(config[key]) &&
  config[key].some((value) => typeof value === "string" && value.length > 0);
const hasCommandConfig = (config: Record<string, unknown>) =>
  hasStringConfigKey(config, "command") || hasStringArrayConfigKey(config, "command");

const validateFormulaCapability = (
  capability: z.infer<typeof formulaCapabilityBaseSchema>,
  ctx: z.RefinementCtx
) => {
  if (capability.entry && !capability.path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Capability entry requires path",
      path: ["entry"],
    });
  }
  if (
    (capability.kind === "skill" || capability.kind === "agent") &&
    (!capability.path || capability.spec)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Skill and agent capabilities require path and must not include spec",
    });
  }
  if (
    capability.kind === "mcp" &&
    Number(Boolean(capability.path)) + Number(Boolean(capability.spec)) !== 1
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "MCP capability requires exactly one of path or spec",
    });
  }
  if (capability.spec?.transport === "stdio") {
    if (!hasCommandConfig(capability.spec.config)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP spec stdio transport requires command config",
        path: ["spec", "config"],
      });
    }
    if (hasStringConfigKey(capability.spec.config, "url")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP spec transport conflicts with URL config",
        path: ["spec", "transport"],
      });
    }
  }
  if (capability.spec?.transport === "remote") {
    if (!hasStringConfigKey(capability.spec.config, "url")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP spec remote transport requires URL config",
        path: ["spec", "config"],
      });
    }
    if (hasCommandConfig(capability.spec.config)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP spec transport conflicts with command config",
        path: ["spec", "transport"],
      });
    }
  }
  const pathFileName = capability.path?.split(/[\\/]/u).at(-1);
  if (capability.entry && pathFileName && knownCapabilityFiles.has(pathFileName)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Capability entry must be omitted when path points to a capability file",
      path: ["entry"],
    });
  }
};

const validateVirtualSourceCapabilities = (
  capabilities: z.infer<typeof formulaCapabilityBaseSchema>[],
  ctx: z.RefinementCtx
) => {
  capabilities.forEach((capability, index) => {
    if (capability.kind !== "mcp" || !capability.spec || capability.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Formula with virtual source may only contain spec-backed MCP capabilities",
        path: ["capabilities", index],
      });
    }
  });
};

export const formulaCapabilitySchema = formulaCapabilityBaseSchema.superRefine(
  (capability, ctx) => {
    validateFormulaCapability(capability, ctx);
  }
);

export type FormulaCapability = z.infer<typeof formulaCapabilitySchema>;

const evidenceSchema = z
  .object({
    path: relativePathSchema,
    quote: z.string().min(1),
  })
  .strict();

export const candidateFormulaCapabilitySchema = formulaCapabilityBaseSchema
  .extend({
    confidence: z.number().min(0).max(1),
    evidence: z.array(evidenceSchema).default([]),
  })
  .strict()
  .superRefine((capability, ctx) => {
    validateFormulaCapability(capability, ctx);
  });

const candidateRequirementEvidenceSchema = z
  .object({
    name: z.string().min(1),
    path: relativePathSchema,
    quote: z.string().min(1),
  })
  .strict();

export const candidateFormulaSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    homepage: z.string().url().optional(),
    license: z.string().min(1).optional(),
    capabilities: z.array(candidateFormulaCapabilitySchema).min(1),
    requirements: requirementsSchema.default({}),
    requirementEvidence: z.array(candidateRequirementEvidenceSchema).default([]),
  })
  .strict();

export type CandidateFormula = z.infer<typeof candidateFormulaSchema>;
export type CandidateFormulaCapability = z.infer<typeof candidateFormulaCapabilitySchema>;
export type FormulaAdvisory = z.infer<typeof formulaAdvisorySchema>;

export const formulaSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: formulaIdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    homepage: z.string().url().optional(),
    license: z.string().min(1).optional(),
    source: formulaSourceSchema,
    capabilities: z.array(formulaCapabilitySchema).min(1),
    requirements: requirementsSchema.default({}),
    hooks: hooksSchema.default({ mode: "explicit", entries: [] }),
    advisories: z.array(formulaAdvisorySchema).default([]),
  })
  .strict()
  .superRefine((formula, ctx) => {
    if (formula.source.type !== "virtual") return;
    validateVirtualSourceCapabilities(formula.capabilities, ctx);
  });

export type Formula = z.infer<typeof formulaSchema>;

const formulaLockReferenceSchema = z
  .object({
    registry: z.string().min(1),
    path: relativePathSchema,
    registryUrl: z.string().url(),
    registryCommit: z.string().min(1),
    formulaHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

const recipeLockCapabilitySchema = formulaCapabilityBaseSchema
  .extend({
    formulaCapabilityId: z.string().min(1),
  })
  .strict()
  .superRefine((capability, ctx) => {
    validateFormulaCapability(capability, ctx);
  });

export const recipeLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    formula: formulaLockReferenceSchema,
    source: formulaSourceSchema,
    capabilities: z.array(recipeLockCapabilitySchema).min(1),
    requirements: requirementsSchema.default({}),
    hooks: hooksSchema.default({ mode: "explicit", entries: [] }),
    advisories: z.array(formulaAdvisorySchema).default([]),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    if (recipe.source.type !== "virtual") return;
    validateVirtualSourceCapabilities(recipe.capabilities, ctx);
  });

export type RecipeLock = z.infer<typeof recipeLockSchema>;

const samxLockRegistrySchema = z
  .object({
    url: z.string().url(),
    commit: z.string().min(1),
  })
  .strict();

const samxLockFormulaSchema = z
  .object({
    id: z.string().min(1),
    formulaPath: relativePathSchema,
    formulaHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    source: formulaSourceSchema,
    capabilities: z.array(z.string().min(1)),
  })
  .strict();

export const samxLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    trustedRegistries: z.array(z.string().min(1)).default([]),
    registries: z.record(samxLockRegistrySchema).default({}),
    formulas: z.array(samxLockFormulaSchema).default([]),
  })
  .strict();

export type SamxLock = z.infer<typeof samxLockSchema>;
