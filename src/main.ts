/// <reference types="vite/client" />
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface CompileResult {
  ok: boolean;
  engine: string;
  log: string;
  pdf: string | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const logEl = $("log") as HTMLPreElement;

let root: string | null = null;
let mainFile = "main.tex";
let current: string | null = null;
let dirty = false;

function setStatus(msg: string, kind: "" | "ok" | "err" = "") {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

// ---------- editor ----------
const lang = new Compartment();
function languageFor(path: string): Extension {
  if (path.endsWith(".py")) return python();
  if (/\.(tex|sty|cls|bib)$/.test(path)) return StreamLanguage.define(stex);
  return [];
}

const view = new EditorView({
  parent: $("editor"),
  state: EditorState.create({
    doc: "",
    extensions: [
      basicSetup,
      oneDark,
      lang.of([]),
      EditorView.lineWrapping,
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (save(), true) },
        { key: "Mod-Enter", preventDefault: true, run: () => (compile(), true) },
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && current) {
          dirty = true;
          $("tab").textContent = current + " •";
        }
      }),
    ],
  }),
});

// ---------- files ----------
async function openFolder() {
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked !== "string") return;
  root = picked;
  await refreshFiles();
  const files = await listFiles();
  // Prefer a file that declares \documentclass as the compile root.
  mainFile = files.includes("main.tex") ? "main.tex" : files.find((f) => f.endsWith(".tex")) ?? "main.tex";
  if (files.includes(mainFile)) await openFile(mainFile);
  setStatus(root);
}

async function listFiles(): Promise<string[]> {
  if (!root) return [];
  return invoke<string[]>("list_files", { root });
}

async function refreshFiles() {
  const box = $("files");
  box.innerHTML = "";
  const files = await listFiles();
  if (!files.length) {
    box.innerHTML = '<div class="empty">No files</div>';
    return;
  }
  let lastDir = "";
  for (const f of files) {
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    if (dir !== lastDir) {
      const d = document.createElement("div");
      d.className = "dir";
      d.textContent = dir || "/";
      box.appendChild(d);
      lastDir = dir;
    }
    const el = document.createElement("div");
    el.className = "item" + (f === current ? " active" : "");
    el.textContent = f.slice(dir ? dir.length + 1 : 0);
    el.title = f;
    el.onclick = () => openFile(f);
    if (/\.(tex|py|bib|sty|cls|txt|md)$/.test(f)) box.appendChild(el);
  }
}

async function openFile(rel: string) {
  if (!root) return;
  if (dirty) await save();
  const text = await invoke<string>("read_file", { root, rel });
  current = rel;
  dirty = false;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    effects: lang.reconfigure(languageFor(rel)),
  });
  $("tab").textContent = rel;
  if (rel.endsWith(".tex") && text.includes("\\documentclass")) mainFile = rel;
  await refreshFiles();
}

async function save() {
  if (!root || !current) return;
  await invoke("write_file", { root, rel: current, content: view.state.doc.toString() });
  dirty = false;
  $("tab").textContent = current;
}

// ---------- compile + preview ----------
let compiling = false;
async function compile() {
  if (!root || compiling) return;
  compiling = true;
  await save();
  setStatus(`Compiling ${mainFile}…`);
  try {
    const res = await invoke<CompileResult>("compile", { root, main: mainFile });
    logEl.textContent = res.log;
    logEl.hidden = res.ok;
    if (res.ok && res.pdf) {
      await renderPdf(res.pdf);
      setStatus(`Compiled with ${res.engine}`, "ok");
    } else {
      setStatus(`Compile failed (${res.engine})`, "err");
      logEl.scrollTop = logEl.scrollHeight;
    }
  } catch (e) {
    logEl.hidden = false;
    logEl.textContent = String(e);
    setStatus("Compile error", "err");
  } finally {
    compiling = false;
  }
}

async function renderPdf(rel: string) {
  const bytes = await invoke<ArrayBuffer>("read_binary", { root, rel });
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pane = $("pdf-pane");
  const scrollTop = pane.scrollTop; // keep reading position across recompiles
  const box = $("pdf");
  const frag = document.createDocumentFragment();
  const width = box.clientWidth - 24;
  const dpr = window.devicePixelRatio || 1;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width / base.width) * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    canvas.style.width = `${vp.width / dpr}px`;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    frag.appendChild(canvas);
  }
  box.replaceChildren(frag);
  pane.scrollTop = scrollTop;
}

$("btn-open").onclick = openFolder;
$("btn-save").onclick = save;
$("btn-compile").onclick = compile;
