// TikZ preview: the tikzpicture under the cursor, drawn in the side pane and redrawn as you
// type. The picture is compiled on its own as a standalone document with the paper's preamble,
// so it takes about a second instead of a whole compile; errors point at lines in the source.
import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import * as pdfjs from "pdfjs-dist";
import { clamp, current, insideProject, mainFile, root, setStatus, showLog } from "./core";
import { explain, parseLog } from "./diagnostics";
import { openPalette, promptInput } from "./palette";
import { refreshFiles } from "./sidebar";
import { closeSide, showInSide, sideFile } from "./split";
import {
  appendStatement, formatCoordinate, fromPage, instrument, INSTRUMENT_MACROS, pictureAt, PICTURE_FILE, previewDocument,
  readMarks, scanPicture, shapeSource, toPage, unclosedParen, type Marks, type PictureScan, type Point, type ShapeTool,
  canvasToPage, canvasToShift, nodeShift, pageToCanvas, shiftToCanvas, withShift,
} from "./tikzsource";
import { STARTERS, starterText } from "./tikzwrite";
import type { CompileResult } from "./types";

const PREVIEW_TEX = "build/tikz/preview.tex";
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 6;

// ---------- the pane ----------
interface Pane {
  box: HTMLElement;
  note: HTMLElement;
  time: HTMLElement;
  points: HTMLElement;
  tools: HTMLElement;
  zoomLabel: HTMLElement;
  stage: HTMLElement;
  editor: EditorView;
}
let pane: Pane | null = null;
let timer = 0;
let running = false;
let again = false;
let lastSource = "";
let lastLog = "";
let lastPicture: { from: number; line: number } | null = null;
/** The last picture that compiled, kept to redraw it at a new size. */
let shownPdf: Uint8Array | null = null;
/** 1 is "fit the pane"; the picture keeps its zoom while you type. */
let zoom = 1;
/** The points that can be dragged in the picture shown: its coordinates as they are in the
 *  editor (`from` is where the picture starts) and where the last drawing put its scopes. */
let shown: { from: number; scan: PictureScan; marks: Marks | null } | null = null;
/** A point or node being dragged: the preview draws `text` in place of `original` (at from–to
 *  in the picture) before the editor has it. A point's value is its coordinate; a node's is its shift in cm. */
let drag: {
  kind: "coord" | "node";
  index: number;
  pictureFrom: number;
  from: number;
  to: number;
  original: string;
  value: [number, number];
  text: string;
  /** A node's centre on the canvas when the drag began, before any shift was drawn. */
  centre: Point | null;
  startX: number;
  startY: number;
  moved: boolean;
} | null = null;
/** Pictures whose marks don't compile (some unusual package); they preview without handles. */
const plainPictures = new Set<string>();
/** Preambles that only compile cut down to the essentials, so they skip the full attempt. */
const minimalFor = new Set<string>();

const open = () => !!pane?.box.isConnected;

async function paperText(editor: EditorView): Promise<string> {
  if (current === mainFile && editor.dom.dataset.path === mainFile) return editor.state.doc.toString();
  if (/\\documentclass/.test(editor.state.doc.toString())) return editor.state.doc.toString();
  return invoke<string>("read_file", { root, rel: mainFile }).catch(() => "");
}

function jumpTo(line: number) {
  const editor = pane!.editor;
  const at = editor.state.doc.line(clamp(line, 1, editor.state.doc.lines));
  editor.dispatch({ selection: { anchor: at.from }, effects: EditorView.scrollIntoView(at.from, { y: "center" }) });
  editor.focus();
}

function note(text: string, kind: "" | "err" = "", line?: number, hint?: string) {
  if (!pane) return;
  pane.note.className = `tikz-note${kind ? ` ${kind}` : ""}`;
  if (!text) {
    pane.note.replaceChildren();
    return;
  }
  const message = document.createElement("span");
  message.className = "tikz-message";
  message.textContent = text;
  pane.note.replaceChildren(message);
  if (line) {
    const jump = document.createElement("button");
    jump.className = "tikz-jump";
    jump.textContent = `Line ${line}`;
    jump.onclick = () => jumpTo(line);
    message.append(" ", jump);
  }
  if (hint) {
    const more = document.createElement("span");
    more.className = "tikz-hint";
    more.textContent = hint;
    pane.note.append(more);
  }
}

// ---------- drawing and zoom ----------
let drawJob = 0;

