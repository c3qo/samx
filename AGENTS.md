# AGENTS.md

## Rule 1 — Think Before Coding

State assumptions explicitly. Ask rather than guess.
Push back when a simpler approach exists. Stop when confused.

## Rule 2 — Simplicity First

Minimum code that solves the problem. Nothing speculative.
No abstractions for single-use code.

## Rule 3 — Surgical Changes

Touch only what you must. Don't improve adjacent code.
Match existing style. Don't refactor what isn't broken.

## Rule 4 — Goal-Driven Execution

Define success criteria. Loop until verified.
Strong success criteria let Claude loop independently.

## Project Shape

- SAMX is a pnpm TypeScript monorepo. Use `pnpm`, not npm/yarn.
- Packages: `packages/schemas` owns Zod/domain types and plugin config schemas, `packages/core` owns scan/classify/parse/infer/probe/report/export plus registry/formula/local-package/bundle/link logic, `packages/cli` owns `cac` command wiring and the bundled CLI build.
- Core entrypoint is `packages/core/src/index.ts`; CLI entrypoint is `packages/cli/src/index.ts` and exposes injectable `runCli()` for tests.
- `DESIGN.md` is the original product/source-scope doc; current implementation has pivoted toward package/capability/bundle/link. Trust package scripts and tests over design prose when they disagree.

## Commands

- Install: `pnpm install`
- Full verification: `pnpm typecheck && pnpm test && pnpm build && pnpm run lint`
- Typecheck one package: `pnpm --filter @c3qo/samx-core typecheck`, `pnpm --filter @c3qo/samx-schemas typecheck`, or `pnpm --filter @c3qo/samx typecheck`
- Run one test file: `pnpm vitest run packages/core/test/scanner.test.ts`
- Run CLI tests only: `pnpm vitest run packages/cli`
- Build before CLI smoke tests: `pnpm build` bundles `packages/cli/dist/index.js`, copies built-in config packs into `packages/cli/dist/config/packs`, and creates `packages/cli/node_modules/.bin/samx` via `packages/cli/scripts/link-bin.mjs`.
- CLI smoke: `pnpm --filter @c3qo/samx exec samx analyze packages/cli/test/fixtures/messy-project`
- Pack smoke: run `pnpm --dir packages/cli pack`, install the resulting `c3qo-samx-0.1.0-beta.0.tgz` in a temp project, then run `samx --help` and `samx analyze .`.

## Current CLI Surface

- Primary package flow: `samx registry add|sync|list|trust|remove`, `samx search <query>`, `samx formula show <owner>/<repo>`, `samx formula generate <repo-url> [--endpoint <api-base-url>]`, `samx formula discover-mcp <url>`, `samx formula generate-mcp <json>`, `samx formula generate-mcp-list <url>`, `samx pkg install <owner>/<repo> [--head [--ref <name>]]`, `samx pkg install --local <id> <path>`, `samx pkg update [formula] [--head [--ref <name>]] [--yes]`, `samx pkg uninstall <id> [--force]`, `samx capability list|show`, `samx bundle create|add|remove|destroy|show|list|check`, `samx link <bundle> --tool <tool>`, `samx unlink <bundle> --tool <tool>`, top-level `samx add <formula | capability-id>` and `samx remove [capability-id | alias]` porcelain commands, and the interactive `samx tui`.
- SAMX stores registries, formula package checkouts, local package records, bundles, and link records under `~/.samx` by default; only `SAMX_HOME` changes that store location. Formula installs live under `packages/<registry>/<owner>/<repo>/source`; local package records live in `local-packages.json` and point at user-owned source directories.
- Formula and local packages index skills, agents, and MCP servers from `skills/<name>/SKILL.md`, `agents/<name>/AGENT.md`, `agents/<name>/agent.md`, `mcp/<name>/mcp.json`, direct MCP config files, and spec-backed virtual MCP formulas. Formula capability ids are `<registry>/<owner>/<repo>:<capability-id>` from the recipe; local package capability ids are `<local-id>:skills-<name>`, `<local-id>:agents-<name>`, and `<local-id>:mcp-<name>` or source-derived MCP names. Use `samx capability list --type skill|agent|mcp` to filter.
- `samx bundle add <bundle> <capability-id>` and `samx bundle remove <bundle> <capability-id>` infer default-registry capability ids from `<owner>/<repo>:<capability>` and store canonical `default/<owner>/<repo>:<capability>` internally. Custom registries must stay explicit, such as `local/<owner>/<repo>:<capability>`. Do not hardcode skill-only bundle additions in CLI flows.
- Top-level `samx add <formula | capability-id>` is project-level porcelain: it installs the package if needed, adds one or more capabilities to a project bundle, then links that bundle into the target tool. Formula ids without `:` are resolved from registry metadata before install; a single capability is selected automatically, while multiple capabilities open a TTY multi-select picker and non-TTY runs print explicit capability ids. If `--bundle` is omitted, only bundles already linked to the current `projectRoot` count as project bundles; unlinked global/user bundles must not be mutated. With no project bundle, create a sanitized cwd-named bundle (suffixing on global-name collisions). With one project bundle, use it and print a tip. With multiple project bundles, prompt in TTY or require `--bundle` in non-TTY. `samx remove` accepts an optional capability id/alias; with none, it selects from the current project bundle in TTY and prints candidates in non-TTY. It unlinks, removes selected bundle items, relinks remaining items, and never uninstalls package cache or creates a new project bundle.
- Local AI config analysis: `samx analyze [path]` replaces the old top-level `doctor`, `scan`, `list`, and `show` surfaces. Use `--paths`, `--inventory`, `--show <id>`, `--json`, or `--format markdown` for narrower output.
- Bundle readiness checks live under `samx bundle check <bundle> --tool <tool>` for link targets `claude`, `codex`, `opencode`, and `kiro`.
- `samx tui` is an Ink-based interactive frontend for package management, capability browsing, bundle creation, link preview/apply, and unlink confirmation. It requires a TTY; `samx tui --help` must print help without launching Ink.

