// Notebook cell view for `# %%` Python files and .ipynb, plus the Python kernel.
import { EditorView, minimalSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { python, pythonLanguage } from "@codemirror/lang-python";
import { autocompletion, closeBrackets, closeBracketsKeymap, CompletionContext } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { invoke } from "@tauri-apps/api/core";
import { compile, saveFile } from "./build";
import { $, current, dirty, ICON_CLOSE, ICON_PLAY, mainFile, root, setDirty, setStatus } from "./core";
import { editorTheme, floatingTooltips, gruvbox, view } from "./editor";
import { openFile, save, setMainView } from "./project";
import { settings } from "./settings";
import { CellResult, IpynbCell, IpynbDoc, NotebookCell, NotebookInfo } from "./types";

// ---------- notebook cell view ----------
export let nbCells: NotebookCell[] = [];
export let kernelStarted = false;
export let cellRunners: ((() => Promise<void>) | undefined)[] = [];
export let activeCell = -1; // index of the cell that last had focus

export let notebookMode = false; // the open file is shown as cells rather than as text
export let nbDoc: IpynbDoc | null = null; // the parsed .ipynb being edited, when there is one

export const isNotebook = () => notebookMode && nbCells.length > 0;

/** Forget the open notebook (another kind of file, or nothing, is being shown). */
export function leaveNotebook() {
  notebookMode = false;
  nbDoc = null;
  nbCells = [];
}

// ----- .ipynb -----
export const ipynbText = (source: string | string[] | undefined) => (Array.isArray(source) ? source.join("") : source ?? "");
// IPython magics and shell escapes aren't Python; the plain kernel can't run them.
export const stripMagics = (code: string) => code.split("\n").filter((l) => !/^\s*[%!]/.test(l)).join("\n");

export function emptyIpynb(): IpynbDoc {
  return {
    cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [] }],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 4,
  };
}

export function ipynbToCells(doc: IpynbDoc): NotebookCell[] {
  return (doc.cells ?? [])
    .filter((c) => c.cell_type === "code" || c.cell_type === "markdown")
    .map((raw) => {
      // "papyrus" is the key written before the app was renamed; saving rewrites it as "scribe".
      const figure = raw.cell_type === "code" ? raw.metadata?.scribe?.figure ?? raw.metadata?.papyrus?.figure : null;
      return {
        cell_type: raw.cell_type === "markdown" ? "markdown" : figure ? "figure" : "code",
        source: ipynbText(raw.source).replace(/\n$/, ""),
        figure_id: typeof figure === "string" ? figure : null,
        raw,
      };
    });
}

// Writes nbCells back into the document. Untouched cells keep their outputs; a figure cell is a
// code cell tagged with metadata.scribe.figure, so the file stays a normal Jupyter notebook.
export function serializeIpynb(doc: IpynbDoc): string {
  const cells = nbCells.map((cell) => {
    const prev = cell.raw;
    const metadata: Record<string, any> = { ...(prev?.metadata ?? {}) };
    if (cell.cell_type === "figure" && cell.figure_id) metadata.scribe = { ...metadata.scribe, figure: cell.figure_id };
    else delete metadata.scribe;
    delete metadata.papyrus;
    const lines = cell.source.split("\n");
    const source = lines.map((l, i) => (i < lines.length - 1 ? l + "\n" : l)).filter((l) => l !== "");
    const id = prev?.id ? { id: prev.id } : {};
    let next: IpynbCell;
    if (cell.cell_type === "markdown") {
      next = { cell_type: "markdown", ...id, metadata, source };
    } else {
      const unchanged = prev?.cell_type === "code" && ipynbText(prev.source).replace(/\n$/, "") === cell.source;
      next = {
        cell_type: "code",
        execution_count: unchanged ? prev!.execution_count ?? null : null,
        ...id,
        metadata,
        outputs: unchanged ? prev!.outputs ?? [] : [],
        source,
      };
    }
    cell.raw = next;
    return next;
  });
  return JSON.stringify({ ...doc, cells }, null, 1) + "\n";
}

