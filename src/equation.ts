// Edit Equation: the maths at the cursor in a visual editor (MathLive) beside the source, typed
// the way one writes on paper, with a live check that it still typesets. Written back as LaTeX in
// one edit, keeping its environment and \label. MathLive loads the first time it's used.
import type { EditorView } from "@codemirror/view";
import katex from "katex";
import { setStatus } from "./core";
import { activeEditor, closeSide, showInSide } from "./split";

/** The maths around `pos`: where its body is, and what wraps it. */
export interface MathBody {
  /** The body inside the delimiters or environment. */
  from: number;
  to: number;
  body: string;
  /** "inline", "display", or an environment name. */
  kind: string;
  /** \label{…} and \nonumber kept out of the visual editor and put back at the end. */
  keep: string;
}

const ENVS = "equation|align|gather|multline|eqnarray|displaymath|alignat|flalign";
// Environments that align on &: the visual editor sees them as their "ed" forms.
const INNER: Record<string, string> = { align: "aligned", alignat: "aligned", flalign: "aligned", eqnarray: "aligned", gather: "gathered" };

/** The formula containing `pos`. Pure. */
export function mathBodyAt(doc: string, pos: number): MathBody | null {
  const patterns: [RegExp, (m: RegExpExecArray) => [number, string]][] = [
    [new RegExp(`\\\\begin\\{(${ENVS})(\\*?)\\}([\\s\\S]*?)\\\\end\\{\\1\\2\\}`, "g"), (m) => [m[0].indexOf("}") + 1, m[1] + m[2]]],
    [/\\\[([\s\S]*?)\\\]/g, () => [2, "display"]],
    [/\$\$([\s\S]*?)\$\$/g, () => [2, "display"]],
    [/\\\(([\s\S]*?)\\\)/g, () => [2, "inline"]],
    [/(?<![\\$])\$((?:\\.|[^$\\\n])+)\$(?!\$)/g, () => [1, "inline"]],
  ];
  for (const [re, describe] of patterns) {
    for (let m = re.exec(doc); m; m = re.exec(doc)) {
      const end = m.index + m[0].length;
      if (pos < m.index || pos > end) continue;
      const [lead, kind] = describe(m);
      const inner = m[3] ?? m[1];
      const from = m.index + (m[3] !== undefined ? m[0].indexOf(inner, lead) : lead);
      const to = from + inner.length;
      const keep = (inner.match(/\\label\{[^}]*\}|\\nonumber|\\notag/g) ?? []).join(" ");
      const body = inner.replace(/\\label\{[^}]*\}|\\nonumber|\\notag/g, "").trim();
      return { from, to, body, kind, keep };
    }
  }
  return null;
}

let mathlive: Promise<typeof import("mathlive")> | null = null;
/** MathLive, set up to use the KaTeX fonts the app already has and to stay quiet. */
function loadMathLive() {
  mathlive ??= import("mathlive").then((ml) => {
    ml.MathfieldElement.fontsDirectory = null;
    ml.MathfieldElement.soundsDirectory = null;
    return ml;
  });
  return mathlive;
}

