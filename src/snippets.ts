// Snippets: a short word, then Tab, becomes a whole structure with places to fill in (Tab moves
// between them). Some come with the app; your own are kept on this computer, and VS Code's
// LaTeX snippet files can be imported.
import { completionStatus, snippet, snippetCompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { setStatus } from "./core";

export interface Snippet { prefix: string; description: string; body: string }

export const DEFAULT_SNIPPETS: Snippet[] = [
  { prefix: "fig", description: "Figure with an image", body: "\\begin{figure}[ht]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${1:path}}\n\t\\caption{${2:Caption.}}\n\t\\label{fig:${3:name}}\n\\end{figure}\n${}" },
  { prefix: "nbfig", description: "Figure from a notebook", body: "\\begin{figure}[ht]\n\t\\centering\n\t\\nbfig{${1:id}}\n\t\\caption{${2:Caption.}}\n\t\\label{fig:${3:name}}\n\\end{figure}\n${}" },
  { prefix: "tab", description: "Table", body: "\\begin{table}[ht]\n\t\\centering\n\t\\caption{${1:Caption.}}\n\t\\label{tab:${2:name}}\n\t\\begin{tabular}{${3:lr}}\n\t\t\\hline\n\t\t${4:Name} & ${5:Value} \\\\\n\t\t\\hline\n\t\\end{tabular}\n\\end{table}\n${}" },
  { prefix: "eq", description: "Numbered equation", body: "\\begin{equation}\n\t${1}\n\t\\label{eq:${2:name}}\n\\end{equation}\n${}" },
  { prefix: "ali", description: "Aligned equations", body: "\\begin{align}\n\t${1:a} &= ${2:b} \\\\\n\t${3:c} &= ${4:d}\n\\end{align}\n${}" },
  { prefix: "item", description: "Bulleted list", body: "\\begin{itemize}\n\t\\item ${1}\n\\end{itemize}\n${}" },
  { prefix: "enum", description: "Numbered list", body: "\\begin{enumerate}\n\t\\item ${1}\n\\end{enumerate}\n${}" },
  { prefix: "sec", description: "Section with a label", body: "\\section{${1:Title}}\n\\label{sec:${2:name}}\n${}" },
  { prefix: "sub", description: "Subsection with a label", body: "\\subsection{${1:Title}}\n\\label{sec:${2:name}}\n${}" },
  { prefix: "frac", description: "Fraction", body: "\\frac{${1:a}}{${2:b}}${}" },
  { prefix: "beg", description: "Any environment", body: "\\begin{${1:env}}\n\t${2}\n\\end{${1:env}}\n${}" },
  { prefix: "thm", description: "Theorem with a proof", body: "\\begin{theorem}\\label{thm:${1:name}}\n\t${2}\n\\end{theorem}\n\\begin{proof}\n\t${3}\n\\end{proof}\n${}" },
];

const KEY = "scribe.snippets";

export function userSnippets(): Snippet[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((s) => s && typeof s.prefix === "string" && typeof s.body === "string") : [];
  } catch {
    return [];
  }
}

export function saveUserSnippets(list: Snippet[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* no storage */ }
}

/** Yours first: one with the same word replaces the built-in one. */
export function allSnippets(): Snippet[] {
  const mine = userSnippets();
  return [...mine, ...DEFAULT_SNIPPETS.filter((d) => !mine.some((m) => m.prefix === d.prefix))];
}

/** A VS Code snippet body (`$1`, `${1:x}`, `$0`) in CodeMirror's form. Pure. */
export function fromVsCode(body: string | string[]): string {
  const text = Array.isArray(body) ? body.join("\n") : body;
  return text
    .replace(/\$\{0(:[^}]*)?\}|\$0(?!\d)/g, "${}")
    .replace(/\$(\d+)/g, "${$1}")
    .replace(/\$\{(\d+)\|([^,|}]*)[^}]*\|\}/g, "${$1:$2}"); // a choice: its first option
}

/** Snippets from a VS Code snippets file: { name: { prefix, body, description } }. Pure. */
export function importVsCode(json: unknown): Snippet[] {
  if (!json || typeof json !== "object") return [];
  const out: Snippet[] = [];
  for (const [name, value] of Object.entries(json as Record<string, unknown>)) {
    const v = value as { prefix?: string | string[]; body?: string | string[]; description?: string };
    const prefix = Array.isArray(v?.prefix) ? v.prefix[0] : v?.prefix;
    if (!prefix || !v.body) continue;
    out.push({ prefix: prefix.replace(/^\\/, ""), description: v.description ?? name, body: fromVsCode(v.body) });
  }
  return out;
}

