// Table editor: a LaTeX tabular as a grid. Put the cursor in a table and choose Edit Table (or
// Insert Table where there is none); edit cells, add or remove rows and columns, set each
// column's alignment, paste a block from a spreadsheet, then Apply writes the LaTeX back as one
// undoable edit.
import { EditorView } from "@codemirror/view";
import { setStatus } from "./core";
import { activeEditor, closeSide, showInSide } from "./split";

const ENVS = "tabular\\*?|tabularx|longtable|array";
const RULE = /^\s*(\\(?:hline|toprule|midrule|bottomrule)\b|\\c(?:mid)?(?:line|rule)(?:\([^)]*\))?\{[^}]*\})\s*/;

interface Row { rules: string[]; cells: string[]; /** Space after the row's \\, like [2pt]. */ gap?: string; }
interface Table {
  /** Everything before the column spec: \begin{tabular}[t] */
  head: string;
  /** The column spec, e.g. "lcr" or "@{}l S[table-format=1.2]@{}". */
  spec: string;
  rows: Row[];
  /** Rules after the last row (\bottomrule). */
  tail: string[];
  env: string;
}

/** Split on `sep` at brace depth 0, skipping escaped characters. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      if (sep === "\\\\" && text[i + 1] === "\\" && depth === 0) {
        out.push(text.slice(start, i));
        i++;
        start = i + 1;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "%") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (depth === 0 && sep === "&" && ch === "&") {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Read the braced group starting at `at` ("{...}"), returning its inside and the index after it. */
function group(text: string, at: number): [string, number] | null {
  if (text[at] !== "{") return null;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return [text.slice(at + 1, i), i + 1];
  }
  return null;
}

/** Columns in a spec: letters (l c r p{} m{} b{} X S[]…), ignoring rules and @{} / >{} / <{}. */
export function specColumns(spec: string): string[] {
  const cols: string[] = [];
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i];
    if (/[|\s]/.test(ch)) continue;
    if ("@!><".includes(ch)) {
      const g = group(spec, i + 1);
      if (g) i = g[1] - 1;
      continue;
    }
    if (ch === "*") {
      const n = group(spec, i + 1);
      const what = n && group(spec, n[1]);
      if (n && what) {
        for (let k = 0; k < Number(n[0]); k++) cols.push(...specColumns(what[0]));
        i = what[1] - 1;
      }
      continue;
    }
    let col = ch;
    const opt = /^\[[^\]]*\]/.exec(spec.slice(i + 1));
    if (opt) { col += opt[0]; i += opt[0].length; }
    const arg = group(spec, i + 1);
    if (arg && /[pmbwW]/.test(ch)) { col += `{${arg[0]}}`; i = arg[1] - 1; }
    cols.push(col);
  }
  return cols;
}

export function parseTable(src: string): Table | null {
  const begin = new RegExp(`^\\\\begin\\{(${ENVS})\\}`).exec(src);
  if (!begin) return null;
  let at = begin[0].length;
  if (begin[1] === "tabular*" || begin[1] === "tabularx") {
    const width = group(src, at);
    if (!width) return null;
    at = width[1];
  }
  const pos = /^\s*\[[^\]]*\]/.exec(src.slice(at));
  if (pos) at += pos[0].length;
  const spec = group(src, at);
  if (!spec) return null;
  const end = src.lastIndexOf(`\\end{${begin[1]}}`);
  if (end < 0) return null;
  const head = src.slice(0, at).trimEnd();
  const rows: Row[] = [];
  let pending: string[] = [];
  for (let chunk of splitTop(src.slice(spec[1], end), "\\\\")) {
    // an optional [2pt] after \\ belongs to the row before it
    const gap = /^\s*(\[[^\]]*\])/.exec(chunk);
    if (gap && rows.length) {
      rows[rows.length - 1].gap = gap[1];
      chunk = chunk.slice(gap[0].length);
    }
    let m: RegExpExecArray | null;
    while ((m = RULE.exec(chunk))) {
      pending.push(m[1]);
      chunk = chunk.slice(m[0].length);
    }
    if (!chunk.trim()) continue;
    rows.push({ rules: pending, cells: splitTop(chunk, "&").map((c) => c.trim()) });
    pending = [];
  }
  return { head, spec: spec[0], rows, tail: pending, env: begin[1] };
}

