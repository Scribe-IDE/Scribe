// Writing TikZ: completion inside a picture (options, colours, styles, node names and anchors,
// libraries) and ready-made pictures to start from.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { setStatus } from "./core";
import { openPalette } from "./palette";
import { activeEditor } from "./split";
import { openTikzPreview } from "./tikz";
import { pictureAt, PICTURE_FILE } from "./tikzsource";

// ---------- completion ----------
const OPTIONS: [string, string][] = [
  ["draw", "stroke the path"], ["fill", "fill the path"], ["thin", "line"], ["thick", "line"], ["very thick", "line"],
  ["ultra thick", "line"], ["very thin", "line"], ["line width=", "e.g. 1pt"], ["dashed", "line"], ["dotted", "line"],
  ["densely dashed", "line"], ["loosely dashed", "line"], ["->", "arrow at the end"], ["<-", "arrow at the start"],
  ["<->", "arrows at both ends"], ["-{Stealth}", "arrows.meta"], ["-{Latex}", "arrows.meta"], ["|->", "arrow"],
  ["rounded corners", "corners"], ["rounded corners=", "e.g. 2pt"], ["opacity=", "0 to 1"], ["fill opacity=", "0 to 1"],
  ["color=", "colour"], ["fill=", "colour"], ["draw=", "colour"], ["text=", "colour"], ["font=", "e.g. \\small"],
  ["scale=", "transform"], ["xscale=", "transform"], ["yscale=", "transform"], ["rotate=", "degrees"],
  ["shift={(1,0)}", "transform"], ["xshift=", "e.g. 1cm"], ["yshift=", "e.g. 1cm"],
  ["above", "node place"], ["below", "node place"], ["left", "node place"], ["right", "node place"],
  ["above left", "node place"], ["above right", "node place"], ["below left", "node place"], ["below right", "node place"],
  ["above=of ", "positioning"], ["below=of ", "positioning"], ["left=of ", "positioning"], ["right=of ", "positioning"],
  ["node distance=", "positioning"], ["anchor=", "node"], ["inner sep=", "node"], ["outer sep=", "node"],
  ["minimum width=", "node"], ["minimum height=", "node"], ["minimum size=", "node"], ["text width=", "node"],
  ["align=center", "node text"], ["circle", "node shape"], ["rectangle", "node shape"], ["ellipse", "shapes.geometric"],
  ["diamond", "shapes.geometric"], ["midway", "node on a path"], ["near start", "node on a path"],
  ["near end", "node on a path"], ["pos=", "0 to 1 along the path"], ["sloped", "node follows the path"],
  ["bend left", "to path"], ["bend right", "to path"], ["bend left=", "degrees"], ["in=", "degrees"], ["out=", "degrees"],
  ["looseness=", "to path"], ["smooth", "plot"], ["domain=", "e.g. 0:2"], ["samples=", "plot"], ["mark=", "e.g. *"],
  ["step=", "grid"], ["help lines", "light grid"], ["label=", "e.g. above:text"], ["pin=", "e.g. right:text"],
  ["top color=", "shading"], ["bottom color=", "shading"], ["line cap=round", "line"], ["line join=round", "line"],
  ["double", "line"], ["every node/.style={}", "style"], ["name=", "name the node"],
];

const BASE_COLORS = [
  "black", "white", "gray", "darkgray", "lightgray", "red", "green", "blue", "cyan", "magenta", "yellow",
  "brown", "lime", "olive", "orange", "pink", "purple", "teal", "violet",
];

const ANCHORS = [
  "north", "south", "east", "west", "north east", "north west", "south east", "south west", "center", "base", "mid", "text",
];

export const TIKZ_LIBRARIES = [
  "arrows.meta", "positioning", "calc", "shapes", "shapes.geometric", "shapes.misc", "shapes.arrows", "fit",
  "backgrounds", "matrix", "trees", "intersections", "through", "angles", "quotes", "automata", "shadows",
  "fadings", "patterns", "patterns.meta", "decorations.pathmorphing", "decorations.pathreplacing",
  "decorations.markings", "3d", "perspective", "graphs", "mindmap", "chains", "spy", "babel", "cd", "external",
];

