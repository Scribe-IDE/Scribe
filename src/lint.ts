// Checks of LaTeX writing as you type: the small things copy editors fix (a breakable space
// before \ref, "the the", straight quotes, $$, \bf), each with a fix. Pure, so it can be tested
// on its own; editor.ts shows the results through @codemirror/lint.
import { maskProse } from "./prose";

export interface Fix { from: number; to: number; insert: string }
export interface Issue {
  rule: RuleId;
  from: number;
  to: number;
  message: string;
  /** What the fix does, for its button. */
  fixLabel?: string;
  fix?: Fix[];
}

export type RuleId =
  | "tilde" | "repeated" | "quotes" | "displaymath" | "oldfont" | "dots" | "footnote" | "labelcaption"
  | "leftright" | "abbrev" | "capsperiod";

export const RULES: Record<RuleId, string> = {
  tilde: "A non-breaking space before \\ref and \\cite",
  repeated: "The same word twice",
  quotes: "Straight quotes",
  displaymath: "$$ … $$ instead of \\[ … \\]",
  oldfont: "\\bf, \\it and the like",
  dots: "Three full stops instead of \\dots",
  footnote: "A space before \\footnote",
  labelcaption: "\\label before \\caption",
  leftright: "\\left without \\right",
  abbrev: "e.g. and i.e. followed by a full stop's space",
  capsperiod: "A sentence ending in capitals",
};

const blank = (match: string) => match.replace(/[^\n]/g, " ");
const CODE_ENV = "verbatim|lstlisting|minted|comment";

/** The source with comments, the preamble and code listings blanked out, offsets kept. */
export function maskCode(text: string): string {
  let t = text.replace(/(^|[^\\])(%[^\n]*)/g, (_m, lead: string, comment: string) => lead + blank(comment));
  const body = t.indexOf("\\begin{document}");
  if (body !== -1) t = blank(t.slice(0, body)) + t.slice(body);
  return t.replace(new RegExp(`\\\\begin\\{(${CODE_ENV})\\*?\\}[\\s\\S]*?\\\\end\\{\\1\\*?\\}`, "g"), blank)
    .replace(/\\verb(.)[^\n]*?\1/g, blank);
}

