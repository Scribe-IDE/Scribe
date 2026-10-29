// TikZ source: finding the picture at the cursor, building the document that previews it on its
// own, and reading TikZ syntax. Pure: no DOM, no editor, so it can be tested on its own.

const ENVS = "tikzpicture|tikzcd|circuitikz";
/** Files that can hold pictures: the paper's .tex files and stand-alone .tikz pictures. */
export const PICTURE_FILE = /\.(tex|tikz)$/;
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
 *  `extra` goes at the end of the preamble. `offset` is the number of lines before the picture. */
export function previewDocument(paper: string, picture: string, minimal: boolean, extra = ""): { source: string; offset: number } {
  const begin = paper.indexOf("\\begin{document}");
  let preamble = begin < 0 ? "" : paper.slice(0, begin).replace(/^[ \t]*\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]*\}[^\n]*\n?/m, "");
  if (minimal) preamble = preamble.split("\n").filter((l) => ESSENTIAL.test(l)).join("\n");
  // \input@path lets the picture's \input and \includegraphics find files from the project folder
  const head = `${CLASS}\n\\makeatletter\\def\\input@path{{../../}}\\makeatother\n${preamble.trim()}\n${extra ? `${extra}\n` : ""}\\begin{document}\n`;
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

// ---------- coordinates that can be dragged ----------
/** A plain `(x,y)` in a picture, with its place in the picture's source. */
export interface Coordinate {
  from: number;
  to: number;
  x: number;
  y: number;
  /** The scope it is in: 0 is the picture itself. */
  scope: number;
}

/** A named node placed some other way than `at (x,y)` (`right=of a`, or a node on a path):
 *  dragging it writes `xshift`/`yshift` into its options. */
export interface NodeRef {
  name: string;
  /** Its options `[…]`, or an empty range just after `\node` when it has none. */
  optionsFrom: number;
  optionsTo: number;
  scope: number;
}

export interface PictureScan {
  coords: Coordinate[];
  nodes: NodeRef[];
  /** Where each scope's body starts (index = scope number). */
  scopes: number[];
  /** Where `\end{tikzpicture}` is; -1 when the picture can't be instrumented (tikzcd). */
  end: number;
}

const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const LITERAL = new RegExp(String.raw`^\(\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\)`);
// what comes before a coordinate in a path: `-- (`, `at (`, `\draw (`, `] (`, `) (` …
const BEFORE_COORD = /(--|\.\.|\|-|-\||\bat|\band|\bcontrols|\bto|\bedge|\brectangle|\bgrid|\bcycle|\\draw|\\path|\\fill|\\filldraw|\\clip|\\shade|\\shadedraw|\\pattern|\]|\))\s*$/;
// options on a statement that move its coordinates, so a handle would be in the wrong place
const MOVES = /\b(x?shift|yshift|scale|xscale|yscale|rotate|cm|xslant|yslant|shift only)\s*=/;
const PATH_COMMANDS = /^\\(draw|path|fill|filldraw|clip|shade|shadedraw|pattern|node|coordinate)\b/;

/** The end of an optional `[…]` starting at or after `i` (after spaces), or `i` when there is none. */
function skipOptions(text: string, i: number): number {
  let j = i;
  while (/\s/.test(text[j] ?? "")) j++;
  if (text[j] !== "[") return i;
  let braces = 0;
  for (let k = j + 1; k < text.length; k++) {
    if (text[k] === "{") braces++;
    else if (text[k] === "}") braces--;
    else if (text[k] === "]" && braces === 0) return k + 1;
  }
  return i;
}

/** The plain coordinates of a picture and its scopes. Coordinates that are relative (`++(1,0)`),
 *  polar, inside a pgfplots axis, or on a statement that shifts or scales itself are left out. */
