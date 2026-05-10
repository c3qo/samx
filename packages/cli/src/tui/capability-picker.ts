import React, { useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { render } from "ink";

import { safeLine } from "./format.js";

const h = React.createElement;

export interface CapabilityPickerItem {
  id: string;
  kind: string;
  description?: string;
}

export async function renderCapabilityPicker(
  formulaId: string,
  capabilities: CapabilityPickerItem[]
): Promise<string[] | undefined> {
  let resolveSelection: (value: string[] | undefined) => void = () => {};
  const result = new Promise<string[] | undefined>((resolve) => {
    resolveSelection = resolve;
  });
  const instance = render(
    h(CapabilityPicker, { formulaId, capabilities, onDone: resolveSelection })
  );
  const selected = await result;
  instance.unmount();
  await instance.waitUntilExit();
  return selected;
}

function CapabilityPicker({
  formulaId,
  capabilities,
  onDone,
}: {
  formulaId: string;
  capabilities: CapabilityPickerItem[];
  onDone: (value: string[] | undefined) => void;
}) {
  const { exit } = useApp();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [cursor, setCursor] = React.useState(0);
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
      setCursor((current) => Math.min(capabilities.length - 1, current + 1));
      return;
    }
    if (input === " ") {
      const capability = capabilities[cursor];
      if (!capability) return;
      setSelected((current) =>
        current.includes(capability.id)
          ? current.filter((value) => value !== capability.id)
          : [...current, capability.id]
      );
      return;
    }
    if (key.return && selected.length > 0) {
      onDone(selected);
      exit();
    }
  });
  useEffect(() => () => onDone(undefined), [onDone]);
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, `Select capability from ${safeLine(formulaId, 80)}`),
    ...capabilities.map((capability, index) =>
      h(
        Text,
        { key: capability.id, color: index === cursor ? "cyan" : undefined },
        `${index === cursor ? "›" : " "} ${selected.includes(capability.id) ? "[x]" : "[ ]"} ${safeLine(capability.id, 48)}  ${safeLine(capability.kind, 12)}${capability.description ? `  ${safeLine(capability.description, 72)}` : ""}`
      )
    ),
    h(
      Text,
      { dimColor: true },
      "↑/↓: move  Space: toggle  Enter: confirm  q/Esc: cancel  Ctrl+C: exit"
    )
  );
}
