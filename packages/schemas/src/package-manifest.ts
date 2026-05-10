import { z } from "zod";

import { relativePathSchema } from "./relative-path.js";

export const hookTargetSchema = z.enum(["claude", "opencode"]);
export type HookTarget = z.infer<typeof hookTargetSchema>;

export const hookAppliesToSchema = z.string().regex(/^(skill|agent):[A-Za-z0-9._-]+$/u);

const hookFileDeclarationSchema = z
  .object({
    target: hookTargetSchema,
    path: relativePathSchema,
  })
  .strict();

export const samxHookDeclarationSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1).optional(),
    appliesTo: z.array(hookAppliesToSchema).min(1),
    files: z.array(hookFileDeclarationSchema).min(1),
    required: z.boolean(),
  })
  .strict()
  .superRefine((hook, ctx) => {
    const seen = new Set<HookTarget>();

    for (const [index, file] of hook.files.entries()) {
      if (seen.has(file.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "target"],
          message: `Duplicate hook file target: ${file.target}`,
        });
      }
      seen.add(file.target);
    }
  });

export type SamxHookDeclaration = z.infer<typeof samxHookDeclarationSchema>;

export const samxPackageManifestSchema = z
  .object({
    hooks: z.array(samxHookDeclarationSchema).default([]),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();

    for (const [index, hook] of manifest.hooks.entries()) {
      if (seen.has(hook.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hooks", index, "id"],
          message: `Duplicate hook id: ${hook.id}`,
        });
      }
      seen.add(hook.id);
    }
  });

export type SamxPackageManifest = z.infer<typeof samxPackageManifestSchema>;
