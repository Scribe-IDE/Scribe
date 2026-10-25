// TikZ source: finding the picture at the cursor, building the document that previews it on its
// own, and reading TikZ syntax. Pure: no DOM, no editor, so it can be tested on its own.

const ENVS = "tikzpicture|tikzcd|circuitikz";
const CLASS = "\\documentclass[tikz,border=6pt]{standalone}";
// Kept from the paper's preamble when the whole of it doesn't compile as a standalone document.
const ESSENTIAL = /^\s*\\(usetikzlibrary|usepgfplotslibrary|tikzset|pgfplotsset|definecolor|colorlet|usepackage(\[[^\]]*\])?\{[^}]*\b(tikz|pgfplots|tikz-cd|circuitikz|xcolor|amsmath|amssymb|bm|siunitx)\b[^}]*\})/;

/** The picture environment around `pos`: where it starts and ends. */
export function pictureAt(doc: string, pos: number): { from: number; to: number } | null {
  const re = new RegExp(`\\\\begin\\{(${ENVS})\\}`, "g");
  let best: { from: number; to: number } | null = null;
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    if (m.index > pos) break;
    const scan = new RegExp(`\\\\(begin|end)\\{${m[1]}\\}`, "g");
    scan.lastIndex = m.index;
    let depth = 0;
    for (let s = scan.exec(doc); s; s = scan.exec(doc)) {
      depth += s[1] === "begin" ? 1 : -1;
      if (depth === 0) {
        const to = s.index + s[0].length;
        if (pos <= to) best = { from: m.index, to };
        break;
      }
    }
  }
  return best;
}

/** The paper's preamble with its class swapped for standalone; `minimal` keeps only what pictures need.
 *  `offset` is the number of lines before the picture. */
export function previewDocument(paper: string, picture: string, minimal: boolean): { source: string; offset: number } {
  const begin = paper.indexOf("\\begin{document}");
  let preamble = begin < 0 ? "" : paper.slice(0, begin).replace(/^[ \t]*\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]*\}[^\n]*\n?/m, "");
  if (minimal) preamble = preamble.split("\n").filter((l) => ESSENTIAL.test(l)).join("\n");
  // \input@path lets the picture's \input and \includegraphics find files from the project folder
  const head = `${CLASS}\n\\makeatletter\\def\\input@path{{../../}}\\makeatother\n${preamble.trim()}\n\\begin{document}\n`;
  return { source: `${head}${picture}\n\\end{document}\n`, offset: head.split("\n").length - 1 };
}

/** The line (1-based, within `picture`) of a ( that a TikZ statement never closes. TeX itself
 *  only says the file ended, with no line, so the preview finds the place this way. Parens in
 *  braces (node text such as `{$[0,1)$}`) and comments don't count. */
export function unclosedParen(picture: string): number | null {
  let line = 1;
  let braces = 0;
  const open: number[] = [];
  for (let i = 0; i < picture.length; i++) {
    const ch = picture[i];
    if (ch === "\n") line++;
    else if (ch === "\\") i++;
    else if (ch === "%") {
      while (i + 1 < picture.length && picture[i + 1] !== "\n") i++;
    } else if (ch === "{") braces++;
    else if (ch === "}") braces = Math.max(0, braces - 1);
    else if (braces > 0) continue;
    else if (ch === "(") open.push(line);
    else if (ch === ")") open.pop();
    else if (ch === ";") {
      if (open.length) return open[0];
    }
  }
  return open.length ? open[0] : null;
}