export function scanPicture(picture: string): PictureScan {
  const head = /^\\begin\{(tikzpicture|circuitikz)\}/.exec(picture);
  if (!head) return { coords: [], nodes: [], scopes: [], end: -1 };
  const scopes = [skipOptions(picture, head[0].length)];
  const coords: Coordinate[] = [];
  const nodes: NodeRef[] = [];
  const stack = [0];
  let loops = 0;
  let axis = 0;
  let moved = false;
  let end = -1;
  for (let i = scopes[0]; i < picture.length && end < 0; i++) {
    const ch = picture[i];
    if (ch === "%") {
      while (i + 1 < picture.length && picture[i + 1] !== "\n") i++;
    } else if (ch === ";") {
      moved = false;
      loops = 0;
    } else if (ch === "\\") {
      const rest = picture.slice(i, i + 40);
      let m: RegExpExecArray | null;
      if ((m = /^\\begin\{scope\}/.exec(rest))) {
        const body = skipOptions(picture, i + m[0].length);
        if (axis) stack.push(-1);
        else {
          stack.push(scopes.length);
          scopes.push(body);
        }
        i = body - 1;
      } else if ((m = /^\\end\{scope\}/.exec(rest))) {
        if (stack.length > 1) stack.pop();
        i += m[0].length - 1;
      } else if ((m = /^\\begin\{\w*axis\}/.exec(rest))) {
        axis++;
        i += m[0].length - 1;
      } else if ((m = /^\\end\{\w*axis\}/.exec(rest))) {
        axis = Math.max(0, axis - 1);
        i += m[0].length - 1;
      } else if (/^\\end\{(tikzpicture|circuitikz)\}/.test(rest)) {
        end = i;
      } else if ((m = PATH_COMMANDS.exec(rest))) {
        const after = skipOptions(picture, i + m[0].length);
        moved = MOVES.test(picture.slice(i + m[0].length, after));
        // \node[…] (name) not followed by `at`: a node placed relative to others
        const named = m[1] === "node" && !axis && !loops && stack[stack.length - 1] >= 0
          ? /^\s*\(([^()\\\s,.]+)\)\s*(at\b)?/.exec(picture.slice(after, after + 80))
          : null;
        if (named && !named[2]) {
          const hasOptions = after > i + m[0].length;
          const open = hasOptions ? picture.indexOf("[", i + m[0].length) : i + m[0].length;
          nodes.push({ name: named[1], optionsFrom: open, optionsTo: hasOptions ? after : open, scope: stack[stack.length - 1] });
        }
        i += m[0].length - 1;
      } else if ((m = /^\\foreach\b/.exec(rest))) {
        // a node in a loop is many nodes; leave those alone (counted until the statement ends)
        loops++;
        i += m[0].length - 1;
      } else {
        i++; // an escaped character or the first letter of a command
      }
    } else if (ch === "(" && !axis && !moved && stack[stack.length - 1] >= 0) {
      const m = LITERAL.exec(picture.slice(i, i + 60));
      const before = picture.slice(Math.max(0, i - 24), i);
      if (m && !/\+\s*$/.test(before) && BEFORE_COORD.test(before)) {
        coords.push({ from: i, to: i + m[0].length, x: Number(m[1]), y: Number(m[2]), scope: stack[stack.length - 1] });
        i += m[0].length - 1;
      }
    }
  }
  return { coords, nodes, scopes, end };
}

/** Macros the instrumented picture uses; they go in the preview's preamble. Each scope gets
 *  three named points (its origin and unit vectors), placed without growing the picture, and
 *  at the end the picture reports where they and its bounding box ended up, in pt. */
export const INSTRUMENT_MACROS = String.raw`\makeatletter
\newcommand\ScribeMark[1]{\begin{pgfinterruptboundingbox}\path (0,0) coordinate (scribeo#1) (1,0) coordinate (scribex#1) (0,1) coordinate (scribey#1) (10pt,0pt) coordinate (scribeu#1) (0pt,10pt) coordinate (scribev#1);\end{pgfinterruptboundingbox}}
\newcommand\ScribeAt[2]{\pgfpointanchor{#1}{#2}\typeout{SCRIBE #1 #2 \the\pgf@x\space\the\pgf@y}}
\newcommand\ScribeNode[1]{\pgfutil@ifundefined{pgf@sh@ns@#1}{}{\ScribeAt{#1}{center}}}
\newcommand\ScribeReport[2]{{\pgftransformreset\ScribeAt{current bounding box}{south west}\ScribeAt{current bounding box}{north east}\foreach\scribek in {0,...,#1}{\ScribeAt{scribeo\scribek}{center}\ScribeAt{scribex\scribek}{center}\ScribeAt{scribey\scribek}{center}\ScribeAt{scribeu\scribek}{center}\ScribeAt{scribev\scribek}{center}}#2}}
\makeatother`;

