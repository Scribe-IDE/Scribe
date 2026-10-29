// Tracked changes and comments as LaTeX, with the `changes` package: \added[id=GK]{new},
// \deleted[id=GK]{old}, \replaced[id=GK]{new}{old}, \comment[id=GK]{note} and
// \highlight[id=GK, comment={note}]{text}. Kept in the source, so they travel with git, show in
// colour in the PDF, and work for co-authors on any editor (Overleaf too). Pure.

export type MarkKind = "added" | "deleted" | "replaced" | "comment" | "highlight";

export interface Mark {
  kind: MarkKind;
  /** The whole command, from its backslash to its last brace. */
  from: number;
  to: number;
  /** The author's id (`id=GK`), if given. */
  id: string | null;
  /** A note attached with `comment={…}`, or the text of a \comment. */
  note: string | null;
  /** The first {…} argument's inside: the new text, the deleted text, the comment, the highlighted text. */
  body: [number, number];
  /** \replaced's second argument: the old text. */
  old: [number, number] | null;
}

const KINDS = "added|deleted|replaced|comment|highlight";

/** The `{…}` group opening at `open`: where it closes, or -1. */
function closeBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** The end of `[…]` opening at `open`, braces respected, or -1. */
function closeBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "]" && depth === 0) return i;
  }
  return -1;
}

/** One option's value from `[a=b, comment={c}]`. */
function option(options: string, key: string): string | null {
  const m = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*`).exec(options);
  if (!m) return null;
  const start = m.index + m[0].length;
  if (options[start] === "{") {
    const end = closeBrace(options, start);
    return end < 0 ? null : options.slice(start + 1, end);
  }
  return options.slice(start).split(",")[0].trim();
}

/** Every change and comment in the text, outside % comments, in order. Nested marks inside a
 *  mark's argument are found too. */
export function scanMarks(text: string): Mark[] {
  const out: Mark[] = [];
  const re = new RegExp(`\\\\(${KINDS})(?![a-zA-Z])`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    if (/(^|[^\\])%/.test(text.slice(lineStart, m.index))) continue;
    let i = m.index + m[0].length;
    while (text[i] === " ") i++;
    let options = "";
    if (text[i] === "[") {
      const end = closeBracket(text, i);
      if (end < 0) continue;
      options = text.slice(i + 1, end);
      i = end + 1;
    }
    while (text[i] === " ") i++;
    if (text[i] !== "{") continue;
    const close = closeBrace(text, i);
    if (close < 0) continue;
    const kind = m[1] as MarkKind;
    let to = close + 1;
    let old: [number, number] | null = null;
    if (kind === "replaced") {
      let j = to;
      while (text[j] === " ") j++;
      const close2 = text[j] === "{" ? closeBrace(text, j) : -1;
      if (close2 < 0) continue;
      old = [j + 1, close2];
      to = close2 + 1;
    }
    const body: [number, number] = [i + 1, close];
    out.push({
      kind, from: m.index, to, id: option(options, "id"), old, body,
      note: kind === "comment" ? text.slice(body[0], body[1]) : option(options, "comment"),
    });
  }
  return out;
}

/** What a mark becomes when accepted (or rejected): the text that stays. */
export function resolve(text: string, mark: Mark, accept: boolean): string {
  const body = text.slice(mark.body[0], mark.body[1]);
  switch (mark.kind) {
    case "added": return accept ? body : "";
    case "deleted": return accept ? "" : body;
    case "replaced": return accept ? body : text.slice(mark.old![0], mark.old![1]);
    case "comment": return "";
    case "highlight": return body;
  }
}

/** Every change accepted or rejected, and comments resolved; marks inside marks too. `only`
 *  limits it to some marks (one author's, say); the others stay as they are. */
export function resolveAll(text: string, accept: boolean, only?: (m: Mark) => boolean): string {
  const marks = scanMarks(text);
  const outer = marks.filter((m) => !marks.some((o) => o !== m && o.from <= m.from && o.to >= m.to));
  let out = text;
  for (const m of [...outer].sort((a, b) => b.from - a.from)) {
    const replacement = only && !only(m) ? text.slice(m.from, m.to) : resolveAll(resolve(text, m, accept), accept, only);
    out = out.slice(0, m.from) + replacement + out.slice(m.to);
  }
  return out;
}

/** The innermost mark at `pos`, if any. */
export function markAt(marks: Mark[], pos: number): Mark | null {
  let best: Mark | null = null;
  for (const m of marks) if (pos >= m.from && pos <= m.to && (!best || m.to - m.from < best.to - best.from)) best = m;
  return best;
}

/** The \added body of `id` holding `pos` (typing there extends that insertion). */
export function addedBodyAt(marks: Mark[], pos: number, id: string): Mark | null {
  return marks.find((m) => m.kind === "added" && m.id === id && pos >= m.body[0] && pos <= m.body[1]) ?? null;
}

/** Initials for an author id: "Georgios Kiritsis" → "GK". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Me";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase().replace(/[^A-Z0-9]/g, "") || "Me";
}

const COLORS = ["orange", "blue", "teal", "violet", "red", "olive", "magenta", "cyan"];
/** A colour for an author, the same every time. */
export function authorColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** The preamble lines the marks need: the package (with `final` to hide them in the PDF) and this
 *  author. Returns the edits as [position, text, length to replace]. Pure. */
export function preambleEdits(doc: string, id: string, name: string, final: boolean): [number, string, number][] {
  const begin = doc.indexOf("\\begin{document}");
  if (begin < 0) return [];
  const preamble = doc.slice(0, begin);
  const edits: [number, string, number][] = [];
  const pkg = /\\usepackage(\[[^\]]*\])?\{changes\}/.exec(preamble);
  const lines: string[] = [];
  if (!pkg) lines.push(`\\usepackage${final ? "[final]" : ""}{changes}`);
  else {
    const isFinal = /\bfinal\b/.test(pkg[1] ?? "");
    if (isFinal !== final) edits.push([pkg.index, `\\usepackage${final ? "[final]" : ""}{changes}`, pkg[0].length]);
  }
  if (!new RegExp(`\\\\definechangesauthor(\\[[^\\]]*\\])?\\{${id}\\}`).test(preamble)) {
    lines.push(`\\definechangesauthor[name={${name || id}}, color=${authorColor(id)}]{${id}}`);
  }
  if (lines.length) {
    const last = [...preamble.matchAll(/^[ \t]*\\usepackage.*$/gm)].pop();
    const at = pkg ? pkg.index + pkg[0].length + 1 : last ? last.index! + last[0].length + 1 : begin;
    edits.push([Math.min(at, begin), lines.join("\n") + "\n", 0]);
  }
  return edits;
}
