// Turns a LaTeX compile log (latexmk or Tectonic) into a list of problems with file and line.
// Pure: no DOM, no editor, so it can be tested on its own.

export interface Problem {
  /** Path relative to the project root. */
  file: string;
  /** 1-based; 0 when the log gives no line. */
  line: number;
  message: string;
  severity: "error" | "warning";
  /** What the message means and how to fix it, in plain words. */
  hint?: string;
}

// `./main.tex:12: Undefined control sequence.` (latexmk -file-line-error)
// `error: main.tex:12: Undefined control sequence` (Tectonic)
const FILE_LINE = /^(error: |warning: )?(?:\.\/)?([^\s:()]+\.(?:tex|sty|cls|bib|bst|tikz)):(\d+): (.+)$/;
const BANG = /^! (.+)$/;
const WARNING = /^(?:LaTeX|Package \S+|Class \S+) Warning: (.*)$/;
const AT_LINE = /^l\.(\d+) ?(.*)$/;
const ON_INPUT_LINE = /on input line (\d+)/;

// Summaries and typesetting chatter that point at nothing the writer can act on directly.
const NOISE = /^(==>|Emergency stop|Fatal error)|There were undefined references|Label\(s\) may have changed|Rerun to get|^(Overfull|Underfull) \\[hv]box/;

