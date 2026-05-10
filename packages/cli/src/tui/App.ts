import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";

import type {
  BundleDetail,
  BundleRow,
  CapabilityRow,
  DashboardData,
  FormulaDetail,
  FormulaRow,
  LinkInput,
  LinkPreview,
  LinkRecordRow,
  PackageRow,
  RegistryRow,
  TuiApi,
} from "./api.js";
import { safeBlock, safeLine } from "./format.js";

const h = React.createElement;
const Select = SelectInput as unknown as React.ComponentType<{
  items: SelectItem<unknown>[];
  onSelect: (item: SelectItem<unknown>) => void;
}>;

type Screen =
  | "dashboard"
  | "formula-search"
  | "packages"
  | "registries"
  | "capabilities"
  | "bundles"
  | "link"
  | "unlink";
type CapabilityTypeFilter = "all" | "skill" | "agent" | "mcp";
type AdjacentHookDecision = Exclude<
  NonNullable<LinkInput["adjacentHooks"]>,
  { mode: "unspecified" }
>;

interface AppProps {
  api: TuiApi;
}

interface SelectItem<T = string> {
  label: string;
  value: T;
}

interface MultiSelectProps {
  items: SelectItem<string>[];
  onSubmit: (values: string[]) => void;
  emptyMessage: string;
}

export function App({ api }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [textInputActive, setTextInputActive] = useState(false);

  function back() {
    setError(undefined);
    setMessage(undefined);
    setScreen("dashboard");
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (textInputActive) {
      return;
    }
    if (input === "q") {
      if (screen === "link" || screen === "unlink") back();
      else exit();
      return;
    }
    if (key.escape) {
      if (screen === "dashboard") exit();
      else back();
    }
  });

  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(Text, { bold: true, color: "cyan" }, "SAMX"),
    error ? h(ErrorPanel, { message: error }) : null,
    message ? h(Text, { color: "green" }, message) : null,
    screen === "dashboard" ? h(DashboardScreen, { api, go: setScreen, setError }) : null,
    screen === "formula-search"
      ? h(FormulaSearchScreen, { api, setError, setMessage, setTextInputActive, onDone: back })
      : null,
    screen === "packages"
      ? h(PackagesScreen, { api, setError, setMessage, setTextInputActive })
      : null,
    screen === "registries"
      ? h(RegistriesScreen, { api, setError, setMessage, setTextInputActive })
      : null,
    screen === "capabilities"
      ? h(CapabilitiesScreen, { api, setError, setMessage, setTextInputActive })
      : null,
    screen === "bundles"
      ? h(BundlesScreen, { api, setError, setMessage, setTextInputActive })
      : null,
    screen === "link"
      ? h(LinkScreen, { api, setError, setMessage, setTextInputActive, onDone: back })
      : null,
    screen === "unlink" ? h(UnlinkScreen, { api, setError, setMessage, setTextInputActive }) : null,
    h(
      Text,
      { dimColor: true },
      textInputActive
        ? "Esc: back  Ctrl+C: exit"
        : screen === "link" || screen === "unlink"
          ? "q/Esc: back  Ctrl+C: exit"
          : "q: quit  Esc: back  Ctrl+C: exit"
    )
  );
}

function DashboardScreen({
  api,
  go,
  setError,
}: {
  api: TuiApi;
  go: (screen: Screen) => void;
  setError: (error: string | undefined) => void;
}) {
  const { data, loading } = useAsync(() => api.getDashboard(), [api], setError);
  const items: SelectItem<Screen | "quit">[] = [
    { label: "Search Formulas", value: "formula-search" },
    { label: "Manage Registries", value: "registries" },
    { label: "Manage Packages", value: "packages" },
    { label: "Browse Capability", value: "capabilities" },
    { label: "Manage Bundles", value: "bundles" },
    { label: "Link Bundle", value: "link" },
    { label: "Unlink Bundle", value: "unlink" },
    { label: "Quit", value: "quit" },
  ];
  const { exit } = useApp();

  return h(
    Box,
    { flexDirection: "column" },
    loading ? h(Loading) : h(DashboardCounts, { data }),
    h(Text, { bold: true }, "Actions"),
    h(Select, {
      items,
      onSelect: (item) => (item.value === "quit" ? exit() : go(item.value as Screen)),
    })
  );
}

function DashboardCounts({ data }: { data?: DashboardData }) {
  if (!data) return null;
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, null, `Packages        ${data.packages}`),
    h(
      Text,
      null,
      `Capabilities    ${data.capabilities.total}  ${data.capabilities.skill} skills, ${data.capabilities.agent} agents, ${data.capabilities.mcp} MCP`
    ),
    h(Text, null, `Bundles         ${data.bundles}`),
    h(Text, null, `Linked bundles  ${data.linkedBundles}`),
    h(Text, null, "")
  );
}

