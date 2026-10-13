// Per-project settings: theme, editor font size, hand-arranged file order.
import { invoke } from "@tauri-apps/api/core";
import { $, root } from "./core";
import { editorTheme, themeConf, view } from "./editor";
import { cellThemeConf, cellViews } from "./notebook";

// ---------- settings ----------
export interface Settings {
  theme: "dark" | "light";
  fontSize: number;
  /** Hand-arranged file order per folder ("" is the project root): file names, top to bottom. */
  order: Record<string, string[]>;
  /** Saving (⌘S) also compiles the paper. */
  compileOnSave: boolean;
}

export const DEFAULT_SETTINGS: Settings = { theme: "dark", fontSize: 13, order: {}, compileOnSave: false };
export const FONT_MIN = 10;
export const FONT_MAX = 24;

export let settings: Settings = { ...DEFAULT_SETTINGS };

for (let size = FONT_MIN; size <= FONT_MAX; size++) {
  $<HTMLSelectElement>("setting-fontsize").add(new Option(String(size), String(size)));
}
$<HTMLSelectElement>("setting-fontsize").value = String(settings.fontSize);

export function resetSettings() {
  settings = { ...DEFAULT_SETTINGS };
}

export function setTheme(theme: Settings["theme"]) {
  settings.theme = theme;
  applySettings();
  saveSettings();
}

export function zoom(delta: number | "reset") {
  const next = delta === "reset" ? DEFAULT_SETTINGS.fontSize : settings.fontSize + delta;
  settings.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, next));
  applySettings();
  saveSettings();
}

export async function loadSettings() {
  if (!root) return;
  try {
    const json = await invoke<string>("read_settings", { root });
    const parsed = JSON.parse(json);
    settings = { ...DEFAULT_SETTINGS };
    if (parsed.theme === "dark" || parsed.theme === "light") settings.theme = parsed.theme;
    if (typeof parsed.fontSize === "number") settings.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, parsed.fontSize));
    if (parsed.order && typeof parsed.order === "object") settings.order = parsed.order;
    settings.compileOnSave = parsed.compileOnSave === true;
  } catch {}
  applySettings();
}

export async function saveSettings() {
  if (!root) return;
  try { await invoke("write_settings", { root, content: JSON.stringify(settings) }); } catch {}
}

export function applySettings() {
  const rootEl = document.documentElement;
  rootEl.setAttribute("data-theme", settings.theme);
  rootEl.style.setProperty("--editor-fs", `${settings.fontSize}px`);
  $<HTMLSelectElement>("setting-theme").value = settings.theme;
  $<HTMLSelectElement>("setting-fontsize").value = String(settings.fontSize);
  $<HTMLInputElement>("setting-compile-on-save").checked = settings.compileOnSave;
  const theme = editorTheme(settings.theme === "dark");
  view.dispatch({ effects: themeConf.reconfigure(theme) });
  view.requestMeasure();
  for (const cellView of cellViews) {
    cellView?.dispatch({ effects: cellThemeConf.reconfigure(theme) });
    cellView?.requestMeasure();
  }
}

$("setting-theme").addEventListener("change", (e) => {
  setTheme((e.target as HTMLSelectElement).value as Settings["theme"]);
});

$("setting-fontsize").addEventListener("change", (e) => {
  settings.fontSize = parseInt((e.target as HTMLSelectElement).value);
  applySettings();
  saveSettings();
});

export function setCompileOnSave(on: boolean) {
  settings.compileOnSave = on;
  applySettings();
  saveSettings();
}

$("setting-compile-on-save").addEventListener("change", (e) => {
  setCompileOnSave((e.target as HTMLInputElement).checked);
});

export function toggleSettings(show?: boolean) {
  const pop = $("settings-popover");
  pop.hidden = show === undefined ? !pop.hidden : !show;
  $("btn-settings").setAttribute("aria-expanded", String(!pop.hidden));
}
