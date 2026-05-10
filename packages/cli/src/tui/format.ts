const secretKeySegments = new Set([
  "key",
  "token",
  "api",
  "apikey",
  "password",
  "credential",
  "auth",
  "bearer",
]);
const secretKeyPhrases = new Set([
  "api_key",
  "access_key",
  "private_key",
  "secret_key",
  "github_token",
]);

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const suffixLength = Math.max(4, Math.floor((maxLength - 1) / 2));
  const prefixLength = maxLength - suffixLength - 1;
  return `${value.slice(0, prefixLength)}…${value.slice(-suffixLength)}`;
}

export function safeLine(value: string, maxLength = 96): string {
  return truncateMiddle(
    value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "").replace(/[\u0000-\u001f\u007f]+/gu, " "),
    maxLength
  );
}

export function safeBlock(value: string, maxLength = 1200): string {
  return truncateMiddle(
    value
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu, " "),
    maxLength
  );
}

export function redactedJson(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    if (depth > 4) return "[truncated]";
    return value.slice(0, 8).map((item) => redactedJson(item, depth + 1));
  }

  if (isRecord(value)) {
    if (depth > 4) return "[truncated]";
    const entries = Object.entries(value)
      .slice(0, 24)
      .map(([key, item]) => [
        key,
        shouldRedactKey(key) ? "[redacted]" : redactedJson(item, depth + 1),
      ]);
    return Object.fromEntries(entries);
  }

  if (typeof value === "string") return safeLine(value, 120);
  return value;
}

export function renderPreviewJson(value: unknown, maxLength = 1200): string {
  return truncateMiddle(JSON.stringify(redactedJson(value), null, 2), maxLength);
}

export function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (secretKeyPhrases.has(normalized)) return true;
  const segments = normalized.split(/[^a-z0-9]+|(?=[A-Z])/u).filter(Boolean);
  return segments.some((segment) => secretKeySegments.has(segment)) || segments.includes("secret");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