/** The `{…}` group opening at `open`: where it closes, or -1. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

const OLD_FONTS: Record<string, string> = { bf: "textbf", it: "textit", rm: "textrm", sc: "textsc", tt: "texttt", sf: "textsf", sl: "textsl" };

export function lintTex(text: string, off: ReadonlySet<RuleId> = new Set()): Issue[] {
  const code = maskCode(text);
  const prose = maskProse(text, "tex");
  const out: Issue[] = [];
  const add = (issue: Issue) => {
    if (!off.has(issue.rule)) out.push(issue);
  };

  // Figure \ref{x}: a line break between "Figure" and its number reads badly.
  for (const m of code.matchAll(/([A-Za-z.,)])([ \t]+)\\(ref|eqref|autoref|cref|pageref|cite[pt]?|citep|citet)\{/g)) {
    if (m[3].startsWith("cite") && /[.,)]/.test(m[1])) continue; // "…as shown. \cite" is a choice
    const from = m.index! + 1;
    add({ rule: "tilde", from, to: from + m[2].length, message: `Use ~ before \\${m[3]}, so a line can't break between the word and its number.`, fixLabel: "Use ~", fix: [{ from, to: from + m[2].length, insert: "~" }] });
  }

  // "the the", across a line break too
  for (const m of prose.matchAll(/\b([A-Za-z]{2,})(\s+)(\1)\b/gi)) {
    if (m[1].toLowerCase() !== m[3].toLowerCase() || /^(that|had|is)$/i.test(m[1])) continue;
    const from = m.index! + m[1].length;
    const to = from + m[2].length + m[3].length;
    add({ rule: "repeated", from: from + m[2].length, to, message: `"${m[1]}" twice in a row.`, fixLabel: "Delete the second", fix: [{ from, to, insert: "" }] });
  }

  // "text" → ``text''
  for (const m of prose.matchAll(/"([^"\n]{1,200})"/g)) {
    const from = m.index!;
    const to = from + m[0].length;
    add({ rule: "quotes", from, to, message: "LaTeX quotes open with `` and close with ''.", fixLabel: "Use `` and ''", fix: [{ from, to: from + 1, insert: "``" }, { from: to - 1, to, insert: "''" }] });
  }

  // $$ … $$ → \[ … \]
  for (const m of code.matchAll(/\$\$([\s\S]*?)\$\$/g)) {
    const from = m.index!;
    const to = from + m[0].length;
    add({ rule: "displaymath", from, to, message: "$$ … $$ is plain TeX; in LaTeX use \\[ … \\], which spaces the formula properly.", fixLabel: "Use \\[ … \\]", fix: [{ from, to: from + 2, insert: "\\[" }, { from: to - 2, to, insert: "\\]" }] });
  }

  // {\bf text} → \textbf{text}
  for (const m of code.matchAll(/\{\\(bf|it|rm|sc|tt|sf|sl)\b\s*/g)) {
    const open = m.index!;
    const close = closeOf(text, open);
    const cmd = OLD_FONTS[m[1]];
    if (close < 0) continue;
    add({
      rule: "oldfont", from: open, to: close + 1, message: `\\${m[1]} is from LaTeX 2.09; \\${cmd}{…} handles spacing and nesting properly.`,
      fixLabel: `Use \\${cmd}`, fix: [{ from: open, to: open + m[0].length, insert: `\\${cmd}{` }],
    });
  }

  // ... → \dots
  for (const m of prose.matchAll(/(?<!\.)\.\.\.(?!\.)/g)) {
    const from = m.index!;
    add({ rule: "dots", from, to: from + 3, message: "Three full stops are spaced too tightly; \\dots spaces them as an ellipsis.", fixLabel: "Use \\dots", fix: [{ from, to: from + 3, insert: "\\dots{}" }] });
  }

  // text \footnote → text\footnote
  for (const m of code.matchAll(/(\S)([ \t]+)\\footnote\{/g)) {
    const from = m.index! + 1;
    add({ rule: "footnote", from, to: from + m[2].length, message: "The space before \\footnote shows up in the text before the footnote mark.", fixLabel: "Remove the space", fix: [{ from, to: from + m[2].length, insert: "" }] });
  }

  // \label before \caption in a float points at the section, not the figure
  for (const m of code.matchAll(/\\begin\{(figure|table)\*?\}([\s\S]*?)\\end\{\1\*?\}/g)) {
    const body = m[2];
    const start = m.index! + m[0].indexOf(body);
    const label = /\\label\{[^}]*\}/.exec(body);
    const caption = /\\caption\s*(\[[^\]]*\])?\{/.exec(body);
    if (!label || !caption || label.index > caption.index) continue;
    const from = start + label.index;
    const captionEnd = closeOf(text, start + caption.index + caption[0].length - 1);
    if (captionEnd < 0) continue;
    add({
      rule: "labelcaption", from, to: from + label[0].length,
      message: "A \\label before the \\caption refers to the section, not this figure; put it after the caption.",
      fixLabel: "Move it after the caption",
      fix: [{ from, to: from + label[0].length, insert: "" }, { from: captionEnd + 1, to: captionEnd + 1, insert: label[0] }],
    });
  }

  // \left without \right in one formula
  // $$…$$ first, so its dollars aren't read as two inline formulas
  const mathBlocks = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$\n]+\$|\\begin\{(equation|align|gather|multline)\*?\}[\s\S]*?\\end\{\1\*?\}/g;
  for (const m of code.matchAll(mathBlocks)) {
    const body = m[0];
    const lefts = (body.match(/\\left(?![a-zA-Z])/g) ?? []).length;
    const rights = (body.match(/\\right(?![a-zA-Z])/g) ?? []).length;
    if (lefts === rights) continue;
    add({ rule: "leftright", from: m.index!, to: m.index! + body.length, message: `${lefts} \\left and ${rights} \\right in this formula; each \\left needs a \\right (\\right. closes it invisibly).` });
  }

  // e.g. text → e.g.\ text (a full stop's space would be too wide)
  for (const m of prose.matchAll(/\b(e\.g|i\.e|et al|cf|vs)\.( )(?=[a-z0-9(])/g)) {
    const from = m.index! + m[0].length - 1;
    add({ rule: "abbrev", from: m.index!, to: from + 1, message: `After "${m[1]}." LaTeX puts the wider space it uses between sentences.`, fixLabel: "Use \\ ", fix: [{ from, to: from + 1, insert: "\\ " }] });
  }

  // …by NASA. Next → NASA\@. (after capitals LaTeX assumes no sentence ends)
  for (const m of prose.matchAll(/\b([A-Z]{2,})\.(\s+)(?=[A-Z])/g)) {
    const at = m.index! + m[1].length;
    add({ rule: "capsperiod", from: m.index!, to: at + 1, message: "LaTeX doesn't end a sentence after capitals, so the space after this full stop comes out short.", fixLabel: "Add \\@", fix: [{ from: at, to: at, insert: "\\@" }] });
  }

  return out.sort((a, b) => a.from - b.from);
}
