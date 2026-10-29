// Reading papers: a PDF in papers/ opens in a reader where text can be selected and highlighted.
// Highlights are kept in .scribe/highlights/<pdf>.json and also written into the paper's note
// (notes/<name>.md) as quotes with a link back to their page.
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import { baseName, root, setStatus } from "./core";
import { openContextMenu } from "./menubar";
import { editNote, ensureCitationNote } from "./notes";
import { appearance } from "./appearance";
import { picturesLayer } from "./darkpdf";

export const isPaper = (rel: string) => /^papers\/.+\.pdf$/i.test(rel);

/** One highlight: rectangles as fractions of the page, so they fit at any zoom. */
interface Highlight { id: string; page: number; text: string; rects: [number, number, number, number][]; }

const store = (rel: string) => `.scribe/highlights/${rel}.json`;
let shown: { rel: string; marks: Highlight[]; box: HTMLElement } | null = null;
let wantedPage: number | null = null;

/** The next paper opened scrolls to this page (a link from a note). */
export function readAtPage(page: number) {
  wantedPage = page;
  if (shown) scrollToPage(shown.box, page);
}

function scrollToPage(box: HTMLElement, page: number) {
  const sheet = box.querySelector<HTMLElement>(`.reader-page[data-page="${page}"]`);
  if (!sheet) return;
  sheet.scrollIntoView({ block: "start" });
  wantedPage = null;
}

async function loadMarks(rel: string): Promise<Highlight[]> {
  try {
    return JSON.parse(await invoke<string>("read_file", { root, rel: store(rel) }));
  } catch {
    return [];
  }
}

async function saveMarks(rel: string, marks: Highlight[]) {
  await invoke("write_file", { root, rel: store(rel), content: JSON.stringify(marks, null, 1) });
}

function drawMarks(box: HTMLElement, marks: Highlight[]) {
  for (const old of box.querySelectorAll(".reader-mark")) old.remove();
  for (const mark of marks) {
    const sheet = box.querySelector<HTMLElement>(`.reader-page[data-page="${mark.page}"]`);
    if (!sheet) continue;
    for (const [x, y, w, h] of mark.rects) {
      const el = document.createElement("div");
      el.className = "reader-mark";
      el.dataset.id = mark.id;
      el.style.left = `${x * 100}%`;
      el.style.top = `${y * 100}%`;
      el.style.width = `${w * 100}%`;
      el.style.height = `${h * 100}%`;
      el.title = "Right-click to remove";
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          { title: "Copy Text", run: () => { navigator.clipboard.writeText(mark.text).catch(() => {}); } },
          { title: "Remove Highlight", run: () => removeMark(mark.id) },
        ]);
      });
      sheet.appendChild(el);
    }
  }
}

async function removeMark(id: string) {
  if (!shown) return;
  shown.marks = shown.marks.filter((m) => m.id !== id);
  drawMarks(shown.box, shown.marks);
  await saveMarks(shown.rel, shown.marks);
}

/** Render a paper with selectable text and its highlights into `box`. `stale()` is true once
 *  something else has been opened, so a slow render stops. */
export async function openReader(rel: string, bytes: Uint8Array, box: HTMLElement, stale: () => boolean) {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const marks = await loadMarks(rel);
  const width = Math.max(320, Math.min(box.clientWidth - 48, 980));
  const dpr = window.devicePixelRatio || 1;
  const column = document.createElement("div");
  column.className = "reader";
  const hint = document.createElement("p");
  hint.className = "reader-hint";
  hint.textContent = `Select text to highlight it. Highlights go into notes/${baseName(rel).replace(/\.pdf$/i, "")}.md with their page.`;
  column.appendChild(hint);
  box.replaceChildren(column);
  shown = { rel, marks, box };
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    if (stale()) return;
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const vp = page.getViewport({ scale: scale * dpr });
    const sheet = document.createElement("div");
    sheet.className = "reader-page";
    sheet.dataset.page = String(i);
    sheet.style.width = `${width}px`;
    sheet.style.height = `${base.height * scale}px`;
    sheet.style.setProperty("--scale-factor", String(scale));
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    sheet.appendChild(canvas);
    const layer = document.createElement("div");
    layer.className = "textLayer";
    sheet.appendChild(layer);
    column.appendChild(sheet);
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    if (appearance.pdfDark) {
      const pictures = await picturesLayer(canvas, page, vp).catch(() => null);
      if (pictures) sheet.insertBefore(pictures, layer);
    }
    await new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport: page.getViewport({ scale }) }).render();
    if (stale()) return;
    drawMarks(box, marks);
    if (wantedPage === i) scrollToPage(box, i);
  }
}