## CLI and Safety Gotchas

- `samx analyze` defaults to project scope. Home-level config paths are opt-in via `--home` or `--all`.
- `samx analyze <path>` must keep explicit path classification relative to the scanned root, not the package cwd.
- Agent Scan support only ingests an existing JSON report. Do not install or run Agent Scan from SAMX.
- `samx formula generate --endpoint` accepts an OpenAI-compatible API base URL such as `http://host:port/v1`; core appends `/responses`. Do not pass or accept a full `/responses` URL. Default base is `https://api.openai.com/v1`.
- Registry URLs and formula git source URLs must use `https:`, `git:`, `ssh:`, or `file:` transports; registry code also accepts absolute local paths for local test/dev registries. Git operations set `protocol.ext.allow=never` and `protocol.file.allow=user`; do not remove those flags. Registry sync fetches `origin`, not `--all`.
- The `default` registry is built in, must be persisted when `registries.json` is created or rewritten, and cannot be removed or replaced through CLI even with `--force`. `samx registry sync` without an id syncs all registries, including `default`.
- `samx registry remove <id>` refuses to remove a non-default registry while installed formula packages from that registry remain. `--force` bypasses only that registry-use blocker: it removes the registry record and checkout, leaves packages, bundles, and links untouched, and means those packages cannot update until the registry is added again. Do not make registry removal unlink outputs or delete packages implicitly.
- Formula source revisions must be locked 40- or 64-character lowercase hex commits. `samx pkg install|update --head [--ref <name>]` is an explicit operation override that resolves a branch/tag/default HEAD to a locked commit in `recipe.lock.json`; `--ref` accepts branch/tag names only. `defaultMaterialize()` checks out detached and asserts `git rev-parse HEAD` equals the locked revision.
- Formula `file://` sources are allowed only from trusted registries or local `file://` registries. Central/community registries must not point formulas at arbitrary local paths.
- Formula update preview uses `previewFormulaPackageUpdate()` to compare installed `recipe.lock.json` with a resolved candidate and render field-level changes, including `source.revision` changes from `--head`. `pkg update --yes` applies; plain `pkg update` previews only.
- Package uninstall checks bundles and link records. `--force` bypasses link-record blockers but not bundle references; remove bundle items first when a bundle still references the package.
- `generic-markdown` is not a link target. `samx link` should only target real tool layouts: `claude`, `codex`, `opencode`, and `kiro`.
- Link targets are data-driven via built-in plugin pack `linkTargets` YAML, but filesystem safety stays in code. Reject absolute paths and `..` traversal in target roots/outputs.
- Skill and agent directory link targets create real symlinks to source capability directories. Do not add copy fallbacks for active link behavior.
- MCP package files may be direct single-server configs, `{ "mcpServers": { "<name>": { ... } } }`, OpenCode `{ "mcp": { "<name>": { ... } } }`, Claude API-style `{ "mcp_servers": [...], "tools": [...] }`, or Codex `.codex/config.toml` `[mcp_servers.<name>]` tables. Formula MCP capabilities may also be inline `spec` entries for virtual remote or stdio servers.
- MCP link transforms are target-aware. Claude writes `.mcp.json` under `mcpServers` and uses scoped keys derived from package id plus capability name; default-registry MCP keys omit the `default/` prefix and dedupe repeated package/capability basenames. Remote MCP servers render as `{ "type": "http", "url": "https://..." }`. OpenCode writes `.opencode/opencode.json` under `mcp` and uses scoped keys with `type: "remote"` for remote servers. Codex writes native skills to `.agents/skills`, agents to `AGENTS.md`, and MCP to `.codex/config.toml` `[mcp_servers.<name>]` tables; remote MCP servers map to `url`. Kiro keeps Claude-local-style stdio support and rejects remote MCP.
- MCP link targets merge SAMX-managed server entries into the configured MCP file and unlink only recorded keys. Do not delete whole MCP files as part of unlink.
- Hook support differs by tool. OpenCode auto-infers top-level hooks from package `hooks/*.js`, `hooks/*.mjs`, single-level `.opencode/plugins/*.js`, and single-level `.opencode/plugins/*.mjs`, plus adjacent `skills/<name>/hooks/opencode.{js,mjs}` and `agents/<name>/hooks/opencode.{js,mjs}`; `samx link --tool opencode` links them by default, `--no-hooks` skips them, and SAMX never writes `samx.package.json` during sync or link. Formula package advisories block link apply unless `--allow-advisories` is passed. Top-level OpenCode hooks only apply when the package contributes at least one selected skill or agent; MCP-only participation skips them with a warning. Claude hooks remain manifest-driven through `samx.package.json` and merge only SAMX-managed sentinel entries into `.claude/settings.json`. Unlink must remove only recorded hook outputs.
- `samx formula generate` records deterministic hook inventory from repo source. Representable hook files become formula `hooks.entries`; unrepresentable hook-like files become persisted `advisories`. Generation must not trust or preserve LLM-supplied `hooks` or `source`; SAMX injects source metadata and scans hooks from the checked-out tree.
- `samx formula generate` sends the LLM only `RepositoryContext`: resolved source metadata, context `fileTree`, bounded context `files` content, locally scanned `capabilities`, and locally scanned hook inventory. The LLM returns a candidate with `id`, `name`, `description`, `capabilities`, `requirements`, and `requirementEvidence`; SAMX validates evidence, merges local scanned capabilities, injects locked source metadata, and uses local hook scan output instead of LLM-supplied `hooks` or `source`.
- Formula generation scans top-level `hooks/*`, single-level `.opencode/plugins/*`, adjacent `hooks/*` under scanned skill/agent capability directories, and valid `samx.package.json` hook declarations. Do not treat arbitrary nested `/hooks/` paths such as `test/fixtures/hooks/*` as hook inventory. Nested `.opencode/plugins/**` files are advisories, not hook entries.
- Registry formula YAML lives under lowercase `formulas/<owner>/<repo>.yaml`; do not use legacy `Formula/` paths in code, docs, tests, recipes, or lock records.
- Formula generation follows the Agent Skills `SKILL.md` frontmatter spec for skills: use frontmatter `description` as formula capability `description`; do not derive descriptions from instruction sentinel blocks such as `<SUBAGENT-STOP>`. Formula capabilities use `description`, not `summary`, and must not include `metadata` copied from skills or agents.
- Generated formula hook entries propagate through recipe locks and generated capability indexes. `samx link` surfaces selected package advisories and requires `--allow-advisories` before applying links with advisories.
- Hook declarations use `files: [{ target, path }]`; do not add or preserve separate `targets` arrays or object-shaped `files: { opencode: ... }` in formulas, recipes, tests, or manifests.
- Formula capability `path` may point at a capability directory or known file. Directory paths use optional `entry`; defaults are `SKILL.md` for skills, `AGENT.md` or `agent.md` for agents, and `mcp.json` for MCP. File paths must omit `entry`.
- `regenerateCapabilities()` writes a generated formula `capabilities.json` and a canonical `index.json`; both are schema-validated before write. Validate recipe capability paths and entries against the materialized temp source before writing recipe locks or `samx.lock` so failed installs do not leave partial package state.
- Recipe audit files use timestamped names with numeric suffixes for same-millisecond writes. Keep `overwrite: false` semantics so audit records are never clobbered.
- TUI screens must call the `packages/cli/src/tui/api.ts` facade rather than importing `@c3qo/samx-core` directly. Link preview uses `TuiApi.previewLink()` before apply; overwrite retry must re-preview and require confirmation again.
- OpenCode legacy copy-record migration is intentionally scoped by config with `allowLegacySkillFileRecords: true`.

