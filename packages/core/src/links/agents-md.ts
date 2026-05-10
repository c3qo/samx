export function agentsMdBlock(bundleId: string, tool: string, content: string): string {
  const trimmed = content.trim();
  return `${beginMarker(bundleId, tool)}\n${trimmed}\n${endMarker(bundleId, tool)}`;
}

export function mergeAgentsMd(
  existing: string,
  bundleId: string,
  tool: string,
  content: string
): string {
  const withoutBlock = removeAgentsMdBlock(existing, bundleId, tool).trimEnd();
  const block = agentsMdBlock(bundleId, tool, content);
  return withoutBlock.length > 0 ? `${withoutBlock}\n\n${block}\n` : `${block}\n`;
}

export function removeAgentsMdBlock(existing: string, bundleId: string, tool: string): string {
  const begin = beginMarker(bundleId, tool);
  const end = endMarker(bundleId, tool);
  const pattern = new RegExp(
    `\\n{0,2}${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`,
    "g"
  );
  return existing.replace(pattern, (match) =>
    match.startsWith("\n") && match.endsWith("\n") ? "\n" : ""
  );
}

function beginMarker(bundleId: string, tool: string): string {
  return `<!-- SAMX:BEGIN bundle=${sentinelValue(bundleId)} tool=${sentinelValue(tool)} -->`;
}

function endMarker(bundleId: string, tool: string): string {
  return `<!-- SAMX:END bundle=${sentinelValue(bundleId)} tool=${sentinelValue(tool)} -->`;
}

function sentinelValue(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