export function parseLog(log: string, mainFile: string): Problem[] {
  const lines = log.split(/\r?\n/);
  const problems: Problem[] = [];
  const seen = new Set<string>();

  const add = (problem: Problem) => {
    problem.message = problem.message.trim().replace(/\s+/g, " ");
    if (!problem.message || NOISE.test(problem.message)) return;
    const key = `${problem.file}:${problem.line}:${problem.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(problem);
  };

  // TeX prints the source line up to the failure as `l.12 text \badcommand`; the last token is the culprit.
  const culprit = (from: number): { line: number; token: string } | null => {
    for (let i = from; i < Math.min(from + 15, lines.length); i++) {
      const m = AT_LINE.exec(lines[i]);
      if (m) return { line: Number(m[1]), token: m[2].trim().split(/\s+/).pop() ?? "" };
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fileLine = FILE_LINE.exec(line);
    if (fileLine) {
      const [, prefix, file, lineNo, text] = fileLine;
      if (file.startsWith("/")) continue; // a package file outside the project
      let message = text.replace(/^LaTeX Error: /, "");
      if (/^Undefined control sequence/.test(text)) {
        const at = culprit(i + 1);
        if (at?.token.startsWith("\\")) message = `Undefined control sequence ${at.token}`;
      }
      add({ file, line: Number(lineNo), message, severity: prefix === "warning: " ? "warning" : "error" });
      continue;
    }

    const bang = BANG.exec(line);
    if (bang) {
      const at = culprit(i + 1);
      let message = bang[1].replace(/^LaTeX Error: /, "");
      if (/^Undefined control sequence/.test(message) && at?.token.startsWith("\\")) {
        message = `Undefined control sequence ${at.token}`;
      }
      add({ file: mainFile, line: at?.line ?? 0, message, severity: "error" });
      continue;
    }

    const warning = WARNING.exec(line);
    if (warning) {
      // Warnings wrap at 79 columns and continue until a blank line.
      let message = warning[1];
      while (i + 1 < lines.length && lines[i + 1].trim() !== "" && !ON_INPUT_LINE.test(message)) {
        message += " " + lines[++i].replace(/^\(\S+\)\s+/, "");
      }
      const at = ON_INPUT_LINE.exec(message);
      add({
        file: mainFile,
        line: at ? Number(at[1]) : 0,
        message: message.replace(/ ?on input line \d+\.?/, "").replace(/\.$/, ""),
        severity: "warning",
      });
    }
  }

  // Errors first, then by position.
  return problems.sort((a, b) =>
    Number(a.severity === "warning") - Number(b.severity === "warning") || a.file.localeCompare(b.file) || a.line - b.line);
}

// ---------- what the messages mean ----------
// Commands people often use without loading their package, and the package to load.
const PACKAGE_OF: Record<string, string> = {
  includegraphics: "graphicx", graphicspath: "graphicx", href: "hyperref", url: "hyperref", autoref: "hyperref",
  toprule: "booktabs", midrule: "booktabs", bottomrule: "booktabs", cmidrule: "booktabs",
  SI: "siunitx", qty: "siunitx", num: "siunitx", unit: "siunitx", si: "siunitx",
  mathbb: "amssymb", text: "amsmath", eqref: "amsmath", align: "amsmath", DeclareMathOperator: "amsmath",
  cref: "cleveref", Cref: "cleveref", nbval: "scribe-figures", nbfig: "scribe-figures", nbtable: "scribe-figures",
  todo: "todonotes", sout: "ulem", textcolor: "xcolor", color: "xcolor", multirow: "multirow",
  lipsum: "lipsum", citep: "natbib", citet: "natbib", subcaption: "subcaption", tikz: "tikz",
};
const ENV_PACKAGE: Record<string, string> = {
  align: "amsmath", "align*": "amsmath", gather: "amsmath", multline: "amsmath", pmatrix: "amsmath", bmatrix: "amsmath",
  cases: "amsmath", tikzpicture: "tikz", lstlisting: "listings", minted: "minted", algorithm: "algorithm",
  algorithmic: "algorithmic", subfigure: "subcaption", tabularx: "tabularx", longtable: "longtable", theorem: "amsthm",
};

const RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^Undefined control sequence (\\[a-zA-Z@]+)/, (m) => {
    const pkg = PACKAGE_OF[m[1].slice(1)];
    return pkg
      ? `${m[1]} comes from the ${pkg} package. Add \\usepackage{${pkg}} before \\begin{document}.`
      : `LaTeX doesn't know ${m[1]}. Check the spelling, or load the package that defines it.`;
  }],
  [/^Undefined control sequence/, () => "A command here isn't one LaTeX knows. Check its spelling, or load the package that defines it."],
  [/^Missing \$ inserted/, () => "Something that only works in maths (^, _, \\alpha, …) is outside maths. Put it between $…$, or write \\_ or \\^{} for the characters themselves."],
  [/^(Missing \} inserted|Extra \}|Too many \}'s|Missing \{ inserted|Extra \{)/, () => "The braces don't balance: a { has no matching }, or a } has no {."],
  [/^Paragraph ended before (\\\S+?) was complete/, (m) => `The argument of ${m[1]} runs into a blank line, so its closing } is probably missing.`],
  [/^Runaway argument/, () => "An argument never ends: a closing } is probably missing."],
  [/^File [`'](.+?)' not found/, (m) => /\.(sty|cls)$/.test(m[1])
    ? `The package ${m[1].replace(/\.\w+$/, "")} isn't installed. Tectonic fetches packages by itself; with TeX Live, run tlmgr install ${m[1].replace(/\.\w+$/, "")}.`
    : `There's no file called ${m[1]}. Check the name and the folder it's in.`],
  [/^Environment (\S+) undefined/, (m) => ENV_PACKAGE[m[1]]
    ? `The ${m[1]} environment comes from the ${ENV_PACKAGE[m[1]]} package. Add \\usepackage{${ENV_PACKAGE[m[1]]}}.`
    : `There's no environment called ${m[1]}. Check the spelling, or load the package that defines it.`],
  [/^\\begin\{(\S+?)\} on input line \d+ ended by \\end\{(\S+?)\}/, (m) => `\\begin{${m[1]}} is closed by \\end{${m[2]}}. The two names must match, and environments must close in the order they opened.`],
  [/^Misplaced alignment tab character &/, () => "An & outside a table or an align environment. To print an ampersand, write \\&."],
  [/^Double (superscript|subscript)/, (m) => `Two ${m[1] === "superscript" ? "^" : "_"} in a row. Group them with braces, as in ${m[1] === "superscript" ? "x^{ab}" : "x_{i_j}"}.`],
  [/Lonely \\item|perhaps a missing \\item/, () => "\\item belongs inside itemize, enumerate or description, and text inside a list must come after an \\item."],
  [/^There's no line here to end/, () => "A \\\\ where no line has started yet, often after a blank line. Remove it; for extra space use \\vspace{…}."],
  [/^Missing number, treated as zero/, () => "A command expected a number or a length here (like 2cm) and got something else."],
  [/^Illegal unit of measure/, () => "A length needs a unit: 2cm, 10pt, 0.5\\linewidth."],
  [/^Missing \\begin\{document\}/, () => "Text before \\begin{document}: only settings, \\usepackage and definitions go there."],
  [/^Can be used only in preamble/, () => "This command must come before \\begin{document}."],
  [/^Option clash for package (\S+)/, (m) => `${m[1]} is loaded twice with different options. Load it once, with all the options together.`],
  [/^Command (\\\S+) already defined/, (m) => `${m[1]} already exists. Use \\renewcommand to change it, or choose another name.`],
  [/^Citation [`'](\S+?)'.*undefined/, (m) => `No bibliography entry has the key ${m[1]}. Add it to the .bib (References panel) or correct the key.`],
  [/^Reference [`'](\S+?)'.*undefined/, (m) => `Nothing has \\label{${m[1]}}. Check the name; a label added just now needs one more compile.`],
  [/^Label [`'](\S+?)' multiply defined/, (m) => `\\label{${m[1]}} is used in two places. Each label must be unique.`],
  [/^Float\(s\) lost/, () => "A figure or table is inside something that can't hold one (a minipage or a box)."],
  [/^Not in outer par mode/, () => "A figure or table is inside a box or another float. Move it out."],
];

const BRACES = /^(Missing \} inserted|Extra \}|Too many \}'s|Missing \{ inserted|Extra \{|Runaway argument|Paragraph ended before)/;

/** The line of the innermost { still open at the end of `line`, ignoring \{ and comments. */
export function unclosedBrace(text: string, line: number): number | null {
  const open: number[] = [];
  const lines = text.split("\n");
  for (let n = 0; n < Math.min(line, lines.length); n++) {
    const src = lines[n];
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "%") break;
      if (ch === "{") open.push(n + 1);
      else if (ch === "}") open.pop();
    }
  }
  return open.length ? open[open.length - 1] : null;
}

/** Adds a plain-words hint to each problem it recognises. `source(file)` gives a file's text,
 *  so a brace error can say where the unclosed { is. */
export function explain(problems: Problem[], source?: (file: string) => string | null): Problem[] {
  for (const p of problems) {
    for (const [re, say] of RULES) {
      const m = re.exec(p.message);
      if (!m) continue;
      p.hint = say(m);
      break;
    }
    if (BRACES.test(p.message) && p.line && source) {
      const text = source(p.file);
      const at = text ? unclosedBrace(text, p.line) : null;
      if (at && at !== p.line) p.hint = `${p.hint ?? ""} The { that is still open is on line ${at}.`.trim();
    }
  }
  return problems;
}
