// The compiled paper: rendering, zoom, page indicator, text search, and SyncTeX jumps between
// a spot in the PDF and its source line.
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { $, clamp, current, root, setStatus } from "./core";
import { view } from "./editor";
import { sizes, togglePane } from "./layout";
import { revealLine } from "./project";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** The PDF being shown, relative to the project root. */
export let lastPdf: string | null = null;

const scroller = $("pdf-scroll");
const box = $("pdf");
const bar = $("pdf-bar");
const pdfEmpty = box.firstElementChild!.cloneNode(true);

let pdfJob = 0;
let pdfDoc: PDFDocumentProxy | null = null;
/** 1 means "fit the pane's width". */
let zoom = 1;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

/** Back to the empty preview, abandoning any render in flight. */
export function resetPdf() {
  lastPdf = null;
  pdfDoc = null;
  pdfJob++;
  zoom = 1;
  matches = [];
  bar.hidden = true;
  box.style.width = "";
  box.replaceChildren(pdfEmpty.cloneNode(true));
}

export async function renderPdf(rel: string) {
  const job = ++pdfJob;
  lastPdf = rel;
  const bytes = await invoke<ArrayBuffer>("read_binary", { root, rel });
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const frag = document.createDocumentFragment();
  // The page column is `zoom` times the pane wide; past 100% the pane scrolls sideways.
  const width = Math.max(200, scroller.clientWidth * zoom - 48);
  const dpr = window.devicePixelRatio || 1;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width / base.width) * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    if (job !== pdfJob) return; // a newer render started
    // The wrapper carries the page's size in PDF points, which SyncTeX and search positions use.
    const sheet = document.createElement("div");
    sheet.className = "pdf-page";
    sheet.dataset.page = String(i);
    sheet.dataset.w = String(base.width);
    sheet.dataset.h = String(base.height);
    sheet.appendChild(canvas);
    frag.appendChild(sheet);
  }

  // Keep the reading position across recompiles and zoom changes, as a fraction of the document.
  const at = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
  pdfDoc = doc;
  box.style.width = zoom === 1 ? "" : `${zoom * 100}%`;
  box.replaceChildren(frag);
  scroller.scrollTop = at * scroller.scrollHeight;
  bar.hidden = false;
  $("pdf-zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  updatePageLabel();
  if ($<HTMLInputElement>("pdf-find").value.trim()) await findInPdf(false);
}

// Re-rasterise at the new width once resizing settles; CSS scales the canvases meanwhile.
let pdfResizeTimer: number | null = null;
export function rerenderPdfSoon() {
  if (pdfResizeTimer) clearTimeout(pdfResizeTimer);
  pdfResizeTimer = window.setTimeout(() => {
    if (lastPdf && root) renderPdf(lastPdf).catch(() => {});
  }, 200);
}
window.addEventListener("resize", rerenderPdfSoon);

// ---------- zoom ----------
export const hasPdf = () => !!root && !!lastPdf;

/** Multiply the zoom, or pass "fit" to return to the pane's width. */
export function zoomPdf(change: number | "fit") {
  if (!hasPdf()) return;
  zoom = change === "fit" ? 1 : clamp(Math.round(zoom * change * 100) / 100, ZOOM_MIN, ZOOM_MAX);
  // Scale the existing pages straight away; the sharp re-render follows.
  box.style.width = zoom === 1 ? "" : `${zoom * 100}%`;
  $("pdf-zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  rerenderPdfSoon();
}

$("pdf-zoom-in").onclick = () => zoomPdf(1.2);
$("pdf-zoom-out").onclick = () => zoomPdf(1 / 1.2);
$("pdf-zoom-label").onclick = () => zoomPdf("fit");

// ---------- page indicator ----------
function updatePageLabel() {
  const pages = [...box.querySelectorAll<HTMLElement>(".pdf-page")];
  if (!pages.length) return;
  // The page under a line 40% down the pane is the one being read.
  const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.4;
  const reading = pages.find((p) => p.getBoundingClientRect().bottom >= line) ?? pages[pages.length - 1];
  $("pdf-page-label").textContent = `Page ${reading.dataset.page} of ${pages.length}`;
}

let labelQueued = false;
scroller.addEventListener("scroll", () => {
  if (labelQueued) return;
  labelQueued = true;
  requestAnimationFrame(() => {
    labelQueued = false;
    updatePageLabel();
  });
});

// ---------- search ----------
let matches: HTMLElement[] = [];
let matchAt = -1;

function showMatch(index: number) {
  matches[matchAt]?.classList.remove("current");
  matchAt = matches.length ? (index + matches.length) % matches.length : -1;
  const count = $("pdf-find-count");
  if (matchAt === -1) {
    count.textContent = $<HTMLInputElement>("pdf-find").value.trim() ? "No matches" : "";
    return;
  }
  const hit = matches[matchAt];
  hit.classList.add("current");
  count.textContent = `${matchAt + 1} of ${matches.length}`;
  const spot = hit.getBoundingClientRect();
  const pane = scroller.getBoundingClientRect();
  if (spot.top < pane.top + 40 || spot.bottom > pane.bottom - 40) {
    scroller.scrollTop += spot.top - pane.top - scroller.clientHeight / 3;
  }
}

/** Marks every occurrence of the query. `jump` moves to the first one after marking. */
async function findInPdf(jump: boolean) {
  const doc = pdfDoc;
  const query = $<HTMLInputElement>("pdf-find").value.trim().toLowerCase();
  const keep = jump ? 0 : Math.max(0, matchAt);
  box.querySelectorAll(".pdf-find-mark").forEach((el) => el.remove());
  matches = [];
  matchAt = -1;
  if (!doc || !query) {
    showMatch(0);
    return;
  }

  for (const sheet of box.querySelectorAll<HTMLElement>(".pdf-page")) {
    const w = Number(sheet.dataset.w);
    const h = Number(sheet.dataset.h);
    const content = await (await doc.getPage(Number(sheet.dataset.page))).getTextContent();
    if (doc !== pdfDoc) return; // recompiled while searching
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      const text = item.str.toLowerCase();
      // PDF text runs carry one box per run, so a match inside a run is placed by character share.
      const [, , skewX, scaleY, x, baseline] = item.transform as number[];
      const size = Math.hypot(skewX, scaleY) || item.height || 10;
      for (let from = text.indexOf(query); from !== -1; from = text.indexOf(query, from + query.length)) {
        const mark = document.createElement("div");
        mark.className = "pdf-find-mark";
        mark.style.left = `${((x + item.width * (from / text.length)) / w) * 100}%`;
        mark.style.width = `${((item.width * (query.length / text.length)) / w) * 100}%`;
        mark.style.top = `${((h - baseline - size * 0.85) / h) * 100}%`;
        mark.style.height = `${((size * 1.1) / h) * 100}%`;
        sheet.appendChild(mark);
        matches.push(mark);
      }
    }
  }
  showMatch(keep);
}