const COLOR_KEY = /(?:^|[\s,[])(?:fill|draw|color|text|top color|bottom color|left color|right color|ball color)\s*=\s*([\w!.]*)$/;

/** Colours the document defines, and the TikZ styles it names. */
function defined(doc: string) {
  const colors = [...doc.matchAll(/\\(?:definecolor|colorlet)\s*\{([^}]+)\}/g)].map((m) => m[1].trim());
  const styles = [...doc.matchAll(/([A-Za-z][\w ]*?)\s*\/\.style/g)].map((m) => m[1].trim());
  return { colors: [...new Set(colors)], styles: [...new Set(styles)] };
}

/** Names of nodes and coordinates in a picture: `\node (a)`, `node[...] (a)`, `coordinate (a)`, `name=a`. */
export function pictureNames(picture: string): string[] {
  const names = [
    ...[...picture.matchAll(/(?:\\node|\bnode|\\coordinate|\bcoordinate)\s*(?:\[[^\]]*\])?\s*\(([^()\s,.]+)\)/g)].map((m) => m[1]),
    ...[...picture.matchAll(/\bname\s*=\s*([\w-]+)/g)].map((m) => m[1]),
  ];
  return [...new Set(names)].filter((n) => !/^-?[\d.]+$/.test(n));
}

