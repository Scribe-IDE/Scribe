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
import { buildCanvas, canvasBusy, canvasCursor, canvasUpdated, learnColors, renderCanvas, type Edit, type Shown } from "./tikzcanvas";
import { definedColors } from "./tikzoptions";
import {
  instrument, INSTRUMENT_MACROS, pictureAt, PICTURE_FILE, previewDocument, readMarks, scanPicture, unclosedParen,
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
/** The picture shown, as the editor had it, and where its points and shapes were drawn. */
let shown: Shown | null = null;
/** Edits drawn before the editor has them, while a drag is in progress. */
let draft: { pictureFrom: number; edits: Edit[] } | null = null;
/** The paper's colours, for the style bar. */
let paperColors: string[] = [];
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
    renderCanvas();
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

/** The picture drawn with some edits made that the editor doesn't have yet (a drag in progress). */
function withDraft(picture: string, pictureFrom: number): string {
  if (!draft || draft.pictureFrom !== pictureFrom) return picture;
  let out = picture;
  for (const e of [...draft.edits].sort((x, y) => y.from - x.from)) {
    if (out.slice(e.from, e.to) !== e.original) return picture;
    out = out.slice(0, e.from) + e.text + out.slice(e.to);
  }
  return out;
}

/** The TeX log beside a PDF, where the marks are. Read as bytes: a log needn't be valid UTF-8. */
async function readLog(pdf: string): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("read_binary", { root, rel: pdf.replace(/\.pdf$/, ".log") }).catch(() => null);
  return bytes ? new TextDecoder().decode(bytes) : "";
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
  if (!pane || !shownPdf || draft) return;
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
  if (!paperColors.length || !shown) {
    const preamble = paper.slice(0, Math.max(0, paper.indexOf("\\begin{document}")));
    paperColors = definedColors(preamble);
    learnColors(preamble);
  }
  const preambleKey = paper.slice(0, paper.indexOf("\\begin{document}"));
  const marked = !plainPictures.has(picture);
  const build = (minimal: boolean) => marked
    ? previewDocument(paper, instrument(picture, scanPicture(picture)), minimal, INSTRUMENT_MACROS)
    : previewDocument(paper, picture, minimal);
  let built = build(minimalFor.has(preambleKey));
  if (built.source === lastSource) {
    // the same drawing (a drag just landed in the editor): only the handles' places in the text moved
    if (shown && !draft) {
      shown = { from: range.from, text: inEditor, scan: scanPicture(inEditor), marks: shown.marks };
      canvasUpdated();
      renderCanvas();
    }
    return;
  }
  lastSource = built.source;

  running = true;
  if (!draft && !canvasBusy()) pane!.stage.classList.add("stale");
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
      shown = { from: range.from, text: inEditor, scan: scanPicture(inEditor), marks };
      canvasUpdated();
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
  else canvasCursor();
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
  const stage = document.createElement("div");
  stage.className = "tikz-stage";
  const canvas = buildCanvas({
    editor,
    stage,
    shown: () => shown,
    setDraft: (edits) => {
      draft = edits && shown ? { pictureFrom: shown.from, edits } : null;
      compileSoon(0);
    },
    paperColors: () => paperColors,
  });
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
  bar.append(canvas.count, time, zoomBox, log, save);
  const toolRow = document.createElement("div");
  toolRow.className = "tikz-toolrow";
  toolRow.append(canvas.tools);
  // pinch, or Cmd + scroll, zooms
  stage.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.01));
  }, { passive: false });
  new ResizeObserver(() => { if (zoom === 1) redrawSoon(); }).observe(stage);

  box.append(bar, toolRow, canvas.style, noteEl, stage);
  return { box, note: noteEl, time, zoomLabel, stage, editor };
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
  draft = null;
  paperColors = [];
  zoom = 1;
  await showInSide("TikZ", pane.box);
  if (moved) setStatus(`Saved ${moved} and closed it in the side pane to show the preview`);
  editor.focus();
  compileNow();
}