/** The picture with the marks put in. Nothing is put on a line of its own, so the line numbers
 *  of errors stay the same. */
export function instrument(picture: string, scan: PictureScan): string {
  if (scan.end < 0) return picture;
  const inserts: [number, string][] = scan.scopes.map((at, k) => [at, `\\ScribeMark{${k}}`]);
  const nodes = scan.nodes.map((n) => `\\ScribeNode{${n.name}}`).join("");
  inserts.push([scan.end, `\\ScribeReport{${scan.scopes.length - 1}}{${nodes}}`]);
  let out = picture;
  for (const [at, text] of inserts.sort((a, b) => b[0] - a[0])) out = out.slice(0, at) + text + out.slice(at);
  return out;
}

export type Point = [number, number];
/** Where things ended up on the page, from the preview's log. */
export interface Marks {
  /** Bounding box corners, in pt. */
  sw: Point;
  ne: Point;
  /** Per scope: origin, the points (1,0) and (0,1), and (10pt,0pt) and (0pt,10pt). */
  scopes: { o: Point; x: Point; y: Point; u: Point; v: Point }[];
  /** Centres of named nodes, in pt. */
  nodes: Map<string, Point>;
}

export function readMarks(log: string): Marks | null {
  const at = new Map<string, Point>();
  for (const m of log.matchAll(/^SCRIBE (.+) (south west|north east|center) (-?[\d.]+)pt (-?[\d.]+)pt\s*$/gm)) {
    at.set(`${m[1]} ${m[2]}`, [Number(m[3]), Number(m[4])]);
  }
  const sw = at.get("current bounding box south west");
  const ne = at.get("current bounding box north east");
  if (!sw || !ne) return null;
  const scopes: Marks["scopes"] = [];
  for (let k = 0; at.has(`scribeo${k} center`); k++) {
    const get = (p: string) => at.get(`scribe${p}${k} center`)!;
    scopes.push({ o: get("o"), x: get("x"), y: get("y"), u: get("u") ?? get("x"), v: get("v") ?? get("y") });
  }
  const nodes = new Map<string, Point>();
  for (const [key, p] of at) {
    const m = /^(.+) center$/.exec(key);
    if (m && !/^scribe[oxyuv]\d+$/.test(m[1])) nodes.set(m[1], p);
  }
  return { sw, ne, scopes, nodes };
}

/** The standalone page's border around the picture, in pt (see CLASS). */
const BORDER = 6;

/** Where `(x,y)` in a scope is on the page, as fractions of its width and height from the top left. */
export function toPage(marks: Marks, scope: number, x: number, y: number): Point | null {
  const s = marks.scopes[scope];
  if (!s) return null;
  const px = s.o[0] + x * (s.x[0] - s.o[0]) + y * (s.y[0] - s.o[0]);
  const py = s.o[1] + x * (s.x[1] - s.o[1]) + y * (s.y[1] - s.o[1]);
  const w = marks.ne[0] - marks.sw[0] + 2 * BORDER;
  const h = marks.ne[1] - marks.sw[1] + 2 * BORDER;
  return [(px - marks.sw[0] + BORDER) / w, (marks.ne[1] + BORDER - py) / h];
}

/** The scope's `(x,y)` at a place on the page given as fractions (the inverse of toPage). */
export function fromPage(marks: Marks, scope: number, fx: number, fy: number): Point | null {
  const s = marks.scopes[scope];
  if (!s) return null;
  const w = marks.ne[0] - marks.sw[0] + 2 * BORDER;
  const h = marks.ne[1] - marks.sw[1] + 2 * BORDER;
  const px = fx * w + marks.sw[0] - BORDER - s.o[0];
  const py = marks.ne[1] + BORDER - fy * h - s.o[1];
  const [a, c] = [s.x[0] - s.o[0], s.x[1] - s.o[1]];
  const [b, d] = [s.y[0] - s.o[0], s.y[1] - s.o[1]];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return null;
  return [(d * px - b * py) / det, (a * py - c * px) / det];
}

