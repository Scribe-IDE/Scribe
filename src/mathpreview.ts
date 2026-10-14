// Live maths preview: while the cursor is inside a formula, the rendered formula floats
// beside it, so the equation can be read without compiling.
import { EditorState, Extension, StateField } from "@codemirror/state";
import { showTooltip, Tooltip } from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";

/** Turned on and off from settings. */
export const mathPrefs = { on: true };

export interface MathSpan { from: number; to: number; tex: string; display: boolean; }

const ENVIRONMENTS = "equation|align|gather|multline|eqnarray|displaymath|math|alignat|flalign";
// Environments that align on &: KaTeX wants them as the "ed" forms inside display maths.
const INNER: Record<string, string> = { align: "aligned", alignat: "aligned", flalign: "aligned", eqnarray: "aligned", gather: "gathered", multline: "gathered" };

const PATTERNS: { re: RegExp; display: boolean; body: (m: RegExpExecArray) => string }[] = [
  {
    re: new RegExp(`\\\\begin\\{(${ENVIRONMENTS})(\\*?)\\}([\\s\\S]*?)\\\\end\\{\\1\\2\\}`, "g"),
    display: true,
    body: (m) => (INNER[m[1]] ? `\\begin{${INNER[m[1]]}}${m[3]}\\end{${INNER[m[1]]}}` : m[3]),
  },
  { re: /\\\[([\s\S]*?)\\\]/g, display: true, body: (m) => m[1] },
  { re: /\$\$([\s\S]*?)\$\$/g, display: true, body: (m) => m[1] },
  { re: /\\\(([\s\S]*?)\\\)/g, display: false, body: (m) => m[1] },
  { re: /(?<![\\$])\$((?:\\.|[^$\\\n])+)\$(?!\$)/g, display: false, body: (m) => m[1] },
];

/** The formula containing `pos`, if any. `offset` is where `text` starts in the document. */
export function mathAt(text: string, pos: number, offset = 0): MathSpan | null {
  for (const { re, display, body } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const from = offset + m.index;
      const to = from + m[0].length;
      if (pos <= from || pos >= to) continue;
      // Labels and numbering switches mean nothing to a preview.
      const tex = body(m).replace(/\\label\{[^{}]*\}|\\nonumber|\\notag/g, "").trim();
      return tex ? { from, to, tex, display } : null;
    }
  }
  return null;
}

/** Macros the document defines with \newcommand and friends, in KaTeX's form. */
export function documentMacros(doc: string): Record<string, string> {
  const macros: Record<string, string> = {
    "\\nbval": "\\text{#1}",
    "\\nbmath": "\\text{#1}",
  };
  for (const m of doc.matchAll(/\\(?:re)?newcommand\*?\{?(\\[a-zA-Z]+)\}?(?:\[\d\])?\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g)) {
    macros[m[1]] = m[2];
  }
  for (const m of doc.matchAll(/\\DeclareMathOperator\*?\{(\\[a-zA-Z]+)\}\{([^{}]*)\}/g)) {
    macros[m[1]] = `\\operatorname{${m[2]}}`;
  }
  return macros;
}

function tooltipFor(state: EditorState): Tooltip | null {
  if (!mathPrefs.on) return null;
  const pos = state.selection.main.head;
  // Formulas are short; looking a couple of thousand characters either way keeps this cheap.
  const start = Math.max(0, pos - 2500);
  const span = mathAt(state.sliceDoc(start, Math.min(state.doc.length, pos + 2500)), pos, start);
  if (!span) return null;
  return {
    pos: span.from,
    end: span.to,
    above: false,
    arrow: false,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-math-preview";
      katex.render(span.tex, dom, {
        displayMode: span.display,
        throwOnError: false,
        errorColor: "var(--err)",
        macros: documentMacros(state.sliceDoc(0, Math.min(state.doc.length, 20000))),
      });
      return { dom };
    },
  };
}

interface Shown { key: string; tooltip: Tooltip | null; }

const field = StateField.define<Shown>({
  create: (state) => ({ key: "", tooltip: tooltipFor(state) }),
  update(value, tr) {
    const tooltip = tooltipFor(tr.state);
    if (!tooltip) return value.tooltip ? { key: "", tooltip: null } : value;
    // Keep the same tooltip while the formula is unchanged, so it doesn't flicker as the cursor moves.
    const key = `${tooltip.pos}:${tooltip.end}:${tr.state.sliceDoc(tooltip.pos, tooltip.end)}`;
    return key === value.key ? value : { key, tooltip };
  },
  provide: (f) => showTooltip.from(f, (shown) => shown.tooltip),
});

/** Maths preview for a file, or nothing if it isn't LaTeX. */
export function mathPreview(path: string): Extension {
  return path.endsWith(".tex") ? field : [];
}

/** A formula as HTML, for places outside the editor (the symbol palette). */
export const renderMath = (tex: string) => katex.renderToString(tex, { throwOnError: false });
