import {
  addFormulaPackage,
  addLocalPackage,
  listPackages,
  previewFormulaPackageUpdate,
  readSamxLock,
  removeFormulaPackage,
  removeLocalPackage,
  updateFormulaPackage,
} from "@c3qo/samx-core";
import type { FormulaPackageUpdateChange } from "@c3qo/samx-core";

import type { CliContext, SamxCli } from "../index.js";
import {
  resolveFormulaIdFromRegistries,
  resolveInstalledFormulaId,
  toVisibleFormulaId,
} from "../formula-ids.js";

export function registerPkgCommand(cli: SamxCli, context: CliContext): void {
  cli
    .command("pkg <command> [...args]", "Manage SAMX packages")
    .option("--yes", "Apply package updates")
    .option("--local", "Add a local development package")
    .option("--force", "Force package removal when linked")
    .option("--head", "Resolve latest source commit instead of formula revision")
    .option("--ref <name>", "Branch or tag name to resolve with --head")
    .action((command: string, args: string[], options: PkgOptions) => {
      context.setAction(handlePkg(context, command, args, options));
    });
}

interface PkgOptions {
  yes?: boolean;
  local?: boolean;
  force?: boolean;
  head?: boolean;
  ref?: string;
}

async function handlePkg(
  context: CliContext,
  command: string,
  args: string[],
  options: PkgOptions
): Promise<void> {
  const parsed = parsePkgArgs(args, options);
  args = parsed.args;
  options = parsed.options;
  if (options.ref && options.head !== true) throw new Error("--ref requires --head");
  const [arg1, arg2] = args;
  if (command === "install" && options.local === true && arg1 && arg2)
    return handlePkgInstallLocal(context, arg1, arg2);
  if (command === "install" && arg1) return handlePkgInstall(context, arg1, options);
  if (command === "update") return handlePkgUpdate(context, arg1, options);
  if (command === "list") return handlePkgList(context);
  if (command === "uninstall" && arg1)
    return handlePkgUninstall(context, arg1, options.force === true);
  throw new Error(`Unsupported pkg command: ${command}`);
}

function parsePkgArgs(
  args: string[],
  options: PkgOptions
): { args: string[]; options: PkgOptions } {
  const parsedArgs: string[] = [];
  const parsedOptions = { ...options };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--head") {
      parsedOptions.head = true;
      continue;
    }
    if (arg === "--yes") {
      parsedOptions.yes = true;
      continue;
    }
    if (arg === "--local") {
      parsedOptions.local = true;
      continue;
    }
    if (arg === "--force") {
      parsedOptions.force = true;
      continue;
    }
    if (arg === "--ref") {
      parsedOptions.ref = args[index + 1];
      index += 1;
      continue;
    }
    parsedArgs.push(arg);
  }
  return { args: parsedArgs, options: parsedOptions };
}

async function handlePkgInstall(
  context: CliContext,
  id: string,
  options: PkgOptions
): Promise<void> {
  const formulaId = await resolveFormulaIdFromRegistries({ samxHome: context.samxHome, id });
  await addFormulaPackage({
    samxHome: context.samxHome,
    id: formulaId,
    sourceHead: options.head === true,
    sourceRef: options.ref,
  });
  context.writeOut(`Installed package: ${toVisibleFormulaId(formulaId)}\n`);
}

async function handlePkgInstallLocal(
  context: CliContext,
  id: string,
  source: string
): Promise<void> {
  await addLocalPackage({ samxHome: context.samxHome, id, source });
  context.writeOut(`Installed local package: ${id}\n`);
}

async function handlePkgUpdate(
  context: CliContext,
  id: string | undefined,
  options: PkgOptions
): Promise<void> {
  const lock = await readSamxLock({ samxHome: context.samxHome });
  const formulas = id
    ? [await resolveInstalledFormulaId({ samxHome: context.samxHome, id })]
    : lock.formulas.map((formula) => formula.id);
  if (options.yes !== true) {
    const previews = await Promise.all(
      formulas.map((formula) => {
        const registry = formula.split("/")[0];
        return previewFormulaPackageUpdate({
          samxHome: context.samxHome,
          id: formula,
          registryCommit: registry ? lock.registries[registry]?.commit : undefined,
          sourceHead: options.head === true,
          sourceRef: options.ref,
        });
      })
    );
    const changed = previews.filter((preview) => preview.changes.length > 0);
    if (changed.length === 0) {
      context.writeOut(
        `Packages already up to date: ${formulas.length}\n${formulas.map(toVisibleFormulaId).join("\n")}\n`
      );
      return;
    }
    context.writeOut(
      `Would update packages: ${changed.length}\n${changed
        .map(
          (preview) =>
            `${toVisibleFormulaId(preview.id)}\n${preview.changes
              .map(renderUpdateChange)
              .map((line) => `  ${line}`)
              .join("\n")}`
        )
        .join("\n")}\nRun with --yes to apply.\n`
    );
    return;
  }
  for (const formula of formulas) {
    await updateFormulaPackage({
      samxHome: context.samxHome,
      id: formula,
      sourceHead: options.head === true,
      sourceRef: options.ref,
    });
  }
  context.writeOut(`Updated packages: ${formulas.length}\n`);
}

function renderUpdateChange(change: FormulaPackageUpdateChange): string {
  if ("before" in change) return `${change.field}: ${change.before} -> ${change.after}`;
  return `${change.field}: ${change.values.join(", ")}`;
}

async function handlePkgList(context: CliContext): Promise<void> {
  const packages = await listPackages({ samxHome: context.samxHome });
  context.writeOut(
    `Packages: ${packages.length}\n${packages.map((pkg) => toVisibleFormulaId(pkg.id)).join("\n")}\n`
  );
}

async function handlePkgUninstall(context: CliContext, id: string, force: boolean): Promise<void> {
  if (id.includes("/")) {
    id = await resolveInstalledFormulaId({ samxHome: context.samxHome, id });
    await removeFormulaPackage({ samxHome: context.samxHome, id, force });
  } else {
    await removeLocalPackage({ samxHome: context.samxHome, id, force });
  }
  context.writeOut(`Uninstalled package: ${toVisibleFormulaId(id)}\n`);
}