let findTimer: number | null = null;
$("pdf-find").addEventListener("input", () => {
  if (findTimer) clearTimeout(findTimer);
  findTimer = window.setTimeout(() => findInPdf(true), 200);
});
$("pdf-find").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    showMatch(matchAt + (e.shiftKey ? -1 : 1));
  } else if (e.key === "Escape") {
    e.stopPropagation();
    $<HTMLInputElement>("pdf-find").value = "";
    findInPdf(false);
    view.focus();
  }
});

export function focusPdfFind() {
  if (!hasPdf()) return;
  if (sizes.hidePreview) togglePane("preview");
  const input = $<HTMLInputElement>("pdf-find");
  input.focus();
  input.select();
}

// ---------- SyncTeX: PDF <-> source ----------
interface SourceSpot { file: string; line: number; }
interface PdfSpot { page: number; x: number; y: number; width: number; height: number; }

// Double-click a spot in the PDF to open the source line that produced it.
box.addEventListener("dblclick", async (e) => {
  const sheet = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page");
  if (!sheet || !root || !lastPdf) return;
  const rect = sheet.getBoundingClientRect();
  const pointsPerPixel = Number(sheet.dataset.w) / rect.width;
  try {
    const spot = await invoke<SourceSpot>("synctex_edit", {
      root,
      pdf: lastPdf,
      page: Number(sheet.dataset.page),
      x: (e.clientX - rect.left) * pointsPerPixel,
      y: (e.clientY - rect.top) * pointsPerPixel,
    });
    await revealLine(spot.file, spot.line);
  } catch (err) {
    setStatus(String(err), "err");
  }
});

export const canShowInPdf = () => hasPdf() && !!current?.endsWith(".tex") && !$("editor").hidden;

/** Scrolls the preview to where the cursor's line landed and marks it briefly. */
export async function showInPdf() {
  if (!canShowInPdf()) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  try {
    const spot = await invoke<PdfSpot>("synctex_view", { root, pdf: lastPdf, file: current, line });
    if (sizes.hidePreview) togglePane("preview");
    const sheet = box.querySelector<HTMLElement>(`.pdf-page[data-page="${spot.page}"]`);
    if (!sheet) return;
    const w = Number(sheet.dataset.w);
    const h = Number(sheet.dataset.h);

    sheet.querySelector(".pdf-mark")?.remove();
    const mark = document.createElement("div");
    mark.className = "pdf-mark";
    mark.style.left = `${(spot.x / w) * 100}%`;
    mark.style.top = `${(spot.y / h) * 100}%`;
    mark.style.width = `${(spot.width / w) * 100}%`;
    mark.style.height = `${(Math.max(spot.height, 8) / h) * 100}%`;
    sheet.appendChild(mark);

    const rect = sheet.getBoundingClientRect();
    scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top + (spot.y / h) * rect.height - scroller.clientHeight / 3;
    setTimeout(() => mark.classList.add("fading"), 900);
    setTimeout(() => mark.remove(), 1700);
  } catch (err) {
    setStatus(String(err), "err");
  }
}
