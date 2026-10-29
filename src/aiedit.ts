// Edits by the model, always reviewed first: the proposed text appears beside the source as a
// word-by-word comparison, and nothing changes until it is accepted. Used for the selection
// (rewrite, shorten, fix grammar, an instruction of your own) and for compile errors.
import type { EditorView } from "@codemirror/view";
import { current, setStatus } from "./core";
import { aiReady, aiStream, unfence, type AiRequest } from "./ai";
import type { Problem } from "./diagnostics";
import { view } from "./editor";
import { openPalette, promptInput } from "./palette";
import { openFile } from "./project";
import { activeEditor, closeSide, showInSide } from "./split";

// ---------- a word diff, for showing what changes ----------
type Part = { kind: "same" | "added" | "removed"; text: string };

/** The changes from `a` to `b`, word by word (spaces kept). Pure. */
export function wordDiff(a: string, b: string): Part[] | null {
  const x = a.split(/(\s+)/);
  const y = b.split(/(\s+)/);
  if (x.length * y.length > 4_000_000) return null; // too long to compare quickly
  const n = x.length;
  const m = y.length;
  // longest common subsequence, from the end
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: Part[] = [];
  const push = (kind: Part["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push("same", x[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push("removed", x[i++]);
    else push("added", y[j++]);
  }
  while (i < n) push("removed", x[i++]);
  while (j < m) push("added", y[j++]);
  return out;
}

// ---------- reviewing a proposed edit ----------
interface Job {
  title: string;
  /** What is being asked, shown above the result. */
  describe: string;
  editor: EditorView;
  from: number;
  to: number;
  original: string;
  request: () => AiRequest;
  /** Tidies the reply into the replacement text. */
  clean?: (reply: string) => string;
}

async function review(job: Job) {
  if (!aiReady()) {
    setStatus("Choose an AI provider and model in Settings > AI first");
    return;
  }
  const box = document.createElement("div");
  box.className = "ai-review";
  const what = document.createElement("p");
  what.className = "ai-review-what";
  what.textContent = job.describe;
  const body = document.createElement("div");
  body.className = "ai-review-body";
  const bar = document.createElement("div");
  bar.className = "ai-review-bar";
  const button = (label: string, cls: string, onclick: () => void) => Object.assign(document.createElement("button"), { className: cls, textContent: label, onclick });
  let proposed = "";
  let running: AbortController | null = null;

  const accept = button("Accept", "btn btn-primary", () => {
    if (job.editor.state.sliceDoc(job.from, job.to) !== job.original) {
      setStatus("The text changed while the model was writing; try again", "err");
      return;
    }
    job.editor.dispatch({ changes: { from: job.from, to: job.to, insert: proposed }, userEvent: "input" });
    closeSide();
    job.editor.focus();
    setStatus("Done. ⌘Z undoes it.", "ok");
  });
  const again = button("Try Again", "btn", () => run());
  const discard = button("Discard", "btn", () => {
    running?.abort();
    closeSide();
    job.editor.focus();
  });
  const gap = document.createElement("span");
  gap.style.flex = "1";
  bar.append(gap, discard, again, accept);
  box.append(what, body, bar);

  const run = async () => {
    running?.abort();
    running = new AbortController();
    accept.disabled = again.disabled = true;
    const live = document.createElement("pre");
    live.className = "ai-review-live";
    live.textContent = "…";
    body.replaceChildren(live);
    try {
      const { text, reason } = await aiStream(job.request(), (sofar) => { live.textContent = sofar; }, running.signal);
      if (reason === "cancelled") return;
      proposed = (job.clean ?? unfence)(text);
      if (!proposed.trim()) throw new Error("The model sent back nothing.");
      if (reason === "max_tokens" || reason === "length") setStatus("The reply was cut off; check its end before accepting", "err");
      const parts = wordDiff(job.original, proposed);
      const out = document.createElement("div");
      out.className = "ai-diff";
      if (parts) for (const p of parts) out.append(Object.assign(document.createElement("span"), { className: `ai-${p.kind}`, textContent: p.text }));
      else out.textContent = proposed;
      body.replaceChildren(out);
      accept.disabled = proposed === job.original;
      if (proposed === job.original) what.textContent = `${job.describe} The model found nothing to change.`;
    } catch (err) {
      body.replaceChildren(Object.assign(document.createElement("p"), { className: "ai-review-error", textContent: String(err).replace(/^Error: /, "") }));
    } finally {
      again.disabled = false;
      running = null;
    }
  };
  await showInSide(job.title, box);
  run();
}

// ---------- the selection ----------
const EDIT_SYSTEM = `You edit part of a LaTeX paper. Reply with only the text that replaces the given text: no code fences, no explanation, no quotation marks around it. Keep LaTeX commands, \\label, \\ref and \\cite keys, and maths exactly as they are unless the instruction asks otherwise. Keep the author's spelling conventions (British or American) and terminology.`;

const ACTIONS: [string, string][] = [
  ["Improve Writing", "Improve the clarity and flow of this text without changing its meaning or technical content."],
  ["Shorten", "Make this text shorter and tighter, keeping every fact and claim."],
  ["Fix Grammar and Spelling", "Fix grammar, spelling and punctuation only. Change nothing else."],
  ["More Formal", "Make the tone more formal and academic, as in a journal paper."],
  ["Simpler", "Make this easier to read: shorter sentences and plainer words, with the same meaning."],
  ["Translate to English", "Translate this into English, keeping the LaTeX as it is."],
  ["Tidy the LaTeX", "Rewrite this as well-formed LaTeX (proper commands, environments, maths and non-breaking spaces) without changing the wording."],
];

function editSelection(editor: EditorView, label: string, instruction: string) {
  const sel = editor.state.selection.main;
  const original = editor.state.sliceDoc(sel.from, sel.to);
  const before = editor.state.sliceDoc(Math.max(0, sel.from - 800), sel.from);
  const after = editor.state.sliceDoc(sel.to, Math.min(editor.state.doc.length, sel.to + 400));
  review({
    title: label,
    describe: instruction,
    editor,
    from: sel.from,
    to: sel.to,
    original,
    request: () => ({
      system: EDIT_SYSTEM,
      messages: [{ role: "user", content: `Instruction: ${instruction}\n\nFor context, the text just before it:\n${before}\n\nAnd just after it:\n${after}\n\nThe text to replace:\n${original}` }],
      maxTokens: 16000,
    }),
  });
}

/** Pick what to do with the selected text: rewrite, shorten, fix, or say what you want. */
export function editWithAi() {
  const editor = activeEditor();
  if (!editor || editor.state.selection.main.empty) {
    setStatus("Select the text to change first");
    return;
  }
  if (!aiReady()) {
    setStatus("Choose an AI provider and model in Settings > AI first");
    return;
  }
  openPalette({
    placeholder: "What should change in the selection?",
    empty: "",
    items: [
      ...ACTIONS.map(([label, instruction]) => ({ label, detail: instruction, run: () => editSelection(editor, label, instruction) })),
      {
        label: "Something Else…",
        detail: "Say what you want done",
        run: () => promptInput({
          placeholder: "What should change?",
          hint: "For example: split into two sentences; use the passive voice; add a citation placeholder.",
          submit: (instruction) => editSelection(editor, "Edit", instruction),
        }),
      },
    ],
  });
}

// ---------- compile errors ----------
const FIX_SYSTEM = `You fix LaTeX compile errors. You get the error from the TeX log, what it usually means, and the source lines around it, numbered. Reply with only the corrected version of exactly those lines, without the line numbers, code fences or any explanation. Change as little as possible.`;

/** Ask the model to fix the lines around an error, and review its fix. */
export async function fixProblem(problem: Problem) {
  if (!problem.line) return;
  if (current !== problem.file) await openFile(problem.file);
  const editor = view;
  const doc = editor.state.doc;
  const first = Math.max(1, problem.line - 12);
  const last = Math.min(doc.lines, problem.line + 12);
  const from = doc.line(first).from;
  const to = doc.line(last).to;
  const original = doc.sliceString(from, to);
  const numbered = original.split("\n").map((l, i) => `${first + i}: ${l}`).join("\n");
  review({
    title: "Fix",
    describe: `${problem.message}${problem.hint ? `. ${problem.hint}` : ""} (line ${problem.line})`,
    editor,
    from,
    to,
    original,
    // a model that numbered its lines anyway: drop the numbers
    clean: (reply) => {
      const text = unfence(reply);
      const lines = text.split("\n");
      return lines.every((l, i) => new RegExp(`^${first + i}: ?`).test(l)) ? lines.map((l) => l.replace(/^\d+: ?/, "")).join("\n") : text;
    },
    request: () => ({
      system: FIX_SYSTEM,
      messages: [{ role: "user", content: `Error in ${problem.file}, line ${problem.line}: ${problem.message}\n${problem.hint ?? ""}\n\nLines ${first}–${last}:\n${numbered}` }],
      maxTokens: 8000,
    }),
  });
}
