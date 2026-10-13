// The main CodeMirror editor: theme, highlighting and LaTeX completion.
import { EditorView } from "codemirror";
import {
  crosshairCursor, drawSelection, dropCursor, gutter, GutterMarker, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection, tooltips,
} from "@codemirror/view";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import {
  bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, HighlightStyle, indentOnInput, StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { vim, Vim } from "@replit/codemirror-vim";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { python } from "@codemirror/lang-python";
import { autocompletion, closeBrackets, closeBracketsKeymap, Completion, CompletionContext, completionKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { compile, saveFile } from "./build";
import { $, current, setDirty } from "./core";
import { outlineChanged } from "./outline";
import { reportCursor } from "./statusbar";
import { closeTab } from "./tabs";
import { displayValue, index, scanLabels } from "./texindex";

// ---------- autocompletion ----------
export const LATEX_COMMANDS = [
  // document structure
  "documentclass", "usepackage", "begin", "end",
  "section", "subsection", "subsubsection", "paragraph",
  "title", "author", "date", "maketitle",
  "tableofcontents", "listoffigures", "listoftables",
  // text formatting
  "textbf", "textit", "texttt", "underline", "emph",
  "tiny", "small", "normalsize", "large", "Large", "huge", "Huge",
  // math
  "frac", "sqrt", "sum", "prod", "int", "lim",
  "alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "mu", "sigma", "omega",
  "mathbb", "mathcal", "mathfrak", "mathrm",
  "left", "right", "infty", "partial", "nabla",
  "leq", "geq", "neq", "approx", "equiv", "cdot", "times",
  // environments
  "equation", "align", "figure", "table", "itemize", "enumerate",
  "theorem", "proof", "lemma", "definition", "remark",
  // refs & citations
  "label", "ref", "eqref", "cite", "bibliography", "bibliographystyle",
  // figures
  "includegraphics", "caption", "centering", "nbfig",
  // misc
  "newcommand", "renewcommand", "input", "include",
  "hspace", "vspace", "noindent", "linebreak", "pagebreak",
].map((cmd) => ({
  label: "\\" + cmd,
  type: "keyword" as const,
  boost: cmd.length > 5 ? 0 : 1,
}));

const REF_COMMAND = /^(?:ref|eqref|autoref|cref|Cref|pageref|nameref|vref)$/;
const CITE_COMMAND = /^(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite|nocite)\*?$/;

const ENVIRONMENTS = [
  "document", "abstract", "figure", "table", "tabular", "equation", "align", "itemize", "enumerate",
  "description", "center", "theorem", "lemma", "proof", "definition", "quote", "verbatim", "minipage",
  "cases", "matrix", "pmatrix", "bmatrix", "frame", "equation*", "align*", "figure*", "table*",
];

const PACKAGES = [
  "amsmath", "amssymb", "amsthm", "graphicx", "hyperref", "booktabs", "xcolor", "geometry", "natbib",
  "biblatex", "cleveref", "siunitx", "subcaption", "tikz", "listings", "microtype", "scribe-figures",
];

// \begin{name} completes to the whole environment, with the cursor on the empty line inside.
function environmentOption(name: string): Completion {
  return {
    label: name,
    type: "class",
    apply: (target, _completion, from, to) => {
      const closed = target.state.sliceDoc(to, to + 1) === "}";
      const indent = /^\s*/.exec(target.state.doc.lineAt(from).text)![0];
      const head = `${name}}\n${indent}  `;
      target.dispatch({
        changes: { from, to: closed ? to + 1 : to, insert: `${head}\n${indent}\\end{${name}}` },
        selection: { anchor: from + head.length },
        userEvent: "input.complete",
      });
    },
  };
}

// What can go inside the braces of `\command{`, or null when there is nothing useful to offer.
function argumentOptions(command: string, doc: string): Completion[] | null {
  if (REF_COMMAND.test(command)) {
    // Labels in the open file count even before it is saved.
    return [...new Set([...scanLabels(doc), ...index.labels])].map((label) => ({ label, type: "constant" }));
  }
  if (CITE_COMMAND.test(command)) return index.bib.map((b) => ({ label: b.key, detail: b.title, type: "text" }));
  if (command === "nbfig") return index.figures.map((f) => ({ label: f.id, detail: f.notebook, type: "variable" }));
  if (command === "nbval" || command === "nbtable") {
    return index.values.map((v) => ({
      label: v.name,
      detail: displayValue(v.value),
      type: "variable",
    }));
  }
  if (command === "begin") return ENVIRONMENTS.map(environmentOption);
  if (command === "end") return ENVIRONMENTS.map((label) => ({ label, type: "class" }));
  if (command === "input" || command === "include" || command === "subfile") {
    return index.texFiles.map((f) => ({ label: f.replace(/\.tex$/, ""), type: "text" }));
  }
  if (command === "includegraphics") return index.graphics.map((label) => ({ label, type: "text" }));
  if (command === "usepackage" || command === "RequirePackage") return PACKAGES.map((label) => ({ label, type: "namespace" }));
  return null;
}

export function latexCompletion(context: CompletionContext) {
  // Inside an argument: \command[options]{a, b, partial
  const arg = context.matchBefore(/\\[a-zA-Z]+\*?(?:\[[^\]\n]*\])?\{[^{}\n]*/);
  if (arg) {
    const [, command, inside] = /^\\([a-zA-Z]+\*?)(?:\[[^\]\n]*\])?\{([^{}\n]*)$/.exec(arg.text)!;
    const partial = inside.slice(inside.lastIndexOf(",") + 1).trimStart();
    const options = argumentOptions(command, context.state.doc.toString());
    if (!options?.length) return null;
    return { from: context.pos - partial.length, options, validFor: /^[^{},\s]*$/ };
  }

  const before = context.matchBefore(/\\[a-zA-Z]*/);
  if (!before || (before.from === before.to && !context.explicit)) return null;
  return { from: before.from, options: LATEX_COMMANDS };
}

// ---------- editor ----------
// Completion lists and other tooltips attach to the body, so no pane or cell can clip them.
export const floatingTooltips = tooltips({ parent: document.body, position: "fixed" });

export const themeConf = new Compartment();
export const vimConf = new Compartment();
export const numbersConf = new Compartment();

export type LineNumberStyle = "absolute" | "relative" | "off";

/** Editor preferences, set from the project's settings. Kept here so new editor states can
 *  read them without this module depending on settings.ts at load time. */
export const editorPrefs = {
  dark: true,
  vim: false,
  numbers: "absolute" as LineNumberStyle,
  /** Notebook cells show line numbers too, in the same style. */
  cellNumbers: false,
};

class NumberMarker extends GutterMarker {
  constructor(readonly text: string) { super(); }
  eq(other: NumberMarker) { return this.text === other.text; }
  toDOM() { return document.createTextNode(this.text); }
}

// Vim-style relative numbers: the cursor's line shows its real number, every other line its
// distance from the cursor, so `5j` and `3k` can be read straight off the gutter.
const relativeNumbers = gutter({
  class: "cm-lineNumbers",
  lineMarker(target, line) {
    const number = target.state.doc.lineAt(line.from).number;
    const cursor = target.state.doc.lineAt(target.state.selection.main.head).number;
    return new NumberMarker(String(number === cursor ? number : Math.abs(number - cursor)));
  },
  lineMarkerChange: (update) => update.selectionSet || update.docChanged,
  initialSpacer: (target) => new NumberMarker("0".repeat(String(target.state.doc.lines).length)),
  updateSpacer: (_spacer, update) => new NumberMarker("0".repeat(String(update.state.doc.lines).length)),
});

export function numberGutter(style: LineNumberStyle): Extension {
  return style === "relative" ? relativeNumbers : style === "absolute" ? lineNumbers() : [];
}

/** Vim keys. The mode is shown in the app's status bar, so Vim's own mode line stays off. */
export const vimKeys = (on: boolean): Extension => (on ? vim() : []);

// :w, :q and :wq do what a Vim user expects of them here.
Vim.defineEx("write", "w", () => { saveFile(); });
Vim.defineEx("quit", "q", () => { if (current) closeTab(current); });
Vim.defineEx("wq", "wq", async () => {
  await saveFile();
  if (current) closeTab(current);
});

// codemirror's basicSetup without its line-number gutter, which numbersConf supplies instead.
const baseSetup: Extension = [
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap,
    ...lintKeymap,
  ]),
];

