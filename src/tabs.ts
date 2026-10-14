// Open-file tabs. Each text tab keeps its own editor state (undo history, cursor, scroll)
// while another file is showing.
import { EditorState } from "@codemirror/state";
import { $, assignDirty, baseName, changeListeners, current, dirty, renderCrumb, setCurrent } from "./core";
import { view } from "./editor";
import { ICONS } from "./icons";
import { leaveNotebook } from "./notebook";
import { openFile, save, setMainView } from "./project";
import { rememberCursor, saveSessionSoon } from "./session";
import { FILE_ICON, refreshFiles } from "./sidebar";

export let openTabs: string[] = [];

/** Replace the set of tabs (restoring a session). */
export function setOpenTabs(tabs: string[]) {
  openTabs = [...tabs];
  renderTabs();
}

interface Stashed { state: EditorState; scroll: number; }
const stashed = new Map<string, Stashed>();

/** Remember the text editor's state for the file being left. */
export function stashEditor() {
  if (current && !$("editor").hidden) {
    stashed.set(current, { state: view.state, scroll: view.scrollDOM.scrollTop });
    rememberCursor();
  }
}

/** The stashed state for `rel`, but only if it still matches the file on disk. */
export function takeStashed(rel: string, text: string): Stashed | null {
  const hit = stashed.get(rel);
  stashed.delete(rel);
  return hit && hit.state.doc.toString() === text ? hit : null;
}

export function noteOpened(rel: string) {
  if (!openTabs.includes(rel)) openTabs.push(rel);
  renderTabs();
}

export function renderTabs() {
  const bar = $("tabs");
  bar.hidden = openTabs.length === 0;
  const names = openTabs.map(baseName);
  const frag = document.createDocumentFragment();
  for (const rel of openTabs) {
    const name = baseName(rel);
    const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
    const active = rel === current;

    const tab = document.createElement("div");
    tab.className = "tab" + (active ? " active" : "") + (active && dirty ? " dirty" : "");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(active));
    tab.title = rel;

    const pick = document.createElement("button");
    pick.className = "tab-pick";
    const icon = document.createElement("span");
    icon.className = `file-icon file-${FILE_ICON[ext] === FILE_ICON.image ? "image" : ext in FILE_ICON ? ext : "text"}`;
    icon.innerHTML = FILE_ICON[ext] ?? FILE_ICON.text;
    const label = document.createElement("span");
    label.className = "tab-name";
    label.textContent = name;
    pick.append(icon, label);
    // Two open files with the same name: show which folder each is in.
    if (names.filter((n) => n === name).length > 1 && rel.includes("/")) {
      const dir = document.createElement("span");
      dir.className = "tab-dir";
      dir.textContent = rel.slice(0, rel.lastIndexOf("/"));
      pick.appendChild(dir);
    }
    pick.onclick = () => { if (!active) openFile(rel); };

    const close = document.createElement("button");
    close.className = "tab-close";
    close.innerHTML = ICONS.close;
    close.title = "Close (⌘W)";
    close.setAttribute("aria-label", `Close ${name}`);
    close.onclick = () => closeTab(rel);

    tab.append(pick, close);
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) closeTab(rel); // middle click
    });
    frag.appendChild(tab);
  }
  bar.replaceChildren(frag);
  saveSessionSoon();
  bar.querySelector(".tab.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** Nothing is open: empty pane with a hint. */
export function showNoFile() {
  setCurrent(null);
  assignDirty(false);
  leaveNotebook();
  setMainView("none");
  renderCrumb();
  refreshFiles();
}

export async function closeTab(rel: string) {
  const at = openTabs.indexOf(rel);
  if (at === -1) return;
  if (rel !== current) {
    openTabs.splice(at, 1);
    stashed.delete(rel);
    renderTabs();
    return;
  }
  if (dirty) await save();
  const next = openTabs[at + 1] ?? openTabs[at - 1];
  openTabs.splice(at, 1);
  if (next) await openFile(next);
  else showNoFile();
  stashed.delete(rel); // openFile stashed the file we were leaving
  renderTabs();
}

/** Files that no longer exist (deleted): close their tabs without saving them back. */
export async function dropTabs(gone: (rel: string) => boolean) {
  const wasCurrent = !!current && gone(current);
  openTabs = openTabs.filter((rel) => !gone(rel));
  for (const rel of [...stashed.keys()]) if (gone(rel)) stashed.delete(rel);
  if (!wasCurrent) {
    renderTabs();
    return;
  }
  setCurrent(null);
  assignDirty(false);
  const next = openTabs[openTabs.length - 1];
  if (next) await openFile(next);
  else showNoFile();
}

/** Files that moved or were renamed keep their tab. */
export function renameTabs(moved: (rel: string) => string) {
  openTabs = openTabs.map(moved);
  for (const [rel, state] of [...stashed]) {
    const to = moved(rel);
    if (to !== rel) {
      stashed.delete(rel);
      stashed.set(to, state);
    }
  }
  renderTabs();
}

export function resetTabs() {
  openTabs = [];
  stashed.clear();
  renderTabs();
}

// The active tab shows the unsaved dot, so it redraws whenever the title bar does.
changeListeners.push(renderTabs);