/** Where an unclosed `[` starts on the line before the cursor, if the cursor is inside one. */
function openBracket(line: string): number {
  let depth = 0;
  let braces = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    const ch = line[i];
    if (ch === "}") braces++;
    else if (ch === "{") braces = Math.max(0, braces - 1);
    else if (braces) continue;
    else if (ch === "]") depth++;
    else if (ch === "[") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

export function tikzCompletion(context: CompletionContext): CompletionResult | null {
  const doc = context.state.doc.toString();
  const range = pictureAt(doc, context.pos);
  if (!range || context.pos <= range.from + 7) return null;
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);

  // inside (…): node names, or anchors after a dot
  const coord = /\(([A-Za-z][\w-]*)?(\.[\w ]*)?$/.exec(before);
  if (coord && !/\\[a-zA-Z]+$/.test(before.slice(0, coord.index))) {
    const picture = doc.slice(range.from, range.to);
    if (coord[2] !== undefined) {
      const partial = coord[2].slice(1);
      return { from: context.pos - partial.length, options: ANCHORS.map((label) => ({ label, type: "property" })), validFor: /^[\w ]*$/ };
    }
    const partial = coord[1] ?? "";
    if (!partial && !context.explicit) return null;
    const options = pictureNames(picture).map((label): Completion => ({ label, type: "variable", detail: "node" }));
    return options.length ? { from: context.pos - partial.length, options, validFor: /^[\w-]*$/ } : null;
  }

  // inside […]: colours after fill= and the like, otherwise option keys and styles
  const bracket = openBracket(before);
  if (bracket < 0) return null;
  const inside = before.slice(bracket + 1);
  const { colors, styles } = defined(doc);
  const color = COLOR_KEY.exec(inside);
  if (color) {
    const options = [
      ...colors.map((label): Completion => ({ label, type: "constant", detail: "defined in the paper", boost: 1 })),
      ...BASE_COLORS.map((label): Completion => ({ label, type: "constant" })),
    ];
    return { from: context.pos - color[1].length, options, validFor: /^[\w!.]*$/ };
  }
  const partial = /[^,[=]*$/.exec(inside)![0].trimStart();
  if (inside.slice(inside.length - partial.length - 1).includes("=")) return null; // a value, not a key
  if (!partial && !context.explicit && !/(^|,)\s*$/.test(inside)) return null;
  const options = [
    ...styles.map((label): Completion => ({ label, type: "class", detail: "style", boost: 1 })),
    ...OPTIONS.map(([label, detail]): Completion => ({ label, detail, type: "property" })),
  ];
  return { from: context.pos - partial.length, options, validFor: /^[\w \-<>|{}]*$/ };
}

// ---------- pictures to start from ----------
interface Starter {
  label: string;
  detail: string;
  packages?: string[];
  libraries?: string[];
  /** The picture, indented by two spaces per level from column 0. */
  body: string;
  /** Shown in display maths rather than a figure (tikzcd). */
  display?: boolean;
}

export const STARTERS: Starter[] = [
  {
    label: "Axes and a curve",
    detail: "Two arrows and a Bézier curve",
    body: String.raw`\begin{tikzpicture}
  \draw[->] (0,0) -- (3,0) node[right] {$x$};
  \draw[->] (0,0) -- (0,2) node[above] {$y$};
  \draw[thick] (0,0) .. controls (1,2) and (2,0) .. (3,1.5);
\end{tikzpicture}`,
  },
  {
    label: "Plot",
    detail: "A function and data points with pgfplots",
    packages: ["pgfplots"],
    body: String.raw`\begin{tikzpicture}
  \begin{axis}[width=8cm, height=5cm, xlabel={$x$}, ylabel={$y$}, axis lines=left, grid=major, legend pos=north west]
    \addplot[blue, thick, domain=0:4, samples=100] {x^2/4};
    \addplot[only marks, mark=*, red] coordinates {(0.5,0.2) (1.5,0.5) (2.5,1.7) (3.5,3)};
    \legend{model, data}
  \end{axis}
\end{tikzpicture}`,
  },
  {
    label: "Flowchart",
    detail: "Boxes joined by arrows",
    libraries: ["positioning", "arrows.meta"],
    body: String.raw`\begin{tikzpicture}[node distance=10mm, box/.style={draw, rounded corners=2pt, minimum width=24mm, minimum height=8mm, align=center}]
  \node[box] (start) {Start};
  \node[box, below=of start] (step) {Do something};
  \node[box, below=of step] (stop) {Stop};
  \draw[-{Stealth}] (start) -- (step);
  \draw[-{Stealth}] (step) -- (stop);
\end{tikzpicture}`,
  },
  {
    label: "Commutative diagram",
    detail: "tikz-cd, in display maths",
    packages: ["tikz-cd"],
    display: true,
    body: String.raw`\begin{tikzcd}
  A \arrow[r, "f"] \arrow[d, "g"'] & B \arrow[d, "h"] \\
  C \arrow[r, "k"'] & D
\end{tikzcd}`,
  },
  {
    label: "Tree",
    detail: "A root with children",
    body: String.raw`\begin{tikzpicture}[level distance=12mm, sibling distance=24mm, every node/.style={draw, circle, minimum size=7mm}]
  \node {r}
    child { node {a} child { node {c} } child { node {d} } }
    child { node {b} };
\end{tikzpicture}`,
  },
  {
    label: "Graph",
    detail: "Vertices on a circle and edges",
    body: String.raw`\begin{tikzpicture}[vertex/.style={draw, circle, fill=white, minimum size=6mm}]
  \foreach \name/\angle in {a/90, b/162, c/234, d/306, e/18}
    \node[vertex] (\name) at (\angle:1.6) {$\name$};
  \foreach \u/\v in {a/b, b/c, c/d, d/e, e/a, a/c, b/d}
    \draw (\u) -- (\v);
\end{tikzpicture}`,
  },
  {
    label: "Neural network",
    detail: "Layers of neurons, fully connected",
    body: String.raw`\begin{tikzpicture}[x=20mm, y=9mm, neuron/.style={circle, draw, fill=white, minimum size=6mm}]
  \foreach \n/\layer [count=\l] in {3/input, 4/hidden, 2/output} {
    \foreach \i in {1,...,\n}
      \node[neuron] (\layer-\i) at (\l, {(\n+1)/2-\i}) {};
    \node[font=\scriptsize] at (\l, 2.6) {\layer};
  }
  \foreach \i in {1,...,3} \foreach \j in {1,...,4} \draw[gray] (input-\i) -- (hidden-\j);
  \foreach \i in {1,...,4} \foreach \j in {1,...,2} \draw[gray] (hidden-\i) -- (output-\j);
\end{tikzpicture}`,
  },
  {
    label: "Venn diagram",
    detail: "Two overlapping sets",
    body: String.raw`\begin{tikzpicture}
  \fill[blue, fill opacity=.25] (0,0) circle (1.2);
  \fill[red, fill opacity=.25] (1.4,0) circle (1.2);
  \draw (0,0) circle (1.2) (1.4,0) circle (1.2);
  \node at (-0.5,0) {$A$};
  \node at (1.9,0) {$B$};
  \node at (0.7,0) {$A \cap B$};
\end{tikzpicture}`,
  },
  {
    label: "Circuit",
    detail: "A resistor and capacitor with circuitikz",
    packages: ["circuitikz"],
    body: String.raw`\begin{circuitikz}
  \draw (0,0) to[battery1, l=$V$] (0,3) to[R, l=$R$] (4,3) to[C, l=$C$] (4,0) -- (0,0);
\end{circuitikz}`,
  },
];

const indented = (text: string, indent: string) => text.split("\n").map((l) => indent + l).join("\n");

/** The starter as it goes into the paper: in a figure with a caption and label, or in display maths. */
export function starterText(starter: Starter, indent: string): string {
  if (starter.display) return `${indent}\\[\n${indented(starter.body, indent + "  ")}\n${indent}\\]\n`;
  return [
    `${indent}\\begin{figure}[ht]`,
    `${indent}  \\centering`,
    indented(starter.body, indent + "  "),
    `${indent}  \\caption{}`,
    `${indent}  \\label{fig:}`,
    `${indent}\\end{figure}`,
    "",
  ].join("\n");
}

/** The edits that load what a starter needs into a preamble, as [position, text] pairs. */
export function preambleEdits(doc: string, starter: Starter): [number, string][] {
  const begin = doc.indexOf("\\begin{document}");
  if (begin < 0) return [];
  const preamble = doc.slice(0, begin);
  const edits: [number, string][] = [];
  const lines: string[] = [];
  const loaded = (pkg: string) => new RegExp(`\\\\usepackage(\\[[^\\]]*\\])?\\{[^}]*\\b${pkg.replace("-", "\\-")}\\b[^}]*\\}`).test(preamble);
  for (const pkg of ["tikz", ...(starter.packages ?? [])]) {
    if (pkg === "tikz" && (loaded("circuitikz") || loaded("pgfplots"))) continue; // both load tikz
    if (!loaded(pkg)) lines.push(`\\usepackage{${pkg}}`);
    if (pkg === "pgfplots" && !/\\pgfplotsset\{[^}]*compat/.test(preamble)) lines.push("\\pgfplotsset{compat=1.18}");
  }
  const missing = (starter.libraries ?? []).filter((lib) =>
    ![...preamble.matchAll(/\\usetikzlibrary\{([^}]*)\}/g)].some((m) => m[1].split(",").map((s) => s.trim()).includes(lib)));
  if (missing.length) {
    const existing = /\\usetikzlibrary\{([^}]*)\}/.exec(preamble);
    if (existing) edits.push([existing.index + existing[0].length - 1, `,${missing.join(",")}`]);
    else lines.push(`\\usetikzlibrary{${missing.join(",")}}`);
  }
  if (lines.length) {
    // after the last \usepackage, or else just before \begin{document}
    const last = [...preamble.matchAll(/^[ \t]*\\usepackage.*$/gm)].pop();
    const at = last ? last.index! + last[0].length + 1 : begin;
    edits.push([Math.min(at, begin), lines.join("\n") + "\n"]);
  }
  return edits;
}

