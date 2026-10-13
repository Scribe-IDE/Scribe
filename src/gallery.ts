// Figures panel: every figure and exported value the notebooks produce, whether it is up to
// date, and whether the paper uses it.
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import { $, root, setStatus, showLog } from "./core";
import { ICONS } from "./icons";
import { insertFigureIntoPaper } from "./notebook";
import { openFile } from "./project";
import { refreshFiles } from "./sidebar";
import { displayValue, FigureEntry, refreshIndex, ValueEntry } from "./texindex";
import { RunResult } from "./types";

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
  } catch {
    if (mine === job) holder.textContent = "Not generated yet";
  }
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

function figureCard(fig: FigureEntry, mine: number): HTMLElement {
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
  if (!index.figures.length && !index.values.length) {
    frag.appendChild(note("No figures yet. Add a Figure cell to a notebook and it shows up here, with its status in the paper."));
  }
  if (index.figures.length) {
    frag.appendChild(heading("Figures"));
    for (const fig of index.figures) frag.appendChild(figureCard(fig, mine));
  }
  if (index.values.length) {
    frag.appendChild(heading("Values"));
    for (const value of index.values) frag.appendChild(valueRow(value));
  }
  panel.replaceChildren(frag);
}
