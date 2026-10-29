// TikZ source: finding the picture at the cursor, building the document that previews it on its
// own, and reading TikZ syntax. Pure: no DOM, no editor, so it can be tested on its own.
import { groupOf, parseOptions, writeOptions } from "./tikzoptions";

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

export type StatementKind = "line" | "polyline" | "curve" | "rectangle" | "circle" | "ellipse" | "arc" | "node" | "coordinate" | "other";

/** One `\draw …;`, `\node …;` and so on at the top level of a picture or scope. */
export interface Statement {
  /** From the command to just after its `;`. */
  from: number;
  to: number;
  command: string;
  /** Its options `[…]`, or an empty range just after the command when it has none. */
  optionsFrom: number;
  optionsTo: number;
  scope: number;
  kind: StatementKind;
  /** Indices into PictureScan.coords of the points written in it. */
  coords: number[];
  /** Nodes it refers to, as in `(nb) -- (fig)`. */
  refs: string[];
  /** The node it defines (`\node (name)`, `\coordinate (name)`). */
  defines: string | null;
  /** A node's text: the inside of its `{…}`. */
  textFrom: number;
  textTo: number;
  /** Selectable in the preview: not in a loop, a plot, or a clip, and not the picture's bounding box. */
  selectable: boolean;
}

export interface PictureScan {
  coords: Coordinate[];
  nodes: NodeRef[];
  statements: Statement[];
  /** Every node name the picture defines (outside loops). */
  names: string[];
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

const NAMED = /(?:\\node|\bnode|\\coordinate|\bcoordinate)\s*(?:\[[^\]]*\])?\s*\(([^()\\\s,.]+)\)|\bname\s*=\s*([\w-]+)/g;

/** Names of nodes and coordinates defined in some TikZ: `\node (a)`, `node[…] (a)`, `coordinate (a)`, `name=a`. */
export function definedNames(text: string): string[] {
  const names = [...text.matchAll(NAMED)].map((m) => m[1] ?? m[2]);
  return [...new Set(names)].filter((n) => !/^-?[\d.]+$/.test(n));
}

/** The kind of shape a statement draws, from what its path says. */
function kindOf(command: string, body: string): StatementKind {
  if (command === "node") return "node";
  if (command === "coordinate") return "coordinate";
  const path = body.replace(/\{[^{}]*\}/g, "{}"); // node texts don't count
  if (/\barc\b/.test(path)) return "arc";
  if (/\bellipse\b/.test(path)) return "ellipse";
  if (/\bcircle\b/.test(path)) return "circle";
  if (/\brectangle\b/.test(path)) return "rectangle";
  if (/\.\.\s*controls\b/.test(path)) return "curve";
  const segments = (path.match(/--|\|-|-\|/g) ?? []).length;
  if (segments >= 2 || /\bcycle\b/.test(path)) return "polyline";
  return segments === 1 ? "line" : "other";
}

/** The plain coordinates of a picture, its statements and its scopes. Coordinates that are
 *  relative (`++(1,0)`), polar, inside a pgfplots axis, or on a statement that shifts or scales
 *  itself are left out, as are statements in loops. */
