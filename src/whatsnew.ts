// What's New: after an update, the CHANGELOG.md sections since the version last opened on this
// computer (localStorage `scribe.version`). A first install shows nothing; the tour does that job.
import { getVersion } from "@tauri-apps/api/app";
import changelog from "../CHANGELOG.md?raw";
import { $, localKeys } from "./core";
import { renderMarkdown } from "./markdown";

const KEY = "scribe.version";

const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
function newer(a: string, b: string) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The changelog's sections, newest first, as written under each `## X.Y.Z`. */
function sections(): { version: string; notes: string }[] {
  return changelog.split(/^## /m).slice(1).map((chunk) => {
    const nl = chunk.indexOf("\n");
    return { version: chunk.slice(0, nl).trim(), notes: chunk.slice(nl + 1).trim() };
  });
}

/** Open the dialog with the notes of `version` and of every version after `since`. */
function show(version: string, since?: string) {
  const shown = sections().filter((s) => !newer(s.version, version) && (since ? newer(s.version, since) : s.version === version));
  if (!shown.length) return;
  $("whatsnew-version").textContent = version;
  const body = $("whatsnew-notes");
  body.replaceChildren();
  for (const s of shown) {
    if (shown.length > 1) {
      const h = document.createElement("h3");
      h.textContent = s.version;
      body.appendChild(h);
    }
    const notes = document.createElement("div");
    notes.className = "markdown";
    notes.innerHTML = renderMarkdown(localKeys(s.notes)); // sanitised by renderMarkdown
    body.appendChild(notes);
  }
  const dialog = $<HTMLDialogElement>("whatsnew");
  if (!dialog.open) dialog.showModal();
}

/** Help > What's New: this version's notes. */
export async function showWhatsNew() {
  show(await getVersion());
}

/** At start: the notes once, the first time a new version opens. */
export async function whatsNewAfterUpdate() {
  const version = await getVersion();
  let last: string | null = null;
  let usedBefore = false;
  try {
    last = localStorage.getItem(KEY);
    usedBefore = localStorage.getItem("scribe.tour") !== null; // versions before 1.2.2 kept no record
    localStorage.setItem(KEY, version);
  } catch {
    return;
  }
  if (last ? newer(version, last) : usedBefore) setTimeout(() => show(version, last ?? undefined), 600);
}

$("whatsnew-close").onclick = () => $<HTMLDialogElement>("whatsnew").close();
$("whatsnew-ok").onclick = () => $<HTMLDialogElement>("whatsnew").close();
