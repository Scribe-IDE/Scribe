// Finding the prose in a source file: what counts as a word for the word count, and which
// words are worth spell-checking. Pure, so it can be tested on its own.

export type ProseKind = "tex" | "plain";

/** Files whose text is written for people: LaTeX sources, Markdown and plain text. */
export function proseKind(path: string | null): ProseKind | null {
  if (!path) return null;
  if (path.endsWith(".tex")) return "tex";
  if (/\.(md|txt)$/.test(path)) return "plain";
  return null;
}

// Replace a match with spaces (newlines kept), so every remaining character keeps its offset.
const blank = (match: string) => match.replace(/[^\n]/g, " ");

const MATH_ENV = "equation|align|gather|multline|eqnarray|math|displaymath|alignat|flalign";
const CODE_ENV = "verbatim|lstlisting|minted|tikzpicture|tabular";
// Commands whose arguments are names, keys or paths, never prose.
const OPAQUE =
  "label|ref|eqref|autoref|cref|Cref|pageref|nameref|vref|cite[a-zA-Z]*|parencite|textcite|autocite|footcite|nocite|" +
  "includegraphics|usepackage|RequirePackage|documentclass|begin|end|input|include|subfile|bibliography|" +
  "bibliographystyle|nbfig|nbval|nbtable|url|newcommand|renewcommand|setlength|vspace|hspace|texttt|verb|color";

/** The text with everything that is not prose blanked out, same length as the input. */
export function maskProse(text: string, kind: ProseKind): string {
  if (kind === "plain") return text;
  let t = text.replace(/(^|[^\\])(%[^\n]*)/g, (_m, lead: string, comment: string) => lead + blank(comment));
  // The preamble configures the document; the paper starts at \begin{document}.
  const body = t.indexOf("\\begin{document}");
  if (body !== -1) t = blank(t.slice(0, body)) + t.slice(body);
  t = t
    .replace(new RegExp(`\\\\begin\\{(${MATH_ENV}|${CODE_ENV})\\*?\\}[\\s\\S]*?\\\\end\\{\\1\\*?\\}`, "g"), blank)
    .replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, blank)
    .replace(/\$\$[\s\S]*?\$\$/g, blank)
    .replace(/(^|[^\\])(\$[^$\n]*\$)/g, (_m, lead: string, math: string) => lead + blank(math))
    .replace(new RegExp(`\\\\(?:${OPAQUE})\\*?(?:\\s*\\[[^\\]]*\\])*(?:\\s*\\{[^{}]*\\})*`, "g"), blank)
    .replace(/\\[a-zA-Z@]+\*?|\\./g, blank);
  return t;
}

const WORD = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu;

export function countWords(text: string, kind: ProseKind): number {
  return maskProse(text, kind).match(WORD)?.length ?? 0;
}

export interface WordSpan { word: string; from: number; to: number; }

/** Words to spell-check, with their positions: letters only, no acronyms, nothing one letter long. */
export function spellWords(text: string, kind: ProseKind): WordSpan[] {
  const out: WordSpan[] = [];
  for (const m of maskProse(text, kind).matchAll(/\p{L}[\p{L}\p{M}]*(?:['’]\p{L}+)*/gu)) {
    const word = m[0];
    if (word.length < 2 || word === word.toUpperCase()) continue;
    // A word glued to digits or underscores (x2, fig_a) is an identifier, not prose.
    const before = text[m.index! - 1] ?? " ";
    const after = text[m.index! + word.length] ?? " ";
    if (/[\p{N}_]/u.test(before) || /[\p{N}_]/u.test(after)) continue;
    out.push({ word, from: m.index!, to: m.index! + word.length });
  }
  return out;
}
