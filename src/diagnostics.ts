// Turns a LaTeX compile log (latexmk or Tectonic) into a list of problems with file and line.
// Pure: no DOM, no editor, so it can be tested on its own.

export interface Problem {
  /** Path relative to the project root. */
  file: string;
  /** 1-based; 0 when the log gives no line. */
  line: number;
  message: string;
  severity: "error" | "warning";
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
      let message = text;
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
