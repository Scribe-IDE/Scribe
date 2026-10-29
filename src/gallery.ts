// Figures panel: every figure and exported value the notebooks produce, whether it is up to
// date, and whether the paper uses it.
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import { $, baseName, mainFile, root, setStatus, showLog } from "./core";
import { view } from "./editor";
import { ICONS } from "./icons";
import { insertFigureIntoPaper } from "./notebook";
import { openFile, revealLine } from "./project";
import { refreshFiles } from "./sidebar";
import { displayValue, FigureEntry, refreshIndex, RunInfo, TikzEntry, ValueEntry } from "./texindex";
import { openTikzPreview } from "./tikz";
import { previewDocument, snippetName } from "./tikzsource";
import { CompileResult, RunResult } from "./types";

let job = 0;

function note(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "empty";
  el.textContent = text;
  return el;
}

function heading(text: string): HTMLElement {
  const el = document.createElement("h3");
  el.className = "gallery-heading";
  el.textContent = text;
  return el;
}

function badge(text: string, kind: string, title: string): HTMLElement {
  const el = document.createElement("span");
  el.className = `gallery-badge ${kind}`;
  el.textContent = text;
  el.title = title;
  return el;
}

// First page of figures/<id>.pdf, drawn small.
async function drawThumb(holder: HTMLElement, id: string, mine: number) {
  try {
    const bytes = new Uint8Array(await invoke<ArrayBuffer>("read_binary", { root, rel: `figures/${id}.pdf` }));
    await drawPdf(holder, bytes, mine);
  } catch {
    if (mine === job) holder.textContent = "Not generated yet";
  }
}

/** Page one of a PDF, as wide as `holder`. */
async function drawPdf(holder: HTMLElement, bytes: Uint8Array, mine: number) {
  const page = await (await pdfjs.getDocument({ data: bytes }).promise).getPage(1);
  const base = page.getViewport({ scale: 1 });
  const cssWidth = Math.max(120, holder.clientWidth || 200);
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: (cssWidth / base.width) * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
  if (mine === job) holder.replaceChildren(canvas);
}

// ---------- TikZ pictures ----------
/** Preview documents that didn't compile, so they aren't tried again on every refresh. */
const failedSnippets = new Set<string>();
/** Thumbnails compile one at a time, behind the live preview rather than beside it. */
let thumbQueue: Promise<void> = Promise.resolve();

/** The picture compiled on its own (cached by its source in build/tikz/), as PDF bytes. */
export async function tikzPdf(picture: string, paper: string): Promise<Uint8Array | null> {
  for (const minimal of [false, true]) {
    const { source } = previewDocument(paper, picture, minimal);
    const name = snippetName(source);
    if (failedSnippets.has(name)) continue;
    const rel = `build/tikz/${name}.pdf`;
    const cached = await invoke<ArrayBuffer>("read_binary", { root, rel }).catch(() => null);
    if (cached) return new Uint8Array(cached);
    const result = await invoke<CompileResult>("compile_snippet", { root, source, name }).catch(() => null);
    if (result?.ok && result.pdf) return new Uint8Array(await invoke<ArrayBuffer>("read_binary", { root, rel: result.pdf }));
    failedSnippets.add(name);
  }
  return null;
}

function tikzCard(entry: TikzEntry, mine: number, paper: Promise<string>): HTMLElement {
  const card = document.createElement("div");
  card.className = "gallery-card";
  const where = `${entry.file}:${entry.line}`;
  const show = async () => {
    await revealLine(entry.file, entry.line);
    if (!$("editor").hidden) openTikzPreview(view);
  };

  const thumb = document.createElement("button");
  thumb.className = "gallery-thumb";
  thumb.title = `Show ${where} with its preview`;
  thumb.onclick = show;
  card.appendChild(thumb);

  const row = document.createElement("div");
  row.className = "gallery-row";
  const id = document.createElement("span");
  id.className = "gallery-id";
  id.textContent = entry.label ?? `${baseName(entry.file)}, line ${entry.line}`;
  id.title = entry.caption ?? id.textContent;
  row.appendChild(id);
  card.appendChild(row);

  const actions = document.createElement("div");
  actions.className = "gallery-row";
  const source = document.createElement("button");
  source.className = "gallery-source";
  source.textContent = where;
  source.title = `Show ${where} with its preview`;
  source.onclick = show;
  actions.appendChild(source);
  card.appendChild(actions);

  requestAnimationFrame(() => {
    thumbQueue = thumbQueue.then(async () => {
      if (mine !== job) return;
      const pdf = await tikzPdf(entry.source, await paper);
      if (mine !== job) return;
      if (pdf) await drawPdf(thumb, pdf, mine);
      else thumb.textContent = "Doesn't compile yet";
    }).catch(() => {});
  });
  return card;
}

