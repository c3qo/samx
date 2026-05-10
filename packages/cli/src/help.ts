const linkTargets = "claude, codex, opencode, kiro";

export function renderHelp(args: string[]): string | undefined {
  if (args.length === 0 || isHelp(args[0])) return topLevelHelp();
  if (!args.some(isHelp)) return undefined;

  const [command, subcommand] = args;
  if (command === "analyze") return analyzeHelp();
  if (command === "registry") return registryHelp(subcommand);
  if (command === "formula") return formulaHelp(subcommand);
  if (command === "pkg") return pkgHelp(subcommand);
  if (command === "search") return searchHelp();
  if (command === "capability") return capabilityHelp(subcommand);
  if (command === "bundle") return bundleHelp(subcommand);
  if (command === "add") return addHelp();
  if (command === "remove") return removeHelp();
  if (command === "link") return linkHelp();
  if (command === "unlink") return unlinkHelp();
  if (command === "tui") return tuiHelp();
  return undefined;
}

function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

function topLevelHelp(): string {
  return `samx

Usage:
  $ samx <command> [options]

Commands:
  analyze [projectRoot]       Analyze SAMX-managed state
  registry <command>          Manage formula registries
  formula <command>           Generate formula drafts
  search <query>              Search local registry formulas
  pkg <command>               Manage SAMX packages
  capability <command>        Browse synced capabilities
  bundle <command>            Manage capability bundles
  add <formula | capability-id> Install and link a capability into the current project
  remove <capability-id | alias>  Unlink and remove a capability from the current project
  link <bundle-id>               Link a bundle into an agent tool
  unlink <bundle-id>             Remove linked bundle outputs
  tui                         Open the interactive terminal UI

For more info, run any command with the --help flag:
  $ samx analyze --help
  $ samx registry --help
  $ samx formula --help
  $ samx search --help
  $ samx pkg --help
  $ samx capability --help
  $ samx bundle --help
  $ samx add --help
  $ samx remove --help
  $ samx link --help
  $ samx unlink --help
  $ samx tui --help
`;
}

function addHelp(): string {
  return `samx add

Installs packages when needed, adds selected capabilities to a project bundle, then links the bundle.
With no --bundle, uses the linked project bundle or creates one for the current directory.
Bare searches such as stripe may ask for confirmation before changing files.

Usage:
  $ samx add <formula | capability-id> [options]

Options:
  --as <alias>          Alias for bundle output
  --bundle <bundle-id>     Bundle id
  --tool <tool>         Link target: ${linkTargets}
  --dry-run             Preview without writing
  --overwrite           Overwrite existing generated files
  --allow-advisories    Apply link with formula advisories

Examples:
  $ samx add stripe/ai --bundle coding --tool claude
  $ samx add obra/superpowers:skills-code-review --bundle coding --tool opencode
  $ samx add default/obra/superpowers:agents-reviewer --as reviewer --bundle coding --tool claude
`;
}

function removeHelp(): string {
  return `samx remove

Removes capabilities from a project bundle, unlinks current outputs, then relinks remaining items.
Omit the argument to select capabilities from the target bundle.
Use --bundle to choose the bundle; positional arguments are capability queries, ids, or aliases.
Use samx unlink <bundle-id> to remove all outputs, or samx bundle destroy <bundle-id> to delete a bundle.

Usage:
  $ samx remove [capability-id | alias] [options]

Options:
  --bundle <bundle-id>     Bundle id
  --tool <tool>         Link target: ${linkTargets}
  --dry-run             Preview without writing
  --overwrite           Overwrite existing generated files when relinking remaining items
  --allow-advisories    Apply relink with remaining formula advisories

Examples:
  $ samx remove --bundle coding --tool claude
  $ samx remove obra/superpowers:skills-code-review --bundle coding --tool opencode
  $ samx remove reviewer --bundle coding --tool claude
`;
}