export function scanPicture(picture: string): PictureScan {
  const head = /^\\begin\{(tikzpicture|circuitikz)\}/.exec(picture);
  if (!head) return { coords: [], nodes: [], statements: [], names: [], scopes: [], end: -1 };
  const scopes = [skipOptions(picture, head[0].length)];
  const coords: Coordinate[] = [];
  const nodes: NodeRef[] = [];
  const statements: Statement[] = [];
  const stack = [0];
  let depth = 0;
  /** A \foreach in progress: its brace depth, and how many groups have closed there (list, then body). */
  let loop: { depth: number; groups: number } | null = null;
  let axis = 0;
  let moved = false;
  let current: Statement | null = null;
  let end = -1;
  const finish = (to: number) => {
    if (!current) return;
    current.to = to;
    const body = picture.slice(current.optionsTo, to);
    current.kind = kindOf(current.command, body);
    current.defines = current.command === "node" || current.command === "coordinate"
      ? /^\s*\(([^()\\\s,.]+)\)/.exec(body)?.[1] ?? null
      : null;
    current.refs = [...new Set([...body.matchAll(/\(([A-Za-z][\w-]*)(?:\.[\w ]+)?\)/g)].map((m) => m[1]))]
      .filter((name) => name !== current!.defines);
    if (current.command === "node") {
      // the node's text is the last {…} before the ;
      const close = picture.lastIndexOf("}", to);
      let open = close;
      for (let d = 0; open > current.optionsTo; open--) {
        if (picture[open] === "}") d++;
        else if (picture[open] === "{" && --d === 0) break;
      }
      if (close > open && open > current.optionsTo) [current.textFrom, current.textTo] = [open + 1, close];
    }
    statements.push(current);
    current = null;
  };
  for (let i = scopes[0]; i < picture.length && end < 0; i++) {
    const ch = picture[i];
    if (ch === "%") {
      while (i + 1 < picture.length && picture[i + 1] !== "\n") i++;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (loop && depth === loop.depth && ++loop.groups >= 2) loop = null; // the loop's body closed
    } else if (ch === ";") {
      moved = false;
      if (loop && depth === loop.depth) loop = null;
      if (depth === 0) finish(i + 1);
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
        const options = picture.slice(i + m[0].length, after);
        moved = MOVES.test(options);
        const scope = stack[stack.length - 1];
        const hasOptions = after > i + m[0].length;
        const optionsFrom = hasOptions ? picture.indexOf("[", i + m[0].length) : i + m[0].length;
        const optionsTo = hasOptions ? after : optionsFrom;
        if (depth === 0 && !current) {
          current = {
            from: i, to: i, command: m[1], optionsFrom, optionsTo, scope, kind: "other", coords: [], refs: [],
            defines: null, textFrom: -1, textTo: -1,
            selectable: !axis && !loop && scope >= 0 && m[1] !== "clip" && !/use as bounding box|\bclip\b/.test(options),
          };
        }
        // \node[…] (name) not followed by `at`: a node placed relative to others
        const named = m[1] === "node" && !axis && !loop && scope >= 0
          ? /^\s*\(([^()\\\s,.]+)\)\s*(at\b)?/.exec(picture.slice(after, after + 80))
          : null;
        if (named && !named[2]) nodes.push({ name: named[1], optionsFrom, optionsTo, scope });
        i += m[0].length - 1;
      } else if ((m = /^\\foreach\b/.exec(rest))) {
        // a node in a loop is many nodes; leave those alone
        if (!loop || loop.depth === depth) loop = { depth, groups: 0 };
        i += m[0].length - 1;
      } else {
        i++; // an escaped character or the first letter of a command
      }
    } else if (ch === "(" && !axis && !moved && stack[stack.length - 1] >= 0) {
      const m = LITERAL.exec(picture.slice(i, i + 60));
      const before = picture.slice(Math.max(0, i - 24), i);
      if (m && !/\+\s*$/.test(before) && BEFORE_COORD.test(before)) {
        if (current && depth === 0) current.coords.push(coords.length);
        coords.push({ from: i, to: i + m[0].length, x: Number(m[1]), y: Number(m[2]), scope: stack[stack.length - 1] });
        i += m[0].length - 1;
      }
    }
  }
  const names = definedNames(statements.filter((st) => st.selectable || st.command === "node" || st.command === "coordinate")
    .map((st) => picture.slice(st.from, st.to)).join("\n"));
  return { coords, nodes, statements, names, scopes, end };
}

/** Macros the instrumented picture uses; they go in the preview's preamble. Each scope gets
 *  three named points (its origin and unit vectors), placed without growing the picture, and
 *  at the end the picture reports where they and its bounding box ended up, in pt. */
export const INSTRUMENT_MACROS = String.raw`\makeatletter
\newcommand\ScribeMark[1]{\begin{pgfinterruptboundingbox}\path (0,0) coordinate (scribeo#1) (1,0) coordinate (scribex#1) (0,1) coordinate (scribey#1) (10pt,0pt) coordinate (scribeu#1) (0pt,10pt) coordinate (scribev#1);\end{pgfinterruptboundingbox}}
\newcommand\ScribeAt[2]{\pgfpointanchor{#1}{#2}\typeout{SCRIBE #1 #2 \the\pgf@x\space\the\pgf@y}}
\newcommand\ScribeNode[1]{\pgfutil@ifundefined{pgf@sh@ns@#1}{}{\ScribeAt{#1}{center}\ScribeAt{#1}{south west}\ScribeAt{#1}{north east}}}
\newcommand\ScribeReport[2]{{\pgftransformreset\ScribeAt{current bounding box}{south west}\ScribeAt{current bounding box}{north east}\foreach\scribek in {0,...,#1}{\ScribeAt{scribeo\scribek}{center}\ScribeAt{scribex\scribek}{center}\ScribeAt{scribey\scribek}{center}\ScribeAt{scribeu\scribek}{center}\ScribeAt{scribev\scribek}{center}}#2}}
\makeatother`;

/** The name of the box around statement `k`. */
export const statementBox = (k: number) => `scribes${k}`;

/** The picture with the marks put in. Nothing is put on a line of its own, so the line numbers
 *  of errors stay the same. Each selectable statement is wrapped in a scope that records its box. */
