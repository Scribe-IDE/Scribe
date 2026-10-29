// Themes: the colours of the whole app (UI and syntax) as data. A theme gives its base colours;
// the washes (hover, selection, the accent's tints) are worked out from them, so every theme,
// including the ones people make, stays consistent. Applied as the CSS variables style.css uses.
// Pure apart from `applyTheme`.

export interface Theme {
  id: string;
  name: string;
  base: "dark" | "light";
  colors: ThemeColors;
}

export interface ThemeColors {
  desk: string; bg: string; panel: string; surface: string; raised: string; border: string; borderHi: string;
  fg: string; fgDim: string; muted: string; faint: string;
  accent: string; err: string; ok: string;
  synKw: string; synCmd: string; synStr: string; synNum: string; synCmt: string; synType: string; synMath: string; synMeta: string;
}

/** The colours a theme editor shows, grouped, with what each is for. */
export const COLOR_GROUPS: { title: string; keys: [keyof ThemeColors, string][] }[] = [
  { title: "Surfaces", keys: [["desk", "Behind the PDF"], ["bg", "Editor"], ["panel", "Panels"], ["surface", "Lists"], ["raised", "Menus"], ["border", "Lines"], ["borderHi", "Strong lines"]] },
  { title: "Text", keys: [["fg", "Text"], ["fgDim", "Secondary"], ["muted", "Muted"], ["faint", "Faint"]] },
  { title: "Signals", keys: [["accent", "Accent"], ["err", "Error"], ["ok", "Success"]] },
  { title: "Syntax", keys: [["synCmd", "Commands"], ["synKw", "Keywords"], ["synStr", "Strings"], ["synNum", "Numbers"], ["synCmt", "Comments"], ["synType", "Types"], ["synMath", "Maths"], ["synMeta", "Brackets"]] },
];

const t = (id: string, name: string, base: Theme["base"], colors: ThemeColors): Theme => ({ id, name, base, colors });

