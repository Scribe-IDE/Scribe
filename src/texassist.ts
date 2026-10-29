// Help while writing LaTeX: what a \ref, \cite, \nbval or \nbfig points at, shown on hover
// (the equation typeset, the figure drawn, the paper's details), and the writing checks of
// lint.ts underlined with their fixes.
import { invoke } from "@tauri-apps/api/core";
import { type Diagnostic, forceLinting, linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip } from "@codemirror/view";
import katex from "katex";
import * as pdfjs from "pdfjs-dist";
import { mainFile, root, VIEWABLE } from "./core";
import { lintTex, RULES, type RuleId } from "./lint";
import { documentMacros } from "./mathpreview";
import { displayValue, index } from "./texindex";

const REF = /^(?:ref|eqref|autoref|cref|Cref|pageref|nameref|vref)$/;
const CITE = /^(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|nocite)\*?$/;

// ---------- finding things ----------
/** The command whose argument is under `pos` on its line, and the key under the pointer. */
function argumentAt(view: EditorView, pos: number): { command: string; key: string; from: number; to: number } | null {
  const line = view.state.doc.lineAt(pos);
  for (const m of line.text.matchAll(/\\([a-zA-Z]+\*?)(?:\[[^\]]*\])*\{([^}]*)\}/g)) {
    const open = line.from + m.index! + m[0].lastIndexOf("{") + 1;
    const close = line.from + m.index! + m[0].length - 1;
    if (pos < line.from + m.index! || pos > close) continue;
    // one key of several: \cite{a, b}
    let at = open;
    for (const part of m[2].split(",")) {
      const end = at + part.length;
      if (pos <= end || end >= close) return { command: m[1], key: part.trim(), from: at, to: end };
      at = end + 1;
    }
  }
  return null;
}

let sources: { at: number; files: Map<string, string> } | null = null;

/** The project's .tex files (the open one as typed), read at most every few seconds. */
async function texSources(view: EditorView, path: string): Promise<Map<string, string>> {
  if (!sources || Date.now() - sources.at > 5000) {
    const files = new Map<string, string>();
    await Promise.all(index.texFiles.map(async (f) => files.set(f, await invoke<string>("read_file", { root, rel: f }).catch(() => ""))));
    sources = { at: Date.now(), files };
  }
  const files = new Map(sources.files);
  files.set(path, view.state.doc.toString());
  return files;
}

const MATH = "equation|align|gather|multline|eqnarray|flalign|alignat";
const FLOAT = "figure|table|wrapfigure|subfigure";
const THEOREM = "theorem|lemma|proposition|corollary|definition|remark|example|claim|conjecture";

interface Labelled { file: string; line: number; text: string; env: string | null; body: string; title: string | null }

/** Where `\label{name}` is, and what it labels: an environment's body, or a section's title. */
function findLabel(files: Map<string, string>, name: string): Labelled | null {
  const needle = `\\label{${name}}`;
  for (const [file, text] of files) {
    let at = text.indexOf(needle);
    while (at >= 0 && /(^|[^\\])%[^\n]*$/.test(text.slice(text.lastIndexOf("\n", at) + 1, at))) at = text.indexOf(needle, at + 1);
    if (at < 0) continue;
    const line = text.slice(0, at).split("\n").length;
    // the innermost environment still open at the label
    const re = new RegExp(`\\\\begin\\{(${MATH}|${FLOAT}|${THEOREM})(\\*?)\\}`, "g");
    let env: { name: string; bodyFrom: number; bodyTo: number } | null = null;
    for (const m of text.slice(0, at).matchAll(re)) {
      const end = text.indexOf(`\\end{${m[1]}${m[2]}}`, m.index!);
      if (end > at) env = { name: m[1], bodyFrom: m.index! + m[0].length, bodyTo: end };
    }
    if (env) return { file, line, text, env: env.name, body: text.slice(env.bodyFrom, env.bodyTo), title: null };
    const section = [...text.slice(Math.max(0, at - 400), at).matchAll(/\\(chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}/g)].pop();
    return { file, line, text, env: null, body: "", title: section ? section[2] : null };
  }
  return null;
}

/** A .bib entry's fields. */
async function bibEntry(key: string): Promise<Record<string, string> | null> {
  const entry = index.bib.find((b) => b.key === key);
  if (!entry) return null;
  const bib = await invoke<string>("read_file", { root, rel: entry.file }).catch(() => "");
  const start = bib.search(new RegExp(`@\\w+\\s*\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,`));
  if (start < 0) return { title: entry.title };
  const fields: Record<string, string> = { type: /@(\w+)/.exec(bib.slice(start))![1].toLowerCase() };
  const body = bib.slice(start);
  const re = /(\w+)\s*=\s*/g;
  re.lastIndex = body.indexOf(",") + 1;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    let i = re.lastIndex;
    let value = "";
    if (body[i] === "{") {
      let depth = 0;
      const open = i;
      for (; i < body.length; i++) {
        if (body[i] === "{") depth++;
        else if (body[i] === "}" && --depth === 0) break;
      }
      value = body.slice(open + 1, i);
    } else if (body[i] === '"') {
      const close = body.indexOf('"', i + 1);
      value = body.slice(i + 1, close);
      i = close;
    } else {
      value = /^[^,}\s]+/.exec(body.slice(i))?.[0] ?? "";
      i += value.length;
    }
    fields[m[1].toLowerCase()] = value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
    re.lastIndex = i + 1;
    if (/^\s*}/.test(body.slice(i + 1))) break; // the entry ends
  }
  return fields;
}