async function draw() {
  if (!open() || !shownPdf) return;
  const job = ++drawJob;
  const pdf = await pdfjs.getDocument({ data: shownPdf.slice() }).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    // fitting: as wide as the pane allows, but never more than twice its printed size
    const fit = Math.max(40, Math.min(pane!.stage.clientWidth - 32, base.width * 2));
    const width = fit * zoom;
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: (width / base.width) * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    canvas.style.width = `${width}px`;
    canvas.className = "tikz-picture";
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    if (job !== drawJob || !open()) return;
    const sheet = document.createElement("div");
    sheet.className = "tikz-sheet";
    const handles = document.createElement("div");
    handles.className = "tikz-handles";
    sheet.append(canvas, handles);
    pane!.stage.replaceChildren(sheet);
    renderHandles();
  } finally {
    pdf.destroy();
  }
}

let redrawTimer = 0;
function redrawSoon() {
  clearTimeout(redrawTimer);
  redrawTimer = window.setTimeout(() => draw().catch(() => {}), 120);
}

function setZoom(next: number | "fit") {
  if (!pane) return;
  const before = zoom;
  zoom = next === "fit" ? 1 : clamp(Math.round(next * 100) / 100, ZOOM_MIN, ZOOM_MAX);
  pane.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  // scale what is there straight away; the sharp redraw follows
  const canvas = pane.stage.querySelector<HTMLCanvasElement>(".tikz-picture");
  if (canvas && before) canvas.style.width = `${(parseFloat(canvas.style.width) * zoom) / before}px`;
  redrawSoon();
}

// ---------- handles: drag a point to change its coordinate ----------
const SNAP = 0.25;
const SNAP_FINE = 0.05;

function place(el: HTMLElement, at: [number, number] | null) {
  el.hidden = !at;
  if (at) {
    el.style.left = `${at[0] * 100}%`;
    el.style.top = `${at[1] * 100}%`;
  }
}

/** Where a node's handle goes: its centre, moved by the shift being dragged. */
function nodeAt(marks: Marks, index: number): Point | null {
  const n = shown!.scan.nodes[index];
  if (drag?.kind !== "node" || drag.index !== index) {
    const centre = marks.nodes.get(n.name);
    return centre ? canvasToPage(marks, centre) : null;
  }
  const centre = drag.centre;
  if (!centre) return null;
  const before = nodeShift(drag.original);
  const d = shiftToCanvas(marks, n.scope, [drag.value[0] - before[0], drag.value[1] - before[1]]);
  return canvasToPage(marks, [centre[0] + d[0], centre[1] + d[1]]);
}

/** The handles for the picture shown, with the one under the editor's cursor marked: round for
 *  points, square for nodes placed relative to others. */
function renderHandles() {
  const layer = pane?.stage.querySelector<HTMLElement>(".tikz-handles");
  if (!layer) return;
  layer.replaceChildren();
  if (!shown?.marks) return;
  const { marks, scan, from } = shown;
  const head = pane!.editor.state.selection.main.head;
  const handle = (kind: "coord" | "node", index: number, at: Point | null, title: string, range: [number, number]) => {
    const el = document.createElement("span");
    el.className = `tikz-handle${kind === "node" ? " node" : ""}`;
    el.dataset.kind = kind;
    el.dataset.index = String(index);
    place(el, at);
    el.title = title;
    if (drag?.kind === kind && drag.index === index) el.classList.add("dragging");
    else if (head >= from + range[0] && head <= from + range[1]) el.classList.add("active");
    layer.append(el);
  };
  scan.coords.forEach((c, index) => {
    const [x, y] = drag?.kind === "coord" && drag.index === index ? drag.value : [c.x, c.y];
    handle("coord", index, toPage(marks, c.scope, x, y),
      `${formatCoordinate(x, y)}. Drag to move it, Option for finer steps; click to find it in the source.`, [c.from, c.to]);
  });
  scan.nodes.forEach((n, index) => {
    if (!marks.nodes.has(n.name)) return;
    handle("node", index, nodeAt(marks, index),
      `Node ${n.name}. Drag to shift it (xshift, yshift), Option for finer steps; click to find it in the source.`, [n.optionsFrom, n.optionsTo]);
  });
  if (drag) {
    const label = document.createElement("span");
    label.className = "tikz-coord";
    label.textContent = drag.kind === "coord" ? drag.text : `shift ${formatCoordinate(drag.value[0], drag.value[1])} cm`;
    const c = scan.coords[drag.index];
    place(label, drag.kind === "coord" ? (c ? toPage(marks, c.scope, drag.value[0], drag.value[1]) : null) : nodeAt(marks, drag.index));
    layer.append(label);
  }
  if (tool !== "select") renderSketch(layer, marks);
}

