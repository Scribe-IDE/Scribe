// Data files (.csv, .tsv): a sortable table, a quick plot of one column against another, and
// a way to put the table into the paper as LaTeX.
import { invoke } from "@tauri-apps/api/core";
import { $, mainFile, root, setStatus } from "./core";
import { revealLine } from "./project";

export const DATA_FILE = /\.(csv|tsv)$/i;

const SHOWN_ROWS = 500; // rendered in the table; the plot and the counts use every row
const TABLE_ROWS = 30; // most rows a table inserted into the paper will carry

export interface Table { header: string[]; rows: string[][]; }

/** Parses comma-, semicolon- or tab-separated text, honouring "quoted, fields" and "" escapes. */
export function parseDelimited(text: string, tabs = false): Table {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delimiter = tabs || count("\t") > Math.max(count(","), count(";")) ? "\t" : count(";") > count(",") ? ";" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);

  const header = (rows.shift() ?? []).map((h, i) => h.trim() || `Column ${i + 1}`);
  return { header, rows };
}

const toNumber = (cell: string) => (cell.trim() === "" ? NaN : Number(cell));

/** A column is numeric when every non-empty cell in it is a number (and at least one is). */
export function numericColumns(table: Table): boolean[] {
  return table.header.map((_h, col) => {
    const cells = table.rows.map((r) => (r[col] ?? "").trim()).filter(Boolean);
    return cells.length > 0 && cells.every((c) => Number.isFinite(Number(c)));
  });
}

const texEscape = (s: string) => s.replace(/\\/g, "\\textbackslash{}").replace(/([%&#_$^{}~])/g, "\\$1");

/** The table as a LaTeX tabular: numbers right-aligned, special characters escaped. */
export function toLatex(table: Table, maxRows = TABLE_ROWS): string {
  const numeric = numericColumns(table);
  const spec = numeric.map((n) => (n ? "r" : "l")).join("");
  const line = (cells: string[]) => `    ${table.header.map((_h, i) => texEscape((cells[i] ?? "").trim())).join(" & ")} \\\\`;
  return [
    `  \\begin{tabular}{${spec}}`,
    "    \\hline",
    line(table.header),
    "    \\hline",
    ...table.rows.slice(0, maxRows).map(line),
    "    \\hline",
    "  \\end{tabular}",
  ].join("\n");
}

// ---------- plot ----------
const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** Round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const ticks: number[] = [];
  // start at or below the smallest value and end at or above the largest, so the axis encloses the data
  const first = Math.floor(min / step + 1e-9) * step;
  for (let v = first; v < max + step - step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

// en-US on purpose: the table shows the file's own decimal points, and the plot should match it.
const compact = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });

function drawPlot(box: HTMLElement, table: Table, xCol: number, yCol: number, kind: "line" | "points") {
  box.replaceChildren();
  const points = table.rows
    .map((r, i) => ({ x: xCol === -1 ? i + 1 : toNumber(r[xCol] ?? ""), y: toNumber(r[yCol] ?? "") }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length < 2) {
    const none = document.createElement("div");
    none.className = "empty";
    none.textContent = "Not enough numbers in those columns to plot.";
    box.appendChild(none);
    return;
  }
  if (kind === "line") points.sort((a, b) => a.x - b.x);

  const style = getComputedStyle(box);
  const width = Math.max(320, box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const height = 220;
  const m = { left: 56, right: 16, top: 12, bottom: 30 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xTicks = niceTicks(Math.min(...xs), Math.max(...xs), Math.max(3, Math.floor(width / 110)));
  const yTicks = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  const x0 = Math.min(xTicks[0], ...xs), x1 = Math.max(xTicks[xTicks.length - 1], ...xs);
  const y0 = Math.min(yTicks[0], ...ys), y1 = Math.max(yTicks[yTicks.length - 1], ...ys);
  const px = (v: number) => m.left + ((v - x0) / (x1 - x0 || 1)) * (width - m.left - m.right);
  const py = (v: number) => height - m.bottom - ((v - y0) / (y1 - y0 || 1)) * (height - m.top - m.bottom);

  const xName = xCol === -1 ? "Row" : table.header[xCol];
  const yName = table.header[yCol];
  const chart = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${yName} against ${xName}` });

  // Recessive hairline grid and tick labels; text uses the muted text colour, never the series colour.
  for (const t of yTicks) {
    chart.appendChild(svg("line", { x1: m.left, x2: width - m.right, y1: py(t), y2: py(t), class: "plot-grid" }));
    const label = svg("text", { x: m.left - 8, y: py(t) + 4, "text-anchor": "end", class: "plot-tick" });
    label.textContent = compact.format(t);
    chart.appendChild(label);
  }
  for (const t of xTicks) {
    const label = svg("text", { x: px(t), y: height - m.bottom + 18, "text-anchor": "middle", class: "plot-tick" });
    label.textContent = compact.format(t);
    chart.appendChild(label);
  }

  if (kind === "line") {
    chart.appendChild(svg("path", { d: points.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)} ${py(p.y).toFixed(1)}`).join(""), class: "plot-line" }));
  } else {
    const r = points.length > 400 ? 3 : 4;
    for (const p of points) chart.appendChild(svg("circle", { cx: px(p.x), cy: py(p.y), r, class: "plot-dot" }));
  }

  // Hover: the nearest point gets a marker, a hairline at its x, and a readout.
  const cross = svg("line", { y1: m.top, y2: height - m.bottom, class: "plot-cross", visibility: "hidden" });
  const marker = svg("circle", { r: 5, class: "plot-marker", visibility: "hidden" });
  chart.append(cross, marker);
  const tip = document.createElement("div");
  tip.className = "plot-tip";
  tip.hidden = true;
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); marker.setAttribute("visibility", "hidden"); };
  chart.addEventListener("pointerleave", hide);
  chart.addEventListener("pointermove", (e) => {
    const rect = chart.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best = points[0], bestD = Infinity;
    for (const p of points) {
      // a line is read by its x; scattered points by whichever is closest
      const d = kind === "line" ? Math.abs(px(p.x) - mx) : Math.hypot(px(p.x) - mx, py(p.y) - my);
      if (d < bestD) { best = p; bestD = d; }
    }
    const cx = px(best.x), cy = py(best.y);
    cross.setAttribute("x1", String(cx)); cross.setAttribute("x2", String(cx));
    cross.setAttribute("visibility", kind === "line" ? "visible" : "hidden");
    marker.setAttribute("cx", String(cx)); marker.setAttribute("cy", String(cy)); marker.setAttribute("visibility", "visible");
    const value = document.createElement("strong");
    value.textContent = compact.format(best.y);
    const name = document.createElement("span");
    name.textContent = ` ${yName}`;
    const at = document.createElement("div");
    at.className = "plot-tip-at";
    at.textContent = `${xName} ${compact.format(best.x)}`;
    tip.replaceChildren(value, name, at);
    tip.hidden = false;
    tip.style.left = `${Math.min(cx + 12, width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${Math.max(4, cy - tip.offsetHeight - 10)}px`;
  });

  const caption = document.createElement("div");
  caption.className = "plot-caption";
  caption.textContent = `${yName} against ${xName}`;
  box.append(caption, chart, tip);
}