export function instrument(picture: string, scan: PictureScan): string {
  if (scan.end < 0) return picture;
  // [where, order among inserts at the same place, text]: a scope's end comes before what follows it
  const inserts: [number, number, string][] = scan.scopes.map((at, k) => [at, 1, `\\ScribeMark{${k}}`]);
  scan.statements.forEach((st, k) => {
    // `use as bounding box` stops TikZ measuring anything after it, the shapes' boxes too; in the
    // preview the path just counts towards the size like any other (it draws nothing either way)
    const options = picture.slice(st.optionsFrom, st.optionsTo);
    if (/use as bounding box/.test(options)) {
      const kept = parseOptions(options).filter((e) => e.trim() !== "use as bounding box");
      inserts.push([st.optionsFrom, 1, `${writeOptions(kept)}\u0000${st.optionsTo - st.optionsFrom}`]);
    }
    if (!st.selectable) return;
    inserts.push([st.from, 2, `\\begin{scope}[local bounding box=${statementBox(k)}]`], [st.to, 0, "\\end{scope}"]);
  });
  const report = [
    ...scan.names.map((n) => `\\ScribeNode{${n}}`),
    ...scan.statements.flatMap((st, k) => (st.selectable ? [`\\ScribeNode{${statementBox(k)}}`] : [])),
  ].join("");
  inserts.push([scan.end, 3, `\\ScribeReport{${scan.scopes.length - 1}}{${report}}`]);
  let out = picture;
  // from the end backwards; at one place, later ones first so they end up after the earlier
  inserts.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (const [at, , text] of inserts) {
    // "text\0n" replaces the n characters at `at` instead of inserting
    const [insert, replace] = text.split("\u0000");
    out = out.slice(0, at) + insert + out.slice(at + (replace ? Number(replace) : 0));
  }
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
  /** Boxes (south west, north east) of named nodes and of statements (`scribesK`), in pt. */
  boxes: Map<string, [Point, Point]>;
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
  const boxes = new Map<string, [Point, Point]>();
  for (const [key, p] of at) {
    const m = /^(.+) (center|south west)$/.exec(key);
    if (!m || /^scribe[oxyuv]\d+$/.test(m[1])) continue;
    if (m[2] === "center" && !/^scribes\d+$/.test(m[1])) nodes.set(m[1], p);
    const ne = at.get(`${m[1]} north east`);
    // an empty box (a coordinate draws nothing) comes out inside out
    if (m[2] === "south west" && ne && ne[0] >= p[0] && ne[1] >= p[1]) boxes.set(m[1], [p, ne]);
  }
  return { sw, ne, scopes, nodes, boxes };
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
export type ShapeTool = "line" | "arrow" | "polyline" | "curve" | "rectangle" | "circle" | "ellipse" | "arc" | "text" | "box" | "round" | "dot";

/** A point of a new shape: where it is, and the node it is on, if any (then the TikZ says `(name)`). */
export interface End { point: Point; node?: string }

const round = (v: number, places = 3) => {
  const n = Math.round(v * 10 ** places) / 10 ** places;
  return Object.is(n, -0) ? 0 : n;
};

/** The TikZ for a new shape. `ends` are the points clicked (two for most, three for an arc: centre,
 *  start, end; any number for a polyline). `options` go in its `[…]`; `name` names a new node.
 *  `closed` closes a polyline with `-- cycle`. */
export function shapeSource(tool: ShapeTool, ends: End[], options = "", name = "", closed = false): string {
  const ref = (e: End) => (e.node ? `(${e.node})` : formatCoordinate(e.point[0], e.point[1]));
  const pt = (p: Point) => formatCoordinate(p[0], p[1]);
  const opts = (extra = "") => {
    const all = [extra, options].filter(Boolean).join(", ");
    return all ? `[${all}]` : "";
  };
  const [a, b, c] = ends;
  switch (tool) {
    case "line": return `\\draw${opts()} ${ref(a)} -- ${ref(b)};`;
    case "arrow": return `\\draw${opts(/(^|,\s*)[<>|]?-[<>|]?|-\{/.test(options) ? "" : "->")} ${ref(a)} -- ${ref(b)};`;
    case "polyline": return `\\draw${opts()} ${ends.map(ref).join(" -- ")}${closed ? " -- cycle" : ""};`;
    case "curve": {
      // controls a third and two thirds of the way along, bent to the left of a → b
      const [dx, dy] = [b.point[0] - a.point[0], b.point[1] - a.point[1]];
      const bend = 0.3;
      const c1: Point = [round(a.point[0] + dx / 3 - dy * bend, 2), round(a.point[1] + dy / 3 + dx * bend, 2)];
      const c2: Point = [round(a.point[0] + (2 * dx) / 3 - dy * bend, 2), round(a.point[1] + (2 * dy) / 3 + dx * bend, 2)];
      return `\\draw${opts()} ${ref(a)} .. controls ${pt(c1)} and ${pt(c2)} .. ${ref(b)};`;
    }
    case "rectangle": return `\\draw${opts()} ${pt(a.point)} rectangle ${pt(b.point)};`;
    case "circle": return `\\draw${opts()} ${pt(a.point)} circle (${round(Math.hypot(b.point[0] - a.point[0], b.point[1] - a.point[1]))});`;
    case "ellipse": {
      const centre: Point = [(a.point[0] + b.point[0]) / 2, (a.point[1] + b.point[1]) / 2];
      const [rx, ry] = [round(Math.abs(b.point[0] - a.point[0]) / 2), round(Math.abs(b.point[1] - a.point[1]) / 2)];
      return `\\draw${opts()} ${pt(centre)} ellipse [x radius=${rx}, y radius=${ry}];`;
    }
    case "arc": {
      const r = Math.hypot(b.point[0] - a.point[0], b.point[1] - a.point[1]);
      const angle = (p: Point) => (Math.atan2(p[1] - a.point[1], p[0] - a.point[0]) * 180) / Math.PI;
      const start = Math.round(angle(b.point));
      let stop = Math.round(angle(c.point));
      if (stop <= start) stop += 360; // anticlockwise from the start
      const from: Point = [a.point[0] + r * Math.cos((start * Math.PI) / 180), a.point[1] + r * Math.sin((start * Math.PI) / 180)];
      return `\\draw${opts()} ${pt([round(from[0]), round(from[1])])} arc[start angle=${start}, end angle=${stop}, radius=${round(r)}];`;
    }
    case "text": return `\\node${opts()} at ${ref(a)} {Text};`;
    case "box": return `\\node${opts("draw, rounded corners=2pt")} (${name}) at ${pt(a.point)} {Text};`;
    case "round": return `\\node${opts("draw, circle")} (${name}) at ${pt(a.point)} {Text};`;
    case "dot": return `\\fill${opts()} ${ref(a)} circle (1.5pt);`;
  }
}

/** A node name not yet used in the picture: `n1`, `n2`, … or `base-2`, `base-3`, … */
export function freshName(taken: Iterable<string>, base = "n"): string {
  const used = new Set(taken);
  for (let k = base === "n" ? 1 : 2; ; k++) {
    const name = base === "n" ? `n${k}` : `${base}-${k}`;
    if (!used.has(name)) return name;
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

// ---------- labels on lines ----------
/** The first `node[…] {…}` on a path statement (a label on a line): its options and text, relative to the statement. */
export function lineLabel(statement: string): { optionsFrom: number; optionsTo: number; textFrom: number; textTo: number } | null {
  const m = /(?:--|\bto\b(?:\[[^\]]*\])?)\s*node\s*(\[[^\]]*\])?\s*\{/.exec(statement);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < statement.length; i++) {
    if (statement[i] === "\\") i++;
    else if (statement[i] === "{") depth++;
    else if (statement[i] === "}" && --depth === 0) {
      const optionsFrom = m[1] ? m.index + m[0].indexOf(m[1]) : m.index + m[0].indexOf("node") + 4;
      return { optionsFrom, optionsTo: optionsFrom + (m[1]?.length ?? 0), textFrom: open + 1, textTo: i };
    }
  }
  return null;
}

/** The statement with its line label set to `text` (added after the first `--` when there is
 *  none, removed when `text` is empty), placed at `place` (`above`, `below`, …). */
export function withLineLabel(statement: string, text: string, place?: string): string {
  const label = lineLabel(statement);
  if (label) {
    if (!text.trim()) {
      // drop ` node[…] {…}` back to the `--`
      const start = statement.lastIndexOf("node", label.optionsFrom);
      return statement.slice(0, start).replace(/\s+$/, " ") + statement.slice(label.textTo + 1).replace(/^\s+/, "");
    }
    let out = statement.slice(0, label.textFrom) + text + statement.slice(label.textTo);
    if (place) {
      // only where it sits changes; its other options (font=…) stay
      const kept = parseOptions(statement.slice(label.optionsFrom, label.optionsTo)).filter((e) => groupOf(e, new Set()) !== "place");
      out = out.slice(0, label.optionsFrom) + writeOptions(["midway", ...place.split(/,\s*/), ...kept]) + out.slice(label.optionsTo);
    }
    return out;
  }
  if (!text.trim()) return statement;
  const at = statement.indexOf("--");
  if (at < 0) return statement;
  return `${statement.slice(0, at + 2)} node[midway, ${place ?? "above"}] {${text}}${statement.slice(at + 2)}`;
}
