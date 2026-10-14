// References: the bibliography as a list, and adding an entry from a DOI or an arXiv ID.
import { invoke } from "@tauri-apps/api/core";
import { $, current, dirty, root, setStatus } from "./core";
import { COMMAND_ICONS, ICONS } from "./icons";
import { openCitationNote } from "./notes";
import { pickFromZotero } from "./zotero";
import { promptInput } from "./palette";
import { listFiles, openFile, revealLine, save } from "./project";
import { activeEditor } from "./split";
import { refreshIndex, scanBib } from "./texindex";

interface Citation { key: string; bibtex: string; }

const panel = $("references-panel");
let job = 0;

/** Put \cite{key} at the cursor, if the cursor is in a LaTeX file. */
function insertCite(key: string): boolean {
  const editor = activeEditor();
  if (!editor || !editor.dom.dataset.path?.endsWith(".tex")) return false;
  const { from, to } = editor.state.selection.main;
  const text = `\\cite{${key}}`;
  editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input" });
  editor.focus();
  return true;
}

// Adds the entry to the project's .bib file (the first one, or a new refs.bib) and returns
// the key it ended up with.
export async function addToBibliography(citation: Citation): Promise<{ key: string; file: string; added: boolean }> {
  const file = (await listFiles()).find((f) => f.endsWith(".bib")) ?? "refs.bib";
  if (current === file && dirty) await save();
  const text = await invoke<string>("read_file", { root, rel: file }).catch(() => "");

  // The same paper twice helps nobody: match on DOI or arXiv number.
  const id = /(?:doi|eprint)\s*=\s*\{([^{}]+)\}/i.exec(citation.bibtex)?.[1];
  if (id) {
    const starts = [...text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)];
    for (let i = 0; i < starts.length; i++) {
      const body = text.slice(starts[i].index!, starts[i + 1]?.index ?? text.length);
      if (body.toLowerCase().includes(id.toLowerCase())) return { key: starts[i][1], file, added: false };
    }
  }

  const taken = new Set(scanBib(text).map((e) => e.key));
  let key = citation.key;
  for (let n = 0; taken.has(key); n++) key = citation.key + "abcdefghijklmnopqrstuvwxyz"[n];
  const entry = citation.bibtex.replace(`{${citation.key},`, `{${key},`);
  await invoke("write_file", { root, rel: file, content: (text.trimEnd() ? text.trimEnd() + "\n\n" : "") + entry });
  if (current === file) await openFile(file); // show the new entry in the open file
  return { key, file, added: true };
}

/** Add a paper from the Zotero library to the bibliography, and cite it at the cursor. */
export function addFromZotero() {
  if (!root) return;
  pickFromZotero(async (item) => {
    try {
      const { key, file, added } = await addToBibliography(item);
      const cited = insertCite(key);
      setStatus(`${added ? `Added ${key} to ${file}` : `${key} is already in ${file}`}${cited ? " and cited it" : ""}`, "ok");
      await refreshIndex();
      renderReferences();
    } catch (e) {
      setStatus(String(e), "err");
    }
  });
}

export function addCitation() {
  if (!root) return;
  promptInput({
    placeholder: "DOI or arXiv ID",
    hint: "For example 10.1093/comjnl/27.2.97 or 1412.6980. Looks the paper up online.",
    submit: async (id) => {
      setStatus("Looking up the paper…", "busy");
      try {
        const citation = await invoke<Citation>("fetch_bibtex", { id });
        const { key, file, added } = await addToBibliography(citation);
        const cited = insertCite(key);
        setStatus(`${added ? `Added ${key} to ${file}` : `${key} is already in ${file}`}${cited ? " and cited it" : ""}`, "ok");
        await refreshIndex();
        renderReferences();
      } catch (e) {
        setStatus(String(e), "err");
      }
    },
  });
}

export async function renderReferences() {
  if (panel.hidden || !root) return;
  const mine = ++job;
  const index = await refreshIndex();
  if (mine !== job) return;

  const frag = document.createDocumentFragment();
  if (!index.bib.length) {
    const none = document.createElement("div");
    none.className = "empty";
    none.textContent = "No references yet. Use the + above to add one from a DOI or an arXiv ID, or write entries in a .bib file.";
    frag.appendChild(none);
  }
  for (const entry of index.bib) {
    const row = document.createElement("div");
    row.className = "ref-row";

    const cite = document.createElement("button");
    cite.className = "ref-cite";
    cite.title = `Insert \\cite{${entry.key}} at the cursor`;
    const key = document.createElement("span");
    key.className = "ref-key";
    key.textContent = entry.key;
    cite.appendChild(key);
    if (!index.cited.includes(entry.key)) {
      const badge = document.createElement("span");
      badge.className = "gallery-badge unused";
      badge.textContent = "Not cited";
      cite.appendChild(badge);
    }
    const title = document.createElement("span");
    title.className = "ref-title";
    title.textContent = entry.title || "(no title)";
    cite.appendChild(title);
    cite.addEventListener("mousedown", (e) => e.preventDefault());
    cite.onclick = () => {
      if (!insertCite(entry.key)) setStatus("Put the cursor in a .tex file to insert the citation");
    };

    const open = document.createElement("button");
    open.className = "icon-btn";
    open.innerHTML = ICONS.out;
    open.title = `Open ${entry.file} at this entry`;
    open.setAttribute("aria-label", `Open ${entry.key} in ${entry.file}`);
    open.onclick = () => revealLine(entry.file, entry.line);

    const notes = document.createElement("button");
    notes.className = "icon-btn";
    notes.innerHTML = COMMAND_ICONS["file.newNote"];
    notes.title = `Your notes on ${entry.key}`;
    notes.setAttribute("aria-label", `Notes on ${entry.key}`);
    notes.onclick = () => openCitationNote(entry.key);

    row.append(cite, notes, open);
    frag.appendChild(row);
  }
  panel.replaceChildren(frag);
}
