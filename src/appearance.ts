// Appearance: theme, accent, custom themes and fonts. Kept on this computer (localStorage), not
// with the project, so the app looks the same whichever paper is open, the welcome screen too.
import { applyTheme, BUILT_IN, type Theme } from "./themes";

export interface Appearance {
  /** A theme id, or "system" to follow the system's light or dark setting. */
  theme: string;
  /** The themes "system" uses. */
  light: string;
  dark: string;
  /** Replaces the theme's accent colour. */
  accent: string | null;
  custom: Theme[];
  /** An id from FONTS, or "name:<family>" for a font installed on the system. */
  font: string;
  ligatures: boolean;
  lineHeight: number;
  /** The whole interface, larger or smaller. */
  uiScale: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "scribe-dark", light: "scribe-light", dark: "scribe-dark", accent: null, custom: [],
  font: "system", ligatures: true, lineHeight: 1.65, uiScale: 1,
};

/** Editor fonts: the system's monospace, or one that ships with the app, loaded when first chosen. */
export const FONTS: { id: string; name: string; family: string; load?: () => Promise<unknown> }[] = [
  { id: "system", name: "System", family: 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas' },
  { id: "jetbrains", name: "JetBrains Mono", family: '"JetBrains Mono Variable"', load: () => import("@fontsource-variable/jetbrains-mono") },
  { id: "fira", name: "Fira Code", family: '"Fira Code Variable"', load: () => import("@fontsource-variable/fira-code") },
  { id: "plex", name: "IBM Plex Mono", family: '"IBM Plex Mono"', load: () => Promise.all([import("@fontsource/ibm-plex-mono/400.css"), import("@fontsource/ibm-plex-mono/500.css")]) },
  { id: "iosevka", name: "Iosevka", family: '"Iosevka"', load: () => Promise.all([import("@fontsource/iosevka/400.css"), import("@fontsource/iosevka/500.css")]) },
  { id: "source", name: "Source Code Pro", family: '"Source Code Pro Variable"', load: () => import("@fontsource-variable/source-code-pro") },
];

const KEY = "scribe.appearance";
export let appearance: Appearance = load();
/** Run whenever the look changes: the editor, terminal and others refresh their styles. */
export const appearanceListeners: (() => void)[] = [];

function load(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && typeof saved === "object") return { ...DEFAULT_APPEARANCE, ...saved };
  } catch { /* first run, or no storage */ }
  return { ...DEFAULT_APPEARANCE };
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(appearance));
  } catch { /* private window */ }
}

export const allThemes = (): Theme[] => [...BUILT_IN, ...appearance.custom];
export const themeById = (id: string): Theme | undefined => allThemes().find((x) => x.id === id);

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

/** The theme in use now. */
export function currentTheme(): Theme {
  const id = appearance.theme === "system" ? (systemDark.matches ? appearance.dark : appearance.light) : appearance.theme;
  return themeById(id) ?? BUILT_IN[0];
}

export const isDark = () => currentTheme().base === "dark";

/** Apply everything: colours, fonts, size. */
export async function applyAppearance() {
  const theme = currentTheme();
  applyTheme(theme, appearance.accent);
  try {
    localStorage.setItem("scribe.themeBase", theme.base);
  } catch { /* no storage */ }
  const root = document.documentElement;
  const font = appearance.font.startsWith("name:")
    ? { family: `"${appearance.font.slice(5).replace(/"/g, "")}"` }
    : FONTS.find((f) => f.id === appearance.font) ?? FONTS[0];
  if ("load" in font && font.load) await font.load().catch(() => {});
  root.style.setProperty("--font-mono", `${font.family}, ui-monospace, Menlo, Consolas, monospace`);
  root.style.setProperty("--mono-ligatures", appearance.ligatures ? "normal" : "none");
  root.style.setProperty("--editor-lh", String(appearance.lineHeight));
  root.style.zoom = appearance.uiScale === 1 ? "" : String(appearance.uiScale);
  for (const fn of appearanceListeners) fn();
}

/** Change the appearance, apply it and keep it. */
export function updateAppearance(change: Partial<Appearance>) {
  Object.assign(appearance, change);
  save();
  return applyAppearance();
}

systemDark.addEventListener("change", () => {
  if (appearance.theme === "system") applyAppearance();
});

/** Settings saved with a project before themes moved here: its theme becomes the first choice. */
export function adoptProjectTheme(theme: unknown) {
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    return;
  }
  if (theme === "light" || theme === "dark") updateAppearance({ theme: `scribe-${theme}` });
}
