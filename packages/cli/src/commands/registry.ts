import {
  addRegistry,
  cloneOrFetchRegistry,
  ensureDefaultRegistry,
  getRegistry,
  listRegistries,
  removeRegistry,
  samxPaths,
  trustRegistry,
} from "@c3qo/samx-core";

import type { CliContext, SamxCli } from "../index.js";

export function registerRegistryCommand(cli: SamxCli, context: CliContext): void {
  cli
    .command("registry <command> [...args]", "Manage formula registries")
    .option("--no-clone", "Record registry without cloning")
    .option("--force", "Force registry removal while leaving installed packages untouched")
    .action((command: string, args: string[], options: RegistryOptions) => {
      context.setAction(handleRegistry(context, command, args, options));
    });
}

interface RegistryOptions {
  clone?: boolean;
  force?: boolean;
}

async function handleRegistry(
  context: CliContext,
  command: string,
  args: string[],
  options: RegistryOptions
): Promise<void> {
  const [arg1, arg2] = args;
  if (command === "add" && arg1 && arg2)
    return handleRegistryAdd(context, arg1, arg2, options.clone !== false);
  if (command === "trust" && arg1) return handleRegistryTrust(context, arg1);
  if (command === "sync") return handleRegistrySync(context, arg1);
  if (command === "remove" && arg1)
    return handleRegistryRemove(context, arg1, options.force === true);
  if (command === "list") return handleRegistryList(context);
  throw new Error(`Unsupported registry command: ${command}`);
}

async function handleRegistryAdd(
  context: CliContext,
  id: string,
  url: string,
  clone: boolean
): Promise<void> {
  if (clone) {
    await cloneOrFetchRegistry(url, samxPaths(context.samxHome).registryRoot(id));
  }
  await addRegistry({ samxHome: context.samxHome, id, url });
  context.writeOut(`Added registry: ${id}\n`);
}

async function handleRegistryTrust(context: CliContext, id: string): Promise<void> {
  await trustRegistry({ samxHome: context.samxHome, id });
  context.writeOut(`Trusted registry: ${id}\n`);
}

async function handleRegistryRemove(
  context: CliContext,
  id: string,
  force: boolean
): Promise<void> {
  const result = await removeRegistry({ samxHome: context.samxHome, id, force });
  context.writeOut(`Removed registry: ${id}\n`);
  if (result.installedPackagesRemaining) {
    context.writeOut(
      "Installed packages from this registry remain installed and cannot be updated until the registry is added again.\n"
    );
  }
}

async function handleRegistrySync(context: CliContext, id: string | undefined): Promise<void> {
  if (!id) await ensureDefaultRegistry({ samxHome: context.samxHome });
  const registries = id
    ? [await getRegistry({ samxHome: context.samxHome, id })]
    : await listRegistries({ samxHome: context.samxHome });
  for (const registry of registries) {
    await cloneOrFetchRegistry(registry.url, samxPaths(context.samxHome).registryRoot(registry.id));
  }
  context.writeOut(`Synced registries: ${registries.length}\n`);
}

async function handleRegistryList(context: CliContext): Promise<void> {
  const registries = await listRegistries({ samxHome: context.samxHome });
  context.writeOut(
    `Registries: ${registries.length}\n${registries.map((registry) => `${registry.trusted ? "*" : "-"} ${registry.id} ${registry.url}`).join("\n")}\n`
  );
}