function FormulaSearchScreen({
  api,
  setError,
  setMessage,
  setTextInputActive,
  onDone,
}: ScreenProps & { onDone: () => void }) {
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [results, setResults] = useState<FormulaRow[]>([]);
  const [detail, setDetail] = useState<FormulaDetail>();
  const [loading, setLoading] = useState(false);

  async function search() {
    const nextQuery = query.trim();
    if (!nextQuery) {
      onDone();
      return;
    }
    if (loading) return;
    setLoading(true);
    setSearchedQuery(nextQuery);
    try {
      setResults(await api.searchFormulas(nextQuery));
      setDetail(undefined);
      setError(undefined);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  function backToSearch() {
    setQuery("");
    setSearchedQuery("");
    setResults([]);
    setDetail(undefined);
    setMessage(undefined);
    setError(undefined);
  }

  async function show(id: string) {
    setLoading(true);
    try {
      setDetail(await api.getFormula(id));
      setError(undefined);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function install(id: string) {
    setLoading(true);
    try {
      const installed = await api.installFormulaPackage(id);
      setMessage(`Installed ${installed}.`);
      setError(undefined);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  if (loading) return h(Loading);

  if (!searchedQuery) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Search formulas:"),
      h(ManagedTextInput, {
        value: query,
        onChange: setQuery,
        onSubmit: () => void search(),
        onCancel: onDone,
        setTextInputActive,
      }),
      h(Text, { dimColor: true }, "Enter empty: back to dashboard")
    );
  }

  if (detail) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, `Formula: ${safeLine(detail.id, 96)}`),
      h(Text, null, `Name: ${safeLine(detail.name, 96)}`),
      detail.description ? h(Text, null, `Description: ${safeLine(detail.description, 96)}`) : null,
      h(Text, null, "Capabilities"),
      ...detail.capabilities.map((capability) =>
        h(
          Text,
          { key: capability.id },
          `${safeLine(capability.id, 72)}  ${safeLine(capability.kind, 24)}`
        )
      ),
      h(Select, {
        items: [
          { label: "Install", value: "install" },
          { label: "Back to results", value: "back" },
          { label: "New search", value: "search" },
        ],
        onSelect: (item) =>
          item.value === "install"
            ? void install(detail.canonicalId)
            : item.value === "search"
              ? backToSearch()
              : setDetail(undefined),
      })
    );
  }

  const resultById = new Map(results.map((result) => [result.canonicalId, result]));
  const actionItems = [
    { label: "New search", value: "__new_search" },
    { label: "Back to search", value: "__back_search" },
  ];
  const items = results.map((result) => ({
    label: `${safeLine(result.name, 72)}  ${safeLine(result.id, 72)}${result.description ? `  ${safeLine(result.description, 60)}` : ""}`,
    value: result.canonicalId,
  }));
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, `Formula results for ${safeLine(searchedQuery, 72)}`),
    items.length === 0 ? h(Text, null, "No formulas found.") : null,
    h(Select, {
      items: items.length === 0 ? actionItems : [...items, ...actionItems],
      onSelect: (item) =>
        String(item.value).startsWith("__")
          ? backToSearch()
          : void show(resultById.get(String(item.value))?.canonicalId ?? String(item.value)),
    })
  );
}