export async function stopKernel() {
  try { await invoke("kernel_stop"); } catch {}
  kernelStarted = false;
}

export async function restartKernel() {
  await stopKernel();
  for (const out of document.querySelectorAll<HTMLElement>(".nb-cell-output")) {
    out.replaceChildren();
    out.hidden = true;
  }
  setStatus("Kernel restarted", "ok");
}

$("notebook-view").addEventListener("focusin", (e) => {
  const card = (e.target as HTMLElement).closest(".nb-cell");
  if (card) activeCell = [...$("notebook-view").querySelectorAll(".nb-cell")].indexOf(card);
});

export const CELL_KIND: Record<string, string> = { code: "Code", markdown: "Text", figure: "Figure" };

export function cellsToPy(): string {
  return nbCells.map((c) => {
    let header = "# %%";
    if (c.cell_type === "markdown") header = "# %% [markdown]";
    else if (c.cell_type === "figure" && c.figure_id) header = `# %% [figure: ${c.figure_id}]`;
    const body = c.cell_type === "markdown"
      ? c.source.split("\n").map((l) => "# " + l).join("\n")
      : c.source;
    return header + "\n" + body;
  }).join("\n\n") + "\n";
}

export async function saveNotebook() {
  if (!root || !current) return;
  const content = current.endsWith(".ipynb") ? serializeIpynb(nbDoc ?? emptyIpynb()) : cellsToPy();
  await invoke("write_file", { root, rel: current, content });
  setDirty(false);
}

export function nextFigureId(): string {
  const taken = new Set(nbCells.map((c) => c.figure_id));
  let n = 1;
  while (taken.has(`figure-${n}`)) n++;
  return `figure-${n}`;
}

export function addCellAt(index: number, type: string) {
  nbCells.splice(index, 0, {
    cell_type: type,
    source: "",
    figure_id: type === "figure" ? nextFigureId() : null,
  });
  setDirty(true);
  renderNotebookCells();
  // A new figure needs a name before anything else; other cells go straight to the source.
  const card = $("notebook-view").querySelectorAll<HTMLElement>(".nb-cell")[index];
  if (type === "figure") {
    const id = card?.querySelector<HTMLInputElement>(".nb-cell-id");
    id?.focus();
    id?.select();
  } else if (cellViews[index]) {
    cellViews[index]!.focus();
  } else {
    card?.querySelector<HTMLTextAreaElement>(".nb-cell-source")?.focus();
  }
}

export function deleteCellAt(index: number) {
  if (nbCells.length <= 1) return;
  nbCells.splice(index, 1);
  setDirty(true);
  renderNotebookCells();
}

export function makeAddBar(index: number): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "nb-add";
  const label = document.createElement("span");
  label.className = "nb-add-label";
  label.textContent = "Add";
  bar.appendChild(label);
  for (const type of ["code", "markdown", "figure"]) {
    const btn = document.createElement("button");
    btn.textContent = CELL_KIND[type];
    btn.title = `Add a ${CELL_KIND[type].toLowerCase()} cell here`;
    btn.onclick = () => addCellAt(index, type);
    bar.appendChild(btn);
  }
  return bar;
}