/** A point on the picture's canvas (pt) as fractions of the page, and back. */
export function canvasToPage(marks: Marks, p: Point): Point {
  const w = marks.ne[0] - marks.sw[0] + 2 * BORDER;
  const h = marks.ne[1] - marks.sw[1] + 2 * BORDER;
  return [(p[0] - marks.sw[0] + BORDER) / w, (marks.ne[1] + BORDER - p[1]) / h];
}

export function pageToCanvas(marks: Marks, f: Point): Point {
  const w = marks.ne[0] - marks.sw[0] + 2 * BORDER;
  const h = marks.ne[1] - marks.sw[1] + 2 * BORDER;
  return [f[0] * w + marks.sw[0] - BORDER, marks.ne[1] + BORDER - f[1] * h];
}

const PT_PER_CM = 72.27 / 2.54;

/** The xshift/yshift (cm) in a scope that moves a node by `d` on the canvas (pt). */
export function canvasToShift(marks: Marks, scope: number, d: Point): Point | null {
  const s = marks.scopes[scope];
  if (!s) return null;
  // (10pt,0) and (0,10pt) in the scope, as canvas vectors
  const [a, c] = [(s.u[0] - s.o[0]) / 10, (s.u[1] - s.o[1]) / 10];
  const [b, e] = [(s.v[0] - s.o[0]) / 10, (s.v[1] - s.o[1]) / 10];
  const det = a * e - b * c;
  if (Math.abs(det) < 1e-9) return null;
  return [(e * d[0] - b * d[1]) / det / PT_PER_CM, (a * d[1] - c * d[0]) / det / PT_PER_CM];
}

/** The canvas offset (pt) that a shift (cm) in a scope makes. */
export function shiftToCanvas(marks: Marks, scope: number, shift: Point): Point {
  const s = marks.scopes[scope];
  if (!s) return [0, 0];
  const [x, y] = [shift[0] * PT_PER_CM / 10, shift[1] * PT_PER_CM / 10];
  return [x * (s.u[0] - s.o[0]) + y * (s.v[0] - s.o[0]), x * (s.u[1] - s.o[1]) + y * (s.v[1] - s.o[1])];
}

const UNIT_CM: Record<string, number> = { cm: 1, mm: 0.1, pt: 1 / PT_PER_CM, bp: 2.54 / 72, in: 2.54, "": 1 / PT_PER_CM };
const SHIFT_KEY = (key: string) => new RegExp(`(^|,)(\\s*)${key}\\s*=\\s*\\{?\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))\\s*(cm|mm|pt|bp|in)?\\s*\\}?\\s*(?=,|$)`);

/** A node's xshift and yshift in cm, from its options text (`[…]` or empty). */
export function nodeShift(options: string): Point {
  const inside = options.replace(/^\[|\]$/g, "");
  const read = (key: string) => {
    const m = SHIFT_KEY(key).exec(inside);
    return m ? Number(m[3]) * UNIT_CM[m[4] ?? ""] : 0;
  };
  return [read("xshift"), read("yshift")];
}

/** The options with xshift and yshift set to `shift` (cm); zero shifts are left out. */
export function withShift(options: string, shift: Point): string {
  let inside = options.replace(/^\[|\]$/g, "");
  const cm = (v: number) => `${Math.round(v * 100) / 100}cm`;
  for (const [key, value] of [["xshift", shift[0]], ["yshift", shift[1]]] as const) {
    const re = SHIFT_KEY(key);
    const zero = Math.abs(value) < 0.005;
    if (re.test(inside)) inside = inside.replace(re, zero ? "" : `$1$2${key}=${cm(value)}`);
    else if (!zero) inside = inside.trim() ? `${inside.replace(/\s+$/, "")}, ${key}=${cm(value)}` : `${key}=${cm(value)}`;
  }
  inside = inside.replace(/^\s*,\s*/, "").replace(/,\s*,/g, ",");
  return inside.trim() ? `[${inside}]` : "";
}

