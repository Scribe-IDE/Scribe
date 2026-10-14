// Status bar along the bottom of the window: git branch, build status and problems on the left;
// Vim mode, cursor position, file kind and compile target on the right.
import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "codemirror";
import { getCM } from "@replit/codemirror-vim";
import { $, changeListeners, current, logPanel, mainFile, root, setLogView, VIEWABLE } from "./core";
import { ICONS } from "./icons";
import { notebookMode } from "./notebook";
import { problemCount } from "./problems";
import { countWords, proseKind } from "./prose";

const KIND: Record<string, string> = {
  tex: "LaTeX", bib: "BibTeX", sty: "LaTeX package", cls: "LaTeX class", md: "Markdown", txt: "Plain text",
};

function fileKind(): string {
  if (!current) return "";
  if (VIEWABLE.test(current)) return "Preview";
  if (/\.(csv|tsv)$/i.test(current)) return "Data";
  if (current.endsWith(".ipynb")) return "Jupyter notebook";
  if (current.endsWith(".py")) return notebookMode ? "Python notebook" : "Python";
  return KIND[current.slice(current.lastIndexOf(".") + 1)] ?? "Plain text";
}

/** File kind and compile target. Also clears the cursor readout when no editor is showing. */
export function renderFileInfo() {
  $("sb-kind").textContent = fileKind();
  $("sb-main").textContent = root ? `Paper: ${mainFile}` : "";
  $("sb-main").title = "The file Compile builds. Opening a .tex file with \\documentclass makes it the paper.";
  const editing = !!current && (!$("editor").hidden || !$("notebook-view").hidden);
  if (!editing) {
    $("sb-cursor").textContent = "";
    $("sb-vim").textContent = "";
    $("sb-words").textContent = "";
  }
}

const number = new Intl.NumberFormat();
let wordTimer: number | null = null;

// Counting reads the whole document, so it waits for a pause in typing.
function reportWords(editor: EditorView) {
  const kind = proseKind(editor.dom.dataset.path ?? null);
  const el = $("sb-words");
  if (!kind) {
    el.textContent = "";
    return;
  }
  if (wordTimer) clearTimeout(wordTimer);
  wordTimer = window.setTimeout(() => {
    const { from, to } = editor.state.selection.main;
    const total = countWords(editor.state.doc.toString(), kind);
    const picked = from === to ? 0 : countWords(editor.state.sliceDoc(from, to), kind);
    el.textContent = picked ? `${number.format(picked)} of ${number.format(total)} words` : `${number.format(total)} word${total === 1 ? "" : "s"}`;
    el.title = "Words in this file, not counting commands, maths or comments";
  }, 300);
}

/** Called by whichever editor (main or a notebook cell) just changed or took focus. */
export function reportCursor(editor: EditorView) {
  if (!editor.hasFocus && document.activeElement !== document.body) return; // a background editor
  reportWords(editor);
  const { head, from, to } = editor.state.selection.main;
  const line = editor.state.doc.lineAt(head);
  const selected = to - from;
  $("sb-cursor").textContent = `Ln ${line.number}, Col ${head - line.from + 1}${selected ? ` (${selected} selected)` : ""}`;

  const vim = getCM(editor)?.state.vim;
  const mode = !vim ? "" : vim.insertMode ? "INSERT" : vim.visualMode ? (vim.visualLine ? "V-LINE" : vim.visualBlock ? "V-BLOCK" : "VISUAL") : "NORMAL";
  const el = $("sb-vim");
  el.textContent = mode;
  el.dataset.mode = mode.toLowerCase();
}

export function renderProblemCount() {
  const el = $("sb-problems");
  const errors = problemCount("error");
  const warnings = problemCount("warning");
  el.classList.toggle("has-errors", errors > 0);
  el.classList.toggle("has-warnings", warnings > 0);
  el.innerHTML = `${ICONS.error}<span>${errors}</span>${ICONS.warn}<span>${warnings}</span>`;
  el.title = `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} in the last compile. Click to show them.`;
}

export async function refreshBranch() {
  const el = $("sb-branch");
  const branch = root ? await invoke<string | null>("git_branch", { root }).catch(() => null) : null;
  el.hidden = !branch;
  if (branch) {
    el.innerHTML = ICONS.branch;
    el.append(branch);
    el.title = `Git branch: ${branch}`;
  }
}

$("sb-problems").onclick = () => {
  const showing = !logPanel.hidden && !$("problems").hidden;
  setLogView("problems");
  logPanel.hidden = showing;
};

changeListeners.push(renderFileInfo);