function PackagesScreen({ api, setError, setMessage, setTextInputActive }: ScreenProps) {
  const [packages, setPackages] = useState<PackageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PackageRow>();
  const [mode, setMode] = useState<
    | "list"
    | "install-formula"
    | "install-local-id"
    | "install-local-source"
    | "updates"
    | "uninstall-confirm"
    | "uninstall-force"
  >("list");
  const [formulaId, setFormulaId] = useState("");
  const [localId, setLocalId] = useState("");
  const [localSource, setLocalSource] = useState("");
  const [updates, setUpdates] = useState<Awaited<ReturnType<TuiApi["previewPackageUpdates"]>>>([]);

  async function refresh() {
    setLoading(true);
    try {
      setPackages(await api.listPackages());
      setError(undefined);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [api]);

  async function installFormula() {
    const id = formulaId.trim();
    if (!id) {
      setFormulaId("");
      setMode("list");
      return;
    }
    if (loading) return;
    setLoading(true);
    try {
      const installed = await api.installFormulaPackage(id);
      setMessage(`Installed ${installed}.`);
      setFormulaId("");
      setMode("list");
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
      setLoading(false);
    }
  }

  async function installLocal() {
    const id = localId.trim();
    const source = localSource.trim();
    if (!source) {
      setLocalSource("");
      setMode("install-local-id");
      return;
    }
    if (!id || loading) return;
    setLoading(true);
    try {
      const installed = await api.installLocalPackage(id, source);
      setMessage(`Installed local package ${installed}.`);
      setLocalId("");
      setLocalSource("");
      setMode("list");
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
      setLoading(false);
    }
  }

  async function previewUpdates() {
    if (loading) return;
    setLoading(true);
    try {
      setUpdates(await api.previewPackageUpdates());
      setMode("updates");
      setError(undefined);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function applyUpdates() {
    if (loading) return;
    setLoading(true);
    try {
      const count = await api.applyPackageUpdates();
      setMessage(`Applied ${count} package ${count === 1 ? "update" : "updates"}.`);
      setMode("list");
      setUpdates([]);
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
      setLoading(false);
    }
  }

  async function uninstall(force = false) {
    if (!selected || loading) return;
    setLoading(true);
    try {
      await api.uninstallPackage(selected.id, force);
      setMessage(`Uninstalled ${selected.id}.`);
      setSelected(undefined);
      setMode("list");
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
      setLoading(false);
    }
  }

  if (mode === "install-formula") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Formula id:"),
      h(ManagedTextInput, {
        value: formulaId,
        onChange: setFormulaId,
        onSubmit: () => void installFormula(),
        onCancel: () => {
          setFormulaId("");
          setMode("list");
        },
        setTextInputActive,
      }),
      h(Text, { dimColor: true }, "Enter empty: back to packages")
    );
  }
  if (mode === "install-local-id") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Local package id:"),
      h(ManagedTextInput, {
        value: localId,
        onChange: setLocalId,
        onSubmit: () => {
          if (localId.trim()) setMode("install-local-source");
          else setMode("list");
        },
        onCancel: () => {
          setLocalId("");
          setMode("list");
        },
        setTextInputActive,
      }),
      h(Text, { dimColor: true }, "Enter empty: back to packages")
    );
  }
  if (mode === "install-local-source") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Local source path:"),
      h(ManagedTextInput, {
        value: localSource,
        onChange: setLocalSource,
        onSubmit: () => void installLocal(),
        onCancel: () => {
          setLocalSource("");
          setMode("install-local-id");
        },
        setTextInputActive,
      }),
      h(Text, { dimColor: true }, "Enter empty: back to package id")
    );
  }
  if (mode === "updates") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, "Package updates"),
      updates.length === 0 ? h(Text, null, "No package updates available.") : null,
      ...updates.flatMap((update) => [
        h(Text, { key: `${update.id}:id` }, update.id),
        update.error
          ? h(
              Text,
              { key: `${update.id}:error`, color: "red" },
              `- error: ${safeLine(update.error, 96)}`
            )
          : null,
        ...update.changes.map((change, index) =>
          h(
            Text,
            { key: `${update.id}:${change.field}:${index}` },
            `- ${change.field}: ${safeLine(formatPackageUpdateChange(change), 96)}`
          )
        ),
      ]),
      h(Select, {
        items:
          updates.length === 0 || updates.every((update) => update.changes.length === 0)
            ? [{ label: "Back to packages", value: "back" }]
            : [
                { label: "Apply updates", value: "apply" },
                { label: "Back to packages", value: "back" },
              ],
        onSelect: (item) => (item.value === "apply" ? void applyUpdates() : setMode("list")),
      })
    );
  }

  if (selected) {
    if (loading) return h(Loading);
    if (mode === "uninstall-confirm") {
      return h(
        Box,
        { flexDirection: "column" },
        h(Text, { bold: true }, `Uninstall ${selected.id}?`),
        h(Select, {
          items: [
            { label: "Confirm uninstall", value: "confirm" },
            { label: "Force uninstall", value: "force" },
            { label: "Cancel", value: "cancel" },
          ],
          onSelect: (item) =>
            item.value === "confirm"
              ? void uninstall(false)
              : item.value === "force"
                ? setMode("uninstall-force")
                : setMode("list"),
        })
      );
    }
    if (mode === "uninstall-force") {
      return h(
        Box,
        { flexDirection: "column" },
        h(Text, { bold: true }, `Force uninstall ${selected.id}?`),
        h(Text, { dimColor: true }, "Force bypasses link-record blockers, not bundle references."),
        h(Select, {
          items: [
            { label: "Confirm force uninstall", value: "force" },
            { label: "Cancel", value: "cancel" },
          ],
          onSelect: (item) =>
            item.value === "force" ? void uninstall(true) : setMode("uninstall-confirm"),
        })
      );
    }
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, `Package: ${selected.id}`),
      h(
        Text,
        null,
        `${selected.type}  ${safeLine(selected.source, 96)}${selected.ref ? ` @ ${selected.ref}` : ""}`
      ),
      h(Select, {
        items: [
          { label: "Uninstall package", value: "uninstall" },
          { label: "Back to packages", value: "back" },
        ],
        onSelect: (item) =>
          item.value === "uninstall" ? setMode("uninstall-confirm") : setSelected(undefined),
      })
    );
  }

  if (loading) return h(Loading);
  const packageItems = packages.map((pkg) => ({
    label: `${pkg.id}  ${pkg.type}  ${safeLine(pkg.source, 72)}${pkg.ref ? ` @ ${pkg.ref}` : ""}`,
    value: pkg.id,
  }));
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, "Packages"),
    packages.length === 0 ? h(Text, null, "No packages configured.") : null,
    h(Select, {
      items: [
        ...packageItems,
        { label: "Preview package updates", value: "__updates" },
        { label: "Install formula package", value: "__install_formula" },
        { label: "Install local package", value: "__install_local" },
      ],
      onSelect: (item) =>
        item.value === "__updates"
          ? void previewUpdates()
          : item.value === "__install_formula"
            ? setMode("install-formula")
            : item.value === "__install_local"
              ? setMode("install-local-id")
              : setSelected(packageById.get(String(item.value))),
    }),
    h(
      Text,
      { dimColor: true },
      "Use `samx pkg install <registry>/<owner>/<repo>` to install packages."
    )
  );
}