function startDrag(e: PointerEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".tikz-handle");
  if (!el || !shown?.marks || e.button !== 0) return;
  const kind = el.dataset.kind === "node" ? "node" : "coord";
  const index = Number(el.dataset.index);
  let from: number, to: number, value: Point;
  if (kind === "coord") {
    const c = shown.scan.coords[index];
    [from, to, value] = [c.from, c.to, [c.x, c.y]];
  } else {
    const n = shown.scan.nodes[index];
    [from, to] = [n.optionsFrom, n.optionsTo];
  }
  const original = pane!.editor.state.doc.sliceString(shown.from + from, shown.from + to);
  if (kind === "node") value = nodeShift(original);
  e.preventDefault();
  pane!.stage.setPointerCapture(e.pointerId);
  pane!.stage.classList.add("dragging");
  window.addEventListener("keydown", escapeDrag, true);
  drag = {
    kind, index, pictureFrom: shown.from, from, to, original, value: value!, text: original,
    centre: kind === "node" ? shown.marks.nodes.get(shown.scan.nodes[index].name) ?? null : null,
    startX: e.clientX, startY: e.clientY, moved: false,
  };
}

function moveDrag(e: PointerEvent) {
  if (!drag || !shown?.marks) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 3) return;
  drag.moved = true;
  const marks = shown.marks;
  const rect = pane!.stage.querySelector(".tikz-sheet")!.getBoundingClientRect();
  const page: Point = [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
  const step = e.altKey ? SNAP_FINE : SNAP;
  const snap = (v: number) => Math.round(v / step) * step;
  let value: Point;
  let text: string;
  if (drag.kind === "coord") {
    const at = fromPage(marks, shown.scan.coords[drag.index].scope, page[0], page[1]);
    if (!at) return;
    value = [snap(at[0]), snap(at[1])];
    text = formatCoordinate(value[0], value[1]);
  } else {
    // the node's centre follows the pointer; its shift changes by as much as the pointer moved
    const n = shown.scan.nodes[drag.index];
    const centre = drag.centre;
    const pointer = pageToCanvas(marks, page);
    const d = centre ? canvasToShift(marks, n.scope, [pointer[0] - centre[0], pointer[1] - centre[1]]) : null;
    if (!d) return;
    const before = nodeShift(drag.original);
    value = [snap(before[0] + d[0]), snap(before[1] + d[1])];
    text = withShift(drag.original, value);
  }
  if (text === drag.text) return;
  drag.value = value;
  drag.text = text;
  renderHandles();
  compileSoon(0);
}

function escapeDrag(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  endDrag(null, true);
}

function endDrag(e: PointerEvent | null, cancel = false) {
  window.removeEventListener("keydown", escapeDrag, true);
  if (!drag) return;
  const d = drag;
  drag = null;
  pane!.stage.classList.remove("dragging");
  if (e && pane!.stage.hasPointerCapture(e.pointerId)) pane!.stage.releasePointerCapture(e.pointerId);
  const editor = pane!.editor;
  const from = d.pictureFrom + d.from;
  const to = d.pictureFrom + d.to;
  const same = editor.state.doc.sliceString(from, to) === d.original;
  if (!d.moved) {
    // a click: show the coordinate in the source
    if (same) {
      editor.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
      editor.focus();
    }
    renderHandles();
    return;
  }
  if (cancel || !same || d.text === d.original) {
    renderHandles();
    compileSoon(0); // back to the source as it is
    return;
  }
  // one edit, so one undo puts the point back; the handles follow once the preview has the new text
  pane!.stage.querySelector(".tikz-coord")?.remove();
  editor.dispatch({ changes: { from, to, insert: d.text }, userEvent: "input.drag" });
}

/** The picture as the preview should draw it: with the coordinate being dragged in its new place. */
function withDraft(picture: string, pictureFrom: number): string {
  if (!drag?.moved || drag.pictureFrom !== pictureFrom || picture.slice(drag.from, drag.to) !== drag.original) return picture;
  return picture.slice(0, drag.from) + drag.text + picture.slice(drag.to);
}