## Test Fixtures

- `packages/cli/test/fixtures/messy-project` is the analyze E2E fixture. It intentionally contains a Claude skill, Cursor rule, MCP configs, missing `GITHUB_TOKEN`, broad `/Users/` filesystem access, and `curl | bash`.
- `scripts/smoke/fixtures/e2e-skill-package` is the smoke fixture used by `scripts/smoke/e2e-skill-formula.sh` for local package and formula install/link coverage.
- E2E tests inject a `probeRunner`; do not make them depend on the host having `gh`, `npx`, Docker, or tokens installed.
- Scanner tests depend on symlink/root-containment behavior. Do not enable `fast-glob` symlink following for project scans.

## Reporting and Output

- Report and bundle Markdown renderers handle untrusted local file content. Escape Markdown/HTML, normalize terminal control text, and fence snippets before adding new output fields.
- Formula `search` and `show` output strips terminal control text before writing to stdout. Preserve that when adding new formula fields.
- Duplicate terminal top findings are grouped by title/category/status. Preserve that behavior so one missing env var does not flood reports.

## Concepts

- Registry: searchable catalog of what exists.
- Formula: one catalog entry.
- Recipe: formula after SAMX validates/resolves it.
- Package: installed formula source under `~/.samx/packages` or local source tracked by `local-packages.json`.
- Capability: skill/agent/MCP exposed by package.
- Bundle: user-selected group of capabilities.
- Link record: what SAMX wrote/symlinked into target tool.