// ---------- view ----------
function option(select: HTMLSelectElement, value: number | string, label: string) {
  select.add(new Option(label, String(value)));
}

export function showData(rel: string, text: string) {
  const view = $("data-view");
  const table = parseDelimited(text, /\.tsv$/i.test(rel));
  const numeric = numericColumns(table);
  const numericIdx = numeric.map((n, i) => (n ? i : -1)).filter((i) => i !== -1);

  // toolbar
  const bar = document.createElement("div");
  bar.className = "data-bar";
  const info = document.createElement("span");
  info.className = "data-info";
  info.textContent = `${table.rows.length.toLocaleString()} rows × ${table.header.length} columns`;
  const insert = document.createElement("button");
  insert.className = "btn btn-outline";
  insert.textContent = "Insert as table";
  insert.title = "Add this data to the paper as a LaTeX table";
  insert.onclick = () => insertTable(rel, table);
  const copy = document.createElement("button");
  copy.className = "btn";
  copy.textContent = "Copy LaTeX";
  copy.onclick = async () => {
    await navigator.clipboard.writeText(toLatex(table)).catch(() => {});
    setStatus(table.rows.length > TABLE_ROWS ? `Copied the first ${TABLE_ROWS} of ${table.rows.length} rows as LaTeX` : "Copied as LaTeX", "ok");
  };
  bar.append(info, insert, copy);

  // plot controls: only offered when there is something numeric to plot
  const plotBox = document.createElement("div");
  plotBox.className = "data-plot";
  const controls = document.createElement("div");
  controls.className = "data-controls";
  if (numericIdx.length) {
    const ySel = document.createElement("select");
    const xSel = document.createElement("select");
    const kindSel = document.createElement("select");
    for (const i of numericIdx) option(ySel, i, table.header[i]);
    option(xSel, -1, "Row number");
    for (const i of numericIdx) option(xSel, i, table.header[i]);
    option(kindSel, "line", "Line");
    option(kindSel, "points", "Points");
    // sensible start: the first numeric column across, the next one up
    xSel.value = String(numericIdx.length > 1 ? numericIdx[0] : -1);
    ySel.value = String(numericIdx.length > 1 ? numericIdx[1] : numericIdx[0]);
    const redraw = () => drawPlot(plotBox, table, Number(xSel.value), Number(ySel.value), kindSel.value as "line" | "points");
    for (const s of [ySel, xSel, kindSel]) s.onchange = redraw;
    const label = (text: string, control: HTMLElement) => {
      const l = document.createElement("label");
      l.append(text, control);
      return l;
    };
    controls.append(label("Plot", ySel), label("against", xSel), label("as", kindSel));
    requestAnimationFrame(redraw); // after layout, so the plot knows its width
  }

  // table
  const wrap = document.createElement("div");
  wrap.className = "data-table-wrap";
  const el = document.createElement("table");
  el.className = "data-table";
  const head = el.createTHead().insertRow();
  const body = el.createTBody();
  let sorted = { col: -1, dir: 1 };
  const fill = (rows: string[][]) => {
    body.replaceChildren();
    for (const r of rows.slice(0, SHOWN_ROWS)) {
      const tr = body.insertRow();
      table.header.forEach((_h, i) => {
        const td = tr.insertCell();
        td.textContent = r[i] ?? "";
        if (numeric[i]) td.className = "num";
      });
    }
  };
  table.header.forEach((name, col) => {
    const th = document.createElement("th");
    if (numeric[col]) th.className = "num";
    const sort = document.createElement("button");
    sort.textContent = name;
    sort.title = `Sort by ${name}`;
    sort.onclick = () => {
      sorted = { col, dir: sorted.col === col ? -sorted.dir : 1 };
      const rows = [...table.rows].sort((a, b) => {
        const av = a[col] ?? "", bv = b[col] ?? "";
        return sorted.dir * (numeric[col] ? toNumber(av) - toNumber(bv) : av.localeCompare(bv));
      });
      head.querySelectorAll("th").forEach((h) => h.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", sorted.dir === 1 ? "ascending" : "descending");
      fill(rows);
    };
    th.appendChild(sort);
    head.appendChild(th);
  });
  fill(table.rows);
  wrap.appendChild(el);

  const parts: HTMLElement[] = [bar];
  if (numericIdx.length) parts.push(controls, plotBox);
  parts.push(wrap);
  if (table.rows.length > SHOWN_ROWS) {
    const more = document.createElement("div");
    more.className = "empty";
    more.textContent = `Showing the first ${SHOWN_ROWS} of ${table.rows.length.toLocaleString()} rows. The plot uses all of them.`;
    parts.push(more);
  }
  view.replaceChildren(...parts);
}

// Adds a table environment for this data to the paper, just before \end{document}.
async function insertTable(rel: string, table: Table) {
  if (!root) return;
  let tex: string;
  try {
    tex = await invoke<string>("read_file", { root, rel: mainFile });
  } catch {
    setStatus(`Couldn't find ${mainFile} to insert into`, "err");
    return;
  }
  const name = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.\w+$/, "");
  const label = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const block = `\\begin{table}[ht]\n  \\centering\n${toLatex(table)}\n  \\caption{}\n  \\label{tab:${label}}\n\\end{table}\n\n`;
  const end = tex.lastIndexOf("\\end{document}");
  const next = end === -1 ? tex.replace(/\n*$/, "\n\n") + block : tex.slice(0, end) + block + tex.slice(end);
  try {
    await invoke("write_file", { root, rel: mainFile, content: next });
  } catch (e) {
    setStatus(`Couldn't update ${mainFile}: ${e}`, "err");
    return;
  }
  const line = next.slice(0, next.indexOf(`\\label{tab:${label}}`)).split("\n").length;
  await revealLine(mainFile, line);
  setStatus(
    table.rows.length > TABLE_ROWS
      ? `Inserted the first ${TABLE_ROWS} of ${table.rows.length} rows into ${mainFile}. For the whole file, build the table in a notebook with nbtable().`
      : `Inserted ${name} into ${mainFile}`,
    "ok",
  );
}