function formulaHelp(subcommand: string | undefined): string {
  if (subcommand === "generate") {
    return `samx formula generate

Generate a formula draft from a Git repository.

Usage:
  $ samx formula generate <repo-url> [options]

Options:
  --ref <name>               Resolve source ref instead of default HEAD
  --out <path>               Write formula draft to path
  --model <name>             OpenAI model name
  --endpoint <url>           OpenAI-compatible API base URL
  --json                     Print JSON output
  --force                    Overwrite existing output
`;
  }
  if (subcommand === "discover-mcp") {
    return `samx formula discover-mcp

Discover remote MCP servers from a web list and write reviewable JSON.

Usage:
  $ samx formula discover-mcp <url> [options]

Options:
  --out <path>               Write discovery JSON to path
  --model <name>             OpenAI model name
  --endpoint <url>           OpenAI-compatible API base URL
  --crawl-depth <count>      Same-origin crawl depth
  --max-pages <count>        Maximum pages to fetch
  --max-page-bytes <bytes>   Maximum bytes to fetch per page
  --json                     Print JSON output
  --strict                   Fail when discovery contains invalid candidates
`;
  }
  if (subcommand === "generate-mcp") {
    return `samx formula generate-mcp

Generate virtual MCP formula YAML from discovery JSON.

Usage:
  $ samx formula generate-mcp <json> [options]

Options:
  --out-dir <path>           Write generated formulas under directory
  --namespace <name>         Formula namespace
  --strict                   Fail when discovery contains invalid candidates
  --force                    Overwrite existing output
`;
  }
  if (subcommand === "generate-mcp-list") {
    return `samx formula generate-mcp-list

Discover remote MCP servers from a web list and generate virtual MCP formulas.

Usage:
  $ samx formula generate-mcp-list <url> [options]

Options:
  --out-dir <path>           Write generated formulas under directory
  --namespace <name>         Formula namespace
  --model <name>             OpenAI model name
  --endpoint <url>           OpenAI-compatible API base URL
  --crawl-depth <count>      Same-origin crawl depth
  --max-pages <count>        Maximum pages to fetch
  --max-page-bytes <bytes>   Maximum bytes to fetch per page
  --strict                   Fail when discovery contains invalid candidates
  --force                    Overwrite existing output
`;
  }
  if (subcommand === "show") {
    return `samx formula show

Show a local registry formula.

Usage:
  $ samx formula show <formula>
`;
  }
  if (subcommand === "validate") {
    return `samx formula validate

Validate formula YAML files.

Usage:
  $ samx formula validate [path]
`;
  }

  return `samx formula

Generate and manage formula drafts.

Usage:
  $ samx formula <command>

Commands:
  formula generate <repo-url>      Generate a formula draft from a Git repository
  formula discover-mcp <url>       Discover remote MCP servers from a web list
  formula generate-mcp <json>      Generate virtual MCP formulas from discovery JSON
  formula generate-mcp-list <url>  Discover and generate virtual MCP formulas
  formula show <formula>           Show a local registry formula
  formula validate [path]           Validate formula YAML files
`;
}

function analyzeHelp(): string {
  return `samx analyze

Analyze SAMX-managed packages, capabilities, bundles, links, and findings.

Usage:
  $ samx analyze [projectRoot] [options]

Options:
  --paths                   Print SAMX-managed package, capability, and link paths only
  --inventory               Print SAMX-managed inventory only
  --show <item-id>               Show one package, capability, bundle, link, or finding as JSON
  --json                    Render the full report as JSON
  --format <format>         Render format. Supported: json, markdown

Examples:
  $ samx analyze .
  $ samx analyze . --inventory
  $ samx analyze . --show default/acme/tools:review
  $ samx analyze . --format markdown
`;
}

function registryHelp(subcommand: string | undefined): string {
  if (subcommand === "add") {
    return `samx registry add

Add a formula registry.

Usage:
  $ samx registry add <registry-id> <url> [--no-clone]

Options:
  --no-clone                Record registry without cloning it
`;
  }
  if (subcommand === "trust") {
    return `samx registry trust

Trust a formula registry.

Usage:
  $ samx registry trust <registry-id>
`;
  }
  if (subcommand === "remove") {
    return `samx registry remove

Remove a formula registry when no installed package uses it.

Usage:
  $ samx registry remove <registry-id> [--force]

Options:
  --force                   Remove registry metadata and checkout while leaving installed packages untouched
`;
  }
  if (subcommand === "sync") {
    return `samx registry sync

Clone or fetch all registries, or one named registry.

Usage:
  $ samx registry sync [registry-id]
`;
  }
  if (subcommand === "list") {
    return `samx registry list

List configured registries and trust status.

Usage:
  $ samx registry list
`;
  }

  return `samx registry

Manage formula registries.

Usage:
  $ samx registry <command>

Commands:
  registry add <registry-id> <url>   Add a registry
  registry trust <registry-id>       Trust a registry
  registry sync [registry-id]        Clone or fetch all registries, or one named registry
  registry remove <registry-id>      Remove a registry
  registry list             List registries
`;
}

function searchHelp(): string {
  return `samx search

Search local registry formulas.

Usage:
  $ samx search <query>
`;
}

function pkgHelp(subcommand: string | undefined): string {
  if (subcommand === "install") {
    return `samx pkg install

Install a formula or local development package to the SAMX package store.

Usage:
  $ samx pkg install <formula>
  $ samx pkg install <formula> --head [--ref <name>]
  $ samx pkg install --local <local-package-id> <path>

Arguments:
  formula            Formula id, for example example/safe-bash
  local-package-id   Local package id
  path               Local package source directory

Examples:
  $ samx pkg install example/safe-bash
  $ samx pkg install example/safe-bash --head --ref main
  $ samx pkg install --local local-tools ../tools
`;
  }
  if (subcommand === "update") {
    return `samx pkg update

Update all formula packages or one formula package.

Usage:
  $ samx pkg update [formula]
  $ samx pkg update [formula] --head [--ref <name>] [--yes]

Arguments:
  formula   Optional formula id. If omitted, all packages in samx.lock are updated.

Examples:
  $ samx pkg update
  $ samx pkg update example/safe-bash
  $ samx pkg update example/safe-bash --head --ref main --yes
`;
  }
  if (subcommand === "list") {
    return `samx pkg list

List configured package ids.

Usage:
  $ samx pkg list
`;
  }
  if (subcommand === "uninstall") {
    return `samx pkg uninstall

Uninstall a package from the SAMX package store. This does not unlink existing bundle outputs.

Usage:
  $ samx pkg uninstall <package-id>

Arguments:
  package-id   Formula or local package id to remove
`;
  }

  return `samx pkg

Manage formula and local packages.

Usage:
  $ samx pkg <command>

Commands:
  pkg install <formula>      Install a formula package
  pkg install --local <local-package-id> <path> Install a local package
  pkg update [formula]       Update all formula packages or one formula package
  pkg list                   List configured packages
  pkg uninstall <package-id> Uninstall a formula or local package
`;
}

