import type { RecipeLock } from "@c3qo/samx-schemas";
import { recipeLockSchema } from "@c3qo/samx-schemas";
import { join } from "node:path";
import { access } from "node:fs/promises";

import { atomicWriteJson, atomicWriteText } from "../store/atomic.js";
import { samxPaths } from "../store/paths.js";

export interface WriteRecipeLocksOptions {
  samxHome?: string;
  registry: string;
  formula: string;
  recipe: RecipeLock;
  now?: Date;
}

export async function writeRecipeLocks(options: WriteRecipeLocksOptions): Promise<RecipeLock> {
  const recipe = recipeLockSchema.parse(options.recipe);
  const paths = samxPaths(options.samxHome);
  await atomicWriteJson(paths.recipeLock(options.registry, options.formula), recipe);
  await atomicWriteText(
    await nextAuditPath(
      paths.recipeAuditDir(options.registry, options.formula),
      auditTimestamp(options.now ?? new Date())
    ),
    `${JSON.stringify(recipe, null, 2)}\n`,
    { overwrite: false }
  );
  return recipe;
}

function auditTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

async function nextAuditPath(dir: string, timestamp: string): Promise<string> {
  for (let counter = 0; ; counter++) {
    const suffix = counter === 0 ? "" : `-${counter}`;
    const path = join(dir, `${timestamp}${suffix}.recipe.lock.json`);
    try {
      await access(path);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return path;
      throw error;
    }
  }
}