// ---------- in the editor ----------
const WORD = /(?:^|[^\\\w])(\w+)$/;

export function snippetCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.state.doc.lineAt(context.pos).text.slice(0, context.pos - context.state.doc.lineAt(context.pos).from);
  const m = WORD.exec(before);
  if (!m) return null;
  const word = m[1];
  const options = allSnippets()
    .filter((s) => s.prefix.startsWith(word) && (context.explicit || word.length >= 2))
    .map((s) => snippetCompletion(s.body, { label: s.prefix, detail: s.description, type: "text", boost: -1 }));
  return options.length ? { from: context.pos - word.length, options, validFor: /^\w*$/ } : null;
}

/** Tab after a snippet's word expands it, when no completion list is open. */
export const snippetTab = Prec.high(keymap.of([{
  key: "Tab",
  run: (view: EditorView) => {
    if (completionStatus(view.state) !== null || !view.state.selection.main.empty) return false;
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const m = WORD.exec(line.text.slice(0, pos - line.from));
    const found = m && allSnippets().find((s) => s.prefix === m[1]);
    if (!found) return false;
    snippet(found.body)(view, { label: found.prefix }, pos - m![1].length, pos);
    return true;
  },
}]));

// ---------- Settings > Snippets ----------
export function openSnippetEditor() {
  const dialog = document.createElement("dialog");
  dialog.className = "theme-editor snippet-editor";
  dialog.setAttribute("aria-label", "Snippets");
  document.body.append(dialog);
  let list = userSnippets();
  const render = () => {
    dialog.replaceChildren();
    const head = document.createElement("header");
    const title = document.createElement("h3");
    title.className = "snippet-title";
    title.textContent = "Your snippets";
    head.append(title);
    const body = document.createElement("div");
    body.className = "snippet-list";
    const note = document.createElement("p");
    note.className = "theme-contrast";
    note.textContent = "Type the word, then Tab. In the body, ${1:name} is a place to fill in; Tab moves to the next. The built-in ones (fig, tab, eq, ali, sec, beg…) are always there; one of yours with the same word replaces it.";
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "snippet-empty";
      empty.textContent = "None yet.";
      body.append(empty);
    }
    list.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "snippet-row";
      const prefix = Object.assign(document.createElement("input"), { value: s.prefix, placeholder: "word", spellcheck: false });
      const desc = Object.assign(document.createElement("input"), { value: s.description, placeholder: "What it is" });
      const text = Object.assign(document.createElement("textarea"), { value: s.body, spellcheck: false, rows: Math.min(8, s.body.split("\n").length + 1) });
      const remove = Object.assign(document.createElement("button"), { className: "btn theme-delete", textContent: "Delete" });
      prefix.oninput = () => { s.prefix = prefix.value.trim().replace(/^\\/, ""); };
      desc.oninput = () => { s.description = desc.value; };
      text.oninput = () => { s.body = text.value; };
      remove.onclick = () => {
        list.splice(i, 1);
        render();
      };
      row.append(prefix, desc, remove, text);
      body.append(row);
    });
    const foot = document.createElement("footer");
    const button = (label: string, onclick: () => void, cls = "btn") => Object.assign(document.createElement("button"), { className: cls, textContent: label, onclick });
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    foot.append(
      button("New Snippet", () => {
        list.push({ prefix: "", description: "", body: "${1}" });
        render();
      }),
      button("Import from VS Code…", () => {
        const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,.code-snippets" });
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          let added: Snippet[] = [];
          try {
            // VS Code allows comments in snippet files
            added = importVsCode(JSON.parse((await file.text()).replace(/^\s*\/\/.*$/gm, "")));
          } catch { /* not JSON */ }
          if (!added.length) {
            setStatus(`No snippets found in ${file.name}`, "err");
            return;
          }
          list = [...list.filter((s) => !added.some((a) => a.prefix === s.prefix)), ...added];
          setStatus(`Imported ${added.length} snippet${added.length === 1 ? "" : "s"}`, "ok");
          render();
        };
        input.click();
      }),
      spacer,
      button("Done", () => dialog.close(), "btn btn-primary"),
    );
    dialog.append(head, body, note, foot);
  };
  dialog.addEventListener("close", () => {
    saveUserSnippets(list.filter((s) => s.prefix && s.body));
    dialog.remove();
  });
  render();
  dialog.showModal();
}