/** A coordinate as written: `(1.25,-2)`, never `1.2500` or `-0`. */
export function formatCoordinate(x: number, y: number): string {
  const n = (v: number) => {
    const s = String(Math.round(v * 1000) / 1000);
    return s === "-0" ? "0" : s;
  };
  return `(${n(x)},${n(y)})`;
}

// ---------- the pictures of a file ----------
export interface PictureInfo {
  from: number;
  to: number;
  /** 1-based line of `\begin{…}`. */
  line: number;
  /** From the figure around the picture, if there is one. */
  label: string | null;
  caption: string | null;
}

/** The text of the `{…}` group that starts at `open`. */
function group(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** Every picture in a file that isn't commented out, with the caption and label of its figure. */
export function findPictures(doc: string): PictureInfo[] {
  const out: PictureInfo[] = [];
  const re = new RegExp(`\\\\begin\\{(${ENVS})\\}`, "g");
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    const lineStart = doc.lastIndexOf("\n", m.index - 1) + 1;
    if (/(^|[^\\])%/.test(doc.slice(lineStart, m.index))) continue;
    const range = pictureAt(doc, m.index);
    if (!range || range.from !== m.index) continue;
    re.lastIndex = range.to; // pictures inside this one belong to it
    const begin = doc.lastIndexOf("\\begin{figure", range.from);
    const end = doc.indexOf("\\end{figure", range.to);
    let label: string | null = null;
    let caption: string | null = null;
    if (begin >= 0 && end >= 0 && doc.lastIndexOf("\\end{figure", range.from) < begin) {
      const around = doc.slice(begin, range.from) + doc.slice(range.to, end);
      label = /\\label\{([^}]*)\}/.exec(around)?.[1] ?? null;
      const at = /\\caption(\[[^\]]*\])?\{/.exec(around);
      if (at) caption = group(around, at.index + at[0].length - 1)?.replace(/\s+/g, " ").trim() || null;
    }
    out.push({ ...range, line: doc.slice(0, range.from).split("\n").length, label, caption });
  }
  return out;
}

/** A short stable name for a picture's preview document, for caching its compiled PDF. */
export function snippetName(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) h = Math.imul(h ^ source.charCodeAt(i), 0x01000193);
  return `t-${(h >>> 0).toString(16)}-${source.length.toString(16)}`;
}

// ---------- drawing new shapes ----------
export type ShapeTool = "line" | "arrow" | "rectangle" | "circle" | "text";

/** The TikZ for a shape drawn from `a` to `b` (for a circle: centre and a point on it). */
export function shapeSource(tool: ShapeTool, a: Point, b: Point): string {
  const p = (q: Point) => formatCoordinate(q[0], q[1]);
  switch (tool) {
    case "line": return `\\draw ${p(a)} -- ${p(b)};`;
    case "arrow": return `\\draw[->] ${p(a)} -- ${p(b)};`;
    case "rectangle": return `\\draw ${p(a)} rectangle ${p(b)};`;
    case "circle": {
      const r = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 1000) / 1000;
      return `\\draw ${p(a)} circle (${r});`;
    }
    case "text": return `\\node at ${p(a)} {Text};`;
  }
}

/** Where a new statement goes in a picture (just before `\end{tikzpicture}`) and the text to
 *  put there, indented like the picture's body. */
export function appendStatement(picture: string, scan: PictureScan, statement: string): { at: number; text: string } | null {
  if (scan.end < 0) return null;
  const lineStart = picture.lastIndexOf("\n", scan.end - 1) + 1;
  const before = picture.slice(lineStart, scan.end);
  if (/\S/.test(before)) return { at: scan.end, text: `${statement} ` }; // \end{…} shares its line
  // the indentation of the body's last line, or the \end line's plus two spaces
  const prev = picture.slice(0, lineStart - 1);
  const prevLine = prev.slice(prev.lastIndexOf("\n") + 1);
  const indent = lineStart > 0 && !/^\s*\\begin\{/.test(prevLine) && /\S/.test(prevLine)
    ? /^[ \t]*/.exec(prevLine)![0]
    : `${before}  `;
  return { at: lineStart, text: `${indent}${statement}\n` };
}
