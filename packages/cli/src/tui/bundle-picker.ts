import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { render } from "ink";

import { safeLine } from "./format.js";

const h = React.createElement;

export async function renderBundlePicker(
  bundleIds: string[],
  defaultBundleId: string
): Promise<string | undefined> {
  let resolveSelection: (value: string | undefined) => void = () => {};
  const result = new Promise<string | undefined>((resolve) => {
    resolveSelection = resolve;
  });
  const instance = render(
    h(BundlePicker, { bundleIds, defaultBundleId, onDone: resolveSelection })
  );
  const selected = await result;
  instance.unmount();
  await instance.waitUntilExit();
  return selected;
}

function BundlePicker({
  bundleIds,
  defaultBundleId,
  onDone,
}: {
  bundleIds: string[];
  defaultBundleId: string;
  onDone: (value: string | undefined) => void;
}) {
  const { exit } = useApp();
  const choices = [...bundleIds, defaultBundleId];
  const [cursor, setCursor] = React.useState(0);
  React.useEffect(() => () => onDone(undefined), [onDone]);
  useInput((input, key) => {
    if ((key.ctrl && input === "c") || key.escape || input === "q") {
      onDone(undefined);
      exit();
      return;
    }
    if (key.upArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((current) => Math.min(choices.length - 1, current + 1));
      return;
    }
    if (key.return) {
      onDone(choices[cursor]);
      exit();
    }
  });
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, "Select project bundle"),
    ...choices.map((choice, index) =>
      h(
        Text,
        { key: choice, color: index === cursor ? "cyan" : undefined },
        `${index === cursor ? "›" : " "} ${safeLine(choice, 80)}${choice === defaultBundleId ? "  (create)" : ""}`
      )
    ),
    h(Text, { dimColor: true }, "↑/↓: move  Enter: select  q/Esc: cancel  Ctrl+C: exit")
  );
}
