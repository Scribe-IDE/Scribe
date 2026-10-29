// TikZ canvas: what sits on top of the picture in the preview: the grid, handles, selection,
// drawing tools, the style bar and the keys. The source stays the one truth: every action here
// is an edit of the editor's document (one undo step each), drawn first as a draft while a
// drag is in progress.
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import {
  BASE_COLORS, parseOptions, readStyle, setGroup, writeOptions, type Group, type Style,
} from "./tikzoptions";
import {
  canvasToPage, canvasToShift, formatCoordinate, freshName, fromPage, lineLabel, nodeShift, pageToCanvas,
  shapeSource, shiftToCanvas, statementBox, toPage, withLineLabel, withShift, appendStatement, scanPicture,
  type End, type Marks, type PictureScan, type Point, type ShapeTool, type Statement,
} from "./tikzsource";

/** A change to the picture's text, relative to where the picture starts. */
export interface Edit { from: number; to: number; original: string; text: string }
/** The picture drawn: where it starts, its text and scan as the editor had it, and its marks. */
export interface Shown { from: number; text: string; scan: PictureScan; marks: Marks | null }

export interface CanvasHost {
  editor: EditorView;
  stage: HTMLElement;
  /** The picture drawn, as the editor has it. */
  shown(): Shown | null;
  /** Draw the picture with these edits made, without touching the editor (null: as it is). */
  setDraft(edits: Edit[] | null): void;
  /** The paper's own colours. */
  paperColors(): string[];
}

type Tool = "select" | ShapeTool;

let host: CanvasHost | null = null;
let toolsEl: HTMLElement;
let styleEl: HTMLElement;
let countEl: HTMLElement;

let tool: Tool = "select";
/** Selected statements, by index in the scan. */
let selected: number[] = [];
let hover = -1;
let lastCount = -1;
/** A statement whose text should open for editing once the preview has drawn the edit that made
 *  it (`pendingAfter` is the picture's text before that edit). */
let pendingText = -1;
let pendingAfter = "";
/** The canvas itself changed the statements (added, duplicated, deleted) and set the selection to match. */
let expectSelection = false;
/** The opacity slider is held: the style bar mustn't be rebuilt under it. */
let sliding = false;
/** Style for new shapes, set from the style bar while a drawing tool is on. */
const defaults = new Map<Group, string>();

let snapStep = Number(read("scribe.tikzSnap") ?? 0.25) || 0;
if (![1, 0.5, 0.25, 0.1, 0].includes(snapStep)) snapStep = 0.25;
let gridOn = read("scribe.tikzGrid") !== "off";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch { /* private window */ }
}

// ---------- geometry ----------
const STICK = 8;
const FINE = 0.05;

function sheet(): HTMLElement | null {
  return host?.stage.querySelector<HTMLElement>(".tikz-sheet") ?? null;
}
function layer(): HTMLElement | null {
  return host?.stage.querySelector<HTMLElement>(".tikz-handles") ?? null;
}
/** The pointer as fractions of the page. */
function pageOf(e: { clientX: number; clientY: number }): Point | null {
  const s = sheet();
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}
/** Fractions of the page to pixels of the layer. */
function px(page: Point): Point {
  const l = layer()!;
  return [page[0] * l.clientWidth, page[1] * l.clientHeight];
}
const stepFor = (e: { altKey: boolean }) => (e.altKey ? FINE : snapStep);
const snap = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : Math.round(v * 100) / 100);

/** A statement's box on the page: [left, top, right, bottom] as fractions. Its place can come
 *  from other marks (`from`, moved by `shift` pt on the canvas), drawn on the page of `marks`. */
function boxOf(marks: Marks, name: string, from: Marks = marks, shift: Point = [0, 0]): [number, number, number, number] | null {
  const b = from.boxes.get(name);
  if (!b) return null;
  const [sw, ne] = b;
  const tl = canvasToPage(marks, [sw[0] + shift[0], ne[1] + shift[1]]);
  const br = canvasToPage(marks, [ne[0] + shift[0], sw[1] + shift[1]]);
  return [tl[0], tl[1], br[0], br[1]];
}

/** A point of a scope on the canvas (pt); `vector` leaves out the scope's origin. */
function canvasOf(marks: Marks, scope: number, p: Point, vector = false): Point {
  const s = marks.scopes[scope];
  if (!s) return [0, 0];
  const o = vector ? [0, 0] : s.o;
  return [o[0] + p[0] * (s.x[0] - s.o[0]) + p[1] * (s.y[0] - s.o[0]), o[1] + p[0] * (s.x[1] - s.o[1]) + p[1] * (s.y[1] - s.o[1])];
}