// Names defined in other cells, so completion follows the notebook rather than one cell.
export function notebookCompletion(context: CompletionContext) {
  const word = context.matchBefore(/[A-Za-z_]\w*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const here = context.state.doc.toString();
  const names = new Set<string>();
  for (const cell of nbCells) {
    if (cell.cell_type === "markdown" || cell.source === here) continue;
    for (const m of cell.source.matchAll(/[A-Za-z_]\w{2,}/g)) names.add(m[0]);
  }
  if (!names.size) return null;
  return {
    from: word.from,
    options: [...names].map((label) => ({ label, type: "variable", boost: -1 })),
    validFor: /^\w*$/,
  };
}

// Code cells are small CodeMirror editors: same highlighting and theme as the main editor.
export const cellThemeConf = new Compartment();
export const cellChrome = Prec.highest(EditorView.theme({
  "&": { backgroundColor: "transparent" },
  ".cm-scroller": { padding: "0 0 12px", lineHeight: "1.6" },
  ".cm-content": { padding: "0" },
  ".cm-line": { padding: "0 14px" },
  ".cm-activeLine": { backgroundColor: "transparent" },
}));
export let cellViews: (EditorView | undefined)[] = [];

export function makeCellEditor(cell: NotebookCell, index: number, card: HTMLElement): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: cell.source,
      extensions: [
        Prec.highest(keymap.of([
          { key: "Shift-Enter", preventDefault: true, run: () => (cellRunners[index]?.(), true) },
          { key: "Mod-Enter", preventDefault: true, run: () => (compile(), true) },
          { key: "Mod-s", preventDefault: true, run: () => (saveFile(), true) },
        ])),
        minimalSetup,
        floatingTooltips,
        python(),
        pythonLanguage.data.of({ autocomplete: notebookCompletion }),
        syntaxHighlighting(gruvbox),
        autocompletion(),
        closeBrackets(),
        bracketMatching(),
        indentOnInput(),
        indentUnit.of("    "),
        keymap.of([...closeBracketsKeymap, indentWithTab]),
        cellThemeConf.of(editorTheme(settings.theme === "dark")),
        cellChrome,
        EditorView.contentAttributes.of({ "aria-label": `${CELL_KIND[cell.cell_type] ?? "Cell"} source` }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          cell.source = u.state.doc.toString();
          setDirty(true);
          setCellState(card, null); // the last result no longer describes this source
        }),
      ],
    }),
  });
}

export function renderNotebookCells() {
  const nb = $("notebook-view");
  const frag = document.createDocumentFragment();
  frag.appendChild(makeAddBar(0));
  cellRunners = [];
  cellViews.forEach((v) => v?.destroy());
  cellViews = [];
  if (activeCell >= nbCells.length) activeCell = -1;

  nbCells.forEach((cell, i) => {
    const card = document.createElement("div");
    card.className = `nb-cell nb-cell-${cell.cell_type}`;

    const head = document.createElement("div");
    head.className = "nb-cell-head";

    let source: HTMLElement;
    if (cell.cell_type === "markdown") {
      const text = document.createElement("textarea");
      text.className = "nb-cell-source";
      text.value = cell.source;
      text.rows = Math.max(1, cell.source.split("\n").length);
      text.setAttribute("aria-label", "Text");
      text.addEventListener("input", () => {
        cell.source = text.value;
        text.rows = Math.max(1, text.value.split("\n").length);
        setDirty(true);
      });
      source = text;
    } else {
      const editor = makeCellEditor(cell, i, card);
      cellViews[i] = editor;
      source = editor.dom;
    }

    let output: HTMLElement | null = null;
    if (cell.cell_type !== "markdown") {
      const out = document.createElement("div");
      out.className = "nb-cell-output";
      out.hidden = true;
      output = out;

      const run = document.createElement("button");
      run.className = "icon-btn nb-cell-run";
      run.innerHTML = ICON_PLAY;
      run.title = "Run cell";
      run.setAttribute("aria-label", "Run cell");
      const runCell = async () => {
        if (run.disabled) return;
        run.disabled = true;
        run.innerHTML = '<span class="spinner"></span>';
        if (!out.childElementCount) {
          out.innerHTML = '<div class="nb-out-running">Running…</div>';
          out.hidden = false;
        }
        const result = await runCellInline(cell.source, `cell-${i}`, out);
        setCellState(card, result);
        run.disabled = false;
        run.innerHTML = ICON_PLAY;
      };
      run.onclick = runCell;
      cellRunners[i] = runCell;
      head.appendChild(run);
    }

    const kind = document.createElement("span");
    kind.className = "nb-cell-kind";
    kind.textContent = CELL_KIND[cell.cell_type] ?? cell.cell_type;
    head.appendChild(kind);

    if (cell.cell_type === "figure") {
      const id = document.createElement("input");
      id.type = "text";
      id.className = "nb-cell-id";
      id.value = cell.figure_id ?? "";
      id.placeholder = "figure-id";
      id.spellcheck = false;
      id.title = "Figure ID. Reference it in LaTeX with \\nbfig{…}";
      id.setAttribute("aria-label", "Figure ID");
      id.addEventListener("input", () => {
        cell.figure_id = id.value.trim().replace(/[\s\]]+/g, "-") || null;
        setDirty(true);
      });
      head.appendChild(id);
    }

    const mark = document.createElement("span");
    mark.className = "nb-cell-mark";
    head.appendChild(mark);

    if (cell.cell_type === "figure") {
      const insert = document.createElement("button");
      insert.className = "btn nb-cell-insert";
      insert.textContent = "Insert into paper";
      insert.title = "Add this figure to the main .tex file";
      insert.onclick = () => insertFigureIntoPaper(cell);
      head.appendChild(insert);
    }

    const del = document.createElement("button");
    del.className = "icon-btn nb-cell-del";
    del.innerHTML = ICON_CLOSE;
    del.title = "Delete cell";
    del.setAttribute("aria-label", "Delete cell");
    del.disabled = nbCells.length <= 1;
    del.onclick = () => deleteCellAt(i);
    head.appendChild(del);

    card.append(head, source);
    if (output) card.appendChild(output);

    frag.appendChild(card);
    frag.appendChild(makeAddBar(i + 1));
  });

  nb.replaceChildren(frag);
}