export function closeReader() {
  shown = null;
  button.hidden = true;
}

// ---------- highlighting a selection ----------
const button = document.createElement("button");
button.className = "btn btn-primary reader-highlight";
button.textContent = "Highlight";
button.hidden = true;
document.body.appendChild(button);

function selectionInReader(): Range | null {
  const sel = getSelection();
  if (!shown || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  return el && shown.box.contains(el) && el.closest(".reader") ? range : null;
}

document.addEventListener("selectionchange", () => {
  const range = selectionInReader();
  if (!range || !range.toString().trim()) {
    button.hidden = true;
    return;
  }
  const r = range.getBoundingClientRect();
  button.style.left = `${Math.min(window.innerWidth - 110, r.right - 40)}px`;
  button.style.top = `${r.bottom + 8}px`;
  button.hidden = false;
});

button.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection

button.onclick = async () => {
  const range = selectionInReader();
  if (!range || !shown) return;
  const text = range.toString().replace(/\s+/g, " ").trim();
  // Each line's rectangle, as a fraction of the page it lies on.
  const sheets = [...shown.box.querySelectorAll<HTMLElement>(".reader-page")];
  const rects: [number, number, number, number][] = [];
  let page = 0;
  for (const r of range.getClientRects()) {
    if (r.width < 2 || r.height < 2) continue;
    const sheet = sheets.find((s) => {
      const b = s.getBoundingClientRect();
      return r.top + r.height / 2 >= b.top && r.top + r.height / 2 <= b.bottom;
    });
    if (!sheet) continue;
    const b = sheet.getBoundingClientRect();
    page ||= Number(sheet.dataset.page);
    if (Number(sheet.dataset.page) !== page) continue; // one highlight stays on one page
    rects.push([(r.left - b.left) / b.width, (r.top - b.top) / b.height, r.width / b.width, r.height / b.height]);
  }
  if (!rects.length || !page) return;
  const mark: Highlight = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, page, text, rects };
  const rel = shown.rel;
  shown.marks.push(mark);
  drawMarks(shown.box, shown.marks);
  getSelection()?.removeAllRanges();
  button.hidden = true;
  try {
    await saveMarks(rel, shown.marks);
    // ...and the quote, with its page, in the paper's note
    const key = baseName(rel).replace(/\.pdf$/i, "");
    const note = await ensureCitationNote(key);
    const quote = `> ${text}\n>\n> [p. ${page}](../${encodeURI(rel)}#page=${page})\n`;
    // at the end of the note's Highlights section, which is started if there isn't one
    await editNote(note, (body) => {
      const heading = /^## Highlights[ \t]*$/m.exec(body);
      if (!heading) return `${body.trimEnd()}\n\n## Highlights\n\n${quote}`;
      const after = heading.index + heading[0].length;
      const next = body.slice(after).search(/^#{1,2} /m);
      const end = next < 0 ? body.length : after + next;
      return `${body.slice(0, end).trimEnd()}\n\n${quote}${next < 0 ? "" : "\n"}${body.slice(end)}`;
    });
    setStatus(`Highlighted on page ${page}, and added to ${note}`, "ok");
  } catch (e) {
    setStatus(`Couldn't save the highlight: ${e}`, "err");
  }
};