/** The TeX log beside a PDF, where the marks are. Read as bytes: a log needn't be valid UTF-8. */
async function readLog(pdf: string): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("read_binary", { root, rel: pdf.replace(/\.pdf$/, ".log") }).catch(() => null);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

// ---------- drawing tools: add shapes with the mouse ----------
type Tool = "select" | ShapeTool;
let tool: Tool = "select";
/** A shape being drawn: its first point, where the pointer is now, and where the press began. */
let sketch: { a: Point; b: Point; downX: number; downY: number } | null = null;
/** An existing point this close (in px) is used exactly, so new shapes join up with old ones. */
const STICK = 8;

const TOOLS: [Tool, string, string][] = [
  ["select", "Move points", '<path d="M4.5 2.5l7.5 5.25-3.25.75L7 12z"/>'],
  ["line", "Line: click two points", '<path d="M3 13L13 3"/>'],
  ["arrow", "Arrow: click two points", '<path d="M3 13L13 3M7.5 3H13v5.5"/>'],
  ["rectangle", "Rectangle: click two corners", '<rect x="2.5" y="4" width="11" height="8" rx="1"/>'],
  ["circle", "Circle: click the centre, then a point on it", '<circle cx="8" cy="8" r="5.5"/>'],
  ["text", "Text: click where it goes", '<path d="M3.5 4.5V3h9v1.5M8 3v10M6 13h4"/>'],
];

