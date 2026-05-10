import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  discoverMcpServersFromWeb,
  generateFormulaDraft,
  readFormula,
  readMcpDiscoveryDocument,
  searchFormulas,
  validateFormulaFiles,
  writeMcpDiscoveryFormulas,
} from "@c3qo/samx-core";

import type { CliContext, SamxCli } from "../index.js";
import { toCanonicalFormulaId, toVisibleFormulaId } from "../formula-ids.js";
import { cleanTerminalText } from "../output.js";

export function registerFormulaCommands(cli: SamxCli, context: CliContext): void {
  // cac does not dispatch multi-word command definitions like
  // `formula generate <repoUrl>`, so keep exact public surface in help and
  // route the subcommand here without manual pre-parsing.
  cli
    .command("formula <command> [target]", "Generate formula drafts")
    .option("--ref <name>", "Resolve source ref instead of default HEAD")
    .option("--out <path>", "Write formula draft to path")
    .option("--model <name>", "OpenAI model name")
    .option("--endpoint <url>", "OpenAI-compatible API base URL")
    .option("--out-dir <path>", "Write generated formulas under directory")
    .option("--namespace <name>", "Formula namespace for generated MCP formulas")
    .option("--crawl-depth <count>", "Same-origin crawl depth for MCP discovery")
    .option("--max-pages <count>", "Maximum pages to fetch for MCP discovery")
    .option("--max-page-bytes <bytes>", "Maximum bytes to fetch per MCP discovery page")
    .option("--json", "Print JSON output")
    .option("--force", "Overwrite existing output")
    .option("--strict", "Fail when MCP discovery contains invalid candidates")
    .action((command: string, target: string | undefined, options: FormulaOptions) => {
      if (command === "generate")
        context.setAction(handleGenerate(context, requireTarget(command, target), options));
      else if (command === "discover-mcp")
        context.setAction(handleDiscoverMcp(context, requireTarget(command, target), options));
      else if (command === "generate-mcp")
        context.setAction(handleGenerateMcp(context, requireTarget(command, target), options));
      else if (command === "generate-mcp-list")
        context.setAction(handleGenerateMcpList(context, requireTarget(command, target), options));
      else if (command === "show")
        context.setAction(handleShow(context, requireTarget(command, target)));
      else if (command === "validate") context.setAction(handleValidate(context, target));
      else throw new Error(`Unsupported formula command: ${command}`);
    });

  cli.command("search <query>", "Search local registry formulas").action((query: string) => {
    context.setAction(handleSearch(context, query));
  });
}

interface FormulaOptions {
  ref?: string;
  out?: string;
  outDir?: string;
  namespace?: string;
  model?: string;
  endpoint?: string;
  crawlDepth?: string | number;
  maxPages?: string | number;
  maxPageBytes?: string | number;
  json?: boolean;
  force?: boolean;
  strict?: boolean;
}

