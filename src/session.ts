// Remembers, per project, what was open: tabs, the active file, cursor positions, the side
// pane and the sidebar panel. Opening the project again puts it all back.
import { $, current, root } from "./core";
import { view } from "./editor";
import { EditorView } from "codemirror";
import { openFile } from "./project";
import { collapsedDirs, currentSidebarTab, showSidebar, SidebarTab } from "./sidebar";
import { openToSide, sideFile } from "./split";
import { openTabs, setOpenTabs } from "./tabs";

interface Session {
  tabs: string[];
  active: string | null;
  side: string | null;
  sidebar: SidebarTab;
  /** Cursor offset per file. */
  cursors: Record<string, number>;
  collapsed: string[];
}

const key = (project: string) => `scribe.session:${project}`;
let cursors: Record<string, number> = {};
let restoring = false;

/** Note where the cursor is in the file showing in the main editor. */
export function rememberCursor() {
  if (current && !$("editor").hidden) cursors[current] = view.state.selection.main.head;
}

export function saveSession() {
  if (!root || restoring) return;
  rememberCursor();
  const session: Session = {
    tabs: openTabs,
    active: current,
    side: sideFile,
    sidebar: currentSidebarTab,
    cursors: Object.fromEntries(Object.entries(cursors).filter(([file]) => openTabs.includes(file))),
    collapsed: [...collapsedDirs],
  };
  try { localStorage.setItem(key(root), JSON.stringify(session)); } catch {}
}

let timer: number | null = null;

/** For callers that fire often: one save after things settle. */
export function saveSessionSoon() {
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(saveSession, 400);
}

/** Put the project back as it was left. Returns false when there is nothing to restore. */
export async function restoreSession(files: string[]): Promise<boolean> {
  if (!root) return false;
  let session: Session | null = null;
  try { session = JSON.parse(localStorage.getItem(key(root)) ?? "null"); } catch {}
  cursors = {};
  const exists = (file: string | null): file is string => !!file && files.includes(file);
  const tabs = (session?.tabs ?? []).filter(exists);
  if (!session || !tabs.length) return false;

  restoring = true; // opening files below must not save a half-restored session over the real one
  try {
    cursors = session.cursors ?? {};
    collapsedDirs.clear();
    for (const dir of session.collapsed ?? []) collapsedDirs.add(dir);
    setOpenTabs(tabs);
    const active = exists(session.active) ? session.active : tabs[tabs.length - 1];
    await openFile(active);
    restoreCursor(active);
    if (exists(session.side) && session.side !== active) await openToSide(session.side);
    // a tab saved by an older version may no longer exist
    if (session.sidebar && session.sidebar !== "files" && document.getElementById(`tab-${session.sidebar}`)) showSidebar(session.sidebar);
  } finally {
    restoring = false;
  }
  return true;
}

/** Move the cursor back to where it was the last time this file was open. */
export function restoreCursor(file: string) {
  const at = cursors[file];
  if (at === undefined || $("editor").hidden || current !== file) return;
  const pos = Math.min(at, view.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
}

// Closing the window is the last chance to record where things were.
window.addEventListener("pagehide", saveSession);