export const BUILT_IN: Theme[] = [
  t("scribe-dark", "Scribe Dark", "dark", {
    desk: "#0b0b0a", bg: "#111110", panel: "#171716", surface: "#1c1c1a", raised: "#242422", border: "#2b2a28", borderHi: "#3d3b38",
    fg: "#e8e6e3", fgDim: "#c4c2be", muted: "#a3a09b", faint: "#807d78", accent: "#d4a556", err: "#e0706b", ok: "#8fbf6f",
    synKw: "#fb4934", synCmd: "#fe8019", synStr: "#b8bb26", synNum: "#d3869b", synCmt: "#928374", synType: "#fabd2f", synMath: "#83a598", synMeta: "#8ec07c",
  }),
  t("scribe-light", "Scribe Light", "light", {
    desk: "#dcdad5", bg: "#fbfaf8", panel: "#f1efec", surface: "#f6f5f2", raised: "#ffffff", border: "#dddad5", borderHi: "#c5c2bc",
    fg: "#1e1d1b", fgDim: "#3b3936", muted: "#5e5b57", faint: "#74716c", accent: "#8f6215", err: "#b3382f", ok: "#4d7a2c",
    synKw: "#9d0006", synCmd: "#af3a03", synStr: "#79740e", synNum: "#8f3f71", synCmt: "#7c6f64", synType: "#b57614", synMath: "#076678", synMeta: "#427b58",
  }),
  t("gruvbox-dark", "Gruvbox Dark", "dark", {
    desk: "#1d2021", bg: "#282828", panel: "#232323", surface: "#2c2b2a", raised: "#3c3836", border: "#3c3836", borderHi: "#504945",
    fg: "#ebdbb2", fgDim: "#d5c4a1", muted: "#bdae93", faint: "#928374", accent: "#d79921", err: "#fb4934", ok: "#b8bb26",
    synKw: "#fb4934", synCmd: "#fe8019", synStr: "#b8bb26", synNum: "#d3869b", synCmt: "#928374", synType: "#fabd2f", synMath: "#83a598", synMeta: "#8ec07c",
  }),
  t("solarized-dark", "Solarized Dark", "dark", {
    desk: "#00212b", bg: "#002b36", panel: "#01313d", surface: "#04323e", raised: "#073642", border: "#0b3d4a", borderHi: "#1d5563",
    fg: "#b4c2c2", fgDim: "#9eacac", muted: "#8fa2a4", faint: "#6f878c", accent: "#b58900", err: "#dc322f", ok: "#859900",
    synKw: "#859900", synCmd: "#268bd2", synStr: "#2aa198", synNum: "#d33682", synCmt: "#586e75", synType: "#b58900", synMath: "#6c71c4", synMeta: "#cb4b16",
  }),
  t("solarized-light", "Solarized Light", "light", {
    desk: "#e6dfc8", bg: "#fdf6e3", panel: "#f5eedb", surface: "#f8f2df", raised: "#fffbef", border: "#e4ddc8", borderHi: "#d3cbb3",
    fg: "#2f444a", fgDim: "#43575d", muted: "#52666c", faint: "#6c7f84", accent: "#8a6900", err: "#c82a27", ok: "#6c7d00",
    synKw: "#859900", synCmd: "#268bd2", synStr: "#2aa198", synNum: "#d33682", synCmt: "#93a1a1", synType: "#b58900", synMath: "#6c71c4", synMeta: "#cb4b16",
  }),
  t("nord", "Nord", "dark", {
    desk: "#242933", bg: "#2e3440", panel: "#2a2f3a", surface: "#323846", raised: "#3b4252", border: "#3b4252", borderHi: "#4c566a",
    fg: "#eceff4", fgDim: "#d8dee9", muted: "#aeb6c6", faint: "#8690a4", accent: "#88c0d0", err: "#bf616a", ok: "#a3be8c",
    synKw: "#81a1c1", synCmd: "#88c0d0", synStr: "#a3be8c", synNum: "#b48ead", synCmt: "#7b88a1", synType: "#ebcb8b", synMath: "#8fbcbb", synMeta: "#d08770",
  }),
  t("catppuccin-mocha", "Catppuccin Mocha", "dark", {
    desk: "#11111b", bg: "#1e1e2e", panel: "#181825", surface: "#232334", raised: "#313244", border: "#313244", borderHi: "#45475a",
    fg: "#cdd6f4", fgDim: "#bac2de", muted: "#a6adc8", faint: "#7f849c", accent: "#cba6f7", err: "#f38ba8", ok: "#a6e3a1",
    synKw: "#cba6f7", synCmd: "#89b4fa", synStr: "#a6e3a1", synNum: "#fab387", synCmt: "#7f849c", synType: "#f9e2af", synMath: "#94e2d5", synMeta: "#f5c2e7",
  }),
  t("catppuccin-latte", "Catppuccin Latte", "light", {
    desk: "#dce0e8", bg: "#eff1f5", panel: "#e6e9ef", surface: "#eaedf2", raised: "#ffffff", border: "#ccd0da", borderHi: "#bcc0cc",
    fg: "#3d4059", fgDim: "#4c4f69", muted: "#5a5d74", faint: "#73768b", accent: "#7c2ee0", err: "#d20f39", ok: "#40a02b",
    synKw: "#8839ef", synCmd: "#1e66f5", synStr: "#40a02b", synNum: "#fe640b", synCmt: "#8c8fa1", synType: "#df8e1d", synMath: "#179299", synMeta: "#ea76cb",
  }),
  t("github-dark", "GitHub Dark", "dark", {
    desk: "#010409", bg: "#0d1117", panel: "#11161d", surface: "#151b23", raised: "#212830", border: "#262c36", borderHi: "#3d444d",
    fg: "#f0f6fc", fgDim: "#d1d7e0", muted: "#9198a1", faint: "#768390", accent: "#4493f8", err: "#f85149", ok: "#3fb950",
    synKw: "#ff7b72", synCmd: "#d2a8ff", synStr: "#a5d6ff", synNum: "#79c0ff", synCmt: "#8b949e", synType: "#ffa657", synMath: "#7ee787", synMeta: "#79c0ff",
  }),
  t("github-light", "GitHub Light", "light", {
    desk: "#e6eaef", bg: "#ffffff", panel: "#f6f8fa", surface: "#f6f8fa", raised: "#ffffff", border: "#d1d9e0", borderHi: "#b7c0c9",
    fg: "#1f2328", fgDim: "#31363c", muted: "#59636e", faint: "#6e7781", accent: "#0969da", err: "#cf222e", ok: "#1a7f37",
    synKw: "#cf222e", synCmd: "#8250df", synStr: "#0a3069", synNum: "#0550ae", synCmt: "#6e7781", synType: "#953800", synMath: "#116329", synMeta: "#0550ae",
  }),
  t("tokyo-night", "Tokyo Night", "dark", {
    desk: "#13131a", bg: "#1a1b26", panel: "#16161e", surface: "#1d1e2b", raised: "#292e42", border: "#292e42", borderHi: "#3b4261",
    fg: "#c0caf5", fgDim: "#a9b1d6", muted: "#8f98c4", faint: "#6a73a1", accent: "#7aa2f7", err: "#f7768e", ok: "#9ece6a",
    synKw: "#bb9af7", synCmd: "#7aa2f7", synStr: "#9ece6a", synNum: "#ff9e64", synCmt: "#565f89", synType: "#e0af68", synMath: "#7dcfff", synMeta: "#73daca",
  }),
];

