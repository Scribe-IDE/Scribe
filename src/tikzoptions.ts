// TikZ options: the `[…]` of a statement as a list of entries, and the style controls of the
// preview as edits of that list. Entries the controls don't know are kept as written.
// Pure: no DOM, no editor.

export type Group =
  | "width" | "dash" | "arrows" | "stroke" | "drawFlag" | "fill" | "opacity" | "corners"
  | "shape" | "font" | "textColor" | "place";

export const BASE_COLORS = [
  "black", "darkgray", "gray", "lightgray", "white", "red", "orange", "yellow", "lime", "green", "teal",
  "cyan", "blue", "violet", "purple", "magenta", "pink", "brown", "olive",
];

const WIDTHS = ["ultra thin", "very thin", "thin", "semithick", "thick", "very thick", "ultra thick"];
const DASHES = ["solid", "dashed", "dotted", "densely dashed", "loosely dashed", "densely dotted", "loosely dotted", "dash dot", "dashdotted"];
const SHAPES = ["rectangle", "circle", "ellipse", "diamond"];
const PLACES = ["above", "below", "left", "right", "above left", "above right", "below left", "below right", "midway", "near start", "near end", "sloped"];

/** The entries of an options text (`[a, b=c]` or `a, b=c`), split at top-level commas. */
export function parseOptions(text: string): string[] {
  const inside = text.trim().replace(/^\[([\s\S]*)\]$/, "$1");
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= inside.length; i++) {
    const ch = inside[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if ((ch === "," && depth === 0) || i === inside.length) {
      const entry = inside.slice(start, i).trim();
      if (entry) out.push(entry);
      start = i + 1;
    }
  }
  return out;
}

/** The options text for entries: `[a, b]`, or nothing when there are none. */
export const writeOptions = (entries: string[]) => (entries.length ? `[${entries.join(", ")}]` : "");

const isColor = (value: string, colors: Set<string>) => {
  // xcolor expressions: red, red!50, red!50!black, amber!25
  const base = /^([A-Za-z][\w]*)(?:![\d.]+(?:![A-Za-z]\w*)?)*$/.exec(value.trim());
  return !!base && colors.has(base[1]);
};

/** Which control an entry belongs to, if any. `colors` are the names that count as colours. */
export function groupOf(entry: string, colors: Set<string>): Group | null {
  const e = entry.trim();
  const key = /^([^=]+?)\s*=/.exec(e)?.[1];
  if (WIDTHS.includes(e) || key === "line width") return "width";
  if (DASHES.includes(e) || key === "dash pattern" || key === "dash") return "dash";
  // ->, <-, <->, |-|, -{Stealth}, {Latex}-{Latex}, -Stealth …
  if (!key && /^(\{[^}]*\}|[<>|]|[A-Z][\w]*)?-(\{[^}]*\}|[<>|]|[A-Z][\w]*)?$/.test(e) && e !== "-") return "arrows";
  if (key === "arrows") return "arrows";
  if (key === "draw" || key === "color") return "stroke";
  if (e === "draw") return "drawFlag";
  if (key === "fill" || e === "fill") return "fill";
  if (key === "opacity" || key === "draw opacity" || key === "fill opacity") return "opacity";
  if (e === "rounded corners" || e === "sharp corners" || key === "rounded corners") return "corners";
  if (SHAPES.includes(e) || key === "shape") return "shape";
  if (key === "font") return "font";
  if (key === "text") return "textColor";
  if (PLACES.includes(e) || key === "pos") return "place";
  if (!key && isColor(e, colors)) return "stroke";
  return null;
}

/** The entries with every entry of `group` removed and `value` (if any) put where the first one was. */
export function setGroup(entries: string[], group: Group, value: string | null, colors: Set<string>): string[] {
  const out: string[] = [];
  let placed = false;
  for (const entry of entries) {
    if (groupOf(entry, colors) !== group) {
      out.push(entry);
      continue;
    }
    if (value && !placed) out.push(value);
    placed = true;
  }
  if (value && !placed) out.push(value);
  return out;
}

/** What the controls show for a statement's options. */
export interface Style {
  stroke: string | null;
  fill: string | null;
  width: string | null;
  dash: string | null;
  arrows: string | null;
  corners: boolean;
  opacity: number;
  shape: string | null;
  font: string | null;
  textColor: string | null;
  /** A node has a border: `draw` or `draw=…`. */
  border: boolean;
}

export function readStyle(entries: string[], colors: Set<string>): Style {
  const style: Style = {
    stroke: null, fill: null, width: null, dash: null, arrows: null, corners: false, opacity: 1,
    shape: null, font: null, textColor: null, border: false,
  };
  const value = (e: string) => e.replace(/^[^=]*=\s*/, "").replace(/^\{(.*)\}$/, "$1").trim();
  for (const e of entries) {
    switch (groupOf(e, colors)) {
      case "stroke": style.stroke = e.includes("=") ? value(e) : e; style.border = true; break;
      case "drawFlag": style.border = true; break;
      case "fill": style.fill = e.includes("=") ? value(e) : "black"; break;
      case "width": style.width = e; break;
      case "dash": style.dash = e; break;
      case "arrows": style.arrows = e; break;
      case "corners": style.corners = e !== "sharp corners"; break;
      case "opacity": style.opacity = Number(value(e)) || 1; break;
      case "shape": style.shape = e.includes("=") ? value(e) : e; break;
      case "font": style.font = value(e); break;
      case "textColor": style.textColor = value(e); break;
    }
  }
  return style;
}

/** Colours a document defines with \definecolor or \colorlet. */
export function definedColors(text: string): string[] {
  return [...new Set([...text.matchAll(/\\(?:definecolor|colorlet)\s*\{([^}]+)\}/g)].map((m) => m[1].trim()))];
}