async function rerun(notebook: string, button: HTMLButtonElement) {
  if (!root) return;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  setStatus(`Running ${notebook}…`, "busy");
  try {
    const res = await invoke<RunResult>("run_notebook", { root, rel: notebook });
    if (res.ok) {
      await invoke("generate_style", { root }).catch(() => {});
      setStatus(`${notebook} ran`, "ok");
    } else {
      showLog(`Notebook log: ${notebook}`, res.log);
      setStatus(`${notebook} failed`, "err");
    }
  } catch (e) {
    showLog(`Notebook log: ${notebook}`, String(e));
    setStatus(`Couldn't run ${notebook}`, "err");
  }
  refreshFiles();
  await renderGallery();
}

function figureCard(fig: FigureEntry, mine: number, lastRun?: RunInfo): HTMLElement {
  const card = document.createElement("div");
  card.className = "gallery-card";

  const thumb = document.createElement("button");
  thumb.className = "gallery-thumb";
  thumb.title = `Open figures/${fig.id}.pdf`;
  thumb.onclick = () => openFile(`figures/${fig.id}.pdf`).catch(() => {});
  card.appendChild(thumb);

  const row = document.createElement("div");
  row.className = "gallery-row";
  const id = document.createElement("span");
  id.className = "gallery-id";
  id.textContent = fig.id;
  id.title = fig.id;
  row.appendChild(id);
  if (fig.stale) row.appendChild(badge("Out of date", "stale", "The notebook changed after this figure was made. It reruns on the next compile."));
  if (!fig.used) row.appendChild(badge("Not in paper", "unused", "No .tex file includes this figure yet."));
  card.appendChild(row);

  const actions = document.createElement("div");
  actions.className = "gallery-row";
  const source = document.createElement("button");
  source.className = "gallery-source";
  source.textContent = fig.notebook;
  source.title = `Open ${fig.notebook}`;
  source.onclick = () => openFile(fig.notebook);
  actions.appendChild(source);
  // When and from which commit this figure was last produced.
  if (lastRun) {
    source.title = `Open ${fig.notebook}. Last run ${lastRun.date}${lastRun.commit ? `, commit ${lastRun.commit}` : ""}, Python ${lastRun.python}`;
    const when = document.createElement("span");
    when.className = "gallery-run";
    when.textContent = lastRun.date.slice(5);
    when.title = source.title;
    actions.appendChild(when);
  }

  if (!fig.used) {
    const insert = document.createElement("button");
    insert.className = "btn gallery-action";
    insert.textContent = "Insert";
    insert.title = "Add this figure to the main .tex file";
    insert.onclick = async () => {
      await insertFigureIntoPaper({ cell_type: "figure", source: "", figure_id: fig.id });
      renderGallery();
    };
    actions.appendChild(insert);
  }
  const run = document.createElement("button");
  run.className = "icon-btn gallery-action";
  run.innerHTML = ICONS.rerun;
  run.title = `Rerun ${fig.notebook}`;
  run.setAttribute("aria-label", `Rerun ${fig.notebook}`);
  run.onclick = () => rerun(fig.notebook, run);
  actions.appendChild(run);
  card.appendChild(actions);

  // Deferred so the card has a width to size the thumbnail from.
  requestAnimationFrame(() => drawThumb(thumb, fig.id, mine));
  return card;
}

function valueRow(value: ValueEntry): HTMLElement {
  const row = document.createElement("button");
  row.className = "gallery-value";
  row.title = `\\nbval{${value.name}}, set in ${value.notebook}`;
  row.onclick = () => openFile(value.notebook);
  const name = document.createElement("span");
  name.className = "gallery-id";
  name.textContent = value.name;
  const shown = document.createElement("span");
  shown.className = "gallery-value-text";
  shown.textContent = displayValue(value.value);
  row.append(name, shown);
  if (!value.used) row.appendChild(badge("Not in paper", "unused", `No .tex file uses \\nbval{${value.name}} yet.`));
  return row;
}

export async function renderGallery() {
  const panel = $("figures-panel");
  const mine = ++job;
  if (!panel.childElementCount) panel.replaceChildren(note("Looking through the notebooks…"));
  const index = await refreshIndex();
  if (mine !== job) return;

  const frag = document.createDocumentFragment();
  if (!index.figures.length && !index.values.length && !index.tikz.length) {
    frag.appendChild(note("No figures yet. Add a Figure cell to a notebook and it shows up here, with its status in the paper."));
  }
  if (index.figures.length) {
    frag.appendChild(heading("Figures"));
    for (const fig of index.figures) frag.appendChild(figureCard(fig, mine, index.runs[fig.notebook]));
  }
  if (index.tikz.length) {
    frag.appendChild(heading("TikZ"));
    const paper = invoke<string>("read_file", { root, rel: mainFile }).catch(() => "");
    for (const entry of index.tikz) frag.appendChild(tikzCard(entry, mine, paper));
  }
  if (index.values.length) {
    frag.appendChild(heading("Values"));
    for (const value of index.values) frag.appendChild(valueRow(value));
  }
  panel.replaceChildren(frag);
}
