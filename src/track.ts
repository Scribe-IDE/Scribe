// Track changes and comments in the editor. With tracking on, what you type is wrapped in
// \added{…} and what you delete in \deleted{…} (the `changes` package), so the source itself
// carries the history; the marks are drawn in colour, and each can be accepted or rejected.
import { Annotation, EditorState, StateField, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { $, localKeys, mainFile, root, setStatus } from "./core";
import { promptInput } from "./palette";
import { profile } from "./profile";
import { activeEditor } from "./split";
import { openTabs } from "./tabs";
import { addedBodyAt, initials, markAt, preambleEdits, resolve, resolveAll, scanMarks, type Mark } from "./trackmarkup";

/** Tracking on or off (a project setting, set by settings.ts), and who is writing. */
export const trackPrefs = { on: false };
export const author = () => ({ id: initials(profile.name), name: profile.name.trim() || "Me" });

/** Marks transactions this module made, so they aren't tracked themselves. */
const own = Annotation.define<boolean>();

// ---------- tracking ----------
const MARKUP = /\\(added|deleted|replaced|comment|highlight)(?![a-zA-Z])|[{}]/;

const tracker = EditorState.transactionFilter.of((tr): Transaction | TransactionSpec | readonly TransactionSpec[] => {
  if (!trackPrefs.on || !tr.docChanged || tr.annotation(own)) return tr;
  // typing, deleting, pasting, completing: what the author writes. Not the TikZ canvas or drags.
  if (!(tr.isUserEvent("input") || tr.isUserEvent("delete")) || tr.isUserEvent("input.tikz") || tr.isUserEvent("input.drag")) return tr;
  const changes: { from: number; to: number; text: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, text: inserted.toString() }));
  if (changes.length !== 1) return tr; // several cursors: left as typed
  const { from, to, text } = changes[0];
  const doc = tr.startState.doc.toString();
  const begin = doc.indexOf("\\begin{document}");
  if (begin >= 0 && from < begin) return tr; // the preamble isn't tracked
  const removed = doc.slice(from, to);
  if (MARKUP.test(removed)) return tr; // cutting through marks: left as it is, so nothing breaks
  const marks = scanMarks(doc);
  const { id } = author();
  const open = (kind: string) => `\\${kind}[id=${id}]{`;
  const spec = (insertAt: number, removeTo: number, insert: string, cursor: number): TransactionSpec => ({
    changes: { from: insertAt, to: removeTo, insert },
    selection: { anchor: cursor },
    annotations: [own.of(true), Transaction.userEvent.of(tr.annotation(Transaction.userEvent) ?? "input")],
    scrollIntoView: true,
  });

  // inside one's own insertion, an edit is just an edit
  const inAdded = addedBodyAt(marks, from, id);
  if (inAdded && to <= inAdded.body[1]) return tr;
  // inside a deletion, the text is already gone: leave it alone
  if (marks.some((m) => m.kind === "deleted" && from >= m.body[0] && to <= m.body[1])) return tr;

  if (!removed) {
    // typing: right after one's own insertion, it goes on inside it
    const before = marks.find((m) => m.kind === "added" && m.id === id && m.to === from);
    if (before) return spec(before.body[1], from, text + "}", before.body[1] + text.length);
    const head = open("added");
    return spec(from, from, `${head}${text}}`, from + head.length + text.length);
  }
  if (!text) {
    const backward = tr.isUserEvent("delete.backward");
    // backspacing into the text before one's own deletion: it joins that deletion
    const after = marks.find((m) => m.kind === "deleted" && m.id === id && m.from === to);
    if (after) {
      const head = doc.slice(after.from, after.body[0]);
      return spec(from, after.body[0], head + removed, backward ? from : after.to);
    }
    // deleting forwards after one's own deletion: it joins that one
    const before = marks.find((m) => m.kind === "deleted" && m.id === id && m.to === from);
    if (before) return spec(before.body[1], to, `${removed}}`, backward ? before.from : before.body[1] + removed.length + 1);
    const block = `${open("deleted")}${removed}}`;
    return spec(from, to, block, backward ? from : from + block.length);
  }
  // replacing a selection: the old text deleted, the new added
  const deleted = `${open("deleted")}${removed}}`;
  const head = open("added");
  return spec(from, to, `${deleted}${head}${text}}`, from + deleted.length + head.length + text.length);
});

// ---------- drawing the marks ----------
const markup = (cls: string, title?: string) => Decoration.mark({ class: cls, attributes: title ? { title } : undefined });

function decorate(state: EditorState): DecorationSet {
  const ranges = [];
  for (const m of scanMarks(state.doc.toString())) {
    const who = m.id ? ` by ${m.id}` : "";
    const quiet = markup("cm-tc-cmd");
    if (m.body[0] > m.from) ranges.push(quiet.range(m.from, m.body[0]));
    const body = { added: "cm-tc-added", deleted: "cm-tc-deleted", replaced: "cm-tc-added", comment: "cm-tc-comment", highlight: "cm-tc-highlight" }[m.kind];
    const title = { added: `Added${who}`, deleted: `Deleted${who}`, replaced: `Replaced${who}`, comment: `Comment${who}`, highlight: `${m.note ?? "Comment"}${who ? ` (${m.id})` : ""}` }[m.kind];
    if (m.body[1] > m.body[0]) ranges.push(markup(body, title).range(m.body[0], m.body[1]));
    if (m.old) {
      ranges.push(quiet.range(m.body[1], m.old[0]));
      if (m.old[1] > m.old[0]) ranges.push(markup("cm-tc-deleted", `Replaced${who}`).range(m.old[0], m.old[1]));
      ranges.push(quiet.range(m.old[1], m.to));
    } else if (m.to > m.body[1]) ranges.push(quiet.range(m.body[1], m.to));
  }
  return Decoration.set(ranges, true);
}