async function handleGenerate(
  context: CliContext,
  url: string,
  options: FormulaOptions
): Promise<void> {
  const apiKey = context.env?.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  const result = await generateFormulaDraft({
    cwd: context.cwd,
    url,
    ...(options.ref ? { ref: options.ref } : {}),
    ...(options.out ? { out: options.out } : {}),
    apiKey,
    model: options.model ?? context.env?.OPENAI_MODEL ?? "gpt-4.1-mini",
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    fetch: context.formulaGenerateFetch,
    force: options.force === true,
  });

  if (options.json === true) {
    context.writeOut(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  context.writeOut(`Generated formula: ${cleanTerminalText(result.outputPath)}\n`);
  if (result.diagnostics.length > 0) {
    context.writeOut(
      `${result.diagnostics.map((diagnostic) => `- ${cleanTerminalText(diagnostic)}`).join("\n")}\n`
    );
  }
}

async function handleDiscoverMcp(
  context: CliContext,
  url: string,
  options: FormulaOptions
): Promise<void> {
  const apiKey = context.env?.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  const discovery = await discoverMcpServersFromWeb({
    url,
    apiKey,
    model: options.model ?? context.env?.OPENAI_MODEL ?? "gpt-4.1-mini",
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    fetch: context.formulaGenerateFetch,
    ...(options.crawlDepth !== undefined
      ? { crawlDepth: numberOption(options.crawlDepth, "--crawl-depth") }
      : {}),
    ...(options.maxPages !== undefined
      ? { maxPages: numberOption(options.maxPages, "--max-pages") }
      : {}),
    ...(options.maxPageBytes !== undefined
      ? { maxPageBytes: positiveNumberOption(options.maxPageBytes, "--max-page-bytes") }
      : {}),
    strict: options.strict !== undefined && options.strict !== false,
  });

  if (options.json === true) {
    context.writeOut(`${JSON.stringify(discovery, null, 2)}\n`);
    return;
  }

  const outputPath = resolve(context.cwd, options.out ?? "mcp-discovery.json");
  await writeFile(outputPath, `${JSON.stringify(discovery, null, 2)}\n`, "utf8");
  context.writeOut(`Discovered MCP servers: ${cleanTerminalText(outputPath)}\n`);
}

async function handleGenerateMcp(
  context: CliContext,
  path: string,
  options: FormulaOptions
): Promise<void> {
  const discovery = await readMcpDiscoveryDocument(resolve(context.cwd, path));
  await writeMcpFormulas(context, discovery, options);
}

async function handleGenerateMcpList(
  context: CliContext,
  url: string,
  options: FormulaOptions
): Promise<void> {
  const apiKey = context.env?.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  const discovery = await discoverMcpServersFromWeb({
    url,
    apiKey,
    model: options.model ?? context.env?.OPENAI_MODEL ?? "gpt-4.1-mini",
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    fetch: context.formulaGenerateFetch,
    ...(options.crawlDepth !== undefined
      ? { crawlDepth: numberOption(options.crawlDepth, "--crawl-depth") }
      : {}),
    ...(options.maxPages !== undefined
      ? { maxPages: numberOption(options.maxPages, "--max-pages") }
      : {}),
    ...(options.maxPageBytes !== undefined
      ? { maxPageBytes: positiveNumberOption(options.maxPageBytes, "--max-page-bytes") }
      : {}),
    strict: options.strict !== undefined && options.strict !== false,
  });
  await writeMcpFormulas(context, discovery, options);
}

async function writeMcpFormulas(
  context: CliContext,
  discovery: Awaited<ReturnType<typeof readMcpDiscoveryDocument>>,
  options: FormulaOptions
): Promise<void> {
  const result = await writeMcpDiscoveryFormulas({
    discovery,
    outDir: resolve(context.cwd, options.outDir ?? "formulas"),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    force: options.force === true,
    strict: options.strict !== undefined && options.strict !== false,
  });
  context.writeOut(`Generated MCP formulas: ${result.files.length}\n`);
  if (result.files.length > 0)
    context.writeOut(`${result.files.map(cleanTerminalText).join("\n")}\n`);
  if (result.diagnostics.length > 0)
    context.writeOut(
      `${result.diagnostics.map((diagnostic) => `- ${cleanTerminalText(diagnostic)}`).join("\n")}\n`
    );
}

function numberOption(value: string | number, name: string): number {
  const text = String(value);
  if (!/^\d+$/u.test(text)) throw new Error(`${name} must be a non-negative integer`);
  return Number(text);
}

function positiveNumberOption(value: string | number, name: string): number {
  const parsed = numberOption(value, name);
  if (parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function handleSearch(context: CliContext, query: string): Promise<void> {
  const results = await searchFormulas({ samxHome: context.samxHome, query });
  context.writeOut(
    results
      .map(
        (formula) =>
          `${cleanTerminalText(toVisibleFormulaId(formula.id))}\t${cleanTerminalText(formula.name)}`
      )
      .join("\n") + (results.length > 0 ? "\n" : "")
  );
}

async function handleShow(context: CliContext, id: string): Promise<void> {
  const formula = await readFormula({ samxHome: context.samxHome, id: toCanonicalFormulaId(id) });
  context.writeOut(
    [
      cleanTerminalText(formula.name),
      cleanTerminalText(toVisibleFormulaId(formula.id)),
      ...formula.capabilities.map(
        (capability) =>
          `- ${cleanTerminalText(capability.kind)} ${cleanTerminalText(capability.id)}`
      ),
      "",
    ].join("\n")
  );
}

async function handleValidate(context: CliContext, path: string | undefined): Promise<void> {
  const result = await validateFormulaFiles({ cwd: context.cwd, ...(path ? { path } : {}) });
  context.writeOut(`✅ Validated ${result.count} formulas successfully.\n`);
}

function requireTarget(command: string, target: string | undefined): string {
  if (!target) throw new Error(`formula ${command} requires a target`);
  return target;
}