/** How many columns a cell covers: \multicolumn{3}{c}{…} covers three. */
const spanOf = (cell: string) => Number(/^\\multicolumn\{(\d+)\}/.exec(cell)?.[1] ?? 1);
export const rowSpan = (row: Row) => row.cells.reduce((n, c) => n + spanOf(c), 0);

export function writeTable(t: Table, indent = ""): string {
  const width = Math.max(1, ...t.rows.map(rowSpan));
  // Rows short of the full width get empty cells; spanning cells count for what they span.
  const cells = t.rows.map((r) => [...r.cells, ...Array(Math.max(0, width - rowSpan(r))).fill("")]);
  // Pad columns so the source lines up, as long as no cell is very long.
  // Pad columns so the source lines up (rows with spanning cells aren't padded), as long as no cell is very long.
  const plain = cells.filter((r) => r.length === width);
  const pad = Array.from({ length: width }, (_, i) => Math.min(24, Math.max(0, ...plain.map((r) => r[i].length))));
  const lines = [`${indent}${t.head}{${t.spec}}`];
  t.rows.forEach((row, r) => {
    for (const rule of row.rules) lines.push(`${indent}  ${rule}`);
    const line = cells[r].map((c, i) => (i < cells[r].length - 1 && cells[r].length === width ? c.padEnd(pad[i]) : c)).join(" & ");
    lines.push(`${indent}  ${line.trimEnd()} \\\\${row.gap ?? ""}`);
  });
  for (const rule of t.tail) lines.push(`${indent}  ${rule}`);
  lines.push(`${indent}\\end{${t.env}}`);
  return lines.join("\n");
}

/** The tabular around `pos`: where it starts and ends in the document. */
function tableAt(doc: string, pos: number): { from: number; to: number } | null {
  const re = new RegExp(`\\\\begin\\{(${ENVS})\\}`, "g");
  let best: { from: number; to: number } | null = null;
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    if (m.index > pos) break;
    const close = `\\end{${m[1]}}`;
    // match nested environments of the same kind
    let depth = 0;
    const scan = new RegExp(`\\\\(begin|end)\\{${m[1].replace("*", "\\*")}\\}`, "g");
    scan.lastIndex = m.index;
    for (let s = scan.exec(doc); s; s = scan.exec(doc)) {
      depth += s[1] === "begin" ? 1 : -1;
      if (depth === 0) {
        const to = s.index + close.length;
        if (pos <= to) best = { from: m.index, to };
        break;
      }
    }
  }
  return best;
}

// ---------- the grid ----------
const ALIGN = ["l", "c", "r"];

function changeAlign(spec: string, col: number, to: string): string {
  // Only plain l/c/r columns change; anything fancier is left as written.
  let seen = -1;
  let out = "";
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i];
    if ("@!><".includes(ch)) {
      const g = group(spec, i + 1);
      if (g) { out += spec.slice(i, g[1]); i = g[1] - 1; continue; }
    }
    if (/[a-zA-Z]/.test(ch)) seen++;
    out += seen === col && ALIGN.includes(ch) && /[a-zA-Z]/.test(ch) ? to : ch;
    if (/[pmbwW]/.test(ch)) {
      const g = group(spec, i + 1);
      if (g) { out += spec.slice(i + 1, g[1]); i = g[1] - 1; }
    }
  }
  return out;
}