async function openEditor(editor: EditorView, math: MathBody) {
  const ml = await loadMathLive();
  const inner = INNER[math.kind.replace("*", "")];
  const field = new ml.MathfieldElement();
  field.className = "eq-field";
  field.value = inner ? `\\begin{${inner}}${math.body}\\end{${inner}}` : math.body;
  field.smartFence = true;
  field.mathVirtualKeyboardPolicy = "manual";

  const box = document.createElement("div");
  box.className = "eq-editor";
  const bar = document.createElement("div");
  bar.className = "eq-bar";
  const check = document.createElement("div");
  check.className = "eq-check";
  const source = document.createElement("pre");
  source.className = "eq-source";
  const hint = document.createElement("p");
  hint.className = "eq-hint";
  hint.textContent = "Type as you would write: / makes a fraction, ^ and _ go up and down, \\ starts a command (\\alpha, \\sum). Tab moves to the next box.";

  const latex = () => {
    let tex = field.getValue("latex-expanded");
    // back from the "ed" form the visual editor used
    if (inner) tex = tex.replace(new RegExp(`^\\\\begin\\{${inner}\\}([\\s\\S]*)\\\\end\\{${inner}\\}$`), "$1");
    return tex.trim();
  };
  const refresh = () => {
    const tex = latex();
    source.textContent = tex;
    try {
      katex.renderToString(inner ? `\\begin{${inner}}${tex}\\end{${inner}}` : tex, { throwOnError: true, displayMode: true });
      check.textContent = "Typesets";
      check.className = "eq-check ok";
    } catch (e) {
      check.textContent = String((e as Error).message ?? e).replace(/^KaTeX parse error: /, "");
      check.className = "eq-check err";
    }
  };
  field.addEventListener("input", refresh);

  const apply = (close: boolean) => {
    const current = editor.state.sliceDoc(math.from, math.to);
    const display = math.kind !== "inline";
    const indent = display ? /^[ \t]*/.exec(editor.state.doc.lineAt(math.from).text)?.[0] ?? "" : "";
    const tex = latex();
    // a display formula keeps its lines; an inline one stays on one line
    const body = display && current.includes("\n")
      ? `\n${indent}  ${tex}${math.keep ? ` ${math.keep}` : ""}\n${indent}`
      : `${display ? " " : ""}${tex}${math.keep ? ` ${math.keep}` : ""}${display ? " " : ""}`;
    editor.dispatch({ changes: { from: math.from, to: math.to, insert: body }, userEvent: "input" });
    math = { ...math, to: math.from + body.length };
    setStatus("Equation updated", "ok");
    if (close) {
      closeSide();
      editor.focus();
    }
  };

  const button = (text: string, title: string, onclick: () => void, cls = "btn") => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = text;
    b.title = title;
    b.onclick = onclick;
    return b;
  };
  const gap = document.createElement("span");
  gap.style.flex = "1";
  bar.append(
    button("Keyboard", "Show or hide the keyboard of symbols", () => {
      const kb = window.mathVirtualKeyboard;
      if (kb.visible) kb.hide();
      else {
        field.focus();
        kb.show();
      }
    }),
    gap,
    button("Apply", "Write the equation back into the document", () => apply(false)),
    button("Done", "Write it back and close", () => apply(true), "btn btn-primary"),
  );
  box.append(bar, field, check, source, hint);
  await showInSide("Equation", box);
  refresh();
  field.focus();
  // the cursor at the end, not the whole formula selected for the first key to replace
  field.executeCommand("moveToMathfieldEnd");
}

/** Edit the maths at the cursor visually; on a line with none, start a new equation. */
export async function editEquation() {
  const editor = activeEditor();
  if (!editor || !editor.dom.dataset.path?.endsWith(".tex")) {
    setStatus("Put the cursor in a .tex file to edit or insert an equation");
    return;
  }
  const pos = editor.state.selection.main.head;
  let math = mathBodyAt(editor.state.doc.toString(), pos);
  if (math && /^(align|alignat|flalign|eqnarray|gather)\*?$/.test(math.kind) && (math.keep.match(/\\label/g) ?? []).length > 1) {
    setStatus("This environment labels several lines; edit it in the source so each label stays on its line");
    return;
  }
  if (!math) {
    const at = editor.state.doc.lineAt(pos);
    const indent = /^[ \t]*/.exec(at.text)![0];
    const insertAt = at.text.trim() ? at.to : at.from;
    const text = `${at.text.trim() ? "\n" + indent : ""}\\begin{equation}\n${indent}  \n${indent}\\end{equation}\n`;
    editor.dispatch({ changes: { from: insertAt, insert: text }, userEvent: "input" });
    math = mathBodyAt(editor.state.doc.toString(), editor.state.doc.toString().indexOf("\\begin{equation}", insertAt) + 18);
    if (!math) return;
  }
  setStatus("Loading the equation editor…", "busy");
  await openEditor(editor, math).catch((e) => setStatus(`Couldn't open the equation editor: ${e}`, "err"));
  setStatus("");
}
