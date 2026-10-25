// TikZ preview: the tikzpicture under the cursor, drawn in the side pane and redrawn as you
// type. The picture is compiled on its own as a standalone document with the paper's preamble,
// so it takes about a second instead of a whole compile; errors point at lines in the source.
import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import * as pdfjs from "pdfjs-dist";
import { current, mainFile, root, setStatus } from "./core";
import { parseLog } from "./diagnostics";
import { closeSide, showInSide } from "./split";

const ENVS = "tikzpicture|tikzcd|circuitikz";
const PREVIEW_TEX = "build/tikz/preview.tex";
const CLASS = "\\documentclass[tikz,border=6pt]{standalone}";
// Kept from the paper's preamble when the whole of it doesn't compile as a standalone document.
const ESSENTIAL = /^\s*\\(usetikzlibrary|usepgfplotslibrary|tikzset|pgfplotsset|definecolor|colorlet|usepackage(\[[^\]]*\])?\{[^}]*\b(tikz|pgfplots|tikz-cd|circuitikz|xcolor|amsmath|amssymb|bm|siunitx)\b[^}]*\})/;

interface CompileResult { ok: boolean; log: string; pdf: string | null; }

/** The picture environment around `pos`: where it starts and ends. */
export function pictureAt(doc: string, pos: number): { from: number; to: number } | null {
  const re = new RegExp(`\\\\begin\\{(${ENVS})\\}`, "g");
  let best: { from: number; to: number } | null = null;
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    if (m.index > pos) break;
    const scan = new RegExp(`\\\\(begin|end)\\{${m[1]}\\}`, "g");
    scan.lastIndex = m.index;
    let depth = 0;
    for (let s = scan.exec(doc); s; s = scan.exec(doc)) {
      depth += s[1] === "begin" ? 1 : -1;
      if (depth === 0) {
        const to = s.index + s[0].length;
        if (pos <= to) best = { from: m.index, to };
        break;
      }
    }
  }
  return best;
}

/** The paper's preamble with its class swapped for standalone; `minimal` keeps only what pictures need. */
export function previewDocument(paper: string, picture: string, minimal: boolean): { source: string; offset: number } {
  const begin = paper.indexOf("\\begin{document}");
  let preamble = begin < 0 ? "" : paper.slice(0, begin).replace(/^[ \t]*\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]*\}[^\n]*\n?/m, "");
  if (minimal) preamble = preamble.split("\n").filter((l) => ESSENTIAL.test(l)).join("\n");
  // \input@path lets the picture's \input and \includegraphics find files from the project folder
  const head = `${CLASS}\n\\makeatletter\\def\\input@path{{../../}}\\makeatother\n${preamble.trim()}\n\\begin{document}\n`;
  return { source: `${head}${picture}\n\\end{document}\n`, offset: head.split("\n").length - 1 };
}

// ---------- the pane ----------
let pane: { box: HTMLElement; note: HTMLElement; stage: HTMLElement; editor: EditorView } | null = null;
let timer = 0;
let running = false;
let again = false;
let lastSource = "";
let lastPicture: { from: number; line: number } | null = null;
/** Preambles that only compile cut down to the essentials, so they skip the full attempt. */
const minimalFor = new Set<string>();

const open = () => !!pane?.box.isConnected;

async function paperText(editor: EditorView): Promise<string> {
  if (current === mainFile && editor.dom.dataset.path === mainFile) return editor.state.doc.toString();
  if (/\\documentclass/.test(editor.state.doc.toString())) return editor.state.doc.toString();
  return invoke<string>("read_file", { root, rel: mainFile }).catch(() => "");
}

function note(text: string, kind: "" | "busy" | "err" = "", line?: number) {
  if (!pane) return;
  pane.note.className = `tikz-note${kind ? ` ${kind}` : ""}`;
  pane.note.replaceChildren(text);
  if (line) {
    const jump = document.createElement("button");
    jump.className = "tikz-jump";
    jump.textContent = `Line ${line}`;
    jump.onclick = () => {
      const editor = pane!.editor;
      const at = editor.state.doc.line(Math.min(line, editor.state.doc.lines));
      editor.dispatch({ selection: { anchor: at.from }, effects: EditorView.scrollIntoView(at.from, { y: "center" }) });
      editor.focus();
    };
    pane.note.append(" ", jump);
  }
}

async function draw(rel: string) {
  const bytes = await invoke<ArrayBuffer>("read_binary", { root, rel });
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  // as wide as the pane allows, but never more than twice its printed size
  const width = Math.min(pane!.stage.clientWidth - 32, base.width * 2);
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: (width / base.width) * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = vp.width;
  canvas.height = vp.height;
  canvas.style.width = `${width}px`;
  canvas.className = "tikz-picture";
  await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
  pdf.destroy();
  if (open()) pane!.stage.replaceChildren(canvas);
}

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
  const picture = doc.slice(range.from, range.to);
  const startLine = editor.state.doc.lineAt(range.from).number;
  lastPicture = { from: range.from, line: startLine };
  const paper = await paperText(editor);
  const preambleKey = paper.slice(0, paper.indexOf("\\begin{document}"));
  let built = previewDocument(paper, picture, minimalFor.has(preambleKey));
  if (built.source === lastSource) return;
  lastSource = built.source;

  running = true;
  pane!.stage.classList.add("stale");
  note("Drawing…", "busy");
  try {
    let result = await invoke<CompileResult>("compile_snippet", { root, source: built.source });
    let problems = parseLog(result.log, PREVIEW_TEX).filter((p) => p.severity === "error");
    // An error before the picture is the preamble not suiting a standalone page; try the essentials.
    if (!result.ok && !minimalFor.has(preambleKey) && problems.some((p) => p.line && p.line <= built.offset)) {
      built = previewDocument(paper, picture, true);
      result = await invoke<CompileResult>("compile_snippet", { root, source: built.source });
      problems = parseLog(result.log, PREVIEW_TEX).filter((p) => p.severity === "error");
      if (result.ok) minimalFor.add(preambleKey);
    }
    if (!open()) return;
    if (result.ok && result.pdf) {
      await draw(result.pdf);
      pane!.stage.classList.remove("stale");
      note("");
    } else {
      const first = problems[0];
      const inPicture = first?.line && first.line > built.offset ? startLine + first.line - built.offset - 1 : undefined;
      note(first ? first.message : "The picture didn't compile. See the log for details.", "err", inPicture);
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
}

const STARTER = (indent: string) =>
  `\\begin{figure}[ht]\n${indent}  \\centering\n${indent}  \\begin{tikzpicture}\n${indent}    \\draw[->] (0,0) -- (3,0) node[right] {$x$};\n${indent}    \\draw[->] (0,0) -- (0,2) node[above] {$y$};\n${indent}    \\draw[thick] (0,0) .. controls (1,2) and (2,0) .. (3,1.5);\n${indent}  \\end{tikzpicture}\n${indent}  \\caption{}\n${indent}  \\label{fig:}\n${indent}\\end{figure}\n`;

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
  const box = document.createElement("div");
  box.className = "tikz-pane";
  const noteEl = document.createElement("div");
  const stage = document.createElement("div");
  stage.className = "tikz-stage";
  box.append(noteEl, stage);
  pane = { box, note: noteEl, stage, editor };
  lastSource = "";
  lastPicture = null;
  await showInSide("TikZ", box);
  editor.focus();
  compileNow();
}
