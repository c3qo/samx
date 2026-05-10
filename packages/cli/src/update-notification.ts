import updateNotifier from "update-notifier";

import packageJson from "../package.json" with { type: "json" };

export interface UpdateNotificationOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  writeErr(chunk: string): void;
  updateNotifier?: UpdateNotifier;
}

interface UpdateResult {
  update?: {
    current: string;
    latest: string;
  };
}

type UpdateNotifier = (options: {
  pkg: { name: string; version: string };
  updateCheckInterval: number;
}) => UpdateResult | undefined;

const updateCheckInterval = 24 * 60 * 60 * 1000;

export function maybeNotifyUpdate(options: UpdateNotificationOptions): void {
  if (shouldSkipUpdateCheck(options.args, options.env)) {
    return;
  }

  try {
    const notifier = options.updateNotifier ?? updateNotifier;
    const result = notifier({
      pkg: { name: packageJson.name, version: packageJson.version },
      updateCheckInterval,
    });
    if (!result?.update) {
      return;
    }

    options.writeErr(
      `Update available: ${packageJson.name} ${result.update.current} -> ${result.update.latest}\n`
    );
    options.writeErr(`Run npm install -g ${packageJson.name} to update.\n`);
  } catch {
    // Update checks are advisory and must never fail user commands.
  }
}

function shouldSkipUpdateCheck(args: string[], env: NodeJS.ProcessEnv): boolean {
  return (
    env.CI === "true" || env.SAMX_NO_UPDATE_CHECK === "1" || args.includes("--no-update-check")
  );
}
