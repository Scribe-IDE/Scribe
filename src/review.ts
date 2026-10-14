// Review panel: the notes left in the paper for later (% TODO, % FIXME, % NOTE, \todo{...}),
// gathered across every .tex file.
import { invoke } from "@tauri-apps/api/core";
import { $, current, root } from "./core";
import { view } from "./editor";
import { revealLine } from "./project";
import { NoteItem, refreshIndex, scanNotes } from "./texindex";

const panel = $("review-panel");
let job = 0;

export async function renderReview() {
  if (panel.hidden || !root) return;
  const mine = ++job;
  const { texFiles } = await refreshIndex();
  const found: { file: string; notes: NoteItem[] }[] = [];
  for (const file of texFiles) {
    // The open file is read from the editor, so notes show up before saving.
    const text = file === current && !$("editor").hidden
      ? view.state.doc.toString()
      : await invoke<string>("read_file", { root, rel: file }).catch(() => "");
    const notes = scanNotes(text);
    if (notes.length) found.push({ file, notes });
  }
  if (mine !== job) return;

  const frag = document.createDocumentFragment();
  if (!found.length) {
    const none = document.createElement("div");
    none.className = "empty";
    none.textContent = "Nothing to review. Write % TODO: … or \\todo{…} in the paper and it is listed here.";
    frag.appendChild(none);
  }
  for (const { file, notes } of found) {
    const heading = document.createElement("h3");
    heading.className = "gallery-heading";
    heading.textContent = file;
    frag.appendChild(heading);
    for (const note of notes) {
      const row = document.createElement("button");
      row.className = "review-row";
      row.title = `${file}:${note.line}`;
      const kind = document.createElement("span");
      kind.className = `review-kind review-${note.kind.toLowerCase()}`;
      kind.textContent = note.kind;
      const text = document.createElement("span");
      text.className = "review-text";
      text.textContent = note.text || "(no text)";
      row.append(kind, text);
      row.onclick = () => revealLine(file, note.line);
      frag.appendChild(row);
    }
  }
  panel.replaceChildren(frag);
}
