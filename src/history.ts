// History panel: earlier versions of the open file, which the backend keeps on every save
// (grouped into one per ten-minute sitting). Click a version to see what changed since, and
// restore it with one click; restoring is an ordinary edit, so ⌘Z takes it back.
import { ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { $, changeListeners, current, root, setStatus } from "./core";
import { diffView } from "./git";
import { activeEditor, showInSide } from "./split";

interface Version { id: number; added: number; removed: number; }

const panel = $("history-panel");
const KEPT = /\.(tex|bib|md|py|sty|cls|txt|ipynb)$/i;
let job = 0;

const day = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const time = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day(d) + (d.getFullYear() === today.getFullYear() ? "" : ` ${d.getFullYear()}`);
}

function empty(text: string) {
  const note = document.createElement("div");
  note.className = "empty";
  note.textContent = text;
  panel.replaceChildren(note);
}

/** The open file's text as it is in the editor now, unsaved edits included. */
function currentText(rel: string): string | null {
  const editor = activeEditor();
  return editor && editor.dom.dataset.path === rel ? editor.state.doc.toString() : null;
}

async function showChanges(rel: string, version: Version) {
  try {
    const now = currentText(rel) ?? (await invoke<string>("read_file", { root, rel }));
    const diff = await invoke<string>("history_diff", { root, rel, id: version.id, current: now });
    const when = new Date(version.id * 1000);
    await showInSide(`${rel}: changes since ${dayLabel(when).toLowerCase()} ${time(when)}`, diffView(diff));
  } catch (e) {
    setStatus(`Couldn't show the changes: ${e}`, "err");
  }
}

async function restore(rel: string, version: Version) {
  const when = new Date(version.id * 1000);
  const sure = await ask(`Replace ${rel} with the version from ${dayLabel(when).toLowerCase()} at ${time(when)}?\n\nThe current text is kept as a version too, and ⌘Z undoes this.`, {
    title: "Restore this version",
    kind: "warning",
    okLabel: "Restore",
  });
  if (!sure) return;
  try {
    const text = await invoke<string>("history_read", { root, rel, id: version.id });
    const editor = activeEditor();
    if (!editor || editor.dom.dataset.path !== rel) {
      setStatus(`Open ${rel} to restore it`, "err");
      return;
    }
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, userEvent: "input" });
    setStatus(`Restored the version from ${time(when)}. Save to keep it.`, "ok");
  } catch (e) {
    setStatus(`Couldn't restore it: ${e}`, "err");
  }
}

export async function renderHistory() {
  if (panel.hidden || !root) return;
  const rel = current;
  if (!rel || !KEPT.test(rel)) {
    empty("Open a file to see its earlier versions. Scribe keeps one each time you save, for papers, notes, notebooks and bibliographies.");
    return;
  }
  const mine = ++job;
  let versions: Version[];
  try {
    versions = await invoke<Version[]>("history_list", { root, rel });
  } catch (e) {
    if (mine === job) empty(`Couldn't read the history: ${e}`);
    return;
  }
  if (mine !== job) return;
  if (!versions.length) {
    empty(`No earlier versions of ${rel} yet. One is kept each time you save it.`);
    return;
  }

  const frag = document.createDocumentFragment();
  const intro = document.createElement("p");
  intro.className = "history-intro";
  intro.textContent = `Versions of ${rel}. Click one to see what changed since.`;
  frag.appendChild(intro);
  let lastDay = "";
  for (const version of versions) {
    const when = new Date(version.id * 1000);
    const label = dayLabel(when);
    if (label !== lastDay) {
      const h = document.createElement("h3");
      h.className = "history-day";
      h.textContent = label;
      frag.appendChild(h);
      lastDay = label;
    }
    const row = document.createElement("div");
    row.className = "history-row";
    const pick = document.createElement("button");
    pick.className = "history-pick";
    pick.title = "Show what changed since this version";
    const t = document.createElement("span");
    t.className = "history-time";
    t.textContent = time(when);
    const delta = document.createElement("span");
    delta.className = "history-delta";
    if (version.added) delta.append(Object.assign(document.createElement("span"), { className: "add", textContent: `+${version.added}` }));
    if (version.removed) delta.append(Object.assign(document.createElement("span"), { className: "del", textContent: `−${version.removed}` }));
    pick.append(t, delta);
    pick.onclick = () => showChanges(rel, version);
    const back = document.createElement("button");
    back.className = "btn history-restore";
    back.textContent = "Restore";
    back.onclick = () => restore(rel, version);
    row.append(pick, back);
    frag.appendChild(row);
  }
  panel.replaceChildren(frag);
}

// A different file, or a save (which may add a version), redraws the list.
changeListeners.push(() => {
  if (!panel.hidden) renderHistory();
});
