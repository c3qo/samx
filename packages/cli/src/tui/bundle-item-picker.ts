import React, { useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { render } from "ink";

import { safeLine } from "./format.js";

const h = React.createElement;

export interface BundleItemPickerItem {
  id: string;
  alias?: string;
}

export async function renderBundleItemPicker(
  bundleId: string,
  items: BundleItemPickerItem[]
): Promise<string[] | undefined> {
  let resolveSelection: (value: string[] | undefined) => void = () => {};
  const result = new Promise<string[] | undefined>((resolve) => {
    resolveSelection = resolve;
  });
  const instance = render(h(BundleItemPicker, { bundleId, items, onDone: resolveSelection }));
  const selected = await result;
  instance.unmount();
  await instance.waitUntilExit();
  return selected;
}

function BundleItemPicker({
  bundleId,
  items,
  onDone,
}: {
  bundleId: string;
  items: BundleItemPickerItem[];
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
      setCursor((current) => Math.min(items.length - 1, current + 1));
      return;
    }
    if (input === " ") {
      const item = items[cursor];
      if (!item) return;
      const value = item.alias ?? item.id;
      setSelected((current) =>
        current.includes(value)
          ? current.filter((selectedItem) => selectedItem !== value)
          : [...current, value]
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
    h(Text, { bold: true }, `Select capabilities to remove from ${safeLine(bundleId, 80)}`),
    ...items.map((item, index) => {
      const value = item.alias ?? item.id;
      const label = item.alias ? `${item.alias} (${item.id})` : item.id;
      return h(
        Text,
        { key: item.id, color: index === cursor ? "cyan" : undefined },
        `${index === cursor ? "›" : " "} ${selected.includes(value) ? "[x]" : "[ ]"} ${safeLine(label, 90)}`
      );
    }),
    h(
      Text,
      { dimColor: true },
      "↑/↓: move  Space: toggle  Enter: confirm  q/Esc: cancel  Ctrl+C: exit"
    )
  );
}
