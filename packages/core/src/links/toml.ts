function renderCodexMcpTable(
  serverName: string,
  value: Record<string, unknown>,
  tablePath = ["mcp_servers"]
): string {
  const lines = [
    `# SAMX:BEGIN mcp_server=${sentinelValue(serverName)}`,
    `[${[...tablePath, serverName].map(tomlKeySegment).join(".")}]`,
  ];
  for (const [key, entryValue] of Object.entries(value)) {
    lines.push(`${tomlKeySegment(key)} = ${renderTomlValue(entryValue)}`);
  }
  lines.push(`# SAMX:END mcp_server=${sentinelValue(serverName)}`);
  return lines.join("\n");
}

export function mergeCodexMcpTables(
  existing: string,
  entries: Array<{ key: string; value: Record<string, unknown> }>,
  tablePath = ["mcp_servers"]
): string {
  const withoutManaged = removeCodexMcpTables(
    existing,
    entries.map((entry) => entry.key),
    tablePath
  );
  const blocks = entries
    .map((entry) => renderCodexMcpTable(entry.key, entry.value, tablePath))
    .join("\n\n");
  if (!blocks) return withoutManaged;
  if (!withoutManaged.trim()) return `${blocks}\n`;
  return `${withoutManaged.replace(/\s*$/u, "\n\n")}${blocks}\n`;
}

export function removeCodexMcpTables(
  existing: string,
  keys: string[],
  tablePath = ["mcp_servers"]
): string {
  let current = existing;
  for (const key of keys) {
    current = current.replace(managedBlockPattern(key, tablePath), "");
  }
  return current.replace(/\n{3,}/g, "\n\n");
}

function managedBlockPattern(key: string, tablePath: string[]): RegExp {
  const encoded = escapeRegExp(sentinelValue(key));
  const header = escapeRegExp(`[${[...tablePath, key].map(tomlKeySegment).join(".")}]`);
  return new RegExp(
    `\\n?# SAMX:BEGIN mcp_server=${encoded}\\n${header}\\n[\\s\\S]*?# SAMX:END mcp_server=${encoded}\\n?`,
    "gu"
  );
}

function renderTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  if (isRecord(value))
    return `{ ${Object.entries(value)
      .map(([key, entryValue]) => `${tomlKeySegment(key)} = ${renderTomlValue(entryValue)}`)
      .join(", ")} }`;
  throw new Error("Unsupported Codex MCP TOML value");
}

function tomlKeySegment(value: string): string {
  if (/^[A-Za-z0-9_-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}

function sentinelValue(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
