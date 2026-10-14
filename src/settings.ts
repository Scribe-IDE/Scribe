// Per-project settings: theme, editor font size, hand-arranged file order.
import { invoke } from "@tauri-apps/api/core";
import { $, root } from "./core";
import { editorPrefs, LineNumberStyle, prefEffects, view } from "./editor";
import { mathPrefs } from "./mathpreview";
import { cellPrefEffects, cellViews } from "./notebook";
import { refreshSpelling, spellPrefs } from "./spell";
import { refreshSidePrefs, sideView } from "./split";
import { refreshTerminalTheme } from "./terminal";

// ---------- settings ----------
export interface Settings {
  theme: "dark" | "light";
  fontSize: number;
  /** Hand-arranged file order per folder ("" is the project root): file names, top to bottom. */
  order: Record<string, string[]>;
  /** Saving (⌘S) also compiles the paper. */
  compileOnSave: boolean;
  /** Recompile a moment after typing stops. */
  compileOnType: boolean;
  /** Vim keys in the editor and in notebook cells. */
  vim: boolean;
  lineNumbers: LineNumberStyle;
  /** Notebook cells show line numbers too. */
  cellLineNumbers: boolean;
  /** Underline misspelled words in .tex, .md and .txt files. */
  spellCheck: boolean;
  /** Show the rendered formula beside the cursor while editing maths. */
  mathPreview: boolean;
  /** Row height in lists and tabs. */
  density: "comfortable" | "compact";
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark", fontSize: 13, order: {}, compileOnSave: false, compileOnType: false, vim: false, lineNumbers: "absolute", cellLineNumbers: false, spellCheck: true, mathPreview: true, density: "comfortable",
};
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
    settings.compileOnType = parsed.compileOnType === true;
    settings.vim = parsed.vim === true;
    if (["absolute", "relative", "off"].includes(parsed.lineNumbers)) settings.lineNumbers = parsed.lineNumbers;
    settings.cellLineNumbers = parsed.cellLineNumbers === true;
    settings.spellCheck = parsed.spellCheck !== false;
    settings.mathPreview = parsed.mathPreview !== false;
    if (parsed.density === "compact") settings.density = "compact";
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
  rootEl.setAttribute("data-density", settings.density);
  $<HTMLSelectElement>("setting-density").value = settings.density;
  rootEl.style.setProperty("--editor-fs", `${settings.fontSize}px`);
  $<HTMLSelectElement>("setting-theme").value = settings.theme;
  $<HTMLSelectElement>("setting-fontsize").value = String(settings.fontSize);
  $<HTMLInputElement>("setting-compile-on-save").checked = settings.compileOnSave;
  $<HTMLInputElement>("setting-compile-on-type").checked = settings.compileOnType;
  $<HTMLInputElement>("setting-vim").checked = settings.vim;
  $<HTMLSelectElement>("setting-line-numbers").value = settings.lineNumbers;
  $<HTMLInputElement>("setting-cell-numbers").checked = settings.cellLineNumbers;
  $<HTMLInputElement>("setting-spell").checked = settings.spellCheck;
  spellPrefs.on = settings.spellCheck;
  $<HTMLInputElement>("setting-math").checked = settings.mathPreview;
  mathPrefs.on = settings.mathPreview;

  Object.assign(editorPrefs, {
    dark: settings.theme === "dark",
    vim: settings.vim,
    numbers: settings.lineNumbers,
    cellNumbers: settings.cellLineNumbers,
  });
  refreshTerminalTheme();
  refreshSidePrefs();
  view.dispatch({ effects: prefEffects() });
  view.requestMeasure();
  refreshSpelling(view);
  if (sideView) refreshSpelling(sideView);
  for (const cellView of cellViews) {
    cellView?.dispatch({ effects: cellPrefEffects() });
    cellView?.requestMeasure();
  }
}

/** Change one or more settings, apply them and save them with the project. */
export function updateSettings(change: Partial<Settings>) {
  Object.assign(settings, change);
  applySettings();
  saveSettings();
}

$("setting-vim").addEventListener("change", (e) => {
  updateSettings({ vim: (e.target as HTMLInputElement).checked });
});
$("setting-line-numbers").addEventListener("change", (e) => {
  updateSettings({ lineNumbers: (e.target as HTMLSelectElement).value as LineNumberStyle });
});
$("setting-density").addEventListener("change", (e) => {
  updateSettings({ density: (e.target as HTMLSelectElement).value as Settings["density"] });
});
$("setting-math").addEventListener("change", (e) => {
  updateSettings({ mathPreview: (e.target as HTMLInputElement).checked });
});
$("setting-spell").addEventListener("change", (e) => {
  updateSettings({ spellCheck: (e.target as HTMLInputElement).checked });
});
$("setting-cell-numbers").addEventListener("change", (e) => {
  updateSettings({ cellLineNumbers: (e.target as HTMLInputElement).checked });
});

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

export function setCompileOnType(on: boolean) {
  settings.compileOnType = on;
  applySettings();
  saveSettings();
}

$("setting-compile-on-type").addEventListener("change", (e) => {
  setCompileOnType((e.target as HTMLInputElement).checked);
});

export function toggleSettings(show?: boolean) {
  const pop = $("settings-popover");
  pop.hidden = show === undefined ? !pop.hidden : !show;
  $("btn-settings").setAttribute("aria-expanded", String(!pop.hidden));
}
