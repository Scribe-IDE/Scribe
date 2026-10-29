// The appearance controls in Settings, and the theme editor: a theme of your own, made from the
// one in use, every colour editable with the app changing as you go.
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { $, setStatus } from "./core";
import { appearance, allThemes, applyAppearance, currentTheme, FONTS, updateAppearance } from "./appearance";
import { BUILT_IN, COLOR_GROUPS, contrast, parseHex, themeFromJson, type Theme, type ThemeColors } from "./themes";

// ---------- Settings > Appearance and Editor ----------
function fillThemeSelect() {
  const select = $<HTMLSelectElement>("setting-theme");
  select.replaceChildren(new Option("Match the system", "system"));
  const group = (label: string, themes: Theme[]) => {
    if (!themes.length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    for (const th of themes) g.append(new Option(th.name, th.id));
    select.append(g);
  };
  group("Dark", BUILT_IN.filter((x) => x.base === "dark"));
  group("Light", BUILT_IN.filter((x) => x.base === "light"));
  group("Yours", appearance.custom);
  select.value = appearance.theme;
}

/** Show the controls as the appearance is now. */
export function renderAppearanceControls() {
  fillThemeSelect();
  const theme = currentTheme();
  $<HTMLInputElement>("setting-accent").value = appearance.accent ?? theme.colors.accent;
  $<HTMLButtonElement>("setting-accent-reset").disabled = !appearance.accent;
  $<HTMLSelectElement>("setting-ui-scale").value = String(appearance.uiScale);
  const font = $<HTMLSelectElement>("setting-font");
  if (!font.options.length) {
    for (const f of FONTS) font.append(new Option(f.name, f.id));
    font.append(new Option("Another installed font…", "name:"));
  }
  const custom = appearance.font.startsWith("name:");
  font.value = custom ? "name:" : appearance.font;
  $("setting-font-name-row").hidden = !custom;
  $<HTMLInputElement>("setting-font-name").value = custom ? appearance.font.slice(5) : "";
  $<HTMLSelectElement>("setting-line-height").value = String(appearance.lineHeight);
  $<HTMLInputElement>("setting-ligatures").checked = appearance.ligatures;
}

export function initAppearanceControls() {
  $("setting-theme").addEventListener("change", (e) => {
    const id = (e.target as HTMLSelectElement).value;
    const chosen = allThemes().find((x) => x.id === id);
    // the chosen theme is also what "Match the system" and the View menu use for its kind
    updateAppearance({ theme: id, ...(chosen ? { [chosen.base]: id } : {}) }).then(renderAppearanceControls);
  });
  const accent = $<HTMLInputElement>("setting-accent");
  accent.addEventListener("input", () => updateAppearance({ accent: accent.value }));
  accent.addEventListener("change", renderAppearanceControls);
  $("setting-accent-reset").addEventListener("click", () => updateAppearance({ accent: null }).then(renderAppearanceControls));
  $("setting-ui-scale").addEventListener("change", (e) => updateAppearance({ uiScale: Number((e.target as HTMLSelectElement).value) }));
  $("setting-font").addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value;
    if (value === "name:") {
      $("setting-font-name-row").hidden = false;
      $<HTMLInputElement>("setting-font-name").focus();
      return;
    }
    updateAppearance({ font: value }).then(renderAppearanceControls);
  });
  const name = $<HTMLInputElement>("setting-font-name");
  name.addEventListener("change", () => {
    const family = name.value.trim();
    if (!family) return;
    // a font the system doesn't have would silently fall back to the default
    if (!document.fonts.check(`12px "${family}"`) && !installed(family)) {
      setStatus(`No font called ${family} on this computer`, "err");
      return;
    }
    updateAppearance({ font: `name:${family}` }).then(renderAppearanceControls);
  });
  $("setting-line-height").addEventListener("change", (e) => updateAppearance({ lineHeight: Number((e.target as HTMLSelectElement).value) }));
  $("setting-ligatures").addEventListener("change", (e) => updateAppearance({ ligatures: (e.target as HTMLInputElement).checked }));
  $("setting-theme-edit").addEventListener("click", () => openThemeEditor());
  renderAppearanceControls();
}

/** Whether a font is installed: text set in it measures differently from the fallback. */
function installed(family: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d")!;
  const sample = "mmmmmmmmmmlli1|WW@";
  const width = (font: string) => {
    ctx.font = `32px ${font}`;
    return ctx.measureText(sample).width;
  };
  return ["monospace", "serif"].some((fallback) => width(`"${family}", ${fallback}`) !== width(fallback));
}

/** The light or dark theme of the user's choice, for the View menu. */
export function useThemeOfKind(kind: "light" | "dark") {
  updateAppearance({ theme: appearance[kind] }).then(renderAppearanceControls);
}

// ---------- the theme editor ----------
let dialog: HTMLDialogElement | null = null;
/** Something was changed since the editor opened (a theme made but left as it was is dropped). */
let edited = false;

/** Edit the theme in use if it's one of yours; otherwise start one from it. */
export function openThemeEditor() {
  let theme = currentTheme();
  const before = appearance.theme;
  const made = !theme.id.startsWith("custom-");
  edited = false;
  if (made) {
    theme = { id: `custom-${Date.now().toString(36)}`, name: `${theme.name} (mine)`, base: theme.base, colors: { ...theme.colors } };
    appearance.custom.push(theme);
  }
  updateAppearance({ theme: theme.id, [theme.base]: theme.id, custom: appearance.custom });
  renderAppearanceControls();
  dialog?.remove();
  dialog = document.createElement("dialog");
  dialog.className = "theme-editor";
  dialog.setAttribute("aria-label", "Edit theme");
  document.body.append(dialog);
  render(theme);
  dialog.addEventListener("close", () => {
    dialog?.remove();
    dialog = null;
    if (made && !edited && appearance.custom.some((x) => x.id === theme.id)) {
      appearance.custom = appearance.custom.filter((x) => x.id !== theme.id);
      void updateAppearance({ custom: appearance.custom, theme: before, [theme.base]: before === "system" ? `scribe-${theme.base}` : before });
    }
    renderAppearanceControls();
  });
  dialog.showModal();
}