function RegistriesScreen({ api, setError, setMessage, setTextInputActive }: ScreenProps) {
  const [registries, setRegistries] = useState<RegistryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<RegistryRow>();
  const [mode, setMode] = useState<
    "list" | "add-id" | "add-url" | "remove-confirm" | "remove-force"
  >("list");
  const [newId, setNewId] = useState("");
  const [newUrl, setNewUrl] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      setRegistries(await api.listRegistries());
      setError(undefined);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [api]);

  async function add() {
    const id = newId.trim();
    const url = newUrl.trim();
    if (!url) {
      setNewUrl("");
      setMode("add-id");
      return;
    }
    if (!id) return;
    setLoading(true);
    try {
      await api.addRegistry(id, url);
      setMessage(`Added registry ${id}.`);
      setMode("list");
      setNewId("");
      setNewUrl("");
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
      setLoading(false);
    }
  }

  async function sync(id?: string) {
    setLoading(true);
    try {
      const count = await api.syncRegistry(id);
      setMessage(
        `Synced ${id ?? "all registries"}: ${count} ${count === 1 ? "registry" : "registries"}.`
      );
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
      setLoading(false);
    }
  }

  async function trust() {
    if (!selected) return;
    setLoading(true);
    try {
      await api.trustRegistry(selected.id);
      setMessage(`Trusted ${selected.id}.`);
      setSelected(undefined);
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
      setLoading(false);
    }
  }

  async function remove(force = false) {
    if (!selected) return;
    setLoading(true);
    try {
      const result = await api.removeRegistry(selected.id, force);
      setMessage(
        result.installedPackagesRemaining
          ? `Removed ${selected.id}; installed packages remain.`
          : `Removed ${selected.id}.`
      );
      setSelected(undefined);
      setMode("list");
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
      setLoading(false);
    }
  }

  if (mode === "add-id") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Registry id:"),
      h(ManagedTextInput, {
        value: newId,
        onChange: setNewId,
        onSubmit: () => {
          if (newId.trim()) setMode("add-url");
          else setMode("list");
        },
        onCancel: () => {
          setNewId("");
          setMode("list");
        },
        setTextInputActive,
      }),
      h(Text, { dimColor: true }, "Enter empty: back to registries")
    );
  }

  if (mode === "add-url") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Registry url:"),
      h(ManagedTextInput, {
        value: newUrl,
        onChange: setNewUrl,
        onSubmit: () => void add(),
        onCancel: () => {
          setNewUrl("");
          setMode("add-id");
        },
        setTextInputActive,
      }),
      h(Text, { dimColor: true }, "Enter empty: back to registry id")
    );
  }

  if (selected) {
    if (loading) return h(Loading);
    if (mode === "remove-confirm") {
      return h(
        Box,
        { flexDirection: "column" },
        h(Text, { bold: true }, `Remove ${selected.id}?`),
        h(Select, {
          items: [
            { label: "Confirm remove", value: "remove" },
            { label: "Force remove", value: "force" },
            { label: "Cancel", value: "cancel" },
          ],
          onSelect: (item) =>
            item.value === "remove"
              ? void remove(false)
              : item.value === "force"
                ? setMode("remove-force")
                : setMode("list"),
        })
      );
    }
    if (mode === "remove-force") {
      return h(
        Box,
        { flexDirection: "column" },
        h(Text, { bold: true }, `Force remove ${selected.id}?`),
        h(Select, {
          items: [
            { label: "Confirm force remove", value: "force" },
            { label: "Cancel", value: "cancel" },
          ],
          onSelect: (item) =>
            item.value === "force" ? void remove(true) : setMode("remove-confirm"),
        })
      );
    }
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, `Registry: ${selected.id}`),
      h(Text, null, `${registryTrustLabel(selected)}  ${safeLine(selected.url, 96)}`),
      h(Select, {
        items: [
          { label: "Sync registry", value: "sync" },
          { label: "Trust registry", value: "trust" },
          { label: "Back to registries", value: "back" },
          ...(selected.id === "default" ? [] : [{ label: "Remove registry", value: "remove" }]),
        ],
        onSelect: (item) =>
          item.value === "sync"
            ? void sync(selected.id)
            : item.value === "trust"
              ? void trust()
              : item.value === "remove"
                ? setMode("remove-confirm")
                : setSelected(undefined),
      })
    );
  }

  if (loading) return h(Loading);
  const registryItems = registries.map((registry) => ({
    label: `${registry.id}  ${registryTrustLabel(registry)}  ${safeLine(registry.url, 72)}`,
    value: registry.id,
  }));
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, "Registries"),
    registries.length === 0 ? h(Text, null, "No registries configured.") : null,
    h(Select, {
      items: [
        ...registryItems,
        { label: "Add registry", value: "__add" },
        { label: "Sync all registries", value: "__sync_all" },
      ],
      onSelect: (item) =>
        item.value === "__add"
          ? setMode("add-id")
          : item.value === "__sync_all"
            ? void sync()
            : setSelected(registries.find((registry) => registry.id === item.value)),
    })
  );
}

function registryTrustLabel(registry: RegistryRow): string {
  if (registry.id === "default") return "built-in";
  return registry.trusted ? "trusted" : "untrusted";
}

function CapabilitiesScreen({ api, setError, setMessage, setTextInputActive }: ScreenProps) {
  const [type, setType] = useState<CapabilityTypeFilter>("all");
  const [searchMode, setSearchMode] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedCapability, setSelectedCapability] = useState<CapabilityRow>();
  const [bundles, setBundles] = useState<BundleRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [bundleId, setBundleId] = useState("");
  const { data: capabilities, loading } = useAsync(
    () =>
      api.listCapabilities({ ...(type === "all" ? {} : { type }), ...(search ? { search } : {}) }),
    [api, type, search],
    setError
  );

  useEffect(() => {
    api
      .listBundles()
      .then(setBundles)
      .catch((error: unknown) => setError(errorMessage(error)));
  }, [api, setError]);

  useInput((input) => {
    if (input === "/" && !searchMode) setSearchMode(true);
    if (input === "t" && !searchMode) setType(nextCapabilityType(type));
  });

  async function createThenAdd() {
    if (bundleId.trim().length === 0) {
      setCreating(false);
      setBundleId("");
      return;
    }
    if (!selectedCapability) return;
    await createBundleShared(api, bundleId.trim(), setError, setMessage);
    await addToBundle(bundleId.trim());
    setCreating(false);
    setBundleId("");
  }

  async function addToBundle(id: string) {
    if (!selectedCapability) return;
    try {
      await api.addCapabilityToBundle(id, selectedCapability.id);
      setMessage(`Added ${selectedCapability.id} to ${id}.`);
      setSelectedCapability(undefined);
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  if (searchMode) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Search capabilities:"),
      h(ManagedTextInput, {
        value: search,
        onChange: setSearch,
        onSubmit: () => setSearchMode(false),
        setTextInputActive,
      })
    );
  }

  if (creating) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Bundle id:"),
      h(ManagedTextInput, {
        value: bundleId,
        onChange: setBundleId,
        onSubmit: () => void createThenAdd(),
        onCancel: () => {
          setCreating(false);
          setBundleId("");
        },
        setTextInputActive,
      }),
      h(Text, { dimColor: true }, "Enter empty: back to capabilities")
    );
  }

  if (selectedCapability) {
    const items: SelectItem<string>[] =
      bundles.length > 0
        ? bundles.map((bundle) => ({ label: `Add to ${bundle.id}`, value: bundle.id }))
        : [{ label: "Create bundle", value: "__create" }];
    if (bundles.length > 0) items.push({ label: "Create bundle", value: "__create" });

    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, selectedCapability.id),
      h(Text, null, `Type: ${selectedCapability.kind}`),
      h(Text, null, `Package: ${selectedCapability.packageId}`),
      h(Text, null, `Path: ${safeLine(selectedCapability.path ?? "inline spec", 96)}`),
      selectedCapability.description
        ? h(Text, null, `Description: ${safeLine(selectedCapability.description, 96)}`)
        : null,
      selectedCapability.preview ? h(Text, null, selectedCapability.preview) : null,
      h(Select, {
        items,
        onSelect: (item) =>
          item.value === "__create" ? setCreating(true) : void addToBundle(String(item.value)),
      })
    );
  }

  if (loading) return h(Loading);
  const capabilityById = new Map(
    (capabilities ?? []).map((capability) => [capability.id, capability])
  );
  const items = (capabilities ?? []).map((capability) => ({
    label: `${capability.id}  ${capability.kind}`,
    value: capability.id,
  }));
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, `Capabilities (${type})`),
    h(Text, { dimColor: true }, "t: cycle type  /: search"),
    items.length === 0
      ? h(Text, null, "No capabilities found.")
      : h(Select, {
          items,
          onSelect: (item) => setSelectedCapability(capabilityById.get(String(item.value))),
        })
  );
}