/** Effects that bring an editor state in line with the current preferences. */
export const prefEffects = () => [
  themeConf.reconfigure(editorTheme(editorPrefs.dark)),
  vimConf.reconfigure(vimKeys(editorPrefs.vim)),
  numbersConf.reconfigure(numberGutter(editorPrefs.numbers)),
];

// Colours are CSS variables so the editor follows the app theme without a rebuild;
// the dark flag only switches CodeMirror's own base styles.
export function editorTheme(dark: boolean): Extension {
  return EditorView.theme({
    "&": { color: "var(--fg)", backgroundColor: "var(--bg)", fontSize: "var(--editor-fs)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65", padding: "8px 0" },
    ".cm-content": { caretColor: "var(--accent)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "1.5px" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--select)",
    },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--faint)", border: "none", paddingRight: "8px" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 16px", fontSize: "0.85em", lineHeight: "1.94" },
    ".cm-activeLine": { backgroundColor: "var(--line-hl)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-dim)" },
    "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--active)", outline: "1px solid var(--border-hi)" },
    ".cm-selectionMatch": { backgroundColor: "var(--active)" },
    ".cm-searchMatch": { backgroundColor: "var(--accent-dim)", outline: "1px solid var(--accent)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--raised)", border: "none", color: "var(--muted)" },
    ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
    ".cm-textfield": { backgroundColor: "var(--bg)", border: "1px solid var(--border-hi)", borderRadius: "4px" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "var(--raised)", border: "1px solid var(--border-hi)", borderRadius: "4px" },
    ".cm-tooltip": {
      backgroundColor: "var(--raised)",
      color: "var(--fg)",
      border: "1px solid var(--border-hi)",
      borderRadius: "6px",
      overflow: "hidden",
    },
    // Vim: block cursor in the accent colour, command line in the editor's own type
    ".cm-fat-cursor": { background: "var(--accent) !important", color: "var(--on-accent) !important" },
    "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid var(--accent)", color: "inherit !important" },
    ".cm-vim-panel": { padding: "2px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", minHeight: "1.6em" },
    ".cm-vim-panel input": { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--fg)" },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-dim)", color: "var(--fg)" },
  }, { dark });
}

