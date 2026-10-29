// Opening and closing projects and files, and saving.
import { EditorView } from "codemirror";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import * as pdfjs from "pdfjs-dist";
import { DATA_FILE, showData } from "./data";
import { clearProblems, markProblemsInEditor } from "./problems";
import { $, assignDirty, baseName, current, dirty, mainFile, renderCrumb, root, setCurrent, setDirty, setMainFile, setRoot, setStatus, showLog, VIEWABLE } from "./core";
import { createEditorState, prefEffects, view } from "./editor";
import { isNotebook, leaveNotebook, saveNotebook, stopKernel, updateNotebookView } from "./notebook";
import { resetPdf } from "./preview";
import { setPaperless } from "./layout";
import { closeReader, isPaper, openReader } from "./reader";
import { tourOnFirstProject } from "./tour";
import { restoreCursor, restoreSession, saveSession } from "./session";
import { loadSettings, resetSettings, toggleSettings } from "./settings";
import { closeSide, sideFile } from "./split";
import { renderFileInfo } from "./statusbar";
import { refreshFiles } from "./sidebar";
import { dropTabs, noteOpened, resetTabs, showNoFile, stashEditor, takeStashed } from "./tabs";
import { canRunFile, resetTerminal } from "./terminal";
import { refreshIndex, refreshIndexSoon, VALUES_TEX } from "./texindex";
import { getRecent, renderRecent, setRecent, showWelcome } from "./welcome";

export async function openFolder() {
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked === "string") await openProject(picked);
}

export async function openProject(path: string) {
  const errEl = $("welcome-error");
  errEl.hidden = true;
  if (dirty) await save();

  let files: string[];
  try {
    files = await invoke<string[]>("list_files", { root: path });
  } catch {
    setRecent(getRecent().filter((p) => p !== path));
    renderRecent();
    errEl.textContent = `Can't open ${baseName(path)}. The folder may have been moved or deleted.`;
    errEl.hidden = false;
    return;
  }

  await closeSide();
  await stopKernel();
  await resetTerminal();
  setRoot(path);
  setCurrent(null);
  assignDirty(false);
  resetPdf();
  clearProblems();
  resetTabs();
  setRecent([path, ...getRecent().filter((p) => p !== path)]);
  $("project-name").textContent = baseName(path);
  renderCrumb();
  setStatus("");
  showLog("Log", "", false);
  showWelcome(false);

  // Prefer a file that declares \documentclass as the compile root.
  setMainFile(files.includes("main.tex") ? "main.tex" : await findPaper(path, files));
  await loadSettings(); // before the file list is drawn: it holds the saved file order
  // Back to where this project was left; a project opened for the first time starts on its paper.
  const hasPaper = files.some((f) => f.endsWith(".tex"));
  setPaperless(!hasPaper);
  if (!(await restoreSession(files))) {
    // A notes project starts on its index, its readme, or any note.
    const note = files.find((f) => /(^|\/)index\.md$/i.test(f)) ?? files.find((f) => /^readme\.md$/i.test(f)) ?? files.find((f) => /\.md$/i.test(f));
    if (files.includes(mainFile)) await openFile(mainFile);
    else if (!hasPaper && note) await openFile(note);
    else showNoFile();
  }
  refreshIndex().catch(() => {});
  tourOnFirstProject();
}

/** The .tex file that declares \documentclass (projects from Overleaf often aren't main.tex). */
async function findPaper(path: string, files: string[]): Promise<string> {
  const tex = files.filter((f) => f.endsWith(".tex") && f !== VALUES_TEX && !f.startsWith(".")).sort((a, b) => a.split("/").length - b.split("/").length);
  for (const f of tex.slice(0, 40)) {
    const text = await invoke<string>("read_file", { root: path, rel: f }).catch(() => "");
    if (/^[^%\n]*\\documentclass/m.test(text)) return f;
  }
  return tex[0] ?? "main.tex";
}

export async function closeProject() {
  if (!root) return;
  if (dirty) await save();
  saveSession();
  await closeSide();
  await stopKernel();
  await resetTerminal();
  $("btn-run-file").hidden = true;
  setRoot(null);
  setCurrent(null);
  assignDirty(false);
  resetPdf();
  clearProblems();
  resetTabs();
  leaveNotebook();
  toggleSettings(false);
  // Settings are per project; the welcome screen always uses the default look.
  resetSettings();
  document.documentElement.removeAttribute("data-density");
  document.documentElement.style.removeProperty("--editor-fs");
  renderRecent();
  showWelcome(true);
}

export const listDirs = async (): Promise<string[]> => (root ? invoke<string[]>("list_dirs", { root }) : []);

export async function listFiles(): Promise<string[]> {
  if (!root) return [];
  return invoke<string[]>("list_files", { root });
}