let saveTimer = 0;
function changed(theme: Theme) {
  edited = true;
  // apply at once; keep after the colour wells settle
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => updateAppearance({ custom: appearance.custom }), 150);
  void applyAppearance();
  checkContrast(theme);
}

function checkContrast(theme: Theme) {
  const note = dialog?.querySelector<HTMLElement>(".theme-contrast");
  if (!note) return;
  const text = contrast(theme.colors.fg, theme.colors.bg);
  const muted = contrast(theme.colors.muted, theme.colors.panel);
  const weak = text < 7 ? "Text" : muted < 4.5 ? "Muted text" : null;
  note.textContent = weak
    ? `${weak} is hard to read on its background (contrast ${(weak === "Text" ? text : muted).toFixed(1)}:1; aim for ${weak === "Text" ? 7 : 4.5}).`
    : `Contrast ${text.toFixed(1)}:1. Easy to read.`;
  note.classList.toggle("weak", !!weak);
}

function render(theme: Theme) {
  if (!dialog) return;
  dialog.replaceChildren();
  const head = document.createElement("header");
  const name = document.createElement("input");
  name.className = "theme-name";
  name.value = theme.name;
  name.setAttribute("aria-label", "Theme name");
  name.addEventListener("input", () => {
    theme.name = name.value.trim() || "My theme";
    changed(theme);
  });
  const base = document.createElement("select");
  base.setAttribute("aria-label", "Light or dark");
  base.append(new Option("Dark", "dark"), new Option("Light", "light"));
  base.value = theme.base;
  base.addEventListener("change", () => {
    theme.base = base.value as Theme["base"];
    changed(theme);
  });
  head.append(name, base);

  const body = document.createElement("div");
  body.className = "theme-groups";
  for (const group of COLOR_GROUPS) {
    const section = document.createElement("section");
    const title = document.createElement("h4");
    title.textContent = group.title;
    section.append(title);
    for (const [key, label] of group.keys) section.append(colorRow(theme, key, label));
    body.append(section);
  }

  const contrastNote = document.createElement("p");
  contrastNote.className = "theme-contrast";

  const foot = document.createElement("footer");
  const button = (text: string, onclick: () => void, cls = "btn") => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = text;
    b.onclick = onclick;
    return b;
  };
  const remove = button("Delete Theme", () => {
    appearance.custom = appearance.custom.filter((x) => x.id !== theme.id);
    const fallback = `scribe-${theme.base}`;
    updateAppearance({ custom: appearance.custom, theme: fallback, [theme.base]: fallback });
    dialog?.close();
  }, "btn theme-delete");
  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  foot.append(remove, spacer, button("Import…", () => importTheme()), button("Export…", () => exportTheme(theme)), button("Done", () => dialog?.close(), "btn btn-primary"));
  dialog.append(head, body, contrastNote, foot);
  checkContrast(theme);
}

function colorRow(theme: Theme, key: keyof ThemeColors, label: string): HTMLElement {
  const row = document.createElement("label");
  row.className = "theme-color";
  const well = document.createElement("input");
  well.type = "color";
  well.value = theme.colors[key];
  const hex = document.createElement("input");
  hex.className = "theme-hex";
  hex.value = theme.colors[key];
  hex.spellcheck = false;
  hex.setAttribute("aria-label", `${label}, hex`);
  const text = document.createElement("span");
  text.textContent = label;
  well.addEventListener("input", () => {
    theme.colors[key] = well.value;
    hex.value = well.value;
    changed(theme);
  });
  hex.addEventListener("change", () => {
    const v = hex.value.trim().startsWith("#") ? hex.value.trim() : `#${hex.value.trim()}`;
    if (!parseHex(v)) {
      hex.value = theme.colors[key];
      return;
    }
    theme.colors[key] = v;
    well.value = v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : v;
    changed(theme);
  });
  row.append(well, text, hex);
  return row;
}

async function exportTheme(theme: Theme) {
  const dest = await save({ title: "Export theme", defaultPath: `${theme.name.replace(/[^\w -]+/g, "")}.json`, filters: [{ name: "Theme", extensions: ["json"] }] });
  if (!dest) return;
  const { id: _id, ...shared } = theme;
  try {
    await invoke("save_text", { dest, content: JSON.stringify(shared, null, 2) + "\n" });
    setStatus(`Exported ${theme.name}`, "ok");
  } catch (e) {
    setStatus(`Couldn't export the theme: ${e}`, "err");
  }
}

function importTheme() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let theme: Theme | null = null;
    try {
      theme = themeFromJson(JSON.parse(await file.text()));
    } catch { /* not JSON */ }
    if (!theme) {
      setStatus(`${file.name} isn't a Scribe theme`, "err");
      return;
    }
    appearance.custom.push(theme);
    edited = true;
    await updateAppearance({ custom: appearance.custom, theme: theme.id, [theme.base]: theme.id });
    render(theme);
    renderAppearanceControls();
    setStatus(`Imported ${theme.name}`, "ok");
  };
  input.click();
}
