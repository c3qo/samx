import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseRegistryUrl } from "./store.js";

const gitProtocolConfig = ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=user"];

export async function cloneOrFetchRegistry(url: string, path: string): Promise<void> {
  parseRegistryUrl(url);
  if (await isGitRepo(path)) {
    if (!registryUrlsEquivalent(await runGit(["-C", path, "remote", "get-url", "origin"]), url)) {
      throw new Error(`Registry checkout origin mismatch: ${path}`);
    }
    await runGit([...gitProtocolConfig, "-C", path, "fetch", "origin", "--prune"]);
    await runGit([...gitProtocolConfig, "-C", path, "pull", "--ff-only"]);
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await runGit([...gitProtocolConfig, "clone", url, path]);
}

export function registryUrlsEquivalent(left: string, right: string): boolean {
  return normalizeRegistryUrl(left) === normalizeRegistryUrl(right);
}

function normalizeRegistryUrl(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\.git$/u, "");
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return value.replace(/\/+$/u, "").replace(/\.git$/u, "");
  }
}

export async function gitHead(path: string): Promise<string> {
  return runGit(["-C", path, "rev-parse", "HEAD"]);
}

export async function resolveRemoteSourceHead(url: string): Promise<string> {
  parseRegistryUrl(url);
  const output = await runGit([...gitProtocolConfig, "ls-remote", "--symref", url, "HEAD"]);
  const commit = output
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .find((parts) => parts[1] === "HEAD" && isCommit(parts[0]))?.[0];
  if (!commit) {
    throw new Error(`Unable to resolve source HEAD: ${url}`);
  }
  return commit;
}

export async function resolveRemoteSourceRef(url: string, ref: string): Promise<string> {
  parseRegistryUrl(url);
  validateSourceRef(ref);
  const output = await runGit([
    ...gitProtocolConfig,
    "ls-remote",
    url,
    `refs/heads/${ref}`,
    `refs/tags/${ref}`,
    `refs/tags/${ref}^{}`,
  ]);
  const commit = output
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .find((parts) => isCommit(parts[0]))?.[0];
  if (!commit) {
    throw new Error(`Unable to resolve source ref: ${ref}`);
  }
  return commit;
}

function validateSourceRef(ref: string): void {
  if (
    ref.length === 0 ||
    ref.startsWith("-") ||
    ref.startsWith("refs/") ||
    ref.includes("/") ||
    ref.includes("\\") ||
    ref.includes("..") ||
    /\s/u.test(ref)
  ) {
    throw new Error(`Invalid source ref: ${ref}`);
  }
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await runGit(["-C", path, "rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

function isCommit(value: string | undefined): boolean {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

async function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(err || `git ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}
