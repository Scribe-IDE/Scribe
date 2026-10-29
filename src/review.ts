// Review panel: tracked changes and comments (\added, \deleted, \replaced, \comment, \highlight)
// with their accept and reject buttons, then the notes left for later (% TODO, % FIXME, % NOTE,
// \todo{...}), gathered across every .tex file.
import { invoke } from "@tauri-apps/api/core";
import { $, current, root } from "./core";
import { view } from "./editor";
import { openFile, revealLine } from "./project";
import { NoteItem, refreshIndex, scanNotes } from "./texindex";
import { applyResolution } from "./track";
import { authorColor, scanMarks, type Mark } from "./trackmarkup";

const panel = $("review-panel");
let job = 0;

const lineOf = (text: string, pos: number) => text.slice(0, pos).split("\n").length;
const short = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Accept or reject one mark of a file: in the editor, so it can be undone. */
async function settle(file: string, mark: Mark, accept: boolean) {
  if (file !== current || $("editor").hidden) await openFile(file);
  // the file as it is now: the mark found again where it was
  const fresh = scanMarks(view.state.doc.toString()).find((m) => m.from === mark.from && m.kind === mark.kind);
  if (fresh) applyResolution(view, fresh, accept);
  renderReview();
}

async function settleAll(file: string, accept: boolean) {
  if (file !== current || $("editor").hidden) await openFile(file);
  const { resolveFile } = await import("./track");
  resolveFile(accept);
  renderReview();
}

function markCard(file: string, text: string, mark: Mark): HTMLElement {
  const card = el("div", `review-card review-${mark.kind}`);
  const head = el("div", "review-card-head");
  const who = el("span", "review-author", mark.id ?? "?");
  who.style.setProperty("--author", `var(--tc-${authorColor(mark.id ?? "?")})`);
  const label = { added: "Added", deleted: "Deleted", replaced: "Replaced", comment: "Comment", highlight: "Comment" }[mark.kind];
  head.append(who, el("span", "review-label", label), el("span", "review-where", `line ${lineOf(text, mark.from)}`));
  card.append(head);
  const body = text.slice(mark.body[0], mark.body[1]);
  if (mark.kind === "replaced") {
    const change = el("div", "review-change");
    change.append(el("del", "", short(text.slice(mark.old![0], mark.old![1]), 70)), el("span", "review-arrow", " → "), el("ins", "", short(body, 70)));
    card.append(change);
  } else if (mark.kind === "highlight") {
    card.append(el("div", "review-note", mark.note ?? ""), el("div", "review-quote", short(body)));
  } else if (mark.kind === "comment") {
    card.append(el("div", "review-note", short(body, 400)));
  } else {
    card.append(el(mark.kind === "added" ? "ins" : "del", "review-change", short(body)));
  }
  const actions = el("div", "review-actions");
  const button = (label: string, accept: boolean, cls = "btn") => {
    const b = el("button", cls, label) as HTMLButtonElement;
    b.onclick = (e) => {
      e.stopPropagation();
      settle(file, mark, accept);
    };
    return b;
  };
  if (mark.kind === "comment" || mark.kind === "highlight") actions.append(button("Resolve", true));
  else actions.append(button("Reject", false), button("Accept", true, "btn btn-primary"));
  card.append(actions);
  card.onclick = () => revealLine(file, lineOf(text, mark.from));
  return card;
}

export async function renderReview() {
  if (panel.hidden || !root) return;
  const mine = ++job;
  const { texFiles } = await refreshIndex();
  const found: { file: string; text: string; marks: Mark[]; notes: NoteItem[] }[] = [];
  for (const file of texFiles) {
    // The open file is read from the editor, so notes show up before saving.
    const text = file === current && !$("editor").hidden
      ? view.state.doc.toString()
      : await invoke<string>("read_file", { root, rel: file }).catch(() => "");
    const marks = scanMarks(text);
    // marks inside marks are settled with the one that holds them
    const outer = marks.filter((m) => !marks.some((o) => o !== m && o.from <= m.from && o.to >= m.to));
    const notes = scanNotes(text);
    if (outer.length || notes.length) found.push({ file, text, marks: outer, notes });
  }
  if (mine !== job) return;

  const frag = document.createDocumentFragment();
  if (!found.length) {
    frag.appendChild(el("div", "empty", "Nothing to review. Turn on Review > Track Changes to mark your edits, add a comment with ⌥⌘M, or write % TODO: … in the paper."));
  }
  const changes = found.filter((f) => f.marks.length);
  if (changes.length) frag.appendChild(el("h3", "gallery-heading", "Changes and comments"));
  for (const { file, text, marks } of changes) {
    const row = el("div", "review-file");
    const name = el("span", "review-file-name", file);
    const all = (label: string, accept: boolean) => {
      const b = el("button", "btn review-all", label) as HTMLButtonElement;
      b.title = `${label} in ${file}: every change, and every comment resolved`;
      b.onclick = () => settleAll(file, accept);
      return b;
    };
    row.append(name, all("Reject All", false), all("Accept All", true));
    frag.appendChild(row);
    for (const mark of marks) frag.appendChild(markCard(file, text, mark));
  }
  const withNotes = found.filter((f) => f.notes.length);
  if (withNotes.length) frag.appendChild(el("h3", "gallery-heading", "Notes for later"));
  for (const { file, notes } of withNotes) {
    if (withNotes.length > 1) frag.appendChild(el("div", "review-file-name review-notes-file", file));
    for (const note of notes) {
      const row = el("button", "review-row");
      row.title = `${file}:${note.line}`;
      row.append(el("span", `review-kind review-${note.kind.toLowerCase()}`, note.kind), el("span", "review-text", note.text || "(no text)"));
      row.onclick = () => revealLine(file, note.line);
      frag.appendChild(row);
    }
  }
  panel.replaceChildren(frag);
}