function BundlesScreen({ api, setError, setMessage, setTextInputActive }: ScreenProps) {
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [bundleId, setBundleId] = useState("");
  const [detail, setDetail] = useState<BundleDetail>();
  const [action, setAction] = useState<
    "show" | "add" | "remove" | "confirm-remove" | "confirm-destroy"
  >("show");
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const { data: bundles, loading } = useAsync(() => api.listBundles(), [api, refresh], setError);
  const { data: capabilities, loading: capabilitiesLoading } = useAsync(
    () => api.listCapabilities(),
    [api],
    setError
  );

  async function create() {
    const id = bundleId.trim();
    if (!id) {
      setCreating(false);
      setBundleId("");
      return;
    }
    const ok = await createBundleShared(api, id, setError, setMessage);
    if (ok) {
      setCreating(false);
      setBundleId("");
      setRefresh((value) => value + 1);
    }
  }

  async function show(id: string) {
    try {
      setDetail(await api.getBundle(id));
      setAction("show");
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  async function refreshDetail() {
    if (!detail) return;
    await show(detail.id);
  }

  async function addCapabilities(capabilityIds: string[]) {
    if (!detail) return;
    if (capabilityIds.length === 0) {
      setMessage(undefined);
      setError("Select at least one capability.");
      return;
    }
    try {
      for (const capabilityId of capabilityIds) {
        await api.addCapabilityToBundle(detail.id, capabilityId);
      }
      setMessage(
        `Added ${capabilityIds.length} ${capabilityIds.length === 1 ? "capability" : "capabilities"} to ${detail.id}.`
      );
      setAction("show");
      await refreshDetail();
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  async function removeCapabilities() {
    if (!detail || removeIds.length === 0) return;
    try {
      for (const capabilityId of removeIds) {
        await api.removeCapabilityFromBundle(detail.id, capabilityId);
      }
      setMessage(
        `Removed ${removeIds.length} ${removeIds.length === 1 ? "capability" : "capabilities"} from ${detail.id}.`
      );
      setRemoveIds([]);
      setAction("show");
      await refreshDetail();
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  async function destroyBundle() {
    if (!detail) return;
    try {
      await api.destroyBundle(detail.id);
      setMessage(`Destroyed bundle ${detail.id}.`);
      setDetail(undefined);
      setAction("show");
      setRefresh((value) => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  if (creating) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Bundle id:"),
      h(ManagedTextInput, {
        value: bundleId,
        onChange: setBundleId,
        onSubmit: () => void create(),
        onCancel: () => {
          setCreating(false);
          setBundleId("");
        },
        setTextInputActive,
      }),
      h(Text, { dimColor: true }, "Enter empty: back to bundles")
    );
  }
  if (detail) {
    if (action === "add") {
      if (capabilitiesLoading) return h(Loading);
      const existingIds = new Set(detail.items.map((item) => item.id));
      const addItems = (capabilities ?? [])
        .filter((capability) => !existingIds.has(capability.id))
        .map((capability) => ({
          label: `${capability.id}  ${capability.kind}`,
          value: capability.id,
        }));
      return h(
        Box,
        { flexDirection: "column" },
        h(Text, { bold: true }, `Add capability to ${detail.id}`),
        h(MultiSelect, {
          items: addItems,
          emptyMessage: "No capabilities available to add.",
          onSubmit: (values) => void addCapabilities(values),
        })
      );
    }

    if (action === "remove") {
      const removeItems = detail.items.map((item) => ({
        label: `${item.kind}: ${item.id}`,
        value: item.id,
      }));
      return h(
        Box,
        { flexDirection: "column" },
        h(Text, { bold: true }, `Remove capability from ${detail.id}`),
        h(MultiSelect, {
          items: removeItems,
          emptyMessage: "No capabilities to remove.",
          onSubmit: (values) => {
            if (values.length === 0) {
              setMessage(undefined);
              setError("Select at least one capability.");
              return;
            }
            setRemoveIds(values);
            setAction("confirm-remove");
          },
        })
      );
    }

    if (action === "confirm-remove" && removeIds.length > 0) {
      return h(
        Box,
        { flexDirection: "column" },
        h(
          Text,
          { bold: true },
          `Remove ${removeIds.length} ${removeIds.length === 1 ? "capability" : "capabilities"} from ${detail.id}?`
        ),
        h(
          Text,
          { dimColor: true },
          "This updates only the bundle definition. It does not unlink existing outputs."
        ),
        h(Select, {
          items: [
            { label: "Confirm remove", value: "confirm" },
            { label: "Back", value: "back" },
          ],
          onSelect: (item) =>
            item.value === "confirm" ? void removeCapabilities() : setAction("remove"),
        })
      );
    }

    if (action === "confirm-destroy") {
      return h(
        Box,
        { flexDirection: "column" },
        h(Text, { bold: true }, `Destroy bundle ${detail.id}?`),
        h(
          Text,
          { dimColor: true },
          "This removes the bundle definition. It does not unlink existing outputs."
        ),
        h(Select, {
          items: [
            { label: "Confirm destroy", value: "confirm" },
            { label: "Back", value: "back" },
          ],
          onSelect: (item) => (item.value === "confirm" ? void destroyBundle() : setAction("show")),
        })
      );
    }

    const actions: SelectItem<string>[] = [
      { label: "Add capability", value: "add" },
      { label: "Remove capability", value: "remove" },
      { label: "Destroy bundle", value: "destroy" },
      { label: "Back to bundle list", value: "back" },
    ];
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, `Bundle: ${detail.id}`),
      detail.items.length === 0 ? h(Text, null, "No capabilities in bundle.") : null,
      ...detail.items.map((item) =>
        h(
          Text,
          { key: item.id },
          `${item.kind}: ${item.id}${item.alias ? ` as ${item.alias}` : ""}`
        )
      ),
      h(Text, null, ""),
      h(Select, {
        items: actions,
        onSelect: (item) =>
          item.value === "back"
            ? setDetail(undefined)
            : item.value === "destroy"
              ? setAction("confirm-destroy")
              : setAction(String(item.value) as "add" | "remove"),
      })
    );
  }
  if (loading) return h(Loading);
  const items: SelectItem<string>[] = [
    { label: "Create bundle", value: "__create" },
    ...(bundles ?? []).map((bundle) => ({
      label: `${bundle.id}  ${bundle.itemCount} items`,
      value: bundle.id,
    })),
  ];
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, "Bundles"),
    h(Select, {
      items,
      onSelect: (item) =>
        item.value === "__create" ? setCreating(true) : void show(String(item.value)),
    })
  );
}

function MultiSelect({ items, onSubmit, emptyMessage }: MultiSelectProps) {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useInput((input, key) => {
    if (items.length === 0) return;
    if (key.upArrow) {
      setCursor((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((value) => Math.min(items.length - 1, value + 1));
      return;
    }
    if (input === " ") {
      const value = items[cursor]?.value;
      if (!value) return;
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
      return;
    }
    if (input === "a") {
      setSelected((current) =>
        current.size === items.length ? new Set() : new Set(items.map((item) => item.value))
      );
      return;
    }
    if (key.return) {
      onSubmit(items.map((item) => item.value).filter((value) => selected.has(value)));
    }
  });

  if (items.length === 0) return h(Text, null, emptyMessage);

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { dimColor: true }, "space: toggle  a: toggle all  enter: apply"),
    ...items.map((item, index) =>
      h(
        Text,
        { key: item.value, color: index === cursor ? "cyan" : undefined },
        `${index === cursor ? ">" : " "} ${selected.has(item.value) ? "[x]" : "[ ]"} ${item.label}`
      )
    )
  );
}

function LinkScreen({ api, setError, setMessage, onDone }: ScreenProps & { onDone: () => void }) {
  const [bundleId, setBundleId] = useState<string>();
  const [tool, setTool] = useState<string>();
  const [preview, setPreview] = useState<LinkPreview>();
  const [overwrite, setOverwrite] = useState(false);
  const [adjacentHookDecision, setAdjacentHookDecision] = useState<AdjacentHookDecision>();
  const [advisoriesAccepted, setAdvisoriesAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);
  const { data: bundles, loading: bundlesLoading } = useAsync(
    () => api.listBundles(),
    [api],
    setError
  );
  const { data: targets, loading: targetsLoading } = useAsync(
    () => api.listLinkTargets(),
    [api],
    setError
  );

  async function runPreview(
    selectedBundle = bundleId,
    selectedTool = tool,
    withOverwrite = overwrite,
    hookDecision = adjacentHookDecision
  ): Promise<boolean> {
    if (!selectedBundle || !selectedTool) return false;
    setBusy(true);
    try {
      await api.checkBundle(selectedBundle, selectedTool);
      setPreview(
        await api.previewLink({
          bundleId: selectedBundle,
          tool: selectedTool,
          overwrite: withOverwrite,
          ...(hookDecision ? { adjacentHooks: hookDecision } : {}),
        })
      );
      setOverwrite(withOverwrite);
      setAdvisoriesAccepted(false);
      setError(undefined);
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!bundleId || !tool) return;
    setBusy(true);
    try {
      await api.applyLink({
        bundleId,
        tool,
        overwrite,
        ...(adjacentHookDecision ? { adjacentHooks: adjacentHookDecision } : {}),
        allowAdvisories: advisoriesAccepted,
      });
      setMessage(`Linked ${bundleId} to ${tool}.`);
      setPreview(undefined);
      setLinked(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function resetLinkFlow() {
    setBundleId(undefined);
    setTool(undefined);
    setPreview(undefined);
    setOverwrite(false);
    setAdjacentHookDecision(undefined);
    setAdvisoriesAccepted(false);
    setLinked(false);
  }

  async function chooseAdjacentHookDecision(decision: AdjacentHookDecision) {
    if (await runPreview(bundleId, tool, overwrite, decision)) {
      setAdjacentHookDecision(decision);
    }
  }

  function backFromAdjacentHookDecision() {
    setPreview(undefined);
    setTool(undefined);
    setOverwrite(false);
    setAdjacentHookDecision(undefined);
  }

  if (busy || bundlesLoading || targetsLoading) return h(Loading);
  if (linked && bundleId && tool) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true, color: "green" }, `Linked ${bundleId} to ${tool}.`),
      h(Select, {
        items: [
          { label: "Back to dashboard", value: "done" },
          { label: "Link another bundle", value: "another" },
        ],
        onSelect: (item) => (item.value === "done" ? onDone() : resetLinkFlow()),
      })
    );
  }
  if (!bundleId) {
    const items = (bundles ?? []).map((bundle) => ({
      label: `${bundle.id}  ${bundle.itemCount} items`,
      value: bundle.id,
    }));
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, "Pick bundle"),
      items.length === 0
        ? h(Text, null, "No bundles found.")
        : h(Select, { items, onSelect: (item) => setBundleId(String(item.value)) })
    );
  }
  if (!tool) {
    const items = (targets ?? []).map((target) => ({ label: target.label, value: target.id }));
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, "Pick tool"),
      h(Select, {
        items,
        onSelect: (item) => {
          const value = String(item.value);
          setTool(value);
          setAdjacentHookDecision(undefined);
          void runPreview(bundleId, value, false, undefined);
        },
      })
    );
  }
  if (!preview)
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "No preview loaded."),
      h(Select, {
        items: [
          { label: "Retry preview", value: "retry" },
          { label: "Retry with overwrite", value: "overwrite" },
          { label: "Back to dashboard", value: "back" },
        ],
        onSelect: (item) =>
          item.value === "back"
            ? onDone()
            : void runPreview(bundleId, tool, item.value === "overwrite"),
      })
    );

  if (preview.hookDecisionRequired && preview.hookCandidates.length > 0 && !adjacentHookDecision) {
    const decisionItems: SelectItem<string>[] = [
      { label: "Enable all hook candidates", value: "all" },
      { label: "Link without hooks", value: "none" },
      { label: "Back", value: "back" },
    ];
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, "Adjacent hook candidates"),
      h(
        Text,
        { dimColor: true },
        "Hooks are executable behavior and require an explicit decision."
      ),
      ...preview.hookCandidates.flatMap((candidate, index) => [
        h(Text, { key: `${candidate.id}:${index}:summary` }, `- ${safeLine(candidate.id, 100)}`),
        h(
          Text,
          { key: `${candidate.id}:${index}:package` },
          `  packageId: ${safeLine(candidate.packageId, 88)}`
        ),
        h(
          Text,
          { key: `${candidate.id}:${index}:file` },
          `  relative file: ${safeLine(candidate.relativeFile, 84)}`
        ),
        h(
          Text,
          { key: `${candidate.id}:${index}:applies` },
          `  appliesTo: ${safeLine(candidate.appliesTo.join(", "), 88)}`
        ),
        h(Text, { key: `${candidate.id}:${index}:risk` }, "  risk: executable behavior"),
      ]),
      h(Select, {
        items: decisionItems,
        onSelect: (item) =>
          item.value === "back"
            ? backFromAdjacentHookDecision()
            : void chooseAdjacentHookDecision({ mode: item.value as "all" | "none" }),
      })
    );
  }

  if (preview.advisories.length > 0 && !advisoriesAccepted) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, "Formula advisories"),
      h(
        Text,
        { dimColor: true },
        "Selected formula packages have advisories. Confirm before linking."
      ),
      ...preview.advisories.flatMap((advisory, index) => [
        h(
          Text,
          { key: `${advisory.packageId}:${advisory.id}:${index}:summary` },
          `- ${safeLine(`${advisory.packageId} ${advisory.id} [${advisory.severity}] ${advisory.message}`, 100)}`
        ),
        advisory.effect
          ? h(
              Text,
              { key: `${advisory.packageId}:${advisory.id}:${index}:effect` },
              `  effect: ${safeLine(advisory.effect, 90)}`
            )
          : null,
        advisory.action
          ? h(
              Text,
              { key: `${advisory.packageId}:${advisory.id}:${index}:action` },
              `  action: ${safeLine(advisory.action, 90)}`
            )
          : null,
      ]),
      h(Select, {
        items: [
          { label: "Allow advisories and continue", value: "allow" },
          { label: "Back to dashboard", value: "back" },
        ],
        onSelect: (item) => (item.value === "allow" ? setAdvisoriesAccepted(true) : onDone()),
      })
    );
  }

  const items: SelectItem<string>[] = [
    { label: overwrite ? "Confirm link with overwrite" : "Confirm link", value: "apply" },
    { label: "Retry with overwrite", value: "overwrite" },
    { label: "Back to dashboard", value: "back" },
  ];

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, `Link ${bundleId} to ${tool}${overwrite ? " with overwrite" : ""}?`),
    h(Text, null, "Generated outputs"),
    ...preview.generatedFiles.map((file) => h(Text, { key: file }, `- ${safeLine(file, 100)}`)),
    preview.instructionBlockPaths.length > 0 ? h(Text, null, "Instructions") : null,
    ...preview.instructionBlockPaths.map((path) =>
      h(Text, { key: `instructions:${path}` }, `- ${safeLine(path, 100)}`)
    ),
    preview.tomlMergeEntries.length > 0 ? h(Text, null, "MCP TOML") : null,
    ...preview.tomlMergeEntries.map((entry) =>
      h(Text, { key: `toml:${entry}` }, `- ${safeLine(entry, 100)}`)
    ),
    preview.managedHooks.length > 0 ? h(Text, null, "Managed hooks") : null,
    ...preview.managedHooks.flatMap((hook, index) => [
      h(
        Text,
        { key: `${hook.tool}:${hook.id}:${hook.output}:${index}:summary` },
        `- ${safeLine(`${hook.id}  ${hook.tool}  ${hook.required ? "required" : "optional"}`, 100)}`
      ),
      h(
        Text,
        { key: `${hook.tool}:${hook.id}:${hook.output}:${index}:applies` },
        `  applies to: ${safeLine(hook.appliesTo.join(", "), 88)}`
      ),
      h(
        Text,
        { key: `${hook.tool}:${hook.id}:${hook.output}:${index}:output` },
        `  output: ${safeLine(hook.output, 90)}`
      ),
      h(
        Text,
        { key: `${hook.tool}:${hook.id}:${hook.output}:${index}:risk` },
        `  risk: ${safeLine(hook.risk, 92)}`
      ),
      hook.drift
        ? h(
            Text,
            { key: `${hook.tool}:${hook.id}:${hook.output}:${index}:drift` },
            "  drift: managed hook changed outside SAMX"
          )
        : null,
    ]),
    preview.plan.environmentReminders.length > 0 ? h(Text, null, "Environment reminders") : null,
    ...preview.plan.environmentReminders.map((reminder) =>
      h(
        Text,
        { key: `env:${reminder.packageId}` },
        `- ${safeLine(`${reminder.packageId} requires ${reminder.env.join(", ")}`, 100)}`
      )
    ),
    preview.managedMcpKeys.length > 0 ? h(Text, null, "Managed MCP keys") : null,
    ...preview.managedMcpKeys.map((key) => h(Text, { key }, `- ${safeLine(key, 100)}`)),
    preview.mcpPreview.length > 0 ? h(Text, null, "MCP preview") : null,
    ...preview.mcpPreview.map((value, index) =>
      h(Text, { key: `mcp-${index}` }, safeBlock(value, 1000))
    ),
    h(Select, {
      items,
      onSelect: (item) =>
        item.value === "apply"
          ? void apply()
          : item.value === "back"
            ? onDone()
            : void runPreview(bundleId, tool, true),
    })
  );
}