// Where a figure is pulled into a .tex source: \nbfig{id}, or a direct \includegraphics of its PDF.
export function figureOffset(tex: string, id: string): number {
  const name = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const include = new RegExp(`\\\\nbfig\\{${name}\\}|\\\\includegraphics(\\[[^\\]]*\\])?\\{(\\./)?figures/${name}(\\.pdf)?\\}`, "g");
  for (const m of tex.matchAll(include)) {
    // A mention inside a % comment doesn't put the figure in the paper.
    const lineStart = tex.lastIndexOf("\n", m.index!) + 1;
    if (!/(^|[^\\])%/.test(tex.slice(lineStart, m.index!))) return m.index!;
  }
  return -1;
}

// Opens the paper with the figure's block selected, so it is obvious what was added and where.
export async function showFigureInPaper(id: string) {
  await openFile(mainFile);
  const doc = view.state.doc.toString();
  const at = figureOffset(doc, id);
  if (at === -1) return;
  const begin = doc.lastIndexOf("\\begin{figure}", at);
  const endTag = "\\end{figure}";
  const end = doc.indexOf(endTag, at);
  const line = view.state.doc.lineAt(at);
  // Select the whole figure environment when the include sits inside one, else just its line.
  const inEnv = begin !== -1 && end !== -1 && !doc.slice(begin, at).includes(endTag);
  view.dispatch({
    selection: inEnv ? { anchor: begin, head: end + endTag.length } : { anchor: line.from, head: line.to },
    effects: EditorView.scrollIntoView(at, { y: "center" }),
  });
  view.focus();
}

// Adds the figure block for a figure cell to the compile root, just before \end{document}.
export async function insertFigureIntoPaper(cell: NotebookCell) {
  if (!root) return;
  const id = cell.figure_id;
  if (!id) {
    setStatus("Give the figure an ID first", "err");
    return;
  }
  if (dirty) await save(); // the notebook on disk has to contain this figure before the paper asks for it

  let tex: string;
  try {
    tex = await invoke<string>("read_file", { root, rel: mainFile });
  } catch {
    setStatus(`Couldn't find ${mainFile} to insert into`, "err");
    return;
  }
  if (figureOffset(tex, id) !== -1) {
    await showFigureInPaper(id);
    setStatus(`${id} is already in ${mainFile}`);
    return;
  }

  const label = id.replace(/^fig[-_:]?/, "") || id;
  const block = `\\begin{figure}[ht]\n  \\centering\n  \\nbfig{${id}}\n  \\caption{}\n  \\label{fig:${label}}\n\\end{figure}\n\n`;
  // Either package defines \nbfig; papyrus-figures is the name from before the rename.
  if (!/\\usepackage(\[[^\]]*\])?\{(scribe|papyrus)-figures\}/.test(tex)) {
    tex = tex.replace(/\\begin\{document\}/, (m) => `\\usepackage{scribe-figures}\n${m}`);
  }
  const end = tex.lastIndexOf("\\end{document}");
  tex = end === -1 ? tex.replace(/\n*$/, "\n\n") + block : tex.slice(0, end) + block + tex.slice(end);

  try {
    await invoke("write_file", { root, rel: mainFile, content: tex });
    try { await invoke("generate_style", { root }); } catch { /* already there */ }
    await showFigureInPaper(id);
    setStatus(`Added ${id} to ${mainFile}`, "ok");
  } catch (e) {
    setStatus(`Couldn't update ${mainFile}: ${e}`, "err");
  }
}