// ---------- drawing ----------
function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Page one of a PDF, `width` px wide. */
async function pdfThumb(bytes: Uint8Array, width = 280): Promise<HTMLCanvasElement> {
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: (Math.min(width, base.width * 1.5) / base.width) * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    canvas.style.width = `${vp.width / dpr}px`;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    return canvas;
  } finally {
    pdf.destroy();
  }
}

/** A picture in the project: `figures/x` with or without its extension. */
async function projectImage(path: string): Promise<HTMLElement | null> {
  const candidates = VIEWABLE.test(path) ? [path] : [".pdf", ".png", ".jpg", ".jpeg"].map((ext) => path + ext);
  const rel = candidates.find((c) => index.graphics.includes(c)) ?? candidates[0];
  const bytes = await invoke<ArrayBuffer>("read_binary", { root, rel }).catch(() => null);
  if (!bytes) return null;
  if (rel.endsWith(".pdf")) return pdfThumb(new Uint8Array(bytes));
  const img = document.createElement("img");
  img.src = URL.createObjectURL(new Blob([bytes]));
  return img;
}

const plain = (tex: string, trim = true) => tex
  .replace(/``|''/g, (q) => (q === "``" ? "\u201c" : "\u201d"))
  .replace(/---/g, "\u2014").replace(/--/g, "\u2013")
  .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, "")
  .replace(/[{}~]/g, (c) => (c === "~" ? " " : ""))
  .replace(/\s+/g, " ")[trim ? "trim" : "toString"]();

/** Text from LaTeX, its maths typeset and notebook values filled in. */
function rich(tex: string, cls: string): HTMLElement {
  const out = el("div", cls);
  const filled = tex.replace(/\\nbval\{([^}]*)\}/g, (_m, name: string) => {
    const v = index.values.find((x) => x.name === name);
    return v?.value ? `\u0000${displayValue(v.value)}\u0000` : name;
  });
  for (const [i, part] of filled.split(/(\$[^$]+\$)/).entries()) {
    if (i % 2) {
      const span = document.createElement("span");
      katex.render(part.slice(1, -1), span, { throwOnError: false });
      out.append(span);
    } else {
      // the spaces around a formula stay
      out.append(plain(part, false).replace(/\u0000/g, ""));
    }
  }
  return out;
}

function where(file: string, line: number): HTMLElement {
  return el("div", "hover-where", `${file}, line ${line}`);
}

async function labelCard(view: EditorView, path: string, name: string): Promise<HTMLElement | null> {
  const found = findLabel(await texSources(view, path), name);
  if (!found) {
    const card = el("div", "hover-card");
    card.append(el("div", "hover-missing", `Nothing has \\label{${name}} yet.`));
    return card;
  }
  const card = el("div", "hover-card");
  const { env, body } = found;
  if (env && new RegExp(`^(${MATH})$`).test(env)) {
    // the formula without its label, set as the paper sets it
    let tex = body.replace(/\\label\{[^}]*\}|\\nonumber|\\notag/g, "").trim();
    if (/^(align|eqnarray|flalign|alignat)$/.test(env)) tex = `\\begin{aligned}${tex}\\end{aligned}`;
    else if (env === "gather") tex = `\\begin{gathered}${tex}\\end{gathered}`;
    const math = el("div", "hover-math");
    katex.render(tex, math, { displayMode: true, throwOnError: false, macros: documentMacros(found.text.slice(0, 20000)) });
    card.append(math);
  } else if (env && new RegExp(`^(${FLOAT})$`).test(env)) {
    const caption = /\\caption\s*(?:\[[^\]]*\])?\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(body)?.[1];
    const picture = el("div", "hover-picture", "…");
    card.append(picture);
    if (caption) card.append(rich(caption, "hover-caption"));
    (async () => {
      let shown: HTMLElement | null = null;
      const nbfig = /\\nbfig\{([^}]+)\}/.exec(body);
      const graphic = /\\includegraphics\s*(?:\[[^\]]*\])?\{([^}]+)\}/.exec(body);
      const tikz = /\\begin\{(tikzpicture|tikzcd|circuitikz)\}[\s\S]*?\\end\{\1\}/.exec(body);
      if (nbfig) shown = await projectImage(`figures/${nbfig[1]}.pdf`);
      else if (graphic) shown = await projectImage(graphic[1].trim());
      else if (tikz) {
        const paper = await invoke<string>("read_file", { root, rel: mainFile }).catch(() => "");
        const { tikzPdf } = await import("./gallery"); // not at load time: the gallery needs most of the app
        const pdf = await tikzPdf(tikz[0], paper);
        if (pdf) shown = await pdfThumb(pdf);
      }
      if (shown) picture.replaceChildren(shown);
      else picture.remove();
    })().catch(() => picture.remove());
  } else if (env) {
    card.append(el("div", "hover-title", env[0].toUpperCase() + env.slice(1)));
    const text = plain(body.replace(/\\label\{[^}]*\}/g, ""));
    card.append(el("div", "hover-text", text.length > 280 ? `${text.slice(0, 280)}…` : text));
  } else {
    card.append(el("div", "hover-title", found.title ? `Section: ${plain(found.title)}` : `\\label{${name}}`));
  }
  card.append(where(found.file, found.line));
  return card;
}

