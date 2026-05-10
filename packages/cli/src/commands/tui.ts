import { createTuiApi } from "../tui/api.js";
import { renderTui } from "../tui/render.js";
import type { CliContext, SamxCli } from "../index.js";

export function registerTuiCommand(cli: SamxCli, context: CliContext): void {
  cli.command("tui", "Open the interactive terminal UI").action(() => {
    context.setAction(handleTui(context));
  });
}

async function handleTui(context: CliContext): Promise<void> {
  if (!context.isTty) {
    throw new Error(
      "samx tui requires an interactive TTY. In scripts, use the regular samx commands."
    );
  }

  // Ink owns the terminal until the app exits, so the CLI action must stay pending.
  await renderTui(createTuiApi({ samxHome: context.samxHome, projectRoot: context.cwd }));
}