function capabilityHelp(subcommand: string | undefined): string {
  if (subcommand === "list") {
    return `samx capability list

List synced capabilities from the SAMX package store.

Usage:
  $ samx capability list [options]

Options:
  --type <type>              Filter by type. Supported: skill, agent, mcp
`;
  }
  if (subcommand === "show") {
    return `samx capability show

Show one synced capability by id.

Usage:
  $ samx capability show <capability-id>

Arguments:
  capability-id   Capability id from samx capability list
`;
  }

  return `samx capability

Browse synced capabilities from configured packages.

Usage:
  $ samx capability <command>

Commands:
  capability list            List synced capabilities, optionally by --type
  capability show <capability-id>       Show one synced capability
`;
}

function bundleHelp(subcommand: string | undefined): string {
  if (subcommand === "create") {
    return `samx bundle create

Create an empty capability bundle.

Usage:
  $ samx bundle create <bundle-id>
`;
  }
  if (subcommand === "add") {
    return `samx bundle add

Add a capability to a bundle.

Usage:
  $ samx bundle add <bundle-id> <capability-id> [options]

Options:
  --as <alias>               Alias destination name when linking

Example:
  $ samx bundle add coding obra/superpowers:skills-code-review --as review-code
  $ samx bundle add coding obra/superpowers:agents-reviewer
  $ samx bundle add coding obra/superpowers:mcp-github
`;
  }
  if (subcommand === "remove") {
    return `samx bundle remove

Remove a capability from a bundle.

Usage:
  $ samx bundle remove <bundle-id> <capability-id>

Example:
  $ samx bundle remove coding obra/superpowers:skills-code-review
`;
  }
  if (subcommand === "destroy") {
    return `samx bundle destroy

Destroy a whole bundle. This does not unlink existing bundle outputs.

Usage:
  $ samx bundle destroy <bundle-id>
`;
  }
  if (subcommand === "show") {
    return `samx bundle show

Show bundle contents.

Usage:
  $ samx bundle show <bundle-id>
`;
  }
  if (subcommand === "list") {
    return `samx bundle list

List bundles.

Usage:
  $ samx bundle list
`;
  }
  if (subcommand === "check") {
    return `samx bundle check

Check whether a bundle can link to a tool target.

Usage:
  $ samx bundle check <bundle-id> --tool <tool>

Options:
  --tool <tool>              Required. One of: ${linkTargets}
`;
  }
  return `samx bundle

Create and manage capability bundles.

Usage:
  $ samx bundle <command>

Commands:
  bundle create <bundle-id>                 Create an empty bundle
  bundle add <bundle-id> <capability-id>           Add a capability to a bundle
  bundle remove <bundle-id> <capability-id>        Remove a capability from a bundle
  bundle destroy <bundle-id>                Destroy a whole bundle
  bundle show <bundle-id>                   Show bundle contents
  bundle list                        List bundles
  bundle check <bundle-id> --tool <tool>    Check if a bundle can link to a tool
`;
}

function linkHelp(): string {
  return `samx link

Link a bundle into an agent tool by creating SAMX-managed outputs.

Usage:
  $ samx link <bundle-id> --tool <tool> [options]

Options:
  --tool <tool>              Required. One of: ${linkTargets}
  --project <path>           Project root. Defaults to current directory.
  --dry-run                  Preview outputs without writing
  --overwrite                Replace existing SAMX-managed symlinks
  --allow-advisories         Apply link even when selected formula packages have advisories

Examples:
  $ samx link coding --tool claude
  $ samx link coding --tool opencode --project . --dry-run
`;
}

function unlinkHelp(): string {
  return `samx unlink

Remove SAMX-managed linked outputs for a bundle and tool.

Usage:
  $ samx unlink <bundle-id> --tool <tool> [options]

Options:
  --tool <tool>              Required. One of: ${linkTargets}
  --project <path>           Project root. Defaults to current directory.
  --dry-run                  Preview removals without deleting

Examples:
  $ samx unlink coding --tool claude
  $ samx unlink coding --tool opencode --project . --dry-run
`;
}

function tuiHelp(): string {
  return `samx tui

Open the interactive terminal UI for package management, capability browsing,
bundle management, and safe link/unlink workflows.

Usage:
  $ samx tui

Notes:
  Requires an interactive TTY. In scripts, use the regular samx commands.
`;
}