// ---------- colour arithmetic ----------
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

const rgba = (hex: string, alpha: number) => {
  const c = parseHex(hex) ?? [128, 128, 128];
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
};

/** Relative luminance (WCAG). */
export function luminance(hex: string): number {
  const c = (parseHex(hex) ?? [0, 0, 0]).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** Mix two colours: `t` = 0 is `a`, 1 is `b`. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [parseHex(a) ?? [0, 0, 0], parseHex(b) ?? [0, 0, 0]];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** Every CSS variable a theme sets, worked out from its colours (and an accent that overrides its own). */
export function themeVariables(theme: Theme, accent?: string | null): Record<string, string> {
  const c = { ...theme.colors, ...(accent && parseHex(accent) ? { accent } : {}) };
  const dark = theme.base === "dark";
  // a hover wash is the text colour, faint; the accent's tints likewise
  const accentHi = dark ? mix(c.accent, "#ffffff", 0.18) : mix(c.accent, "#000000", 0.15);
  const onAccent = contrast(c.accent, "#ffffff") >= contrast(c.accent, "#111111") ? "#ffffff" : "#1b1407";
  return {
    "--desk": c.desk, "--bg": c.bg, "--panel": c.panel, "--surface": c.surface, "--raised": c.raised,
    "--border": c.border, "--border-hi": c.borderHi,
    "--fg": c.fg, "--fg-dim": c.fgDim, "--muted": c.muted, "--faint": c.faint,
    "--hover": rgba(c.fg, dark ? 0.06 : 0.05), "--active": rgba(c.fg, dark ? 0.1 : 0.09), "--line-hl": rgba(c.fg, 0.035),
    "--accent": c.accent, "--accent-hi": accentHi, "--accent-dim": rgba(c.accent, dark ? 0.14 : 0.12),
    "--on-accent": onAccent, "--select": rgba(c.accent, dark ? 0.26 : 0.28),
    "--err": c.err, "--err-dim": rgba(c.err, dark ? 0.12 : 0.1), "--ok": c.ok,
    "--syn-kw": c.synKw, "--syn-cmd": c.synCmd, "--syn-str": c.synStr, "--syn-num": c.synNum,
    "--syn-cmt": c.synCmt, "--syn-type": c.synType, "--syn-math": c.synMath, "--syn-meta": c.synMeta,
    "--chart-1": dark ? mix(c.accent, c.bg, 0.15) : c.accent,
  };
}

/** A theme read from a file someone shared: the colours it has, the rest from the base it names. */
export function themeFromJson(json: unknown): Theme | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Partial<Theme>;
  const base = o.base === "light" ? "light" : "dark";
  const fallback = BUILT_IN.find((x) => x.id === `scribe-${base}`)!;
  const colors = { ...fallback.colors };
  for (const key of Object.keys(colors) as (keyof ThemeColors)[]) {
    const v = (o.colors as Record<string, unknown> | undefined)?.[key];
    if (typeof v === "string" && parseHex(v)) colors[key] = v;
  }
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 40) : "Imported theme";
  return { id: `custom-${Date.now().toString(36)}`, name, base, colors };
}

/** Set a theme's variables on the page. */
export function applyTheme(theme: Theme, accent?: string | null) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(theme, accent))) root.style.setProperty(name, value);
  root.setAttribute("data-theme", theme.base);
  root.style.colorScheme = theme.base;
}