function openGrid(editor: EditorView, from: number, table: Table) {
  const indent = /^[ \t]*/.exec(editor.state.doc.lineAt(from).text)?.[0] ?? "";
  const box = document.createElement("div");
  box.className = "table-editor";
  const bar = document.createElement("div");
  bar.className = "table-bar";
  const grid = document.createElement("div");
  grid.className = "table-grid";
  const foot = document.createElement("div");
  foot.className = "table-foot";
  box.append(bar, grid, foot);

  let focus = { r: 0, c: 0 };
  const width = () => Math.max(1, ...table.rows.map(rowSpan), specColumns(table.spec).length);

  const button = (label: string, title: string, run: () => void, cls = "btn") => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.title = title;
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cell focused
    b.onclick = run;
    return b;
  };

  const draw = () => {
    const w = width();
    for (const row of table.rows) while (rowSpan(row) < w) row.cells.push("");
    const cols = specColumns(table.spec);
    grid.style.gridTemplateColumns = `repeat(${w}, minmax(90px, 1fr))`;
    const frag = document.createDocumentFragment();
    // alignment row
    for (let c = 0; c < w; c++) {
      const select = document.createElement("select");
      select.className = "table-align";
      select.setAttribute("aria-label", `Column ${c + 1} alignment`);
      const kind = (cols[c] ?? "l")[0];
      if (!ALIGN.includes(kind)) {
        select.append(new Option(cols[c] ?? "l", kind));
        select.disabled = true;
      } else {
        for (const [v, label] of [["l", "Left"], ["c", "Centre"], ["r", "Right"]]) select.append(new Option(label, v));
        select.value = kind;
        select.onchange = () => { table.spec = changeAlign(table.spec, c, select.value); draw(); };
      }
      frag.appendChild(select);
    }
    table.rows.forEach((row, r) => {
      row.cells.forEach((value, c) => {
        const input = document.createElement("input");
        input.className = "table-cell" + (row.rules.length ? " ruled" : "");
        input.value = value;
        input.spellcheck = false;
        input.dataset.r = String(r);
        input.dataset.c = String(c);
        input.style.textAlign = { l: "left", c: "center", r: "right" }[(cols[c] ?? "l")[0]] ?? "left";
        input.oninput = () => { row.cells[c] = input.value; };
        input.onfocus = () => { focus = { r, c }; };
        input.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (r === table.rows.length - 1) addRow();
            cell(r + 1, c)?.focus();
          } else if (e.key === "ArrowUp" && !e.altKey) { e.preventDefault(); cell(r - 1, c)?.focus(); }
          else if (e.key === "ArrowDown" && !e.altKey) { e.preventDefault(); cell(r + 1, c)?.focus(); }
        };
        // A block copied from a spreadsheet (tabs and newlines) fills the grid from this cell.
        input.onpaste = (e) => {
          const text = e.clipboardData?.getData("text/plain") ?? "";
          if (!/[\t\n]/.test(text.trim())) return;
          e.preventDefault();
          const block = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
          block.forEach((line, dr) => {
            while (table.rows.length <= r + dr) table.rows.push({ rules: [], cells: [] });
            line.forEach((v, dc) => {
              const target = table.rows[r + dr].cells;
              while (target.length <= c + dc) target.push("");
              target[c + dc] = v.trim().replace(/([&%#_])/g, "\\$1");
            });
          });
          const w2 = width();
          const extra = w2 - specColumns(table.spec).length;
          if (extra > 0) table.spec += "l".repeat(extra);
          draw();
          cell(r, c)?.focus();
        };
        frag.appendChild(input);
      });
    });
    grid.replaceChildren(frag);
    foot.textContent = `${table.rows.length} rows × ${w} columns · Tab and Enter move between cells · paste a block from a spreadsheet into any cell`;
  };

  const cell = (r: number, c: number) => grid.querySelector<HTMLInputElement>(`.table-cell[data-r="${r}"][data-c="${c}"]`);
  const addRow = () => {
    table.rows.splice(focus.r + 1, 0, { rules: [], cells: Array(width()).fill("") });
    draw();
    cell(focus.r + 1, focus.c)?.focus();
  };
  const addColumn = () => {
    for (const row of table.rows) row.cells.splice(focus.c + 1, 0, "");
    table.spec += "l";
    draw();
    cell(focus.r, focus.c + 1)?.focus();
  };
  const removeRow = () => {
    if (table.rows.length <= 1) return;
    table.rows.splice(focus.r, 1);
    focus.r = Math.min(focus.r, table.rows.length - 1);
    draw();
    cell(focus.r, focus.c)?.focus();
  };
  const removeColumn = () => {
    if (width() <= 1) return;
    for (const row of table.rows) row.cells.splice(focus.c, 1);
    const cols = specColumns(table.spec);
    cols.splice(focus.c, 1);
    // A spec we can rebuild exactly only when it was plain; otherwise drop the last plain letter.
    table.spec = /^[lcr|]*$/.test(table.spec) ? cols.join("") : table.spec.replace(/[lcr](?=[^lcr]*$)/, "");
    focus.c = Math.min(focus.c, width() - 1);
    draw();
    cell(focus.r, focus.c)?.focus();
  };
  const rule = () => {
    const row = table.rows[focus.r];
    row.rules = row.rules.length ? [] : ["\\hline"];
    draw();
    cell(focus.r, focus.c)?.focus();
  };
  const apply = (close: boolean) => {
    const text = writeTable(table, indent).replace(/^[ \t]*/, "");
    // Found again, so edits made elsewhere in the document since opening don't matter.
    const range = tableAt(editor.state.doc.toString(), from);
    if (!range) {
      setStatus("The table is no longer where it was", "err");
      return;
    }
    editor.dispatch({ changes: { from: range.from, to: range.to, insert: text }, userEvent: "input" });
    setStatus("Table updated", "ok");
    if (close) {
      closeSide();
      editor.focus();
    }
  };

  bar.append(
    button("+ Row", "Add a row below this one (Enter on the last row adds one too)", addRow),
    button("+ Column", "Add a column to the right of this one", addColumn),
    button("− Row", "Remove this row", removeRow),
    button("− Column", "Remove this column", removeColumn),
    button("Line above", "A line (\\hline) above this row, or none", rule),
    Object.assign(document.createElement("span"), { className: "table-gap" }),
    button("Apply", "Write the table back into the document", () => apply(false)),
    button("Done", "Write the table back and close", () => apply(true), "btn btn-primary"),
  );
  draw();
  showInSide("Table", box).then(() => cell(0, 0)?.focus());
}