function UnlinkScreen({ api, setError, setMessage }: ScreenProps) {
  const [selected, setSelected] = useState<LinkRecordRow>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const { data: records, loading } = useAsync(
    () => api.listLinkRecords(),
    [api, refresh],
    setError
  );

  async function unlink(record: LinkRecordRow) {
    setBusy(true);
    try {
      await api.unlink(record);
      setMessage(`Unlinked ${record.bundleId} from ${record.tool}.`);
      setSelected(undefined);
      setRefresh((value) => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (loading || busy) return h(Loading);
  if (selected) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, `Unlink ${selected.bundleId} from ${selected.tool}?`),
      h(Text, null, safeLine(selected.projectRoot, 100)),
      h(Text, null, "Generated outputs"),
      ...selected.generatedFiles.map((file) => h(Text, { key: file }, `- ${safeLine(file, 100)}`)),
      selected.managedJsonEntries.length > 0 ? h(Text, null, "Managed MCP keys") : null,
      ...selected.managedJsonEntries.map((entry) =>
        h(
          Text,
          { key: `${entry.path}:${entry.key}` },
          `- ${safeLine(`${entry.path} ${entry.keyPath.join(".")}.${entry.key}`, 100)}`
        )
      ),
      h(
        Text,
        { dimColor: true },
        "MCP unlink removes only recorded SAMX-managed server keys. It does not delete the whole MCP file."
      ),
      h(Select, {
        items: [
          { label: "Confirm unlink", value: "confirm" },
          { label: "Cancel", value: "cancel" },
        ],
        onSelect: (item) =>
          item.value === "confirm" ? void unlink(selected) : setSelected(undefined),
      })
    );
  }
  if (!records || records.length === 0)
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "No linked bundles found."),
      h(Text, { dimColor: true }, "Use Link bundle first, or return to the dashboard.")
    );
  const recordById = new Map(records.map((record) => [record.id, record]));
  const items = records.map((record) => ({
    label: `${record.bundleId} -> ${record.tool}  ${record.generatedFiles.length} outputs, ${record.managedJsonEntries.length} MCP server keys`,
    value: record.id,
  }));
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, "Linked bundles"),
    h(Select, { items, onSelect: (item) => setSelected(recordById.get(String(item.value))) })
  );
}

