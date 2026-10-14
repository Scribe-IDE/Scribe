// Outline panel: the paper's headings, figures and tables as a tree, following \input files.
import { invoke } from "@tauri-apps/api/core";
import { $, changeListeners, current, mainFile, root } from "./core";
import { view } from "./editor";
import { ICONS } from "./icons";
import { revealLine } from "./project";
import { OutlineItem, scanOutline } from "./texindex";

interface Entry extends OutlineItem { file: string; }

const panel = $("outline-panel");
const toggle = $("outline-toggle");
const OPEN_KEY = "scribe.outline";
let job = 0;

/** Drawn only while it can be seen: the file tree is showing and the section is expanded. */
const visible = () => !panel.hidden && !$("files-panel").hidden;

export function showOutline(open: boolean) {
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  $("file-outline").classList.toggle("collapsed", !open);
  try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch {}
  if (open) renderOutline();
}

toggle.onclick = () => showOutline(panel.hidden);

// The open file's text comes from the editor, so the outline tracks unsaved edits.
async function textOf(rel: string): Promise<string> {
  if (rel === current && !$("editor").hidden) return view.state.doc.toString();
  return invoke<string>("read_file", { root, rel }).catch(() => "");
}

async function collect(rel: string, depth: number, seen: Set<string>): Promise<Entry[]> {
  if (seen.has(rel) || depth > 4) return []; // a file that inputs itself, or absurd nesting
  seen.add(rel);
  const out: Entry[] = [];
  for (const item of scanOutline(await textOf(rel))) {
    if (item.kind !== "input") {
      out.push({ ...item, file: rel });
      continue;
    }
    const target = /\.\w+$/.test(item.title) ? item.title : `${item.title}.tex`;
    out.push(...(await collect(target.replace(/^\.\//, ""), depth + 1, seen)));
  }
  return out;
}

export async function renderOutline() {
  if (!visible() || !root) return;
  const mine = ++job;
  // The paper as a whole when there is one; otherwise whatever .tex file is open.
  const start = mainFile && (await textOf(mainFile)) ? mainFile : current?.endsWith(".tex") ? current : null;
  const entries = start ? await collect(start, 0, new Set()) : [];
  if (mine !== job) return;

  if (!entries.length) {
    const note = document.createElement("div");
    note.className = "empty";
    note.textContent = "No sections yet. Headings like \\section{…} in the paper show up here.";
    panel.replaceChildren(note);
    return;
  }

  const top = Math.min(...entries.filter((e) => e.kind === "heading").map((e) => e.level), 9);
  const frag = document.createDocumentFragment();
  let depth = 0;
  for (const entry of entries) {
    if (entry.kind === "heading") depth = entry.level - top;
    const row = document.createElement("button");
    row.className = `outline-row outline-${entry.kind}`;
    // Figures and tables sit one step inside the heading they belong to.
    row.style.paddingLeft = `${8 + 12 * Math.max(0, entry.kind === "heading" ? depth : depth + 1)}px`;
    row.title = `${entry.file}:${entry.line}`;
    if (entry.kind !== "heading") {
      const icon = document.createElement("span");
      icon.className = "outline-icon";
      icon.innerHTML = entry.kind === "figure" ? ICONS.figure : ICONS.table;
      row.appendChild(icon);
    }
    const label = document.createElement("span");
    label.className = "outline-label";
    label.textContent = entry.title;
    row.appendChild(label);
    row.onclick = () => revealLine(entry.file, entry.line);
    frag.appendChild(row);
  }
  panel.replaceChildren(frag);
}

let timer: number | null = null;

/** The paper may have changed: redraw once typing pauses (no-op while the panel is hidden). */
export function outlineChanged() {
  if (!visible()) return;
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(() => {
    renderOutline().catch(() => {});
  }, 400);
}

changeListeners.push(outlineChanged);

// Collapsed stays collapsed between launches.
try {
  if (localStorage.getItem(OPEN_KEY) === "0") showOutline(false);
} catch {}