/** The page points a statement goes through: its written coordinates and the nodes it joins. */
function pointsOf(shown: Shown, st: Statement): Point[] {
  const marks = shown.marks!;
  // in the order the path goes through them
  const found: [number, Point][] = [];
  for (const k of st.coords) {
    const c = shown.scan.coords[k];
    const p = toPage(marks, c.scope, c.x, c.y);
    if (p) found.push([c.from, p]);
  }
  const text = shown.text.slice(st.from, st.to);
  for (const m of text.matchAll(/\(([A-Za-z][\w-]*)(?:\.[\w ]+)?\)/g)) {
    const centre = marks.nodes.get(m[1]);
    if (centre && m[1] !== st.defines) found.push([st.from + m.index!, canvasToPage(marks, centre)]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** The statement under the pointer: the smallest box holding it, and for lines, near the line itself. */
function hitStatement(e: { clientX: number; clientY: number }): number {
  const shown = host?.shown();
  const page = pageOf(e);
  if (!shown?.marks || !page) return -1;
  const at = px(page);
  let best = -1;
  let bestArea = Infinity;
  shown.scan.statements.forEach((st, k) => {
    if (!st.selectable) return;
    const box = boxOf(shown.marks!, statementBox(k));
    if (!box) return;
    const [x0, y0] = px([box[0], box[1]]);
    const [x1, y1] = px([box[2], box[3]]);
    const pad = 5;
    if (at[0] < x0 - pad || at[0] > x1 + pad || at[1] < y0 - pad || at[1] > y1 + pad) return;
    if (st.kind === "line" || st.kind === "polyline" || st.kind === "curve") {
      const pts = pointsOf(shown, st).map(px);
      if (st.kind !== "curve" && pts.length >= 2) {
        let d = Infinity;
        for (let i = 1; i < pts.length; i++) d = Math.min(d, distanceToSegment(at, pts[i - 1], pts[i]));
        if (pts.length > 2 && shown.text.slice(st.from, st.to).includes("cycle")) d = Math.min(d, distanceToSegment(at, pts[pts.length - 1], pts[0]));
        if (d > 7) return;
      }
    }
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    if (area < bestArea) [best, bestArea] = [k, area];
  });
  return best;
}

/** Where a new shape's point goes: on a node (named in the TikZ) when `nodes` and the pointer is
 *  over one, on an existing point when close to it, otherwise on the grid. */
function endAt(e: PointerEvent, nodes: boolean): End | null {
  const shown = host?.shown();
  const page = pageOf(e);
  if (!shown?.marks || !page) return null;
  const marks = shown.marks;
  const at = px(page);
  if (nodes) {
    let best: string | null = null;
    let bestArea = Infinity;
    for (const name of shown.scan.names) {
      const box = boxOf(marks, name);
      if (!box) continue;
      const [x0, y0] = px([box[0], box[1]]);
      const [x1, y1] = px([box[2], box[3]]);
      if (at[0] < x0 - 2 || at[0] > x1 + 2 || at[1] < y0 - 2 || at[1] > y1 + 2) continue;
      const area = (x1 - x0) * (y1 - y0);
      if (area < bestArea) [best, bestArea] = [name, area];
    }
    const centre = best ? marks.nodes.get(best) : null;
    if (best && centre) {
      const c = canvasToPage(marks, centre);
      const point = fromPage(marks, 0, c[0], c[1]);
      if (point) return { point, node: best };
    }
  }
  for (const c of shown.scan.coords) {
    if (c.scope !== 0) continue;
    const p = toPage(marks, 0, c.x, c.y);
    if (p && Math.hypot(...(px(p).map((v, i) => v - at[i]) as Point)) <= STICK) return { point: [c.x, c.y] };
  }
  const point = fromPage(marks, 0, page[0], page[1]);
  if (!point) return null;
  const step = stepFor(e);
  return { point: [snap(point[0], step), snap(point[1], step)] };
}

// ---------- editing the source ----------
function pictureText(): string | null {
  const shown = host?.shown();
  return shown && shown.scan.end >= 0 && fresh() ? shown.text : null;
}

/** The editor still has the text the scan was made from (typing since then moves everything). */
function fresh(): boolean {
  const shown = host?.shown();
  return !!shown && host!.editor.state.doc.sliceString(shown.from, shown.from + shown.text.length) === shown.text;
}

/** Make the edits in the editor as one step. Edits whose text has changed underneath are dropped. */
function commit(edits: Edit[], select?: { from: number; to: number }) {
  const shown = host?.shown();
  if (!shown || !edits.length || !fresh()) return;
  const editor = host!.editor;
  const doc = editor.state.doc;
  const valid = edits.filter((e) => doc.sliceString(shown.from + e.from, shown.from + e.to) === e.original && e.text !== e.original);
  if (!valid.length) return;
  editor.dispatch({
    changes: valid.map((e) => ({ from: shown.from + e.from, to: shown.from + e.to, insert: e.text })),
    selection: select ? { anchor: shown.from + select.from, head: shown.from + select.to } : undefined,
    userEvent: "input.tikz",
  });
  // redraw straight away rather than after the typing pause, so the next action has fresh marks
  host!.setDraft(null);
}

const textOf = (from: number, to: number) => {
  const shown = host!.shown()!;
  return host!.editor.state.doc.sliceString(shown.from + from, shown.from + to);
};

/** An edit setting a statement's options to `entries`. */
function optionsEdit(st: Statement, entries: string[]): Edit {
  const original = textOf(st.optionsFrom, st.optionsTo);
  return { from: st.optionsFrom, to: st.optionsTo, original, text: writeOptions(entries) };
}

/** The edits that move statements by a pointer offset on the page (snapped in each scope). */
function moveEdits(indices: number[], from: Point, to: Point, step: number): Edit[] {
  const shown = host?.shown();
  if (!shown?.marks) return [];
  const marks = shown.marks;
  const edits: Edit[] = [];
  for (const k of indices) {
    const st = shown.scan.statements[k];
    if (!st) continue;
    for (const ci of st.coords) {
      const c = shown.scan.coords[ci];
      const a = fromPage(marks, c.scope, from[0], from[1]);
      const b = fromPage(marks, c.scope, to[0], to[1]);
      if (!a || !b) continue;
      const [dx, dy] = [snap(b[0] - a[0], step), snap(b[1] - a[1], step)];
      edits.push({ from: c.from, to: c.to, original: textOf(c.from, c.to), text: formatCoordinate(c.x + dx, c.y + dy) });
    }
    // a node placed relative to others moves by its shift
    const node = shown.scan.nodes.find((n) => n.name === st.defines && n.optionsFrom >= st.from && n.optionsTo <= st.to);
    if (node && !st.coords.length) {
      const [a, b] = [pageToCanvas(marks, from), pageToCanvas(marks, to)];
      const d = canvasToShift(marks, node.scope, [b[0] - a[0], b[1] - a[1]]);
      if (!d) continue;
      const original = textOf(node.optionsFrom, node.optionsTo);
      const before = nodeShift(original);
      edits.push({ from: node.optionsFrom, to: node.optionsTo, original, text: withShift(original, [snap(before[0] + d[0], step), snap(before[1] + d[1], step)]) });
    }
  }
  return edits;
}

/** The page offset of one snap step right and down, for nudging and duplicating. */
function stepOffset(dx: number, dy: number): [Point, Point] | null {
  const shown = host?.shown();
  if (!shown?.marks) return null;
  const a = toPage(shown.marks, 0, 0, 0);
  const b = toPage(shown.marks, 0, dx, dy);
  return a && b ? [a, b] : null;
}

function nudge(dx: number, dy: number) {
  const pair = stepOffset(dx, dy);
  if (!pair || !selected.length) return;
  commit(moveEdits(selected, pair[0], pair[1], Math.min(Math.abs(dx || dy), snapStep || FINE)));
}

function deleteSelected() {
  const shown = host?.shown();
  const picture = pictureText();
  if (!shown || picture == null || !selected.length) return;
  const edits: Edit[] = [];
  for (const k of selected) {
    const st = shown.scan.statements[k];
    if (!st) continue;
    // the whole line when the statement is all there is on it
    const lineStart = picture.lastIndexOf("\n", st.from - 1) + 1;
    const lineEnd = picture.indexOf("\n", st.to);
    const alone = !picture.slice(lineStart, st.from).trim() && lineEnd >= 0 && !picture.slice(st.to, lineEnd).trim();
    const [from, to] = alone ? [lineStart, lineEnd + 1] : [st.from, st.to];
    edits.push({ from, to, original: picture.slice(from, to), text: "" });
  }
  selected = [];
  expectSelection = true;
  commit(edits);
}

function duplicateSelected() {
  const shown = host?.shown();
  const picture = pictureText();
  const pair = stepOffset(snapStep || 0.25, -(snapStep || 0.25));
  if (!shown?.marks || picture == null || !selected.length || !pair) return;
  const taken = new Set(shown.scan.names);
  const renamed = new Map<string, string>();
  const order = [...selected].sort((a, b) => a - b);
  for (const k of order) {
    const name = shown.scan.statements[k]?.defines;
    if (name) {
      const fresh = freshName(taken, name);
      taken.add(fresh);
      renamed.set(name, fresh);
    }
  }
  const edits: Edit[] = [];
  for (const k of order) {
    const st = shown.scan.statements[k];
    // the copy: moved by one step, its nodes renamed
    const moves = moveEdits([k], pair[0], pair[1], snapStep || 0.25).sort((a, b) => b.from - a.from);
    let text = picture.slice(st.from, st.to);
    for (const m of moves) text = text.slice(0, m.from - st.from) + m.text + text.slice(m.to - st.from);
    for (const [from, to] of renamed) text = text.replace(new RegExp(`\\((${from.replace(/[-]/g, "\\-")})(\\.[\\w ]+)?\\)`, "g"), `(${to}$2)`);
    const lineStart = picture.lastIndexOf("\n", st.from - 1) + 1;
    const indent = /^[ \t]*/.exec(picture.slice(lineStart, st.from))![0];
    edits.push({ from: st.to, to: st.to, original: "", text: `\n${indent}${text}` });
  }
  // each copy lands right after its original
  selected = order.map((k, i) => k + i + 1);
  expectSelection = true;
  commit(edits);
}

/** Put a new statement at the end of the picture; it becomes the selection. */
function addStatement(statement: string, editText: boolean) {
  const shown = host?.shown();
  const picture = pictureText();
  if (!shown || picture == null) return;
  const spot = appendStatement(picture, scanPicture(picture), statement);
  if (!spot) return;
  const index = shown.scan.statements.length;
  selected = [index];
  expectSelection = true;
  if (editText) [pendingText, pendingAfter] = [index, shown.text];
  commit([{ from: spot.at, to: spot.at, original: "", text: spot.text }]);
}

// ---------- style ----------
function colorSet(): Set<string> {
  return new Set([...BASE_COLORS, ...(host?.paperColors() ?? [])]);
}

function selectedStatements(): Statement[] {
  const shown = host?.shown();
  return shown ? selected.map((k) => shown.scan.statements[k]).filter(Boolean) : [];
}

/** Change one style control: for the selection, or for new shapes while drawing. */
function applyStyle(group: Group | "border" | "nodeShape", value: string | null, draftOnly = false) {
  const colors = colorSet();
  const sts = selectedStatements();
  if (!sts.length) {
    if (group === "border" || group === "nodeShape") return;
    if (value) defaults.set(group, value);
    else defaults.delete(group);
    renderStyleBar();
    return;
  }
  const edits = sts.map((st) => {
    let entries = parseOptions(textOf(st.optionsFrom, st.optionsTo));
    const isNode = st.kind === "node";
    if (group === "stroke") {
      entries = setGroup(entries, "drawFlag", null, colors);
      entries = setGroup(entries, "stroke", value && (isNode ? `draw=${value}` : value), colors);
    } else if (group === "border") {
      entries = setGroup(setGroup(entries, "stroke", null, colors), "drawFlag", value ? "draw" : null, colors);
    } else if (group === "nodeShape") {
      entries = setGroup(entries, "shape", value === "circle" ? "circle" : null, colors);
      entries = setGroup(entries, "corners", value === "rounded" ? "rounded corners=2pt" : null, colors);
    } else {
      entries = setGroup(entries, group, value, colors);
    }
    return optionsEdit(st, entries);
  });
  if (draftOnly) host!.setDraft(edits);
  else {
    host!.setDraft(null);
    commit(edits);
  }
}

/** Options for a new shape from the style bar's defaults. */
function newOptions(t: ShapeTool): string {
  const entries: string[] = [];
  const lineish = t === "line" || t === "arrow" || t === "polyline" || t === "curve" || t === "arc";
  for (const [group, value] of defaults) {
    if (group === "arrows" && !lineish) continue;
    if (group === "corners" && !(t === "rectangle" || t === "polyline" || t === "box")) continue;
    if (group === "stroke" && (t === "box" || t === "round")) entries.push(`draw=${value}`);
    else entries.push(value);
  }
  return entries.join(", ");
}

const WIDTH_CHOICES: [string | null, string][] = [["thin", "Thin"], [null, "Normal"], ["thick", "Thick"], ["very thick", "Very thick"]];
const DASH_CHOICES: [string | null, string][] = [[null, "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]];
const ARROW_CHOICES: [string | null, string][] = [[null, "None"], ["->", "End"], ["<-", "Start"], ["<->", "Both"], ["-{Stealth}", "Stealth"]];
const FONT_CHOICES: [string | null, string][] = [["\\tiny", "Tiny"], ["\\scriptsize", "Script"], ["\\small", "Small"], [null, "Normal"], ["\\large", "Large"], ["\\Large", "Larger"]];
const PLACE_CHOICES: [string, string][] = [["above", "Above"], ["below", "Below"], ["left", "Left"], ["right", "Right"], ["above, sloped", "Along"]];

const ICON = (path: string, extra = "") =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${path}</svg>`;
const WIDTH_ICON: Record<string, string> = {
  thin: ICON('<path d="M2.5 8h11" stroke-width=".75"/>'),
  "": ICON('<path d="M2.5 8h11" stroke-width="1.25"/>'),
  thick: ICON('<path d="M2.5 8h11" stroke-width="2"/>'),
  "very thick": ICON('<path d="M2.5 8h11" stroke-width="3"/>'),
};
const DASH_ICON: Record<string, string> = {
  "": ICON('<path d="M2.5 8h11"/>'),
  dashed: ICON('<path d="M2.5 8h11" stroke-dasharray="3 2"/>'),
  dotted: ICON('<path d="M2.5 8h11" stroke-dasharray=".1 2.5"/>'),
};
const ARROW_ICON: Record<string, string> = {
  "": ICON('<path d="M2.5 8h11"/>'),
  "->": ICON('<path d="M2.5 8h11M10 5l3.5 3-3.5 3"/>'),
  "<-": ICON('<path d="M2.5 8h11M6 5L2.5 8 6 11"/>'),
  "<->": ICON('<path d="M2.5 8h11M10 5l3.5 3-3.5 3M6 5L2.5 8 6 11"/>'),
  "-{Stealth}": ICON('<path d="M2.5 8h8"/><path d="M9.5 5l4 3-4 3 1-3z" fill="currentColor"/>'),
};

function segmented(label: string, choices: [string | null, string][], current: string | null, icons: Record<string, string> | null, apply: (v: string | null) => void): HTMLElement {
  const group = document.createElement("span");
  group.className = "tikz-seg";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  for (const [value, title] of choices) {
    const b = document.createElement("button");
    b.className = icons ? "icon-btn" : "btn";
    b.title = `${label}: ${title}`;
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", String(value === current));
    if (icons) b.innerHTML = icons[value ?? ""];
    else b.textContent = title;
    b.onclick = () => apply(value);
    group.append(b);
  }
  return group;
}

/** A colour button that opens a grid of the paper's colours, then the base ones. */
function swatch(label: string, current: string | null, allowNone: boolean, apply: (v: string | null) => void): HTMLElement {
  const b = document.createElement("button");
  b.className = "tikz-swatch";
  b.title = `${label}: ${current ?? "none"}`;
  b.setAttribute("aria-label", b.title);
  const chip = document.createElement("span");
  chip.className = `tikz-chip${current ? "" : " none"}`;
  if (current) chip.style.background = cssColor(current);
  const text = document.createElement("span");
  text.textContent = label;
  b.append(chip, text);
  b.onclick = (e) => {
    e.stopPropagation();
    openPopover(b, (pop) => {
      const grid = document.createElement("div");
      grid.className = "tikz-colors";
      const add = (name: string | null, title: string) => {
        const c = document.createElement("button");
        c.className = `tikz-chip${name ? "" : " none"}`;
        if (name) c.style.background = cssColor(name);
        c.title = title;
        c.setAttribute("aria-label", title);
        if (name === current) c.classList.add("current");
        c.onclick = () => {
          closePopover();
          apply(name);
        };
        grid.append(c);
      };
      if (allowNone) add(null, "None");
      for (const name of host?.paperColors() ?? []) add(name, `${name} (the paper's)`);
      for (const name of BASE_COLORS) add(name, name);
      pop.append(grid);
    });
  };
  return b;
}

// The paper's colours are only known to TeX; the swatches show them as the picture draws them.
const paperRgb = new Map<string, string>();
const BASE_RGB: Record<string, string> = {
  black: "#000", darkgray: "#404040", gray: "#808080", lightgray: "#bfbfbf", white: "#fff", red: "#f00", orange: "#ff8000",
  yellow: "#ff0", lime: "#bfff00", green: "#0f0", teal: "#008080", cyan: "#0ff", blue: "#00f", violet: "#800080",
  purple: "#bf0040", magenta: "#f0f", pink: "#ffbfbf", brown: "#bf8040", olive: "#808000",
};
function cssColor(name: string): string {
  const [base, mix] = name.split("!");
  const rgb = paperRgb.get(base) ?? BASE_RGB[base] ?? "#888";
  return mix ? `color-mix(in srgb, ${rgb} ${Number(mix)}%, white)` : rgb;
}
/** Learn the paper's colours from its preamble: \definecolor{name}{HTML}{…} and {rgb}{r,g,b}. */
export function learnColors(preamble: string) {
  for (const m of preamble.matchAll(/\\definecolor\s*\{([^}]+)\}\s*\{(HTML|rgb|RGB)\}\s*\{([^}]+)\}/g)) {
    const [, name, model, value] = m;
    if (model === "HTML") paperRgb.set(name.trim(), `#${value.trim()}`);
    else {
      const parts = value.split(",").map(Number);
      const scale = model === "rgb" ? 255 : 1;
      paperRgb.set(name.trim(), `rgb(${parts.map((v) => Math.round(v * scale)).join(",")})`);
    }
  }
  for (const m of preamble.matchAll(/\\colorlet\s*\{([^}]+)\}\s*\{([^}]+)\}/g)) paperRgb.set(m[1].trim(), cssColor(m[2].trim()));
}