interface ScreenProps {
  api: TuiApi;
  setError(error: string | undefined): void;
  setMessage(message: string | undefined): void;
  setTextInputActive(active: boolean): void;
}

interface ManagedTextInputProps {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  onCancel?(): void;
  setTextInputActive(active: boolean): void;
}

function ManagedTextInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  setTextInputActive,
}: ManagedTextInputProps) {
  useEffect(() => {
    setTextInputActive(true);
    return () => setTextInputActive(false);
  }, [setTextInputActive]);
  useInput((_, key) => {
    if (key.escape && onCancel) onCancel();
  });

  return h(TextInput, { value, onChange, onSubmit });
}

function Loading() {
  return h(Text, { color: "yellow" }, "Loading...");
}

function ErrorPanel({ message }: { message: string }) {
  return h(
    Box,
    { borderStyle: "round", borderColor: "red", paddingX: 1, flexDirection: "column" },
    h(Text, { color: "red" }, "Error"),
    h(Text, null, message)
  );
}

function useAsync<T>(
  load: () => Promise<T>,
  deps: React.DependencyList,
  setError: (error: string | undefined) => void
): { data?: T; loading: boolean } {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    load()
      .then((value) => {
        if (active) {
          setData(value);
          setError(undefined);
        }
      })
      .catch((error: unknown) => {
        if (active) setError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, deps);
  return { data, loading };
}

async function createBundleShared(
  api: TuiApi,
  id: string,
  setError: (error: string | undefined) => void,
  setMessage: (message: string | undefined) => void
): Promise<boolean> {
  try {
    await api.createBundle(id);
    setMessage(`Created bundle ${id}.`);
    return true;
  } catch (error) {
    setError(errorMessage(error));
    return false;
  }
}

function nextCapabilityType(type: CapabilityTypeFilter): CapabilityTypeFilter {
  if (type === "all") return "skill";
  if (type === "skill") return "agent";
  if (type === "agent") return "mcp";
  return "all";
}

function formatPackageUpdateChange(
  change: Awaited<ReturnType<TuiApi["previewPackageUpdates"]>>[number]["changes"][number]
): string {
  if ("values" in change) return JSON.stringify(change.values);
  return `${change.before} -> ${change.after}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
