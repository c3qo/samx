import { getCapability, listCapabilities } from "@c3qo/samx-core";

import type { CliContext, SamxCli } from "../index.js";
import { resolveCapabilityId } from "../formula-ids.js";

export function registerCapabilityCommand(cli: SamxCli, context: CliContext): void {
  cli
    .command("capability <command> [capability-id]", "Browse synced capabilities")
    .option("--type <type>", "Filter capability list by type")
    .action(
      (
        command: string,
        idOrOptions: string | CapabilityListOptions | undefined,
        maybeOptions: CapabilityListOptions | undefined
      ) => {
        const id = typeof idOrOptions === "string" ? idOrOptions : undefined;
        const options =
          typeof idOrOptions === "object" && idOrOptions !== null
            ? idOrOptions
            : (maybeOptions ?? {});
        context.setAction(handleCapability(context, command, id, options));
      }
    );
}

interface CapabilityListOptions {
  type?: string;
}

type CapabilityType = "skill" | "agent" | "mcp";

async function handleCapability(
  context: CliContext,
  command: string,
  id: string | undefined,
  options: CapabilityListOptions
): Promise<void> {
  if (command === "list") return handleCapabilityList(context, options.type);
  if (command === "show" && id) return handleCapabilityShow(context, id);
  throw new Error(`Unsupported capability command: ${command}`);
}

async function handleCapabilityList(context: CliContext, type: string | undefined): Promise<void> {
  const capabilityType = parseCapabilityType(type);
  const capabilities = await listCapabilities({
    samxHome: context.samxHome,
    ...(capabilityType ? { type: capabilityType } : {}),
  });
  context.writeOut(
    `Capabilities: ${capabilities.length}\n${capabilities.map((capability) => `${capability.id}\t${capability.kind}`).join("\n")}\n`
  );
}

async function handleCapabilityShow(context: CliContext, id: string): Promise<void> {
  id = await resolveCapabilityId({ samxHome: context.samxHome, id });
  const capability = await getCapability({ samxHome: context.samxHome, id });
  context.writeOut(
    `Capability: ${capability.id}\nType: ${capability.kind}\nName: ${capability.name ?? "unknown"}\nPath: ${capability.path}\n`
  );
}

function parseCapabilityType(type: string | undefined): CapabilityType | undefined {
  if (!type) return undefined;
  if (type === "skill" || type === "agent" || type === "mcp") return type;
  throw new Error(`Unsupported capability type: ${type}`);
}