function setTool(next: Tool) {
  tool = next;
  sketch = null;
  if (!pane) return;
  for (const b of pane.tools.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
  pane.stage.classList.toggle("drawing", tool !== "select");
  renderHandles();
}

/** Tools need the picture's marks; a picture without them (tikzcd) can only be previewed. */
function updateTools() {
  if (!pane) return;
  const usable = !!shown?.marks;
  for (const b of pane.tools.querySelectorAll<HTMLButtonElement>("button")) b.disabled = !usable && b.dataset.tool !== "select";
  if (!usable && tool !== "select") setTool("select");
  const marks = shown?.marks;
  const n = marks ? shown!.scan.coords.length + shown!.scan.nodes.filter((node) => marks.nodes.has(node.name)).length : 0;
  pane.points.textContent = n === 1 ? "1 handle" : `${n} handles`;
  pane.points.title = n
    ? "Round handles are points written as numbers, like (1,2); square ones are named nodes, which move by xshift and yshift."
    : "Nothing here can be dragged: points made by ++ steps, loops (\\foreach) and plots have no handles.";
}

/** The point under the pointer in the picture's own coordinates: an existing point if one is
 *  close, otherwise snapped to the grid (Option for finer steps). */
function snapPoint(e: PointerEvent): Point | null {
  const sheet = pane?.stage.querySelector(".tikz-sheet");
  if (!sheet || !shown?.marks) return null;
  const rect = sheet.getBoundingClientRect();
  for (const c of shown.scan.coords) {
    if (c.scope !== 0) continue;
    const at = toPage(shown.marks, 0, c.x, c.y);
    if (at && Math.hypot(at[0] * rect.width + rect.left - e.clientX, at[1] * rect.height + rect.top - e.clientY) <= STICK) return [c.x, c.y];
  }
  const at = fromPage(shown.marks, 0, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  if (!at) return null;
  const step = e.altKey ? SNAP_FINE : SNAP;
  return [Math.round(at[0] / step) * step, Math.round(at[1] / step) * step];
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(name: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** While a drawing tool is on: the grid it snaps to, and the shape so far. */
function renderSketch(layer: HTMLElement, marks: Marks) {
  const w = layer.clientWidth;
  const h = layer.clientHeight;
  const svg = svgEl("svg", { class: "tikz-ghost", viewBox: `0 0 ${w} ${h}` });
  const px = (p: Point): Point => {
    const at = toPage(marks, 0, p[0], p[1]) ?? [0, 0];
    return [at[0] * w, at[1] * h];
  };
  // grid lines at whole units across the page
  const corners = ([[0, 0], [1, 0], [0, 1], [1, 1]] as Point[]).map((c) => fromPage(marks, 0, c[0], c[1])).filter(Boolean) as Point[];
  if (corners.length === 4) {
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const [x0, x1, y0, y1] = [Math.ceil(Math.min(...xs)), Math.floor(Math.max(...xs)), Math.ceil(Math.min(...ys)), Math.floor(Math.max(...ys))];
    if (x1 - x0 < 200 && y1 - y0 < 200) {
      for (let x = x0; x <= x1; x++) {
        const [a, b] = [px([x, Math.min(...ys)]), px([x, Math.max(...ys)])];
        svg.append(svgEl("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: x === 0 ? "axis" : "" }));
      }
      for (let y = y0; y <= y1; y++) {
        const [a, b] = [px([Math.min(...xs), y]), px([Math.max(...xs), y])];
        svg.append(svgEl("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: y === 0 ? "axis" : "" }));
      }
    }
  }
  if (sketch) {
    const [a, b] = [px(sketch.a), px(sketch.b)];
    const shape = tool === "rectangle"
      ? svgEl("rect", { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) })
      : tool === "circle"
        ? svgEl("circle", { cx: a[0], cy: a[1], r: Math.hypot(b[0] - a[0], b[1] - a[1]) })
        : svgEl("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
    shape.classList.add("shape");
    svg.append(shape, svgEl("circle", { cx: a[0], cy: a[1], r: 3, class: "end" }), svgEl("circle", { cx: b[0], cy: b[1], r: 3, class: "end" }));
    const label = document.createElement("span");
    label.className = "tikz-coord";
    label.textContent = formatCoordinate(sketch.b[0], sketch.b[1]);
    place(label, toPage(marks, 0, sketch.b[0], sketch.b[1]));
    layer.append(label);
  }
  layer.prepend(svg);
}

/** Put a statement at the end of the picture shown. `select` is a word in it to select, so
 *  typing replaces it (the text of a new node). */
function addStatement(statement: string, select?: string) {
  const editor = pane!.editor;
  const doc = editor.state.doc.toString();
  const range = shown ? pictureAt(doc, shown.from) : null;
  if (!range || range.from !== shown!.from) return;
  const picture = doc.slice(range.from, range.to);
  const spot = appendStatement(picture, scanPicture(picture), statement);
  if (!spot) return;
  const at = range.from + spot.at;
  const word = select ? spot.text.lastIndexOf(select) : -1;
  editor.dispatch({
    changes: { from: at, insert: spot.text },
    selection: word >= 0 ? { anchor: at + word, head: at + word + select!.length } : undefined,
    effects: EditorView.scrollIntoView(at, { y: "nearest" }),
    userEvent: "input",
  });
  if (word >= 0) editor.focus();
}

function cancelSketch(e: KeyboardEvent) {
  if (e.key !== "Escape" || !sketch) return;
  e.preventDefault();
  e.stopPropagation();
  sketch = null;
  window.removeEventListener("keydown", cancelSketch, true);
  renderHandles();
}

function finishSketch(b: Point) {
  if (!sketch || tool === "select" || tool === "text") return;
  const { a } = sketch;
  if (a[0] === b[0] && a[1] === b[1]) return; // the same point twice: wait for another
  sketch = null;
  window.removeEventListener("keydown", cancelSketch, true);
  addStatement(shapeSource(tool, a, b));
  renderHandles();
}

/** A press on the picture while a drawing tool is on. Returns false when the select tool is on. */
function drawDown(e: PointerEvent): boolean {
  if (tool === "select") return false;
  if (e.button !== 0) return true;
  const p = snapPoint(e);
  if (!p) return true;
  e.preventDefault();
  if (tool === "text") {
    addStatement(shapeSource("text", p, p), "Text");
    return true;
  }
  if (sketch) {
    finishSketch(p);
    return true;
  }
  sketch = { a: p, b: p, downX: e.clientX, downY: e.clientY };
  pane!.stage.setPointerCapture(e.pointerId);
  window.addEventListener("keydown", cancelSketch, true);
  renderHandles();
  return true;
}

function drawMove(e: PointerEvent) {
  if (!sketch) return;
  const p = snapPoint(e);
  if (!p || (p[0] === sketch.b[0] && p[1] === sketch.b[1])) return;
  sketch.b = p;
  renderHandles();
}

/** Pressing, dragging and letting go draws the shape in one go; a plain click waits for the second point. */
function drawUp(e: PointerEvent) {
  if (!sketch || Math.hypot(e.clientX - sketch.downX, e.clientY - sketch.downY) < 6) return;
  finishSketch(snapPoint(e) ?? sketch.b);
}

// ---------- export ----------
const writeBinary = (rel: string, bytes: Uint8Array) =>
  invoke("write_binary", bytes, { headers: { "x-root": encodeURIComponent(root ?? ""), "x-rel": encodeURIComponent(rel) } });

/** A file name for the picture shown: its figure's label without `fig:`, or its line. */
function exportName(): string {
  const doc = pane!.editor.state.doc.toString();
  const picture = lastPicture ? pictureAt(doc, lastPicture.from) : null;
  const figureEnd = picture ? doc.indexOf("\\end{figure", picture.to) : -1;
  const label = picture && figureEnd >= 0 ? /\\label\{(?:fig:)?([^}]+)\}/.exec(doc.slice(picture.to, figureEnd))?.[1] : undefined;
  return (label ?? `tikz-${lastPicture?.line ?? 1}`).replace(/[^\w-]+/g, "-");
}

/** Page one of the picture at `dpi`, as PNG bytes. */
async function pngBytes(pdfBytes: Uint8Array, dpi: number): Promise<Uint8Array> {
  const pdf = await pdfjs.getDocument({ data: pdfBytes.slice() }).promise;
  try {
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    if (!blob) throw new Error("the picture couldn't be drawn");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    pdf.destroy();
  }
}

async function saveAs(rel: string, pdf: Uint8Array) {
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "pdf") await writeBinary(rel, pdf);
  else if (ext === "png") await writeBinary(rel, await pngBytes(pdf, 300));
  else {
    // the converter reads a file, so the PDF goes in the build folder first
    await writeBinary("build/tikz/export.pdf", pdf);
    await invoke("pdf_to_svg", { root, from: "build/tikz/export.pdf", to: rel });
  }
}

/** Swap the picture in the source for the image, keeping its TikZ in a .tikz file beside it. */
async function replaceWithImage(rel: string) {
  const editor = pane!.editor;
  const doc = editor.state.doc.toString();
  const picture = lastPicture ? pictureAt(doc, lastPicture.from) : null;
  if (!picture) return;
  const tikzRel = rel.replace(/\.\w+$/, ".tikz");
  await invoke("write_file", { root, rel: tikzRel, content: doc.slice(picture.from, picture.to) + "\n" });
  const graphic = rel.replace(/\.pdf$/, "");
  editor.dispatch({
    changes: { from: picture.from, to: picture.to, insert: `\\includegraphics{${graphic}} % drawn from ${tikzRel}` },
    userEvent: "input",
  });
  const preamble = await paperText(editor);
  const needs = /\\usepackage(\[[^\]]*\])?\{[^}]*\bgraphicx\b/.test(preamble) ? "" : " Add \\usepackage{graphicx} to the preamble.";
  setStatus(`The picture is now ${rel}; its TikZ is in ${tikzRel}.${needs}`, "ok");
}

function exportPicture() {
  if (!pane || !shownPdf || drag) return;
  const pdf = shownPdf;
  const name = exportName();
  const ask = (ext: string, then?: (rel: string) => Promise<void>) => () => promptInput({
    placeholder: "Save the picture as",
    hint: "Path inside the project. Saving again replaces the file.",
    value: `figures/${name}.${ext}`,
    validate: (rel) => {
      if (!insideProject(rel)) return "The file has to live inside the project.";
      if (!rel.toLowerCase().endsWith(`.${ext}`)) return `The name has to end in .${ext}.`;
      return null;
    },
    submit: async (rel) => {
      try {
        setStatus(`Saving ${rel}…`, "busy");
        await saveAs(rel, pdf);
        await refreshFiles();
        if (then) await then(rel);
        else setStatus(`Saved ${rel}`, "ok");
      } catch (e) {
        setStatus(`Couldn't save ${rel}: ${e}`, "err");
      }
    },
  });
  openPalette({
    placeholder: "Export the picture…",
    empty: "No format by that name",
    items: [
      { label: "PDF", detail: "Sharp at any size; what LaTeX includes best", run: ask("pdf") },
      { label: "SVG", detail: "For the web and slides", run: ask("svg") },
      { label: "PNG", detail: "300 dpi, for documents that take only images", run: ask("png") },
      { label: "Replace with the image", detail: "Save as PDF and \\includegraphics it here; the TikZ goes in a .tikz file", run: ask("pdf", replaceWithImage) },
    ],
  });
}

// ---------- compiling ----------
async function compileNow() {
  if (!open() || !root) return;
  if (running) {
    again = true;
    return;
  }
  const editor = pane!.editor;
  const doc = editor.state.doc.toString();
  const range = pictureAt(doc, editor.state.selection.main.head) ??
    (lastPicture ? pictureAt(doc, Math.min(lastPicture.from, doc.length)) : null);
  if (!range) {
    note("Put the cursor in a tikzpicture to see it here.");
    return;
  }
  const inEditor = doc.slice(range.from, range.to);
  const picture = withDraft(inEditor, range.from);
  const startLine = editor.state.doc.lineAt(range.from).number;
  lastPicture = { from: range.from, line: startLine };
  const paper = await paperText(editor);
  const preambleKey = paper.slice(0, paper.indexOf("\\begin{document}"));
  const marked = !plainPictures.has(picture);
  const build = (minimal: boolean) => marked
    ? previewDocument(paper, instrument(picture, scanPicture(picture)), minimal, INSTRUMENT_MACROS)
    : previewDocument(paper, picture, minimal);
  let built = build(minimalFor.has(preambleKey));
  if (built.source === lastSource) {
    // the same drawing (a drag just landed in the editor): only the handles' places in the text moved
    if (shown && !drag) {
      shown = { from: range.from, scan: scanPicture(inEditor), marks: shown.marks };
      updateTools();
      renderHandles();
    }
    return;
  }
  lastSource = built.source;

  running = true;
  if (!drag) pane!.stage.classList.add("stale");
  pane!.time.textContent = "Drawing…";
  const started = performance.now();
  try {
    let result = await invoke<CompileResult>("compile_snippet", { root, source: built.source });
    let problems = parseLog(result.log, PREVIEW_TEX).filter((p) => p.severity === "error");
    // An error before the picture is the preamble not suiting a standalone page; try the essentials.
    if (!result.ok && !minimalFor.has(preambleKey) && problems.some((p) => p.line && p.line <= built.offset)) {
      built = build(true);
      result = await invoke<CompileResult>("compile_snippet", { root, source: built.source });
      problems = parseLog(result.log, PREVIEW_TEX).filter((p) => p.severity === "error");
      if (result.ok) minimalFor.add(preambleKey);
    }
    // An error in the marks themselves: draw the picture without handles from now on.
    if (!result.ok && marked && /\\Scribe(Mark|Report|At)/.test(result.log)) {
      plainPictures.add(picture);
      built = previewDocument(paper, picture, minimalFor.has(preambleKey));
      result = await invoke<CompileResult>("compile_snippet", { root, source: built.source });
      problems = parseLog(result.log, PREVIEW_TEX).filter((p) => p.severity === "error");
    }
    lastLog = result.log;
    if (!open()) return;
    pane!.time.textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;
    if (result.ok && result.pdf) {
      shownPdf = new Uint8Array(await invoke<ArrayBuffer>("read_binary", { root, rel: result.pdf }));
      const marks = marked ? readMarks(await readLog(result.pdf)) : null;
      // handles follow the editor's text; while dragging, the scopes are the same in both
      shown = { from: range.from, scan: scanPicture(inEditor), marks };
      updateTools();
      await draw();
      pane!.stage.classList.remove("stale");
      note("");
    } else {
      const [first] = explain(problems);
      // TeX's line is in the preview document; the picture starts at line offset + 1 there.
      let line = first?.line && first.line > built.offset ? startLine + first.line - built.offset - 1 : undefined;
      // Some errors (an unclosed parenthesis) come with no line at all; find the place in the picture.
      if (!line) {
        const paren = unclosedParen(picture);
        line = paren ? startLine + paren - 1 : startLine;
      }
      const kept = shownPdf ? " Showing the last picture that compiled." : "";
      note(first ? first.message : "The picture didn't compile.", "err", line, `${first?.hint ?? "See the log for details."}${kept}`);
    }
  } catch (e) {
    note(String(e), "err");
  } finally {
    running = false;
    if (again) {
      again = false;
      compileNow();
    }
  }
}

function compileSoon(delay = 500) {
  clearTimeout(timer);
  timer = window.setTimeout(compileNow, delay);
}

/** Called by the editor on every change and cursor move; does nothing while the preview is closed. */
export function tikzChanged(editor: EditorView, docChanged: boolean) {
  if (!open() || editor !== pane!.editor) return;
  if (docChanged) {
    compileSoon();
    return;
  }
  // moving into a different picture shows that one
  const range = pictureAt(editor.state.doc.toString(), editor.state.selection.main.head);
  if (range && editor.state.doc.lineAt(range.from).number !== lastPicture?.line) compileSoon(150);
  else renderHandles();
}

function button(className: string, label: string, title: string, onclick: () => void, svg?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = className;
  b.title = title;
  b.setAttribute("aria-label", title);
  if (svg) b.innerHTML = svg;
  else b.textContent = label;
  b.onclick = onclick;
  return b;
}

const svg = (path: string) =>
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

function buildPane(editor: EditorView): Pane {
  const box = document.createElement("div");
  box.className = "tikz-pane";
  const bar = document.createElement("div");
  bar.className = "tikz-bar";
  const noteEl = document.createElement("div");
  noteEl.className = "tikz-note";
  const tools = document.createElement("span");
  tools.className = "tikz-tools";
  for (const [id, title, path] of TOOLS) {
    const b = button("icon-btn", "", title, () => setTool(id), svg(path));
    b.dataset.tool = id;
    b.setAttribute("aria-pressed", String(id === tool));
    tools.append(b);
  }
  const points = document.createElement("span");
  points.className = "tikz-points";
  const time = document.createElement("span");
  time.className = "tikz-time";
  time.title = "How long the last drawing took";
  const zoomBox = document.createElement("span");
  zoomBox.className = "pdf-zoom";
  const zoomLabel = button("btn", "100%", "Fit to the pane", () => setZoom("fit"));
  zoomBox.append(
    button("icon-btn", "", "Zoom out", () => setZoom(zoom / 1.25), svg('<path d="M3.5 8h9"/>')),
    zoomLabel,
    button("icon-btn", "", "Zoom in", () => setZoom(zoom * 1.25), svg('<path d="M3.5 8h9M8 3.5v9"/>')),
  );
  const log = button("btn tikz-log", "Log", "Show the log of the last drawing", () => showLog("TikZ preview", lastLog));
  const save = button("btn tikz-log", "Export…", "Save the picture as PDF, SVG or PNG", exportPicture);
  bar.append(tools, points, time, zoomBox, log, save);
  const stage = document.createElement("div");
  stage.className = "tikz-stage";
  // pinch, or Cmd + scroll, zooms
  stage.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.01));
  }, { passive: false });
  new ResizeObserver(() => { if (zoom === 1) redrawSoon(); }).observe(stage);
  stage.addEventListener("pointerdown", (e) => { if (!drawDown(e)) startDrag(e); });
  stage.addEventListener("pointermove", (e) => { drawMove(e); moveDrag(e); });
  stage.addEventListener("pointerup", (e) => { drawUp(e); endDrag(e); });
  stage.addEventListener("pointercancel", (e) => endDrag(e, true));

  box.append(bar, noteEl, stage);
  return { box, note: noteEl, time, points, tools, zoomLabel, stage, editor };
}

/** Show the picture at the cursor beside the source; with none there, insert one to start from. */
export async function previewTikz(editor: EditorView | null) {
  if (open()) {
    closeSide();
    return;
  }
  if (!editor || !PICTURE_FILE.test(editor.dom.dataset.path ?? "")) {
    setStatus("Put the cursor in a .tex or .tikz file to preview or insert a TikZ picture");
    return;
  }
  const pos = editor.state.selection.main.head;
  if (!pictureAt(editor.state.doc.toString(), pos)) {
    const at = editor.state.doc.lineAt(pos);
    const indent = /^[ \t]*/.exec(at.text)![0];
    const insertAt = at.text.trim() ? at.to : at.from;
    const text = (at.text.trim() ? "\n" : "") + starterText(STARTERS[0], indent);
    editor.dispatch({ changes: { from: insertAt, insert: text }, userEvent: "input" });
    const inside = editor.state.doc.toString().indexOf("\\begin{tikzpicture}", insertAt) + "\\begin{tikzpicture}".length;
    editor.dispatch({ selection: { anchor: inside } });
  }
  await openPane(editor);
}

/** Open the preview beside `editor`, or redraw it for the picture now at the cursor. */
export async function openTikzPreview(editor: EditorView) {
  if (open() && pane!.editor === editor) {
    compileSoon(0);
    return;
  }
  if (open()) await closeSide();
  await openPane(editor);
}

async function openPane(editor: EditorView) {
  const moved = sideFile;
  pane = buildPane(editor);
  lastSource = "";
  lastLog = "";
  lastPicture = null;
  shownPdf = null;
  shown = null;
  drag = null;
  tool = "select";
  sketch = null;
  zoom = 1;
  await showInSide("TikZ", pane.box);
  if (moved) setStatus(`Saved ${moved} and closed it in the side pane to show the preview`);
  editor.focus();
  compileNow();
}