// A .py file is a notebook only when it has `# %%` cell markers; otherwise it is a plain script
// and opens in the text editor. An .ipynb is always a notebook.
export async function updateNotebookView(text: string) {
  const showText = () => {
    leaveNotebook();
    setMainView("editor");
  };

  const ipynb = !!current?.endsWith(".ipynb");
  if (!root || !current || !(ipynb || (current.endsWith(".py") && /^# %%/m.test(text)))) {
    showText();
    return;
  }

  let cells: NotebookCell[];
  if (ipynb) {
    try {
      nbDoc = text.trim() ? (JSON.parse(text) as IpynbDoc) : emptyIpynb();
      cells = ipynbToCells(nbDoc);
    } catch {
      // Not valid JSON: show the raw text so it can be repaired, rather than an empty notebook.
      showText();
      setStatus(`${current} is not a valid notebook file`, "err");
      return;
    }
  } else {
    nbDoc = null;
    try {
      cells = (await invoke<NotebookInfo>("parse_notebook", { root, rel: current })).cells;
    } catch {
      showText();
      return;
    }
  }

  notebookMode = true;
  setMainView("notebook");
  nbCells = cells.length > 0 ? cells : [{ cell_type: "code", source: "", figure_id: null }];
  renderNotebookCells();
}

// "quiet" = ran fine and printed nothing, which otherwise looks the same as never having run.
export type CellRunState = "ok" | "quiet" | "err";

export const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
export const ICON_FAIL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M8 4v5M8 11.75v.01"/></svg>';

export function setCellState(card: HTMLElement, state: CellRunState | null) {
  card.classList.remove("ran-ok", "ran-quiet", "ran-err");
  const mark = card.querySelector<HTMLElement>(".nb-cell-mark");
  if (!mark) return;
  if (!state) {
    mark.replaceChildren();
    mark.title = "";
    return;
  }
  card.classList.add(`ran-${state}`);
  mark.innerHTML = state === "err" ? ICON_FAIL : ICON_CHECK;
  mark.title = state === "err" ? "Failed" : state === "quiet" ? "Ran with no output" : "Ran";
}

export function outputBlock(className: string, text: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = className;
  pre.textContent = text;
  return pre;
}

export async function runCellInline(code: string, cellId: string, outputEl: HTMLElement): Promise<CellRunState> {
  try {
    if (!kernelStarted) {
      await invoke("kernel_start", { root });
      kernelStarted = true;
    }
    const res = await invoke<CellResult>("kernel_run_cell", { code: stripMagics(code), cellId });
    outputEl.replaceChildren();
    if (res.stdout) outputEl.appendChild(outputBlock("nb-out-text", res.stdout));
    if (res.stderr && !res.ok) outputEl.appendChild(outputBlock("nb-out-err", res.stderr));
    for (const b64 of res.figures) {
      const img = document.createElement("img");
      img.className = "nb-out-fig";
      img.alt = "Figure output";
      img.src = `data:image/png;base64,${b64}`;
      outputEl.appendChild(img);
    }
    outputEl.hidden = outputEl.childElementCount === 0;
    if (!res.ok) return "err";
    return outputEl.hidden ? "quiet" : "ok";
  } catch (e) {
    outputEl.replaceChildren(outputBlock("nb-out-err", String(e)));
    outputEl.hidden = false;
    return "err";
  }
}
