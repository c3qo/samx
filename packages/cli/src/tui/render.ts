import React from "react";
import { render } from "ink";

import { App } from "./App.js";
import type { TuiApi } from "./api.js";

export async function renderTui(api: TuiApi): Promise<void> {
  const instance = render(React.createElement(App, { api }));
  await instance.waitUntilExit();
}