async function citeCard(key: string): Promise<HTMLElement> {
  const card = el("div", "hover-card");
  const f = await bibEntry(key);
  if (!f) {
    card.append(el("div", "hover-missing", `No entry ${key} in the bibliography.`));
    return card;
  }
  if (f.title) card.append(el("div", "hover-title", f.title));
  if (f.author) {
    const names = f.author.split(/\s+and\s+/).map((a) => (a.includes(",") ? a.split(",").reverse().join(" ").trim() : a));
    card.append(el("div", "hover-text", names.length > 3 ? `${names.slice(0, 3).join(", ")} et al.` : names.join(", ")));
  }
  const venue = f.journal ?? f.booktitle ?? f.publisher ?? f.school ?? f.howpublished;
  const year = f.year ?? f.date?.slice(0, 4);
  if (venue || year) card.append(el("div", "hover-caption", [venue, year].filter(Boolean).join(", ")));
  if (f.doi) card.append(el("div", "hover-where", `doi:${f.doi}`));
  return card;
}

function valueCard(name: string): HTMLElement {
  const card = el("div", "hover-card");
  const v = index.values.find((x) => x.name === name);
  if (!v) {
    card.append(el("div", "hover-missing", `No notebook makes ${name} yet.`));
    return card;
  }
  card.append(el("div", "hover-value", displayValue(v.value)));
  card.append(el("div", "hover-where", `${v.notebook}${v.value == null ? ": run it to get the value" : ""}`));
  return card;
}

async function figureCard(id: string): Promise<HTMLElement> {
  const card = el("div", "hover-card");
  const shown = await projectImage(`figures/${id}.pdf`).catch(() => null);
  card.append(shown ?? el("div", "hover-missing", `figures/${id}.pdf isn't made yet. Run its notebook.`));
  const fig = index.figures.find((f) => f.id === id);
  if (fig) card.append(el("div", "hover-where", `${fig.notebook}${fig.stale ? ", out of date" : ""}`));
  return card;
}

function texHover(path: string): Extension {
  return hoverTooltip(async (view, pos) => {
    const at = argumentAt(view, pos);
    if (!at || !at.key) return null;
    let card: HTMLElement | null = null;
    if (REF.test(at.command)) card = await labelCard(view, path, at.key);
    else if (CITE.test(at.command)) card = await citeCard(at.key);
    else if (at.command === "nbval") card = valueCard(at.key);
    else if (at.command === "nbfig") card = await figureCard(at.key);
    if (!card) return null;
    const dom = card;
    return { pos: at.from, end: at.to, above: true, create: () => ({ dom }) };
  }, { hoverTime: 350 });
}

// ---------- writing checks ----------
const OFF_KEY = "scribe.lintOff";

export const lintPrefs = { on: true, off: new Set<RuleId>() };
try {
  const saved = JSON.parse(localStorage.getItem(OFF_KEY) ?? "null");
  if (saved) {
    lintPrefs.on = saved.on !== false;
    lintPrefs.off = new Set(saved.off ?? []);
  }
} catch { /* defaults */ }

export function saveLintPrefs() {
  try {
    localStorage.setItem(OFF_KEY, JSON.stringify({ on: lintPrefs.on, off: [...lintPrefs.off] }));
  } catch { /* no storage */ }
}

const texLinter = linter((view) => {
  if (!lintPrefs.on) return [];
  return lintTex(view.state.doc.toString(), lintPrefs.off).map((issue): Diagnostic => ({
    from: issue.from,
    to: issue.to,
    severity: "info",
    source: RULES[issue.rule],
    message: issue.message,
    actions: [
      ...(issue.fix ? [{
        name: issue.fixLabel ?? "Fix",
        apply: (v: EditorView) => v.dispatch({ changes: issue.fix!, userEvent: "input" }),
      }] : []),
      {
        name: "Turn off this check",
        apply: (v: EditorView) => {
          lintPrefs.off.add(issue.rule);
          saveLintPrefs();
          forceLinting(v);
        },
      },
    ],
  }));
}, { delay: 600 });

/** Hover previews and writing checks for a LaTeX file; nothing for other files. */
export function texAssist(path: string): Extension {
  return path.endsWith(".tex") ? [texHover(path), texLinter] : [];
}
