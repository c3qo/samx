import { readCapabilityIndex, readSamxLock, searchFormulas } from "@c3qo/samx-core";

export function toCanonicalFormulaId(id: string): string {
  const parts = id.split("/");
  return parts.length === 2 ? `default/${id}` : id;
}

export function toVisibleFormulaId(id: string): string {
  const parts = id.split("/");
  return parts.length === 3 && parts[0] === "default" ? `${parts[1]}/${parts[2]}` : id;
}

export function toVisibleCapabilityId(id: string): string {
  const separator = id.indexOf(":");
  if (separator === -1) return toVisibleFormulaId(id);
  const formulaId = id.slice(0, separator);
  return `${toVisibleFormulaId(formulaId)}${id.slice(separator)}`;
}

export async function resolveFormulaIdFromRegistries(options: {
  samxHome?: string;
  id: string;
}): Promise<string> {
  if (!isFormulaShorthand(options.id) && options.id.includes("/")) return options.id;
  const results = await searchFormulas({ samxHome: options.samxHome, query: options.id });
  const matches = results
    .map((result) => result.id)
    .filter((id) =>
      isFormulaShorthand(options.id)
        ? id.endsWith(`/${options.id}`)
        : id.split("/").includes(options.id)
    )
    .sort((a, b) => a.localeCompare(b));
  return uniqueOrThrow("formula", options.id, matches);
}

export async function resolveInstalledFormulaId(options: {
  samxHome?: string;
  id: string;
}): Promise<string> {
  if (!isFormulaShorthand(options.id)) return options.id;
  const lock = await readSamxLock({ samxHome: options.samxHome });
  const matches = lock.formulas
    .map((formula) => formula.id)
    .filter((id) => id.endsWith(`/${options.id}`))
    .sort((a, b) => a.localeCompare(b));
  return uniqueOrThrow("formula", options.id, matches);
}

export async function resolveCapabilityId(options: {
  samxHome?: string;
  id: string;
}): Promise<string> {
  const separator = options.id.indexOf(":");
  if (separator === -1) return resolveInstalledFormulaId(options);
  const formulaId = options.id.slice(0, separator);
  if (!isFormulaShorthand(formulaId)) return options.id;
  const suffix = options.id.slice(separator);
  const index = await readCapabilityIndex({ samxHome: options.samxHome });
  const matches = index.capabilities
    .map((capability) => capability.id)
    .filter((id) => id.endsWith(`/${formulaId}${suffix}`))
    .sort((a, b) => a.localeCompare(b));
  return uniqueOrThrow("capability", options.id, matches);
}

function isFormulaShorthand(id: string): boolean {
  return id.split("/").length === 2;
}

function uniqueOrThrow(kind: "formula" | "capability", input: string, matches: string[]): string {
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`${capitalize(kind)} not found: ${input}`);
  throw new Error(
    `Ambiguous ${kind} id: ${input}\nMatches:\n${matches.map((match) => `- ${match}`).join("\n")}\nSpecify one of the full ids above.`
  );
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
