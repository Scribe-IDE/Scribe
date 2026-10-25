// TikZ preview: the tikzpicture under the cursor, drawn in the side pane and redrawn as you
// type. The picture is compiled on its own as a standalone document with the paper's preamble,
// so it takes about a second instead of a whole compile; errors point at lines in the source.
import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import * as pdfjs from "pdfjs-dist";
import { clamp, current, mainFile, root, setStatus, showLog } from "./core";
import { explain, parseLog } from "./diagnostics";
import { closeSide, showInSide, sideFile } from "./split";
import {
  formatCoordinate, fromPage, instrument, INSTRUMENT_MACROS, pictureAt, previewDocument, readMarks, scanPicture,
  toPage, unclosedParen, type Marks, type PictureScan,
} from "./tikzsource";

const PREVIEW_TEX = "build/tikz/preview.tex";
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 6;

interface CompileResult { ok: boolean; log: string; pdf: string | null; }

// ---------- the pane ----------
interface Pane {
  box: HTMLElement;
  note: HTMLElement;
  time: HTMLElement;
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
/** A coordinate being dragged: the preview draws `text` in its place before the editor has it. */
let drag: {
  index: number;
  pictureFrom: number;
  from: number;
  to: number;
  original: string;
  value: [number, number];
  text: string;
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

/** The handles for the picture shown, with the one under the editor's cursor marked. */
function renderHandles() {
  const layer = pane?.stage.querySelector<HTMLElement>(".tikz-handles");
  if (!layer) return;
  layer.replaceChildren();
  if (!shown?.marks) return;
  const { marks, scan, from } = shown;
  const head = pane!.editor.state.selection.main.head;
  scan.coords.forEach((c, index) => {
    const el = document.createElement("span");
    el.className = "tikz-handle";
    el.dataset.index = String(index);
    const dragging = drag?.index === index;
    const [x, y] = dragging ? drag!.value : [c.x, c.y];
    place(el, toPage(marks, c.scope, x, y));
    el.title = `${formatCoordinate(x, y)}. Drag to move it, Option for finer steps; click to find it in the source.`;
    if (dragging) el.classList.add("dragging");
    else if (head >= from + c.from && head <= from + c.to) el.classList.add("active");
    layer.append(el);
  });
  if (drag) {
    const label = document.createElement("span");
    label.className = "tikz-coord";
    label.textContent = drag.text;
    const c = scan.coords[drag.index];
    if (c) place(label, toPage(marks, c.scope, drag.value[0], drag.value[1]));
    layer.append(label);
  }
}

function startDrag(e: PointerEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".tikz-handle");
  if (!el || !shown?.marks || e.button !== 0) return;
  const index = Number(el.dataset.index);
  const c = shown.scan.coords[index];
  const doc = pane!.editor.state.doc;
  const original = doc.sliceString(shown.from + c.from, shown.from + c.to);
  e.preventDefault();
  pane!.stage.setPointerCapture(e.pointerId);
  pane!.stage.classList.add("dragging");
  window.addEventListener("keydown", escapeDrag, true);
  drag = {
    index, pictureFrom: shown.from, from: c.from, to: c.to, original,
    value: [c.x, c.y], text: formatCoordinate(c.x, c.y), startX: e.clientX, startY: e.clientY, moved: false,
  };
}

function moveDrag(e: PointerEvent) {
  if (!drag || !shown?.marks) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 3) return;
  drag.moved = true;
  const rect = pane!.stage.querySelector(".tikz-sheet")!.getBoundingClientRect();
  const c = shown.scan.coords[drag.index];
  const at = fromPage(shown.marks, c.scope, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  if (!at) return;
  const step = e.altKey ? SNAP_FINE : SNAP;
  const value: [number, number] = [Math.round(at[0] / step) * step, Math.round(at[1] / step) * step];
  const text = formatCoordinate(value[0], value[1]);
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

const STARTER = (indent: string) =>
  `\\begin{figure}[ht]\n${indent}  \\centering\n${indent}  \\begin{tikzpicture}\n${indent}    \\draw[->] (0,0) -- (3,0) node[right] {$x$};\n${indent}    \\draw[->] (0,0) -- (0,2) node[above] {$y$};\n${indent}    \\draw[thick] (0,0) .. controls (1,2) and (2,0) .. (3,1.5);\n${indent}  \\end{tikzpicture}\n${indent}  \\caption{}\n${indent}  \\label{fig:}\n${indent}\\end{figure}\n`;

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
  bar.append(time, zoomBox, log);
  const stage = document.createElement("div");
  stage.className = "tikz-stage";
  // pinch, or Cmd + scroll, zooms
  stage.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.01));
  }, { passive: false });
  new ResizeObserver(() => { if (zoom === 1) redrawSoon(); }).observe(stage);
  stage.addEventListener("pointerdown", startDrag);
  stage.addEventListener("pointermove", moveDrag);
  stage.addEventListener("pointerup", (e) => endDrag(e));
  stage.addEventListener("pointercancel", (e) => endDrag(e, true));

  box.append(bar, noteEl, stage);
  return { box, note: noteEl, time, zoomLabel, stage, editor };
}

/** Show the picture at the cursor beside the source; with none there, insert one to start from. */
export async function previewTikz(editor: EditorView | null) {
  if (open()) {
    closeSide();
    return;
  }
  if (!editor || !editor.dom.dataset.path?.endsWith(".tex")) {
    setStatus("Put the cursor in a .tex file to preview or insert a TikZ picture");
    return;
  }
  const pos = editor.state.selection.main.head;
  if (!pictureAt(editor.state.doc.toString(), pos)) {
    const at = editor.state.doc.lineAt(pos);
    const indent = /^[ \t]*/.exec(at.text)![0];
    const insertAt = at.text.trim() ? at.to : at.from;
    const text = (at.text.trim() ? "\n" + indent : "") + STARTER(indent);
    editor.dispatch({ changes: { from: insertAt, insert: text }, userEvent: "input" });
    const inside = editor.state.doc.toString().indexOf("\\begin{tikzpicture}", insertAt) + "\\begin{tikzpicture}".length;
    editor.dispatch({ selection: { anchor: inside } });
  }
  const moved = sideFile;
  pane = buildPane(editor);
  lastSource = "";
  lastLog = "";
  lastPicture = null;
  shownPdf = null;
  shown = null;
  drag = null;
  zoom = 1;
  await showInSide("TikZ", pane.box);
  if (moved) setStatus(`Saved ${moved} and closed it in the side pane to show the preview`);
  editor.focus();
  compileNow();
}