/** Edit the table at the cursor; with none there, insert a new 3 × 3 table and edit that. */
export function editTable() {
  const editor = activeEditor();
  if (!editor || !editor.dom.dataset.path?.endsWith(".tex")) {
    setStatus("Put the cursor in a .tex file to edit or insert a table");
    return;
  }
  const pos = editor.state.selection.main.head;
  const doc = editor.state.doc.toString();
  let range = tableAt(doc, pos);
  if (!range) {
    const at = editor.state.doc.lineAt(pos);
    const indent = /^[ \t]*/.exec(at.text)![0];
    const fresh = `\\begin{table}[ht]\n${indent}  \\centering\n${indent}  \\begin{tabular}{lll}\n${indent}    \\hline\n${indent}    Name & Value & Unit \\\\\n${indent}    \\hline\n${indent}     &  &  \\\\\n${indent}    \\hline\n${indent}  \\end{tabular}\n${indent}  \\caption{}\n${indent}  \\label{tab:}\n${indent}\\end{table}\n`;
    const insertAt = at.text.trim() ? at.to : at.from;
    const text = (at.text.trim() ? "\n" + indent : "") + fresh;
    editor.dispatch({ changes: { from: insertAt, insert: text }, userEvent: "input" });
    const doc2 = editor.state.doc.toString();
    range = tableAt(doc2, doc2.indexOf("\\begin{tabular}", insertAt) + 1);
    if (!range) return;
  }
  const table = parseTable(editor.state.sliceDoc(range.from, range.to));
  if (!table) {
    setStatus("Couldn't read this table");
    return;
  }
  openGrid(editor, range.from, table);
}