function insertStarter(editor: EditorView, starter: Starter) {
  const pos = editor.state.selection.main.head;
  const at = editor.state.doc.lineAt(pos);
  const indent = /^[ \t]*/.exec(at.text)![0];
  const insertAt = at.text.trim() ? at.to : at.from;
  const text = (at.text.trim() ? "\n" : "") + starterText(starter, indent);
  const doc = editor.state.doc.toString();
  const preamble = preambleEdits(doc, starter);
  const changes = [{ from: insertAt, insert: text }, ...preamble.map(([from, insert]) => ({ from, insert }))];
  const shift = preamble.filter(([from]) => from <= insertAt).reduce((n, [, insert]) => n + insert.length, 0);
  // the cursor goes at the end of the picture's first line, so the preview shows it
  const head = starter.body.split("\n")[0];
  const first = text.indexOf(head) + head.length;
  editor.dispatch({ changes, selection: { anchor: insertAt + shift + first }, userEvent: "input", scrollIntoView: true });
  if (!preamble.length && !/\\documentclass/.test(doc) && (starter.packages?.length || starter.libraries?.length)) {
    const needs = [...(starter.packages ?? []).map((p) => `\\usepackage{${p}}`), ...(starter.libraries?.length ? [`\\usetikzlibrary{${starter.libraries.join(",")}}`] : [])];
    setStatus(`This picture needs ${needs.join(" and ")} in the paper's preamble`);
  }
  editor.focus();
  openTikzPreview(editor);
}

/** Pick a picture to start from and put it at the cursor, with the preview open beside it. */
export function insertTikzPicture() {
  const editor = activeEditor();
  if (!editor || !PICTURE_FILE.test(editor.dom.dataset.path ?? "")) {
    setStatus("Put the cursor in a .tex or .tikz file to insert a TikZ picture");
    return;
  }
  openPalette({
    placeholder: "Insert a TikZ picture…",
    empty: "No picture by that name",
    items: STARTERS.map((starter) => ({ label: starter.label, detail: starter.detail, run: () => insertStarter(editor, starter) })),
  });
}