let popover: HTMLElement | null = null;
function closePopover() {
  popover?.remove();
  popover = null;
  document.removeEventListener("pointerdown", outside, true);
}
function outside(e: Event) {
  if (popover && !popover.contains(e.target as Node)) closePopover();
}
function openPopover(anchor: HTMLElement, fill: (pop: HTMLElement) => void) {
  closePopover();
  const pane = anchor.closest<HTMLElement>(".tikz-pane");
  if (!pane) return;
  popover = document.createElement("div");
  popover.className = "tikz-pop";
  fill(popover);
  const a = anchor.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(a.left - p.left, p.width - 232))}px`;
  popover.style.top = `${a.bottom - p.top + 4}px`;
  pane.append(popover);
  document.addEventListener("pointerdown", outside, true);
}

/** The bar of style controls, for the selection or (while drawing) for new shapes. */
function renderStyleBar() {
  if (!styleEl) return;
  closePopover();
  const sts = selectedStatements();
  const drawing = tool !== "select";
  styleEl.replaceChildren();
  styleEl.hidden = !sts.length && !drawing;
  if (styleEl.hidden) return;
  const colors = colorSet();
  const first = sts[0];
  const style: Style = first
    ? readStyle(parseOptions(textOf(first.optionsFrom, first.optionsTo)), colors)
    : readStyle([...defaults.values()], colors);
  const kinds = new Set(sts.map((s) => s.kind));
  if (drawing) kinds.add(tool === "box" || tool === "round" || tool === "text" ? "node" : tool === "arrow" ? "line" : (tool as Statement["kind"]));
  const nodes = kinds.has("node");
  const lines = ["line", "polyline", "curve", "arc"].some((k) => kinds.has(k as Statement["kind"]));
  const closed = ["rectangle", "circle", "ellipse", "polyline", "node"].some((k) => kinds.has(k as Statement["kind"]));

  const label = document.createElement("span");
  label.className = "tikz-style-label";
  label.textContent = sts.length ? (sts.length === 1 ? describe(first) : `${sts.length} shapes`) : "New shapes";
  styleEl.append(label);

  styleEl.append(swatch(nodes && !lines ? "Border" : "Line", style.stroke ?? (style.border || !nodes ? "black" : null), nodes, (v) => {
    if (nodes && !v) applyStyle("border", null);
    else applyStyle("stroke", v);
  }));
  if (closed) styleEl.append(swatch("Fill", style.fill, true, (v) => applyStyle("fill", v ? `fill=${v}` : null)));
  styleEl.append(segmented("Width", WIDTH_CHOICES, style.width, WIDTH_ICON, (v) => applyStyle("width", v)));
  styleEl.append(segmented("Dash", DASH_CHOICES, style.dash, DASH_ICON, (v) => applyStyle("dash", v)));
  if (lines) styleEl.append(segmented("Arrows", ARROW_CHOICES, style.arrows, ARROW_ICON, (v) => applyStyle("arrows", v)));
  if (nodes && sts.length) {
    const shape = style.shape === "circle" ? "circle" : style.corners ? "rounded" : "rectangle";
    styleEl.append(segmented("Shape", [["rectangle", "Box"], ["rounded", "Rounded"], ["circle", "Circle"]], shape, null, (v) => applyStyle("nodeShape", v)));
    styleEl.append(segmented("Size", FONT_CHOICES, style.font, null, (v) => applyStyle("font", v && `font=${v}`)));
    styleEl.append(swatch("Text", style.textColor, true, (v) => applyStyle("textColor", v && `text=${v}`)));
  } else if (kinds.has("rectangle") || kinds.has("polyline")) {
    styleEl.append(segmented("Corners", [[null, "Sharp"], ["rounded corners", "Rounded"]], style.corners ? "rounded corners" : null, null, (v) => applyStyle("corners", v)));
  }

  const opacity = document.createElement("label");
  opacity.className = "tikz-opacity";
  opacity.title = "Opacity";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0.1";
  slider.max = "1";
  slider.step = "0.05";
  slider.value = String(style.opacity);
  slider.setAttribute("aria-label", "Opacity");
  const value = (v: string) => (Number(v) >= 1 ? null : `opacity=${Number(v)}`);
  slider.onpointerdown = () => { sliding = true; };
  slider.oninput = () => applyStyle("opacity", value(slider.value), true);
  slider.onchange = () => {
    sliding = false;
    applyStyle("opacity", value(slider.value));
  };
  slider.onpointerup = () => {
    // a click that didn't move it changes nothing
    if (sliding) setTimeout(() => { if (sliding) { sliding = false; host?.setDraft(null); } }, 0);
  };
  opacity.append("Opacity", slider);
  styleEl.append(opacity);

  // a label on a single line
  if (sts.length === 1 && ["line", "polyline"].includes(first.kind)) {
    const statement = textOf(first.from, first.to);
    const existing = lineLabel(statement);
    const input = document.createElement("input");
    input.className = "tikz-label-input";
    input.placeholder = "Label";
    input.setAttribute("aria-label", "Label on the line");
    const before = existing ? statement.slice(existing.textFrom, existing.textTo) : "";
    input.value = before;
    const save = (place?: string) => {
      // the statement as it is now: an earlier save may have moved it
      const st = selectedStatements()[0];
      if (!st || !["line", "polyline"].includes(st.kind)) return;
      const now = textOf(st.from, st.to);
      commit([{ from: st.from, to: st.to, original: now, text: withLineLabel(now, input.value, place) }]);
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") save();
      if (e.key === "Escape") {
        input.value = before;
        input.blur();
      }
    };
    input.onchange = () => save();
    styleEl.append(input);
    if (existing) {
      const places = segmented("Label place", PLACE_CHOICES, null, null, (v) => save(v ?? "above"));
      styleEl.append(places);
    }
  }
}

function describe(st: Statement): string {
  const name = st.defines ? ` ${st.defines}` : "";
  return { line: "Line", polyline: "Path", curve: "Curve", rectangle: "Rectangle", circle: "Circle", ellipse: "Ellipse", arc: "Arc", node: "Node", coordinate: "Point", other: "Shape" }[st.kind] + name;
}

// ---------- inline text ----------
let textInput: HTMLInputElement | null = null;

/** Edit a node's text, or a line's label, in place over the picture. */
function openTextEditor(k: number) {
  const shown = host?.shown();
  const s = sheet();
  if (!shown?.marks || !s) return;
  const st = shown.scan.statements[k];
  if (!st) return;
  let from = st.textFrom;
  let to = st.textTo;
  let box = boxOf(shown.marks, st.defines ?? statementBox(k)) ?? boxOf(shown.marks, statementBox(k));
  if (st.kind !== "node") {
    // a line: its label, made if there is none yet
    const statement = textOf(st.from, st.to);
    const label = lineLabel(statement);
    if (!label) {
      [pendingText, pendingAfter] = [k, shown.text];
      commit([{ from: st.from, to: st.to, original: statement, text: withLineLabel(statement, "Label") }]);
      return;
    }
    [from, to] = [st.from + label.textFrom, st.from + label.textTo];
    const pts = pointsOf(shown, st);
    if (pts.length >= 2) {
      const mid: Point = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
      box = [mid[0] - 0.05, mid[1] - 0.06, mid[0] + 0.05, mid[1]];
    }
  }
  if (from < 0 || !box) return;
  closeTextEditor();
  const original = textOf(from, to);
  const input = document.createElement("input");
  input.className = "tikz-text-input";
  input.value = original;
  input.setAttribute("aria-label", "Text");
  input.style.left = `${((box[0] + box[2]) / 2) * 100}%`;
  input.style.top = `${((box[1] + box[3]) / 2) * 100}%`;
  input.style.minWidth = `${Math.max(80, (box[2] - box[0]) * s.clientWidth)}px`;
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save && input.value !== original) commit([{ from, to, original, text: input.value }]);
    closeTextEditor();
    host?.stage.focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  input.onpointerdown = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
  s.append(input);
  textInput = input;
  input.focus();
  input.select();
}

function closeTextEditor() {
  textInput?.remove();
  textInput = null;
}

// ---------- tools ----------
interface ToolInfo { id: Tool; title: string; key: string; icon: string; group: number }
const TOOLS: ToolInfo[] = [
  { id: "select", title: "Select and move", key: "v", group: 0, icon: '<path d="M4.5 2.5l7.5 5.25-3.25.75L7 12z"/>' },
  { id: "line", title: "Line", key: "l", group: 1, icon: '<path d="M3 13L13 3"/>' },
  { id: "arrow", title: "Arrow", key: "a", group: 1, icon: '<path d="M3 13L13 3M7.5 3H13v5.5"/>' },
  { id: "polyline", title: "Path: click points, double-click or Return to finish", key: "p", group: 1, icon: '<path d="M2.5 12.5l3-7 4 4 4-7"/>' },
  { id: "curve", title: "Curve: drag from start to end, then shape it by its handles", key: "c", group: 1, icon: '<path d="M2.5 12.5C4 4 12 12 13.5 3.5"/>' },
  { id: "rectangle", title: "Rectangle", key: "r", group: 2, icon: '<rect x="2.5" y="4" width="11" height="8" rx="1"/>' },
  { id: "circle", title: "Circle: centre, then a point on it", key: "o", group: 2, icon: '<circle cx="8" cy="8" r="5.5"/>' },
  { id: "ellipse", title: "Ellipse: two corners of its box", key: "e", group: 2, icon: '<ellipse cx="8" cy="8" rx="6" ry="4"/>' },
  { id: "arc", title: "Arc: centre, start, end (anticlockwise)", key: "q", group: 2, icon: '<path d="M3 12.5a9.5 9.5 0 019.5-9.5"/>' },
  { id: "box", title: "Box with text", key: "b", group: 3, icon: '<rect x="2" y="4.5" width="12" height="7" rx="2"/><path d="M5.5 8h5"/>' },
  { id: "round", title: "Round node with text", key: "n", group: 3, icon: '<circle cx="8" cy="8" r="5.5"/><path d="M6 8h4"/>' },
  { id: "text", title: "Text", key: "t", group: 3, icon: '<path d="M3.5 4.5V3h9v1.5M8 3v10M6 13h4"/>' },
  { id: "dot", title: "Dot", key: "d", group: 3, icon: '<circle cx="8" cy="8" r="2.25" fill="currentColor"/>' },
];
const SVG_TOOL = (path: string) =>
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

/** How many points each drawing tool takes (polyline: until finished). */
const POINTS: Partial<Record<ShapeTool, number>> = {
  line: 2, arrow: 2, curve: 2, rectangle: 2, circle: 2, ellipse: 2, arc: 3, text: 1, box: 1, round: 1, dot: 1,
};
/** Tools whose points may be nodes, written `(name)`. */
const JOINS: Set<Tool> = new Set(["line", "arrow", "polyline", "curve", "text", "dot"]);

function setTool(next: Tool) {
  tool = next;
  sketch = null;
  hover = -1;
  for (const b of toolsEl?.querySelectorAll<HTMLButtonElement>("button[data-tool]") ?? []) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
  host?.stage.classList.toggle("drawing", tool !== "select");
  renderStyleBar();
  renderCanvas();
}

let sketch: { ends: End[]; hover: End | null; downX: number; downY: number } | null = null;

function finishSketch(closed = false) {
  if (!sketch || tool === "select") return;
  const ends = sketch.ends;
  sketch = null;
  const t = tool as ShapeTool;
  const shown = host?.shown();
  const name = t === "box" || t === "round" ? freshName(shown?.scan.names ?? []) : "";
  addStatement(shapeSource(t, ends, newOptions(t), name, closed), t === "box" || t === "round" || t === "text");
  renderCanvas();
}

const same = (a: End, b: End) => (a.node ? a.node === b.node : !b.node && a.point[0] === b.point[0] && a.point[1] === b.point[1]);

function drawDown(e: PointerEvent) {
  const t = tool as ShapeTool;
  const end = endAt(e, JOINS.has(t));
  if (!end) return;
  if (!sketch) sketch = { ends: [], hover: end, downX: e.clientX, downY: e.clientY };
  const ends = sketch.ends;
  if (t === "polyline" && ends.length) {
    // on the first point again: close it; on the last again (a double click): finish
    if (ends.length >= 3 && same(end, ends[0])) return finishSketch(true);
    if (same(end, ends[ends.length - 1])) return ends.length >= 2 ? finishSketch() : undefined;
  } else if (ends.length && same(end, ends[ends.length - 1])) {
    return; // the same point twice: wait for another
  }
  ends.push(end);
  sketch.downX = e.clientX;
  sketch.downY = e.clientY;
  if (ends.length >= (POINTS[t] ?? Infinity)) finishSketch();
  else renderCanvas();
}

function drawMove(e: PointerEvent) {
  if (tool === "select") return;
  const end = endAt(e, JOINS.has(tool));
  if (!sketch) {
    // before the first click, show which node a line would start from
    const node = end?.node ?? null;
    if (node !== targetNode) {
      targetNode = node;
      renderCanvas();
    }
    return;
  }
  if (!end || (sketch.hover && same(end, sketch.hover))) return;
  sketch.hover = end;
  targetNode = end.node ?? null;
  renderCanvas();
}

/** Press, drag and let go draws a two-point shape in one go. */
function drawUp(e: PointerEvent) {
  if (!sketch || tool === "polyline" || Math.hypot(e.clientX - sketch.downX, e.clientY - sketch.downY) < 6) return;
  const end = endAt(e, JOINS.has(tool));
  if (end && sketch.ends.length === 1 && POINTS[tool as ShapeTool] === 2 && !same(end, sketch.ends[0])) {
    sketch.ends.push(end);
    finishSketch();
  }
}
let targetNode: string | null = null;

// ---------- dragging handles and shapes ----------
type Drag =
  | { kind: "coord" | "node"; index: number; from: number; to: number; original: string; value: Point; text: string; centre: Point | null; startX: number; startY: number; moved: boolean }
  | {
    kind: "move"; start: Point; edits: Edit[]; startX: number; startY: number; moved: boolean; hit: number; additive: boolean;
    /** Where things were when the drag began (the drafts redraw them already moved), and how far
     *  the snapped move takes them, on the canvas in pt. */
    base: Marks; offset: Point;
  };
let drag: Drag | null = null;

export const canvasBusy = () => !!drag?.moved;

function handleDown(e: PointerEvent): boolean {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".tikz-handle");
  const shown = host?.shown();
  if (!el || !shown?.marks) return false;
  const kind = el.dataset.kind === "node" ? "node" : "coord";
  const index = Number(el.dataset.index);
  let from: number, to: number;
  let value: Point = [0, 0];
  if (kind === "coord") {
    const c = shown.scan.coords[index];
    [from, to, value] = [c.from, c.to, [c.x, c.y]];
  } else {
    const n = shown.scan.nodes[index];
    [from, to] = [n.optionsFrom, n.optionsTo];
  }
  const original = textOf(from, to);
  if (kind === "node") value = nodeShift(original);
  drag = {
    kind, index, from, to, original, value, text: original,
    centre: kind === "node" ? shown.marks.nodes.get(shown.scan.nodes[index].name) ?? null : null,
    startX: e.clientX, startY: e.clientY, moved: false,
  };
  return true;
}

function dragMove(e: PointerEvent) {
  const shown = host?.shown();
  if (!drag || !shown?.marks) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 3) return;
  drag.moved = true;
  const marks = shown.marks;
  const page = pageOf(e);
  if (!page) return;
  const step = stepFor(e);
  if (drag.kind === "move") {
    const edits = moveEdits(selected, drag.start, page, step);
    const key = edits.map((x) => x.text).join("|");
    if (key === drag.edits.map((x) => x.text).join("|")) return;
    drag.edits = edits;
    // the outline follows the snapped move straight away; the picture follows when drawn
    const a = fromPage(marks, 0, drag.start[0], drag.start[1]);
    const b = fromPage(marks, 0, page[0], page[1]);
    if (a && b) drag.offset = canvasOf(drag.base, 0, [snap(b[0] - a[0], step), snap(b[1] - a[1], step)], true);
    host!.setDraft(edits);
    renderCanvas();
    return;
  }
  let value: Point;
  let text: string;
  if (drag.kind === "coord") {
    const at = fromPage(marks, shown.scan.coords[drag.index].scope, page[0], page[1]);
    if (!at) return;
    value = [snap(at[0], step), snap(at[1], step)];
    text = formatCoordinate(value[0], value[1]);
  } else {
    // the node's centre follows the pointer; its shift changes by as much as the pointer moved
    const n = shown.scan.nodes[drag.index];
    const pointer = pageToCanvas(marks, page);
    const d = drag.centre ? canvasToShift(marks, n.scope, [pointer[0] - drag.centre[0], pointer[1] - drag.centre[1]]) : null;
    if (!d) return;
    const before = nodeShift(drag.original);
    value = [snap(before[0] + d[0], step), snap(before[1] + d[1], step)];
    text = withShift(drag.original, value);
  }
  if (text === drag.text) return;
  drag.value = value;
  drag.text = text;
  host!.setDraft([{ from: drag.from, to: drag.to, original: drag.original, text }]);
  renderCanvas();
}

function dragEnd(cancel: boolean) {
  const d = drag;
  drag = null;
  window.removeEventListener("keydown", escapeKey, true);
  if (!d) return;
  if (cancel && !d.moved) return renderCanvas();
  if (!d.moved) {
    if (d.kind === "move") {
      selectionClicked(d.hit, d.additive);
    } else {
      // a click on a handle: show it in the source
      const editor = host!.editor;
      const shown = host!.shown()!;
      editor.dispatch({ selection: { anchor: shown.from + d.from, head: shown.from + d.to }, effects: EditorView.scrollIntoView(shown.from + d.from, { y: "center" }) });
    }
    renderCanvas();
    return;
  }
  const edits = d.kind === "move" ? d.edits : [{ from: d.from, to: d.to, original: d.original, text: d.text }];
  if (cancel) {
    host!.setDraft(null);
    renderCanvas();
    return;
  }
  // the draft stays drawn until the editor's text, now the same, is drawn
  commit(edits);
  host!.setDraft(null);
}

function escapeKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  dragEnd(true);
}

function selectionClicked(k: number, additive: boolean) {
  if (k < 0) selected = additive ? selected : [];
  else if (additive) selected = selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k];
  else selected = [k];
  // the source of a single selection is selected in the editor too
  const shown = host?.shown();
  const st = selected.length === 1 && shown ? shown.scan.statements[selected[0]] : null;
  if (st) {
    host!.editor.dispatch({
      selection: { anchor: shown!.from + st.from, head: shown!.from + st.to },
      effects: EditorView.scrollIntoView(shown!.from + st.from, { y: "nearest" }),
    });
  }
  renderStyleBar();
  renderCount();
  renderCanvas();
}

// ---------- pointer and keys ----------
function pointerDown(e: PointerEvent) {
  if (e.button !== 0 || !host?.shown()?.marks || !sheet()) return;
  closePopover();
  host.stage.focus({ preventScroll: true });
  if (tool !== "select") {
    e.preventDefault();
    host.stage.setPointerCapture(e.pointerId);
    drawDown(e);
    return;
  }
  if (handleDown(e)) {
    e.preventDefault();
    host.stage.setPointerCapture(e.pointerId);
    window.addEventListener("keydown", escapeKey, true);
    return;
  }
  const k = hitStatement(e);
  const page = pageOf(e);
  if (!page) return;
  e.preventDefault();
  host.stage.setPointerCapture(e.pointerId);
  // pressing on an unselected shape selects it first, so it can be dragged straight away
  if (k >= 0 && !selected.includes(k) && !e.shiftKey) {
    selected = [k];
    renderStyleBar();
  }
  drag = { kind: "move", start: page, edits: [], offset: [0, 0], base: host.shown()!.marks!, startX: e.clientX, startY: e.clientY, moved: false, hit: k, additive: e.shiftKey };
  window.addEventListener("keydown", escapeKey, true);
}

function pointerMove(e: PointerEvent) {
  if (drag) {
    if (drag.kind !== "move" || (drag.hit >= 0 && selected.includes(drag.hit))) dragMove(e);
    return;
  }
  if (tool !== "select") return drawMove(e);
  const k = hitStatement(e);
  if (k !== hover) {
    hover = k;
    renderCanvas();
  }
}

function pointerUp(e: PointerEvent) {
  if (host?.stage.hasPointerCapture(e.pointerId)) host.stage.releasePointerCapture(e.pointerId);
  if (drag) return dragEnd(false);
  if (tool !== "select") drawUp(e);
}

function doubleClick(e: MouseEvent) {
  if (tool !== "select" || textInput) return;
  const k = hitStatement(e);
  const st = k >= 0 ? host?.shown()?.scan.statements[k] : null;
  if (st && (st.kind === "node" || st.kind === "line" || st.kind === "polyline")) {
    selected = [k];
    renderStyleBar();
    openTextEditor(k);
  }
}

function keyDown(e: KeyboardEvent) {
  if (textInput?.isConnected) return;
  // keys while the pointer holds something would leave the drag half done
  if (drag) return;
  const mod = e.metaKey || e.ctrlKey;
  const editor = host?.editor;
  if (!editor) return;
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (e.key === "Escape") {
    if (sketch) sketch = null;
    else if (selected.length) selected = [];
    else if (tool !== "select") return setTool("select"), handled();
    else return;
    renderStyleBar();
    renderCanvas();
    return handled();
  }
  if (mod && e.key.toLowerCase() === "z") return (e.shiftKey ? redo(editor) : undo(editor)), handled();
  if (mod && e.key.toLowerCase() === "d") return duplicateSelected(), handled();
  if (mod && e.key.toLowerCase() === "a") {
    selected = host!.shown()?.scan.statements.flatMap((st, k) => (st.selectable ? [k] : [])) ?? [];
    renderStyleBar();
    renderCanvas();
    return handled();
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selected.length) return deleteSelected(), handled();
  if (e.key === "Enter" && sketch && tool === "polyline" && sketch.ends.length >= 2) return finishSketch(), handled();
  const arrows: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  if (arrows[e.key] && selected.length) {
    const step = e.shiftKey ? 1 : snapStep || FINE;
    return nudge(arrows[e.key][0] * step, arrows[e.key][1] * step), handled();
  }
  if (!mod && !e.altKey) {
    const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
    if (t) return setTool(t.id), handled();
    if (e.key === "g") return toggleGrid(), handled();
  }
}

// ---------- drawing the layer ----------
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(name: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function place(el: HTMLElement, at: Point | null) {
  el.hidden = !at;
  if (at) {
    el.style.left = `${at[0] * 100}%`;
    el.style.top = `${at[1] * 100}%`;
  }
}

/** The grid of the picture's own units: lines every unit, fainter ones at the snap step, the
 *  axes stronger, and the units numbered along the edges. */
function drawGrid(svg: SVGElement, marks: Marks, w: number, h: number) {
  const corners = ([[0, 0], [1, 0], [0, 1], [1, 1]] as Point[]).map((c) => fromPage(marks, 0, c[0], c[1])).filter(Boolean) as Point[];
  if (corners.length < 4) return;
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const unitPx = (() => {
    const a = toPage(marks, 0, 0, 0)!;
    const b = toPage(marks, 0, 1, 0)!;
    return Math.hypot((b[0] - a[0]) * w, (b[1] - a[1]) * h);
  })();
  if (!(unitPx > 4) || (maxX - minX) * (maxY - minY) > 40000) return;
  const P = (x: number, y: number): Point => {
    const p = toPage(marks, 0, x, y)!;
    return [p[0] * w, p[1] * h];
  };
  const line = (a: Point, b: Point, cls: string) => svg.append(svgEl("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: cls }));
  const minor = snapStep > 0 && snapStep < 1 && unitPx * snapStep >= 8 ? snapStep : 0;
  if (minor) {
    for (let x = Math.ceil(minX / minor) * minor; x <= maxX; x += minor) if (Math.abs(x - Math.round(x)) > 1e-6) line(P(x, minY), P(x, maxY), "minor");
    for (let y = Math.ceil(minY / minor) * minor; y <= maxY; y += minor) if (Math.abs(y - Math.round(y)) > 1e-6) line(P(minX, y), P(maxX, y), "minor");
  }
  const every = unitPx < 14 ? 5 : 1;
  for (let x = Math.ceil(minX); x <= maxX; x++) {
    if (x % every) continue;
    line(P(x, minY), P(x, maxY), x === 0 ? "axis" : "major");
    const at = P(x, maxY);
    const t = svgEl("text", { x: at[0] + 2, y: Math.max(10, at[1] + 10), class: "unit" });
    t.textContent = String(x);
    svg.append(t);
  }
  for (let y = Math.ceil(minY); y <= maxY; y++) {
    if (y % every) continue;
    line(P(minX, y), P(maxX, y), y === 0 ? "axis" : "major");
    const at = P(minX, y);
    const t = svgEl("text", { x: Math.max(2, at[0] + 2), y: at[1] - 2, class: "unit" });
    t.textContent = String(y);
    svg.append(t);
  }
}

/** The shape being drawn, as a dashed outline. */
function drawSketch(svg: SVGElement, marks: Marks, w: number, h: number) {
  if (!sketch) return;
  const P = (e: End): Point => {
    const p = toPage(marks, 0, e.point[0], e.point[1])!;
    return [p[0] * w, p[1] * h];
  };
  const pts = [...sketch.ends, ...(sketch.hover ? [sketch.hover] : [])].map(P);
  if (!pts.length) return;
  const [a, b, c] = pts;
  let shape: SVGElement | null = null;
  if (tool === "rectangle" && b) shape = svgEl("rect", { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) });
  else if (tool === "circle" && b) shape = svgEl("circle", { cx: a[0], cy: a[1], r: Math.hypot(b[0] - a[0], b[1] - a[1]) });
  else if (tool === "ellipse" && b) shape = svgEl("ellipse", { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2 });
  else if (tool === "arc" && b) {
    const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (c) {
      // anticlockwise on paper is the other way round on screen, where y points down
      const large = (() => {
        const s = Math.atan2(a[1] - b[1], b[0] - a[0]);
        let t = Math.atan2(a[1] - c[1], c[0] - a[0]);
        if (t <= s) t += 2 * Math.PI;
        return t - s > Math.PI ? 1 : 0;
      })();
      const angle = Math.atan2(c[1] - a[1], c[0] - a[0]);
      const end: Point = [a[0] + r * Math.cos(angle), a[1] + r * Math.sin(angle)];
      shape = svgEl("path", { d: `M${b[0]},${b[1]} A${r},${r} 0 ${large} 0 ${end[0]},${end[1]}` });
    } else shape = svgEl("circle", { cx: a[0], cy: a[1], r, class: "guide" });
  } else if (tool === "curve" && b) {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    shape = svgEl("path", { d: `M${a[0]},${a[1]} C${a[0] + dx / 3 + dy * 0.3},${a[1] + dy / 3 - dx * 0.3} ${a[0] + (2 * dx) / 3 + dy * 0.3},${a[1] + (2 * dy) / 3 - dx * 0.3} ${b[0]},${b[1]}` });
  } else if (pts.length >= 2) shape = svgEl("polyline", { points: pts.map((p) => p.join(",")).join(" ") });
  if (shape) {
    shape.classList.add("shape");
    svg.append(shape);
  }
  for (const p of pts) svg.append(svgEl("circle", { cx: p[0], cy: p[1], r: 3, class: "end" }));
}

/** Everything over the picture: grid, outlines, the shape being drawn, handles. */
export function renderCanvas() {
  const l = layer();
  const shown = host?.shown();
  if (!l) return;
  l.replaceChildren();
  if (!shown?.marks) return;
  const marks = shown.marks;
  const [w, h] = [l.clientWidth, l.clientHeight];
  const svg = svgEl("svg", { class: "tikz-ghost", viewBox: `0 0 ${w} ${h}` });
  if (gridOn || tool !== "select") drawGrid(svg, marks, w, h);
  const moving = drag?.kind === "move" && drag.moved ? drag : null;
  const outline = (name: string, cls: string, moved = false) => {
    const box = moved && moving ? boxOf(marks, name, moving.base, moving.offset) : boxOf(marks, name);
    if (!box) return;
    const pad = 3;
    svg.append(svgEl("rect", {
      x: box[0] * w - pad, y: box[1] * h - pad,
      width: (box[2] - box[0]) * w + 2 * pad, height: (box[3] - box[1]) * h + 2 * pad, rx: 3, class: cls,
    }));
  };
  if (hover >= 0 && !selected.includes(hover) && !drag) outline(statementBox(hover), "hover");
  for (const k of selected) outline(statementBox(k), "selected", true);
  if (targetNode && tool !== "select") outline(targetNode, "target");
  drawSketch(svg, marks, w, h);
  l.append(svg);

  // handles: round for points, square for nodes placed relative to others
  const head = host!.editor.state.selection.main.head - shown.from;
  const inSelection = new Set<number>();
  const nodesInSelection = new Set<string>();
  for (const k of selected) {
    const st = shown.scan.statements[k];
    st?.coords.forEach((c) => inSelection.add(c));
    if (st?.defines) nodesInSelection.add(st.defines);
  }
  const handle = (kind: "coord" | "node", index: number, at: Point | null, title: string, range: [number, number], inMove: boolean) => {
    if (!at) return;
    const el = document.createElement("span");
    el.className = `tikz-handle${kind === "node" ? " node" : ""}`;
    el.dataset.kind = kind;
    el.dataset.index = String(index);
    place(el, at);
    el.title = title;
    if (drag && drag.kind === kind && drag.index === index) el.classList.add("dragging");
    else if (inMove || (head >= range[0] && head <= range[1])) el.classList.add("active");
    l.append(el);
  };
  shown.scan.coords.forEach((c, index) => {
    const dragging = drag?.kind === "coord" && drag.index === index;
    const [x, y] = dragging ? (drag as { value: Point }).value : [c.x, c.y];
    let at = toPage(marks, c.scope, x, y);
    if (moving && inSelection.has(index)) {
      const p = canvasOf(moving.base, c.scope, [x, y]);
      at = canvasToPage(marks, [p[0] + moving.offset[0], p[1] + moving.offset[1]]);
    }
    handle("coord", index, at,
      `${formatCoordinate(x, y)}. Drag to move it, Option for finer steps; click to find it in the source.`, [c.from, c.to], inSelection.has(index));
  });
  shown.scan.nodes.forEach((n, index) => {
    const moved = moving && nodesInSelection.has(n.name);
    const centre = (moved ? moving!.base : marks).nodes.get(n.name);
    if (!centre) return;
    let at = canvasToPage(marks, moved ? [centre[0] + moving!.offset[0], centre[1] + moving!.offset[1]] : centre);
    if (drag?.kind === "node" && drag.index === index && drag.centre) {
      const before = nodeShift(drag.original);
      const d = shiftToCanvas(marks, n.scope, [drag.value[0] - before[0], drag.value[1] - before[1]]);
      at = canvasToPage(marks, [drag.centre[0] + d[0], drag.centre[1] + d[1]]);
    }
    handle("node", index, at, `Node ${n.name}. Drag to shift it (xshift, yshift); click to find it in the source.`, [n.optionsFrom, n.optionsTo], nodesInSelection.has(n.name));
  });
  // what the point being dragged or drawn is
  const label = (text: string, at: Point | null) => {
    if (!at) return;
    const el = document.createElement("span");
    el.className = "tikz-coord";
    el.textContent = text;
    place(el, at);
    l.append(el);
  };
  if (drag?.kind === "coord" && drag.moved) {
    const c = shown.scan.coords[drag.index];
    label(drag.text, toPage(marks, c.scope, drag.value[0], drag.value[1]));
  } else if (drag?.kind === "node" && drag.moved) {
    label(`shift ${formatCoordinate(drag.value[0], drag.value[1])} cm`, null);
  } else if (sketch?.hover) {
    const e = sketch.hover;
    label(e.node ? `(${e.node})` : formatCoordinate(e.point[0], e.point[1]), toPage(marks, 0, e.point[0], e.point[1]));
  }
  // each drawing replaces the sheet: an open text editor moves onto the new one
  if (textInput && !textInput.isConnected) sheet()?.append(textInput);
  if (pendingText >= 0 && shown.text !== pendingAfter && shown.scan.statements[pendingText]) {
    const k = pendingText;
    pendingText = -1;
    openTextEditor(k);
  }
}

// ---------- the toolbar ----------
function toggleGrid() {
  gridOn = !gridOn;
  remember("scribe.tikzGrid", gridOn ? "on" : "off");
  toolsEl?.querySelector<HTMLButtonElement>("[data-grid]")?.setAttribute("aria-pressed", String(gridOn));
  renderCanvas();
}

const SNAPS: [number, string][] = [[1, "1"], [0.5, "½"], [0.25, "¼"], [0.1, "0.1"], [0, "Off"]];

/** Build the tool buttons, the count, and the style bar for a pane. */
export function buildCanvas(h: CanvasHost): { tools: HTMLElement; count: HTMLElement; style: HTMLElement } {
  host = h;
  selected = [];
  hover = -1;
  sketch = null;
  drag = null;
  tool = "select";
  lastCount = -1;
  pendingText = -1;
  toolsEl = document.createElement("span");
  toolsEl.className = "tikz-tools";
  let group = 0;
  for (const t of TOOLS) {
    if (t.group !== group) {
      group = t.group;
      const sep = document.createElement("span");
      sep.className = "tikz-sep";
      toolsEl.append(sep);
    }
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.dataset.tool = t.id;
    b.title = `${t.title} (${t.key.toUpperCase()})`;
    b.setAttribute("aria-label", t.title);
    b.setAttribute("aria-pressed", String(t.id === tool));
    b.innerHTML = SVG_TOOL(t.icon);
    b.onclick = () => setTool(t.id);
    toolsEl.append(b);
  }
  const sep = document.createElement("span");
  sep.className = "tikz-sep";
  const grid = document.createElement("button");
  grid.className = "icon-btn";
  grid.dataset.grid = "";
  grid.title = "Grid (G)";
  grid.setAttribute("aria-label", "Grid");
  grid.setAttribute("aria-pressed", String(gridOn));
  grid.innerHTML = SVG_TOOL('<path d="M2.5 5.5h11M2.5 10.5h11M5.5 2.5v11M10.5 2.5v11"/>');
  grid.onclick = toggleGrid;
  const snapSelect = document.createElement("select");
  snapSelect.className = "tikz-snap";
  snapSelect.title = "Snap points to steps of this many units (Option: 0.05)";
  snapSelect.setAttribute("aria-label", "Snap step");
  for (const [v, text] of SNAPS) {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = v ? `Snap ${text}` : "No snap";
    o.selected = v === snapStep;
    snapSelect.append(o);
  }
  snapSelect.onchange = () => {
    snapStep = Number(snapSelect.value);
    remember("scribe.tikzSnap", String(snapStep));
    renderCanvas();
  };
  toolsEl.append(sep, grid, snapSelect);

  countEl = document.createElement("span");
  countEl.className = "tikz-points";
  styleEl = document.createElement("div");
  styleEl.className = "tikz-style";
  styleEl.hidden = true;

  const stage = h.stage;
  stage.tabIndex = 0;
  stage.addEventListener("pointerdown", pointerDown);
  stage.addEventListener("pointermove", pointerMove);
  stage.addEventListener("pointerup", pointerUp);
  stage.addEventListener("pointercancel", () => {
    sketch = null;
    dragEnd(true);
  });
  stage.addEventListener("pointerleave", () => {
    if (hover >= 0 && !drag) {
      hover = -1;
      renderCanvas();
    }
  });
  stage.addEventListener("dblclick", doubleClick);
  stage.addEventListener("keydown", keyDown);
  return { tools: toolsEl, count: countEl, style: styleEl };
}

/** After each drawing: what can be done with this picture, and the selection kept valid. */
export function canvasUpdated() {
  const shown = host?.shown();
  if (!shown) return;
  const marks = shown.marks;
  const usable = !!marks;
  for (const b of toolsEl?.querySelectorAll<HTMLButtonElement>("button[data-tool]") ?? []) b.disabled = !usable && b.dataset.tool !== "select";
  if (!usable && tool !== "select") setTool("select");
  const count = shown.scan.statements.length;
  // statements added or removed in the editor: indices no longer mean the same shapes
  if (lastCount >= 0 && count !== lastCount && !expectSelection) selected = [];
  if (count !== lastCount) expectSelection = false;
  selected = selected.filter((k) => shown.scan.statements[k]?.selectable);
  lastCount = count;
  renderCount();
  // not while a control in the bar is in use (the opacity slider drafts as it moves)
  if (!sliding && !styleEl.contains(document.activeElement)) renderStyleBar();

}

function renderCount() {
  const shown = host?.shown();
  if (!shown || !countEl) return;
  const marks = shown.marks;
  const handles = marks ? shown.scan.coords.length + shown.scan.nodes.filter((n) => marks.nodes.has(n.name)).length : 0;
  const shapes = marks ? shown.scan.statements.filter((s) => s.selectable).length : 0;
  countEl.textContent = selected.length ? `${selected.length} selected` : `${shapes} shapes`;
  countEl.title = `${shapes} shapes you can select, ${handles} handles you can drag. Shapes in loops (\\foreach) and plots can't be selected.`;
}

/** The editor's cursor moved: the statement it is in becomes the selection. */
export function canvasCursor() {
  const shown = host?.shown();
  if (!shown || drag || textInput?.isConnected) return renderCanvas();
  const sel = host!.editor.state.selection.main;
  const k = shown.scan.statements.findIndex((st) => st.selectable && sel.from - shown.from >= st.from && sel.to - shown.from <= st.to);
  const next = k >= 0 ? [k] : sel.empty ? [] : selected;
  if (next.join() !== selected.join()) {
    selected = next;
    renderStyleBar();
    renderCount();
  }
  renderCanvas();
}
