// Notes: Markdown files with maths, quick enough to keep up with a lecture. Formulas render in
// place as soon as the cursor leaves them, short shortcuts expand into LaTeX inside maths, and
// notes link to each other with [[name]] and to the bibliography with @key.
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Completion, CompletionContext, CompletionResult, snippet } from "@codemirror/autocomplete";
import { EditorSelection, EditorState, Extension, Prec, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";
import { $, baseName, changeListeners, current, root, setStatus } from "./core";
import { promptInput } from "./palette";
import { parseLog } from "./diagnostics";
import { setPaperless } from "./layout";
import { renderPdf } from "./preview";
import { setProblems } from "./problems";
import { listFiles, openFile, revealLine } from "./project";
import { showSidebar } from "./sidebar";
import { activeEditor } from "./split";
import { index } from "./texindex";

export const NOTE = /\.md$/i;
export const isNote = (path: string | null | undefined) => !!path && NOTE.test(path);
const NOTES_DIR = "notes";

/** Live preview can be turned off to see a note's plain Markdown. */
export const notePrefs = { live: true };
const refresh = StateEffect.define<null>();

// ---------- finding maths and code ----------
interface Span { from: number; to: number; tex: string; display: boolean; open: number; }

// Code first, so a `$` inside backticks or a fenced block is never maths.
const CODE = /^```[^\n]*\n[\s\S]*?^```[ \t]*$|`[^`\n]+`/gm;
// Rendered maths: $$…$$ (may span lines), \[…\], and $…$ that hugs its content like Pandoc's.
const MATH = /(?<!\\)\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(?<![\\$])\$(?=[^\s$])((?:\\.|[^$\\\n])+?)(?<=[^\s\\])\$(?!\$)/g;
// While typing, an empty or spaced formula still counts, so shortcuts work in `$ | $`.
const LOOSE = /(?<!\\)\$\$([\s\S]*?)\$\$|(?<![\\$])\$((?:\\.|[^$\\\n])*?)\$/g;

function codeRanges(text: string): [number, number][] {
  return [...text.matchAll(CODE)].map((m) => [m.index!, m.index! + m[0].length]);
}

const inside = (ranges: [number, number][], at: number) => ranges.some(([a, b]) => at >= a && at < b);

function mathSpans(text: string, re = MATH): Span[] {
  const code = codeRanges(text);
  const out: Span[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (inside(code, m.index)) continue;
    const display = m[0].startsWith("$$") || m[0].startsWith("\\[");
    const tex = m[1] ?? m[2] ?? m[3] ?? "";
    out.push({ from: m.index, to: m.index + m[0].length, tex, display, open: display ? 2 : 1 });
  }
  return out;
}

/** The formula the position is typing into, if any (between its delimiters). */
export function mathAround(state: EditorState, pos: number): Span | null {
  // Formulas are short; a window around the cursor keeps this cheap in long notes.
  const start = Math.max(0, pos - 3000);
  for (const span of mathSpans(state.sliceDoc(start, Math.min(state.doc.length, pos + 3000)), LOOSE)) {
    const from = span.from + start;
    const to = span.to + start;
    if (pos >= from + span.open && pos <= to - span.open) return { ...span, from, to };
  }
  return null;
}

// ---------- widgets ----------
class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly open: number) { super(); }
  eq(other: MathWidget) { return other.tex === this.tex && other.display === this.display; }
  toDOM(view: EditorView) {
    const dom = document.createElement(this.display ? "div" : "span");
    dom.className = this.display ? "cm-md-math cm-md-math-display" : "cm-md-math";
    katex.render(this.tex.trim(), dom, { displayMode: this.display, throwOnError: false, errorColor: "var(--err)" });
    dom.title = "Click to edit";
    // A click puts the cursor into the formula, which shows its source again.
    dom.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const at = view.posAtDOM(dom) + this.open;
      view.dispatch({ selection: { anchor: at } });
      view.focus();
    });
    return dom;
  }
  ignoreEvent() { return false; }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(other: CheckboxWidget) { return other.checked === this.checked; }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-check";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "Done" : "Not done");
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const at = view.posAtDOM(box);
      view.dispatch({ changes: { from: at, to: at + 3, insert: this.checked ? "[ ]" : "[x]" } });
    });
    return box;
  }
  ignoreEvent() { return false; }
}

const imageUrls = new Map<string, Promise<string>>();

function imageUrl(rel: string): Promise<string> {
  let url = imageUrls.get(rel);
  if (!url) {
    url = invoke<ArrayBuffer>("read_binary", { root, rel }).then((bytes) => URL.createObjectURL(new Blob([bytes])));
    imageUrls.set(rel, url);
    url.catch(() => imageUrls.delete(rel)); // try again next time, e.g. after the file appears
  }
  return url;
}

class ImageWidget extends WidgetType {
  constructor(readonly rel: string) { super(); }
  eq(other: ImageWidget) { return other.rel === this.rel; }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-md-image";
    const img = document.createElement("img");
    img.alt = "";
    imageUrl(this.rel).then((url) => { img.src = url; }).catch(() => { box.textContent = `Image not found: ${this.rel}`; });
    box.appendChild(img);
    return box;
  }
}

/** A link target relative to the note, as a path from the project root. */
function fromNote(note: string, target: string): string {
  const parts = note.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

// ---------- live preview ----------
const mark = (cls: string, attrs?: Record<string, string>) => Decoration.mark({ class: cls, attributes: attrs });
const hashMark = mark("cm-md-hash");
const hidden = Decoration.replace({});
// Markdown punctuation that disappears while the cursor is on another line.
const QUIET = new Set(["HeaderMark", "EmphasisMark", "CodeMark", "LinkMark", "URL", "StrikethroughMark"]);

function decorate(state: EditorState, path: string): DecorationSet {
  const text = state.doc.toString();
  const out: Range<Decoration>[] = [];
  const touches = (from: number, to: number) => state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const code = codeRanges(text);
  const maths = mathSpans(text);
  const taken = (at: number) => inside(code, at) || maths.some((m) => at >= m.from && at < m.to);
  const onLine = (pos: number) => {
    const line = state.doc.lineAt(pos);
    return touches(line.from, line.to);
  };
  // The line being edited shows its Markdown as written; every other line reads as formatted text.
  const quiet = (from: number, to: number) => {
    if (notePrefs.live && from < to && !onLine(from)) out.push(hidden.range(from, to));
  };

  if (notePrefs.live) {
    syntaxTree(state).iterate({
      enter(node) {
        if (!QUIET.has(node.name) || taken(node.from)) return;
        if (node.name === "CodeMark" && text.startsWith("```", node.from)) return; // fences stay
        if (node.name === "URL" && text[node.from - 1] !== "(") return; // only a link's address, not a bare URL
        // the space after a heading's #s goes too
        const to = node.name === "HeaderMark" && text[node.to] === " " ? node.to + 1 : node.to;
        quiet(node.from, to);
      },
    });
  }

  for (const [from, to] of code) {
    if (text.startsWith("```", from)) {
      for (let line = state.doc.lineAt(from); ; line = state.doc.line(line.number + 1)) {
        out.push(Decoration.line({ class: "cm-md-codeblock" }).range(line.from));
        if (line.to >= to || line.number === state.doc.lines) break;
      }
    }
  }

  if (notePrefs.live) {
    for (const m of maths) {
      if (touches(m.from, m.to)) {
        out.push(mark("cm-md-math-source").range(m.from, m.to));
        continue;
      }
      const first = state.doc.lineAt(m.from);
      const last = state.doc.lineAt(m.to);
      // A display formula alone on its lines becomes a block of its own.
      const block = m.display && m.from === first.from && m.to === last.to;
      out.push(Decoration.replace({ widget: new MathWidget(m.tex, m.display, m.open), block }).range(m.from, m.to));
    }
  }

  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (inside(code, line.from)) continue;
    const heading = /^(#{1,6})\s/.exec(line.text);
    if (heading) {
      out.push(Decoration.line({ class: `cm-md-h cm-md-h${Math.min(heading[1].length, 4)}` }).range(line.from));
      out.push(hashMark.range(line.from, line.from + heading[1].length + 1));
    }
    if (/^>\s?/.test(line.text)) out.push(Decoration.line({ class: "cm-md-quote" }).range(line.from));
    const check = /^(\s*[-*+]\s)\[( |x|X)\]/.exec(line.text);
    if (check && notePrefs.live) {
      const from = line.from + check[1].length;
      if (!touches(from, from + 3)) out.push(Decoration.replace({ widget: new CheckboxWidget(check[2] !== " ") }).range(from, from + 3));
    }
    const image = /^!\[[^\]]*\]\(([^)\s]+)\)\s*$/.exec(line.text);
    if (image && notePrefs.live && !/^[a-z]+:/i.test(image[1])) {
      out.push(Decoration.widget({ widget: new ImageWidget(fromNote(path, decodeURI(image[1]))), block: true, side: 1 }).range(line.to));
    }
  }

  for (const m of text.matchAll(/\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g)) {
    if (taken(m.index!)) continue;
    const from = m.index!;
    const to = from + m[0].length;
    out.push(mark("cm-md-wikilink", { "data-note": m[1].trim(), title: `⌘-click to open ${m[1].trim()}` }).range(from, to));
    // [[name]] reads as "name", and [[name|label]] as "label"
    quiet(from, m[2] ? from + 2 + m[1].length + 1 : from + 2);
    quiet(to - 2, to);
  }
  for (const m of text.matchAll(/(?<![\w@\\])@([A-Za-z][\w:.-]*\w)/g)) {
    if (taken(m.index!)) continue;
    out.push(mark("cm-md-cite", { "data-key": m[1], title: `⌘-click for your notes on ${m[1]}` }).range(m.index!, m.index! + m[0].length));
  }
  for (const m of text.matchAll(TAG)) {
    if (taken(m.index!)) continue;
    const line = state.doc.lineAt(m.index!);
    if (line.from === m.index && /^#+\s/.test(line.text)) continue;
    out.push(mark("cm-md-tag", { "data-tag": m[1], title: `⌘-click for every note tagged #${m[1]}` }).range(m.index!, m.index! + m[0].length));
  }
  for (const m of text.matchAll(/(?<!!)\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    if (taken(m.index!)) continue;
    out.push(mark("cm-md-url", { "data-href": m[2], title: `⌘-click to open ${m[2]}` }).range(m.index!, m.index! + m[0].length));
  }
  return Decoration.set(out, true);
}

function livePreview(path: string) {
  return StateField.define<DecorationSet>({
    create: (state) => decorate(state, path),
    update(value, tr) {
      if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refresh))) return decorate(tr.state, path);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/** Redraw notes after live preview is switched on or off. */
export function refreshNotes(...views: (EditorView | null)[]) {
  for (const v of views) if (v && isNote(v.dom.dataset.path)) v.dispatch({ effects: refresh.of(null) });
}

// ---------- typing maths quickly ----------
const GREEK: Record<string, string> = {
  a: "alpha", b: "beta", g: "gamma", d: "delta", e: "varepsilon", z: "zeta", h: "eta", t: "theta", i: "iota",
  k: "kappa", l: "lambda", m: "mu", n: "nu", x: "xi", p: "pi", r: "rho", s: "sigma", u: "upsilon", f: "varphi",
  c: "chi", y: "psi", w: "omega", G: "Gamma", D: "Delta", T: "Theta", L: "Lambda", X: "Xi", P: "Pi", S: "Sigma",
  F: "Phi", Y: "Psi", W: "Omega",
};

/** Shortcuts that expand inside maths. `${…}` marks the fields Tab moves through. */
export const MATH_SHORTCUTS: [string, string][] = [
  ["//", "\\frac{${1}}{${2}}${3}"],
  ["->", "\\to "],
  ["=>", "\\implies "],
  ["<=", "\\leq "],
  [">=", "\\geq "],
  ["!=", "\\neq "],
  ["~=", "\\approx "],
  ["**", "\\cdot "],
  ["...", "\\dots "],
  ["RR", "\\mathbb{R}"],
  ["NN", "\\mathbb{N}"],
  ["ZZ", "\\mathbb{Z}"],
  ["QQ", "\\mathbb{Q}"],
  ["CC", "\\mathbb{C}"],
  ...Object.entries(GREEK).map(([k, name]): [string, string] => [`;${k}`, `\\${name}`]),
];
const SHORTCUT = new Map(MATH_SHORTCUTS);

function expand(view: EditorView, from: number, to: number, template: string) {
  if (template.includes("${")) {
    snippet(template)(view, null, from, to);
  } else {
    view.dispatch({ changes: { from, to, insert: template }, selection: { anchor: from + template.length }, userEvent: "input" });
  }
}

const mathTyping = EditorView.inputHandler.of((view, from, to, text) => {
  if (text.length !== 1 || from !== to || view.state.selection.ranges.length > 1) return false;
  const { state } = view;
  const next = state.sliceDoc(from, from + 1);
  const prev = state.sliceDoc(from - 1, from);

  if (text === "$" && prev !== "\\") {
    // `$` opens $|$; a second `$` straight away makes it $$|$$; otherwise `$` steps over a closing one.
    if (prev === "$" && next === "$" && state.sliceDoc(from - 2, from - 1) !== "$") {
      view.dispatch({ changes: { from, insert: "$$" }, selection: { anchor: from + 1 }, userEvent: "input" });
      return true;
    }
    if (next === "$") {
      view.dispatch({ selection: { anchor: from + 1 }, userEvent: "select" });
      return true;
    }
    if (!mathAround(state, from) && !/\w/.test(next)) {
      view.dispatch({ changes: { from, insert: "$$" }, selection: { anchor: from + 1 }, userEvent: "input" });
      return true;
    }
    return false;
  }

  if (!mathAround(state, from)) return false;
  for (const length of [3, 2]) {
    const typed = state.sliceDoc(from - (length - 1), from) + text;
    const template = SHORTCUT.get(typed);
    if (!template || state.sliceDoc(from - length, from - length + 1) === "\\") continue;
    expand(view, from - (length - 1), to, template);
    return true;
  }
  return false;
});

// Tab inside a formula jumps past its closing delimiter, back to the prose.
const leaveMath = Prec.low(keymap.of([{
  key: "Tab",
  run: (view) => {
    const span = mathAround(view.state, view.state.selection.main.head);
    if (!span || !view.state.selection.main.empty) return false;
    view.dispatch({ selection: EditorSelection.cursor(span.to) });
    return true;
  },
}]));

// ---------- completion ----------
const MATH_WORDS = [
  ...Object.values(GREEK), "epsilon", "phi", "vartheta", "varrho", "ell", "hbar", "partial", "nabla", "infty",
  "sum", "prod", "int", "iint", "oint", "lim", "limsup", "liminf", "sup", "inf", "max", "min", "arg", "det", "dim",
  "log", "ln", "exp", "sin", "cos", "tan", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "cdot", "times", "div", "pm", "mp", "circ", "leq", "geq", "neq", "approx", "equiv", "sim", "simeq", "cong", "propto",
  "ll", "gg", "to", "mapsto", "implies", "iff", "forall", "exists", "nexists", "in", "notin", "ni", "subset",
  "subseteq", "supset", "supseteq", "cup", "cap", "bigcup", "bigcap", "emptyset", "setminus", "land", "lor", "neg",
  "mathbb", "mathcal", "mathbf", "mathrm", "mathit", "operatorname", "text", "vec", "hat", "bar", "dot", "ddot",
  "tilde", "overline", "underline", "overbrace", "underbrace", "langle", "rangle", "lvert", "rvert", "lVert", "rVert",
  "lfloor", "rfloor", "lceil", "rceil", "left", "right", "ldots", "cdots", "vdots", "ddots", "quad", "qquad",
];
const SNIPPETS: [string, string][] = [
  ["frac", "\\frac{${1}}{${2}}${3}"],
  ["sqrt", "\\sqrt{${1}}${2}"],
  ["binom", "\\binom{${1}}{${2}}${3}"],
  ["sum", "\\sum_{${1}}^{${2}}${3}"],
  ["int", "\\int_{${1}}^{${2}}${3} \\,d${4}"],
  ["lim", "\\lim_{${1} \\to ${2}}${3}"],
  ["pmatrix", "\\begin{pmatrix} ${1} \\end{pmatrix}${2}"],
  ["bmatrix", "\\begin{bmatrix} ${1} \\end{bmatrix}${2}"],
  ["cases", "\\begin{cases} ${1} & ${2} \\\\ ${3} & ${4} \\end{cases}${5}"],
  ["aligned", "\\begin{aligned} ${1} &= ${2} \\end{aligned}${3}"],
];
const MATH_OPTIONS: Completion[] = [
  ...SNIPPETS.map(([label, body]): Completion => ({ label: `\\${label}`, type: "function", detail: "template", apply: snippet(body), boost: 2 })),
  ...[...new Set(MATH_WORDS)].map((word): Completion => ({ label: `\\${word}`, type: "keyword" })),
];

export async function notesCompletion(context: CompletionContext): Promise<CompletionResult | null> {
  const link = context.matchBefore(/\[\[[^\[\]\n]*/);
  if (link) {
    const names = (await listFiles()).filter((f) => NOTE.test(f)).map((f) => noteName(f));
    return { from: link.from + 2, options: [...new Set(names)].map((label) => ({ label, type: "text" })), validFor: /^[^\[\]\n]*$/ };
  }
  const cite = context.matchBefore(/(?<![\w@])@[\w:.-]*/);
  if (cite && index.bib.length) {
    return { from: cite.from + 1, options: index.bib.map((b) => ({ label: b.key, detail: b.title, type: "variable" })), validFor: /^[\w:.-]*$/ };
  }
  const command = context.matchBefore(/\\[a-zA-Z]*/);
  if (command && (command.from < command.to || context.explicit) && mathAround(context.state, context.pos)) {
    return { from: command.from, options: MATH_OPTIONS, validFor: /^\\[a-zA-Z]*$/ };
  }
  return null;
}

// ---------- pasting images ----------
const stamp = () => {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
};

async function pasteImage(view: EditorView, file: File, note: string) {
  if (!root) return;
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  const folder = note.includes("/") ? note.slice(0, note.lastIndexOf("/") + 1) : "";
  const name = `${baseName(note).replace(NOTE, "").replace(/[^\w-]+/g, "-")}-${stamp()}.${ext}`;
  const rel = `${folder}images/${name}`;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await invoke("write_binary", bytes, { headers: { "x-root": encodeURIComponent(root), "x-rel": encodeURIComponent(rel) } });
  } catch (e) {
    setStatus(`Couldn't save the pasted image: ${e}`);
    return;
  }
  const { from, to } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  // An image on a line of its own, so it shows below the text in live preview.
  const insert = `${from > line.from ? "\n" : ""}![](images/${encodeURI(name)})\n`;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.paste" });
}

// ---------- following links ----------
export const noteName = (rel: string) => baseName(rel).replace(NOTE, "");

/** The note a [[name]] link points to: a note with that name anywhere, else a new one beside this note. */
async function resolveNote(name: string, from: string | null): Promise<string> {
  const files = (await listFiles()).filter((f) => NOTE.test(f));
  const wanted = name.replace(NOTE, "").toLowerCase();
  const hit = files.find((f) => f.replace(NOTE, "").toLowerCase() === wanted) ?? files.find((f) => noteName(f).toLowerCase() === wanted);
  if (hit) return hit;
  const folder = from?.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : `${NOTES_DIR}/`;
  return `${folder}${name.replace(NOTE, "")}.md`;
}

async function ensureNote(rel: string, content: string) {
  const files = await listFiles();
  if (!files.includes(rel)) await invoke("write_file", { root, rel, content });
}

async function followLink(target: HTMLElement, note: string) {
  if (target.dataset.tag) {
    showSidebar("notes");
    filterByTag(target.dataset.tag);
  } else if (target.dataset.note) {
    const rel = await resolveNote(target.dataset.note, note);
    await ensureNote(rel, `# ${noteName(rel)}\n\n`);
    await openFile(rel);
  } else if (target.dataset.key) {
    await openCitationNote(target.dataset.key);
  } else if (target.dataset.href) {
    const href = target.dataset.href;
    if (/^(https?:|mailto:)/i.test(href)) await openUrl(href).catch(() => {});
    else await openFile(fromNote(note, decodeURI(href)));
  }
}

const handlers = (path: string) => EditorView.domEventHandlers({
  mousedown(e) {
    if (!(e.metaKey || e.ctrlKey)) return false;
    const target = (e.target as HTMLElement).closest<HTMLElement>(".cm-md-wikilink, .cm-md-cite, .cm-md-url, .cm-md-tag");
    if (!target) return false;
    e.preventDefault();
    followLink(target, path).catch((err) => setStatus(`Couldn't open the link: ${err}`));
    return true;
  },
  paste(e, view) {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (!file) return false;
    e.preventDefault();
    pasteImage(view, file, path);
    return true;
  },
});

/** Everything a note's editor needs on top of the shared setup. */
export function notesExtension(path: string): Extension {
  if (!isNote(path)) return [];
  return [
    markdown({ base: markdownLanguage }),
    livePreview(path),
    mathTyping,
    leaveMath,
    handlers(path),
    EditorView.editorAttributes.of({ class: "cm-notes" }),
  ];
}

// ---------- Markdown to LaTeX ----------
const LATEX_SPECIAL = /[&%#_{}~^\\$]/g;
const ESCAPE: Record<string, string> = {
  "&": "\\&", "%": "\\%", "#": "\\#", "_": "\\_", "{": "\\{", "}": "\\}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
  "\\": "\\textbackslash{}", "$": "\\$",
};

/** One line of prose: maths and code kept, emphasis and links turned into LaTeX, the rest escaped. */
function inlineLatex(text: string): string {
  const keep: string[] = [];
  const hold = (s: string) => `\u0000${keep.push(s) - 1}\u0000`;
  let s = text
    .replace(/`([^`]+)`/g, (_m, c) => hold(`\\texttt{${c.replace(LATEX_SPECIAL, (ch: string) => ESCAPE[ch])}}`))
    .replace(/(?<!\\)\$((?:\\.|[^$\\])+)\$/g, (m) => hold(m))
    .replace(/\\\(([\s\S]+?)\\\)/g, (m) => hold(m))
    .replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_m, src) => hold(`\\includegraphics[width=\\linewidth]{${decodeURI(src)}}`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => hold(`\\href{${href}}{${inlineLatex(label)}}`))
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, name, label) => hold(inlineLatex(label ?? name)))
    .replace(/(?<![\w@\\])@([A-Za-z][\w:.-]*\w)/g, (_m, key) => hold(`\\cite{${key}}`));
  s = s.replace(LATEX_SPECIAL, (ch) => ESCAPE[ch]);
  s = s
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a, b) => `\\textbf{${a ?? b}}`)
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\*)|(?<!\w)\\_(?!\s)(.+?)(?<!\s)\\_(?!\w)/g, (_m, a, b) => `\\emph{${a ?? b}}`)
    .replace(/~~(.+?)~~/g, "\\sout{$1}")
    .replace(/"([^"]+)"/g, "``$1''");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)]);
}

const SECTION = ["section*", "subsection*", "subsubsection*", "paragraph", "paragraph", "paragraph"];

export function markdownToLatex(md: string): string {
  const out: string[] = [];
  const lists: { indent: number; env: string }[] = [];
  const closeLists = (indent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > indent) out.push(`${"  ".repeat(lists.length - 1)}\\end{${lists.pop()!.env}}`);
  };
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeLists();
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      out.push("\\begin{verbatim}", ...body, "\\end{verbatim}");
      continue;
    }
    const display = /^\s*\$\$(.*)$/.exec(line);
    if (display) {
      closeLists();
      const body: string[] = [];
      let rest = display[1];
      while (!rest.includes("$$") && i + 1 < lines.length) {
        body.push(rest);
        rest = lines[++i];
      }
      body.push(rest.slice(0, rest.indexOf("$$")));
      out.push("\\[", ...body.map((l) => l.trim()).filter(Boolean).map((l) => `  ${l}`), "\\]");
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeLists();
      out.push(`\\${SECTION[heading[1].length - 1]}{${inlineLatex(heading[2].trim())}}`);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (item) {
      const indent = item[1].replace(/\t/g, "  ").length;
      const env = /\d/.test(item[2]) ? "enumerate" : "itemize";
      closeLists(indent);
      // a numbered list right after a bulleted one (or the reverse) is a new list
      if (lists.length && lists[lists.length - 1].indent === indent && lists[lists.length - 1].env !== env) {
        out.push(`${"  ".repeat(lists.length - 1)}\\end{${lists.pop()!.env}}`);
      }
      if (!lists.length || lists[lists.length - 1].indent < indent) {
        out.push(`${"  ".repeat(lists.length)}\\begin{${env}}`);
        lists.push({ indent, env });
      }
      const box = item[3] === undefined ? "" : item[3] === " " ? "[$\\square$] " : "[$\\boxtimes$] ";
      out.push(`${"  ".repeat(lists.length)}\\item ${box}${inlineLatex(item[4])}`);
      continue;
    }
    if (/^\s*$/.test(line)) {
      // a blank line inside a list doesn't end it unless prose follows
      if (!lists.length || !/^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1] ?? "")) closeLists();
      out.push("");
      continue;
    }
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      closeLists();
      out.push("\\medskip\\hrule\\medskip");
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeLists();
      const body = [quote[1]];
      while (i + 1 < lines.length && /^>/.test(lines[i + 1])) body.push(lines[++i].replace(/^>\s?/, ""));
      out.push("\\begin{quote}", ...body.map(inlineLatex), "\\end{quote}");
      continue;
    }
    if (lists.length && /^\s+\S/.test(line)) {
      out.push(`${"  ".repeat(lists.length + 1)}${inlineLatex(line.trim())}`); // continuation of an item
      continue;
    }
    closeLists();
    out.push(inlineLatex(line));
  }
  closeLists();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Copy the selection (or the whole note) as LaTeX, ready to paste into the paper. */
export async function copyAsLatex() {
  const editor = activeEditor();
  if (!editor || !isNote(editor.dom.dataset.path)) return;
  const { from, to } = editor.state.selection.main;
  const md = from === to ? editor.state.doc.toString() : editor.state.sliceDoc(from, to);
  try {
    await navigator.clipboard.writeText(markdownToLatex(md));
    setStatus(from === to ? "Copied the note as LaTeX" : "Copied the selection as LaTeX");
  } catch (e) {
    setStatus(`Couldn't copy: ${e}`);
  }
}

// ---------- creating notes ----------
const two = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const longDate = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

export function newNote() {
  if (!root) return;
  promptInput({
    placeholder: "Note name",
    hint: "Saved in notes/ unless you give a folder, for example lectures/Week 3",
    value: `${NOTES_DIR}/Untitled.md`,
    validate: (v) => (/[<>:"|?*]/.test(v) ? "A name can't contain < > : \" | ? or *" : null),
    submit: async (value) => {
      let rel = value.replace(/^\/+/, "");
      if (!rel.includes("/")) rel = `${NOTES_DIR}/${rel}`;
      if (!NOTE.test(rel)) rel += ".md";
      await ensureNote(rel, `# ${noteName(rel)}\n\n`);
      await openFile(rel);
      afterChange();
    },
  });
}

export async function todaysNote() {
  if (!root) return;
  const today = new Date();
  const rel = `${NOTES_DIR}/${isoDate(today)}.md`;
  await ensureNote(rel, `# ${longDate(today)}\n\n`);
  await openFile(rel);
  afterChange();
}

const INBOX = `${NOTES_DIR}/Inbox.md`;

/** Jot something down without leaving what you are doing; it lands in notes/Inbox.md. */
export function quickNote() {
  if (!root) return;
  promptInput({
    placeholder: "Quick note",
    hint: "Added to notes/Inbox.md with the time. Enter to save, Escape to cancel.",
    submit: async (value) => {
      const now = new Date();
      const day = `## ${longDate(now)}`;
      const line = `- ${two(now.getHours())}:${two(now.getMinutes())} ${value}`;
      const add = (text: string) => {
        const base = text.trimEnd() || "# Inbox";
        return `${base}${base.split("\n").includes(day) ? "\n" : `\n\n${day}\n\n`}${line}\n`;
      };
      const editor = activeEditor();
      // The inbox is open with unsaved changes: add to the editor, not underneath it on disk.
      if (editor && editor.dom.dataset.path === INBOX) {
        const text = editor.state.doc.toString();
        editor.dispatch({ changes: { from: 0, to: text.length, insert: add(text) }, userEvent: "input" });
      } else {
        const text = await invoke<string>("read_file", { root, rel: INBOX }).catch(() => "");
        await invoke("write_file", { root, rel: INBOX, content: add(text) });
      }
      setStatus("Saved to notes/Inbox.md");
      afterChange();
    },
  });
}

/** Reading notes for a reference: notes/<key>.md, started from its BibTeX entry. */
export async function openCitationNote(key: string) {
  if (!root) return;
  const rel = `${NOTES_DIR}/${key}.md`;
  const entry = index.bib.find((b) => b.key === key);
  let content = `# ${entry?.title || key}\n\n@${key}\n\n## Summary\n\n## Key ideas\n\n## Quotes and page numbers\n\n`;
  if (entry?.file) {
    const bib = await invoke<string>("read_file", { root, rel: entry.file }).catch(() => "");
    const start = bib.search(new RegExp(`@\\w+\\s*\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,`));
    if (start >= 0) {
      const body = bib.slice(start, start + 4000);
      const field = (name: string) => new RegExp(`\\b${name}\\s*=\\s*[{"]((?:[^{}"]|\\{[^{}]*\\})*)[}"]`, "i").exec(body)?.[1].replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
      const authors = field("author")?.split(/\s+and\s+/).map((a) => (a.includes(",") ? a.split(",").reverse().join(" ").trim() : a)).join(", ");
      const year = field("year");
      const link = field("doi") ? `https://doi.org/${field("doi")}` : field("eprint") ? `https://arxiv.org/abs/${field("eprint")}` : field("url");
      const byline = [`@${key}`, authors, year].filter(Boolean).join(" · ");
      content = `# ${entry.title || key}\n\n${byline}${link ? `\n\n<${link}>` : ""}\n\n## Summary\n\n## Key ideas\n\n## Quotes and page numbers\n\n`;
    }
  }
  await ensureNote(rel, content);
  await openFile(rel);
  afterChange();
}

// ---------- notes panel ----------
const panel = $("notes-panel");
let filter = "";
let job = 0;

function afterChange() {
  if (!panel.hidden) renderNotes();
}

function row(rel: string, onClick: () => void, detail = ""): HTMLElement {
  const button = document.createElement("button");
  button.className = "note-row" + (rel === current ? " active" : "");
  button.title = rel;
  const name = document.createElement("span");
  name.className = "note-name";
  name.textContent = noteName(rel);
  button.appendChild(name);
  const where = detail || rel.slice(0, Math.max(0, rel.lastIndexOf("/")));
  if (where) {
    const dir = document.createElement("span");
    dir.className = "note-dir";
    dir.textContent = where;
    button.appendChild(dir);
  }
  button.onclick = onClick;
  return button;
}

function section(title: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "notes-heading";
  h.textContent = title;
  return h;
}

/** Does this note link to `rel`, by name or by path? */
function linksTo(text: string, rel: string): boolean {
  const name = noteName(rel).toLowerCase();
  const path = rel.replace(NOTE, "").toLowerCase();
  for (const m of text.matchAll(/\[\[([^\[\]\n|]+)/g)) {
    const target = m[1].trim().replace(NOTE, "").toLowerCase();
    if (target === name || target === path) return true;
  }
  return false;
}

// #tags: a # straight before a word, not a heading (which needs a space) or part of a word or link.
const TAG = /(?<![\p{L}\p{N}_#&/\\])#([\p{L}_][\p{L}\p{N}_\-\/]*)/gu;

export function tagsIn(text: string): string[] {
  const code = codeRanges(text);
  const maths = mathSpans(text);
  const out = new Set<string>();
  for (const m of text.matchAll(TAG)) {
    if (inside(code, m.index!) || maths.some((s) => m.index! >= s.from && m.index! < s.to)) continue;
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

// Statements worth finding again before an exam: "**Definition 2.1** …", "### Θεώρημα (Squeeze)" …
const STATEMENT = /^(?:#{1,6}\s+|>\s*)?(?:\*\*|__)?\s*(Definition|Theorem|Lemma|Proposition|Corollary|Example|Ορισμός|Θεώρημα|Λήμμα|Πρόταση|Πόρισμα|Παράδειγμα)\b(.*)$/i;
const KIND: Record<string, string> = {
  definition: "Definitions", ορισμός: "Definitions", theorem: "Theorems", θεώρημα: "Theorems",
  lemma: "Theorems", λήμμα: "Theorems", proposition: "Theorems", πρόταση: "Theorems", corollary: "Theorems",
  πόρισμα: "Theorems", example: "Examples", παράδειγμα: "Examples",
};

interface Statement { kind: string; title: string; note: string; line: number; }

function statementsIn(text: string, note: string): Statement[] {
  const out: Statement[] = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (/^```/.test(line)) fenced = !fenced;
    const m = !fenced && STATEMENT.exec(line);
    if (!m) return;
    // "Theorem 2.1 (Squeeze)": the name and its number or title, not the statement after it
    const rest = m[2].replace(/\*\*|__/g, "");
    const label = /^\s*([\d.]*\d)?\s*(\([^)]*\))?/.exec(rest)!;
    const title = [m[1], label[1], label[2]].filter(Boolean).join(" ");
    out.push({ kind: KIND[m[1].toLowerCase()] ?? "Theorems", title, note, line: i + 1 });
  });
  return out;
}

/** Lower case without accents, so "θεωρημα" finds "Θεώρημα". */
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

let activeTag: string | null = null;

/** Show the notes carrying a tag (from a ⌘-click on it in a note). */
export function filterByTag(tag: string) {
  activeTag = tag.toLowerCase();
  renderNotes();
}

export async function renderNotes() {
  if (!root || panel.hidden) return;
  const mine = ++job;
  const notes = (await listFiles()).filter((f) => NOTE.test(f)).sort((a, b) => a.localeCompare(b));
  // Every note's text, once: for search, tags, links and the statements list. The open note
  // comes from the editor, so what's shown includes unsaved edits.
  const texts = new Map<string, string>();
  await Promise.all(notes.map(async (n) => {
    const editor = activeEditor();
    texts.set(n, editor?.dom.dataset.path === n ? editor.state.doc.toString() : await invoke<string>("read_file", { root, rel: n }).catch(() => ""));
  }));
  if (mine !== job) return;
  const tags = new Map<string, string[]>();
  for (const n of notes) for (const tag of tagsIn(texts.get(n)!)) tags.set(tag, [...(tags.get(tag) ?? []), n]);
  if (activeTag && !tags.has(activeTag)) activeTag = null;

  const tools = document.createElement("div");
  tools.className = "notes-tools";
  const button = (label: string, title: string, run: () => void) => {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = label;
    b.title = title;
    b.onclick = run;
    return b;
  };
  tools.append(
    button("New note", "Start a note", newNote),
    button("Today", "Open today's note (⌥⌘T)", todaysNote),
    button("Quick note", "Jot something into the inbox (⌥⌘N)", quickNote),
  );
  if (isNote(current)) tools.append(button("PDF", "Typeset this note as a PDF", exportNotePdf));

  const search = document.createElement("input");
  search.className = "notes-filter";
  search.type = "search";
  search.placeholder = "Search notes";
  search.setAttribute("aria-label", "Search notes");
  search.value = filter;

  const chips = document.createElement("div");
  chips.className = "notes-tags";
  for (const [tag, where] of [...tags].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const chip = document.createElement("button");
    chip.className = "note-tag" + (tag === activeTag ? " active" : "");
    chip.textContent = `#${tag}`;
    chip.title = `${where.length} note${where.length === 1 ? "" : "s"}`;
    chip.setAttribute("aria-pressed", String(tag === activeTag));
    chip.onclick = () => {
      activeTag = tag === activeTag ? null : tag;
      renderNotes();
    };
    chips.appendChild(chip);
  }

  const list = document.createElement("div");
  list.className = "notes-list";
  const statements = document.createElement("div");
  const draw = () => {
    const q = fold(filter.trim());
    const inTag = activeTag ? new Set(tags.get(activeTag)) : null;
    const shown: [string, string][] = [];
    for (const n of notes) {
      if (inTag && !inTag.has(n)) continue;
      if (!q || fold(n).includes(q)) {
        shown.push([n, ""]);
        continue;
      }
      // A match inside the note shows the line it is on.
      const line = texts.get(n)!.split("\n").find((l) => fold(l).includes(q));
      if (line) shown.push([n, line.replace(/^[#>*\-\s]+/, "").trim()]);
    }
    list.replaceChildren(...shown.map(([n, hit]) => {
      const r = row(n, () => openFile(n));
      if (hit) {
        const snippet = document.createElement("span");
        snippet.className = "note-hit";
        snippet.textContent = hit;
        r.appendChild(snippet);
        r.classList.add("with-hit");
      }
      return r;
    }));
    if (!shown.length) {
      const none = document.createElement("div");
      none.className = "empty";
      none.textContent = notes.length ? "No note matches." : "No notes yet. Start one with New note, or press ⌥⌘T for today's.";
      list.appendChild(none);
    }

    // Definitions and theorems across the notes shown, for revising.
    const found = shown.flatMap(([n]) => statementsIn(texts.get(n)!, n));
    statements.replaceChildren();
    if (!found.length) return;
    const box = document.createElement("details");
    box.className = "notes-statements";
    box.open = statementsOpen;
    box.ontoggle = () => { statementsOpen = box.open; };
    const summary = document.createElement("summary");
    summary.textContent = `Definitions and theorems (${found.length})`;
    box.appendChild(summary);
    for (const kind of ["Definitions", "Theorems", "Examples"]) {
      const items = found.filter((s) => s.kind === kind);
      if (!items.length) continue;
      box.appendChild(section(kind));
      for (const s of items) {
        const r = row(s.note, () => revealLine(s.note, s.line), noteName(s.note));
        r.querySelector(".note-name")!.textContent = s.title;
        r.title = `${s.note}:${s.line}`;
        r.classList.remove("active"); // a statement, not the note itself
        box.appendChild(r);
      }
    }
    statements.appendChild(box);
  };
  search.oninput = () => {
    filter = search.value;
    draw();
  };
  draw();

  const parts: HTMLElement[] = [tools, search];
  if (tags.size) parts.push(chips);
  parts.push(list, statements);
  if (isNote(current)) {
    const links = notes.filter((n) => n !== current && linksTo(texts.get(n)!, current!));
    parts.push(section("Linked from"));
    if (links.length) {
      const box = document.createElement("div");
      box.className = "notes-list";
      box.append(...links.map((n) => row(n, () => openFile(n))));
      parts.push(box);
    } else {
      const none = document.createElement("div");
      none.className = "empty";
      none.textContent = `No note links here yet. Write [[${noteName(current!)}]] in another note.`;
      parts.push(none);
    }
  }

  // The shortcuts, where someone taking notes can glance at them.
  const help = document.createElement("details");
  help.className = "notes-help";
  const summary = document.createElement("summary");
  summary.textContent = "Maths shortcuts";
  help.appendChild(summary);
  const table = document.createElement("dl");
  const shortcuts: [string, string][] = [
    ["$", "inline maths; type $ again for a display formula"],
    ["Tab", "jump to the next field, or out of the formula"],
    ["//", "fraction"],
    [";a ;b ;g …", "Greek letters (;G for Γ)"],
    ["-> => <= >= != ~=", "→ ⟹ ≤ ≥ ≠ ≈"],
    ["** ...", "· …"],
    ["RR NN ZZ QQ CC", "number sets"],
    ["\\", "commands and templates (\\frac, \\int, \\pmatrix …)"],
    ["[[", "link to another note"],
    ["@", "cite a reference"],
    ["#word", "a tag, to find notes together"],
    ["**Definition** …", "listed under Definitions and theorems"],
    ["⌘V", "paste a screenshot or photo of the board"],
  ];
  for (const [keys, what] of shortcuts) {
    const dt = document.createElement("dt");
    dt.textContent = keys;
    const dd = document.createElement("dd");
    dd.textContent = what;
    table.append(dt, dd);
  }
  help.appendChild(table);
  parts.push(help);
  const hadFocus = document.activeElement?.classList.contains("notes-filter");
  panel.replaceChildren(...parts);
  if (hadFocus) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

let statementsOpen = true;

// ---------- a note as a PDF ----------
const NOTE_PREAMBLE = String.raw`\documentclass[11pt]{article}
\usepackage{iftex}
\ifPDFTeX
  \usepackage[utf8]{inputenc}
  \usepackage[T1]{fontenc}
  \usepackage{lmodern}
  \usepackage{textalpha}
\else
  \usepackage{fontspec}
  % a face with Greek as well as Latin, when the system has one
  \IfFontExistsTF{CMU Serif}{\setmainfont{CMU Serif}}{\IfFontExistsTF{Times New Roman}{\setmainfont{Times New Roman}}{}}
\fi
\usepackage[a4paper,margin=2.3cm]{geometry}
\usepackage{amsmath,amssymb,graphicx}
\usepackage[normalem]{ulem}
\usepackage[hidelinks]{hyperref}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0.6em}
`;

/** Typeset the open note (Markdown and maths) as a PDF in build/, and show it in the preview. */
export async function exportNotePdf() {
  const editor = activeEditor();
  const note = editor && isNote(editor.dom.dataset.path) ? editor.dom.dataset.path! : isNote(current) ? current! : null;
  if (!root || !note) return;
  const md = editor?.dom.dataset.path === note ? editor.state.doc.toString() : await invoke<string>("read_file", { root, rel: note });
  const folder = note.includes("/") ? note.slice(0, note.lastIndexOf("/") + 1) : "";
  // Spaces and accents in a TeX file name cause trouble with some engines; the PDF gets a plain one.
  const stem = noteName(note).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "note";
  const tex = `${NOTE_PREAMBLE}\\graphicspath{{${folder || "./"}}}\n\\begin{document}\n${markdownToLatex(md)}\\end{document}\n`;
  const main = `.scribe/notes/${stem}.tex`;
  setStatus(`Typesetting ${noteName(note)}…`, "busy");
  try {
    await invoke("write_file", { root, rel: main, content: tex });
    const res = await invoke<{ ok: boolean; log: string; pdf: string | null }>("compile", { root, main });
    if (!res.pdf) {
      setProblems(parseLog(res.log, main), res.log, true, "Note PDF");
      setStatus(`Couldn't typeset ${noteName(note)}. The log says why.`, "err");
      return;
    }
    setPaperless(false);
    await renderPdf(res.pdf);
    setStatus(`Saved ${res.pdf}`, "ok");
  } catch (e) {
    setStatus(String(e), "err");
  }
}

changeListeners.push(() => {
  if (!panel.hidden) renderNotes();
});