// The editor pane shows exactly one of: the text editor, notebook cells, a file preview, or
// (with no file open) a hint.
export function setMainView(which: "editor" | "notebook" | "preview" | "data" | "none") {
  if (which !== "preview") closeReader(); // its Highlight button goes with it
  $("no-file").hidden = which !== "none";
  $("data-view").hidden = which !== "data";
  if (which !== "data") $("data-view").replaceChildren();
  $("editor").hidden = which !== "editor";
  $("notebook-view").hidden = which !== "notebook";
  $("file-preview").hidden = which !== "preview";
  $("btn-run-file").hidden = !canRunFile();
  renderFileInfo();
  if (which !== "preview") {
    previewJob++;
    $("file-preview").replaceChildren();
  }
}

export const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml" };
export let previewJob = 0;

// PDFs and images (figures, mostly) open as a picture of themselves in the editor pane.
export async function showFilePreview(rel: string) {
  const box = $("file-preview");
  const job = ++previewJob;
  box.replaceChildren();
  closeReader();
  try {
    const bytes = new Uint8Array(await invoke<ArrayBuffer>("read_binary", { root, rel }));
    const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
    // Papers to read open in the reader, with selectable text and highlights.
    if (isPaper(rel)) {
      await openReader(rel, bytes, box, () => job !== previewJob);
      return;
    }
    const frag = document.createDocumentFragment();
    if (ext === "pdf") {
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      const dpr = window.devicePixelRatio || 1;
      const room = Math.max(200, box.clientWidth - 48);
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        // Fit the pane, but don't blow a small figure up past twice its real size.
        const cssWidth = Math.min(room, base.width * 2);
        const vp = page.getViewport({ scale: (cssWidth / base.width) * dpr });
        const canvas = document.createElement("canvas");
        canvas.width = vp.width;
        canvas.height = vp.height;
        canvas.style.width = `${cssWidth}px`;
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
        frag.appendChild(canvas);
      }
    } else {
      const img = new Image();
      img.alt = rel;
      img.src = URL.createObjectURL(new Blob([bytes], { type: IMAGE_MIME[ext] ?? "application/octet-stream" }));
      img.onload = () => URL.revokeObjectURL(img.src);
      frag.appendChild(img);
    }
    if (job === previewJob) box.replaceChildren(frag);
  } catch (e) {
    if (job !== previewJob) return;
    const note = document.createElement("div");
    note.className = "empty";
    note.textContent = `Couldn't preview ${rel}: ${e}`;
    box.replaceChildren(note);
  }
}

export async function openFile(rel: string) {
  if (!root) return;
  if (dirty) await save();
  if (rel === sideFile) await closeSide(); // one editor per file: it moves to the main pane
  stashEditor(); // the file being left keeps its undo history, cursor and scroll
  if (VIEWABLE.test(rel)) {
    setCurrent(rel);
    assignDirty(false);
    leaveNotebook();
    noteOpened(rel);
    renderCrumb();
    setMainView("preview");
    await refreshFiles();
    await showFilePreview(rel);
    return;
  }
  let text: string;
  try {
    text = await invoke<string>("read_file", { root, rel });
  } catch (e) {
    // Gone or unreadable (deleted outside the app, say): don't leave a dead tab behind.
    setStatus(`Couldn't open ${rel}: ${e}`, "err");
    await dropTabs((tab) => tab === rel);
    return;
  }
  if (DATA_FILE.test(rel)) {
    // Data opens as a table and plot; to edit it as text, open it to the side.
    setCurrent(rel);
    assignDirty(false);
    leaveNotebook();
    noteOpened(rel);
    renderCrumb();
    setMainView("data");
    showData(rel, text);
    await refreshFiles();
    return;
  }
  setCurrent(rel);
  const back = takeStashed(rel, text);
  if (back) {
    view.setState(back.state);
    // Theme, Vim keys or line numbers may have changed while this tab was in the background.
    view.dispatch({ effects: prefEffects() });
    requestAnimationFrame(() => { view.scrollDOM.scrollTop = back.scroll; });
  } else {
    view.setState(createEditorState(text, rel));
  }
  assignDirty(false);
  noteOpened(rel);
  if (!back) restoreCursor(rel); // a tab reopened from a saved session returns to its place
  renderCrumb();
  if (rel.endsWith(".tex") && text.includes("\\documentclass")) setMainFile(rel);
  markProblemsInEditor();
  await refreshFiles();
  await updateNotebookView(text);
}

/** Opens `rel` if it isn't already open and puts the cursor on `line` (1-based). */
export async function revealLine(rel: string, line: number, col = 0) {
  if (current !== rel) await openFile(rel);
  if ($("editor").hidden || line < 1) return; // notebooks and previews have no lines to go to
  const target = view.state.doc.line(Math.min(line, view.state.doc.lines));
  view.dispatch({
    selection: { anchor: Math.min(target.from + col, target.to) },
    effects: EditorView.scrollIntoView(target.from, { y: "center" }),
  });
  view.focus();
}

export async function save() {
  if (!root || !current) return;
  // A preview or a data table has nothing to write, and must never overwrite the file.
  if (VIEWABLE.test(current) || DATA_FILE.test(current)) return;
  if (isNotebook()) {
    await saveNotebook();
  } else {
    await invoke("write_file", { root, rel: current, content: view.state.doc.toString() });
    setDirty(false);
  }
  refreshIndexSoon(); // new labels, citations or figure cells
}