export const gruvbox = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--syn-kw)" },
  { tag: [t.tagName, t.macroName, t.standard(t.variableName)], color: "var(--syn-cmd)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-str)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.self], color: "var(--syn-num)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-cmt)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--syn-meta)" },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.className)], color: "var(--syn-type)" },
  { tag: [t.special(t.variableName), t.escape, t.labelName], color: "var(--syn-math)" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "var(--syn-meta)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--fg-dim)" },
  { tag: t.heading, color: "var(--syn-type)", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.link, color: "var(--syn-math)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--err)" },
]);

export function languageFor(path: string): Extension {
  if (path.endsWith(".py")) return python();
  if (path.endsWith(".ipynb")) return []; // only shown raw when the JSON is broken
  if (/\.(tex|sty|cls|bib)$/.test(path)) return StreamLanguage.define(stex);
  return [];
}

export function completionFor(path: string): Extension {
  if (/\.(tex|sty|cls|bib)$/.test(path)) {
    return autocompletion({ override: [latexCompletion] });
  }
  // Python gets built-in completions from the language mode
  return autocompletion();
}

/** What an editor does when its text changes or the user saves from inside it. */
export interface EditorHooks { onChange(): void; onSave(): void; }

const mainHooks: EditorHooks = {
  onChange: () => { if (current) setDirty(true); },
  onSave: () => { saveFile(); },
};

/** A fresh editor state for one file: its own undo history, language and completion.
 *  The side pane passes its own hooks; everything else uses the main file's. */
export function createEditorState(doc: string, path: string, hooks: EditorHooks = mainHooks): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      vimConf.of(vimKeys(editorPrefs.vim)), // first, so its keys win over the default keymap
      numbersConf.of(numberGutter(editorPrefs.numbers)),
      baseSetup,
      floatingTooltips,
      syntaxHighlighting(gruvbox),
      languageFor(path),
      completionFor(path),
      themeConf.of(editorTheme(editorPrefs.dark)),
      EditorView.lineWrapping,
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (hooks.onSave(), true) },
        { key: "Mod-Enter", preventDefault: true, run: () => (compile(), true) },
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          hooks.onChange();
          outlineChanged();
        }
        reportCursor(u.view);
      }),
    ],
  });
}

// One view for the whole app; switching files swaps its state (see tabs.ts).
export const view = new EditorView({ parent: $("editor"), state: createEditorState("", "") });