const marksField = StateField.define<DecorationSet>({
  create: decorate,
  update: (value, tr) => (tr.docChanged ? decorate(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

/** Tracking and the drawn marks, for LaTeX files. */
export function trackExtension(path: string): Extension {
  return path.endsWith(".tex") ? [tracker, marksField] : [];
}

// ---------- the preamble ----------
/** Make sure the paper loads `changes` and knows this author; `final` hides the marks in the PDF. */
export async function ensurePreamble(editor: EditorView, final?: boolean): Promise<boolean> {
  const { id, name } = author();
  const doc = editor.state.doc.toString();
  const hidden = final ?? /\\usepackage\[[^\]]*\bfinal\b[^\]]*\]\{changes\}/.test(doc);
  if (/\\documentclass/.test(doc)) {
    const edits = preambleEdits(doc, id, name, hidden);
    if (edits.length) {
      editor.dispatch({ changes: edits.map(([from, insert, length]) => ({ from, to: from + length, insert })), annotations: own.of(true) });
    }
    return true;
  }
  // the paper is another file: changed on disk when it isn't open with unsaved changes
  if (!mainFile || openTabs.includes(mainFile)) {
    setStatus(`Add \\usepackage{changes} to ${mainFile || "the paper"}'s preamble for the marks to show in the PDF`);
    return false;
  }
  const paper = await invoke<string>("read_file", { root, rel: mainFile }).catch(() => "");
  const edits = preambleEdits(paper, id, name, final ?? /\\usepackage\[[^\]]*\bfinal\b/.test(paper));
  if (!edits.length) return true;
  let out = paper;
  for (const [at, insert, length] of [...edits].sort((a, b) => b[0] - a[0])) out = out.slice(0, at) + insert + out.slice(at + length);
  await invoke("write_file", { root, rel: mainFile, content: out });
  return true;
}

// ---------- commands ----------
const texEditor = (): EditorView | null => {
  const editor = activeEditor();
  if (!editor?.dom.dataset.path?.endsWith(".tex")) {
    setStatus("Open a .tex file first");
    return null;
  }
  return editor;
};

/** A comment on the selection (a highlight carrying it), or at the cursor. */
export function addComment() {
  const editor = texEditor();
  if (!editor) return;
  const sel = editor.state.selection.main;
  promptInput({
    placeholder: sel.empty ? "Comment" : "Comment on the selection",
    hint: "Shown in the margin of the PDF and in the Review panel, with your initials.",
    submit: async (text) => {
      await ensurePreamble(editor);
      const { id } = author();
      const note = text.replace(/[{}]/g, "");
      const s = editor.state.selection.main;
      const insert = s.empty ? `\\comment[id=${id}]{${note}}` : `\\highlight[id=${id}, comment={${note}}]{${editor.state.sliceDoc(s.from, s.to)}}`;
      editor.dispatch({ changes: { from: s.from, to: s.to, insert }, annotations: own.of(true), userEvent: "input" });
      editor.focus();
    },
  });
}

/** Accept or reject the change at the cursor (a comment is resolved either way). */
export function resolveHere(accept: boolean) {
  const editor = texEditor();
  if (!editor) return;
  const doc = editor.state.doc.toString();
  const mark = markAt(scanMarks(doc), editor.state.selection.main.head);
  if (!mark) return setStatus("Put the cursor in a change or a comment");
  applyResolution(editor, mark, accept);
}

export function applyResolution(editor: EditorView, mark: Mark, accept: boolean) {
  const doc = editor.state.doc.toString();
  const insert = resolveAll(resolve(doc, mark, accept), accept);
  editor.dispatch({ changes: { from: mark.from, to: mark.to, insert }, selection: { anchor: mark.from + insert.length }, annotations: own.of(true), userEvent: "input" });
}

/** Every change in the file accepted or rejected, every comment resolved, as one step. */
export function resolveFile(accept: boolean) {
  const editor = texEditor();
  if (!editor) return;
  const doc = editor.state.doc.toString();
  const count = scanMarks(doc).length;
  if (!count) return setStatus("No changes or comments in this file");
  editor.dispatch({ changes: { from: 0, to: doc.length, insert: resolveAll(doc, accept) }, annotations: own.of(true), userEvent: "input" });
  setStatus(localKeys(`${accept ? "Accepted" : "Rejected"} ${count} change${count === 1 ? "" : "s"} and comments. ⌘Z undoes it.`), "ok");
}

/** The cursor to the next change or comment after it (round to the first). */
export function nextChange() {
  const editor = texEditor();
  if (!editor) return;
  const marks = scanMarks(editor.state.doc.toString());
  if (!marks.length) return setStatus("No changes or comments in this file");
  const head = editor.state.selection.main.head;
  const next = marks.find((m) => m.from > head) ?? marks[0];
  editor.dispatch({ selection: { anchor: next.from, head: next.to }, effects: EditorView.scrollIntoView(next.from, { y: "center" }) });
  editor.focus();
}

/** Show the marks in the PDF, or print the paper as if every change were accepted. */
export async function toggleMarksInPdf() {
  const editor = activeEditor();
  if (!editor) return;
  const doc = editor.state.doc.toString();
  const hidden = /\\usepackage\[[^\]]*\bfinal\b[^\]]*\]\{changes\}/.test(doc);
  if (await ensurePreamble(editor, !hidden)) setStatus(hidden ? "Changes show in the PDF" : "The PDF shows the paper as if every change were accepted", "ok");
}

/** The status bar says when tracking is on; a click turns it off. */
export function renderTrackStatus() {
  $("sb-track").hidden = !trackPrefs.on;
}
