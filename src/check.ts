// Check before submitting: the things reviewers and arXiv catch, found before they do. Results
// go to the Problems list, each one a click away from where it is.
import { invoke } from "@tauri-apps/api/core";
import { mainFile, root, setStatus } from "./core";
import { Problem } from "./diagnostics";
import { setProblems } from "./problems";
import { listFiles } from "./project";
import { index, refreshIndex, scanNotes, stripComments } from "./texindex";

const CITE = /\\(?:no)?(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite|footcite)\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)\}/g;
const REF = /\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref|vref)\*?\{([^{}]*)\}/g;
const LABEL = /\\label\{([^{}]*)\}/g;
const GRAPHIC = /\\includegraphics\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g;
const VALUE = /\\nb(val|table|math)\{([^{}]*)\}/g;
const GRAPHIC_EXT = ["", ".pdf", ".png", ".jpg", ".jpeg", ".eps"];
const MB = 1024 * 1024;

interface Sizes { rel: string; bytes: number; }

const lineAt = (text: string, at: number) => text.slice(0, at).split("\n").length;

export async function checkBeforeSubmitting() {
  if (!root) return;
  setStatus("Checking the paper…", "busy");
  await refreshIndex().catch(() => {});
  const files = await listFiles();
  const sizes = await invoke<Sizes[]>("file_sizes", { root }).catch(() => [] as Sizes[]);
  const texFiles = files.filter((f) => f.endsWith(".tex") && f !== "scribe-values.tex" && !f.startsWith("build/"));
  const texts = new Map<string, string>();
  await Promise.all(texFiles.map(async (f) => texts.set(f, stripComments(await invoke<string>("read_file", { root, rel: f }).catch(() => "")))));

  const found: Problem[] = [];
  const bibKeys = new Set(index.bib.map((b) => b.key));
  const cited = new Set<string>();
  const labels = new Map<string, { file: string; line: number; float: boolean }>();
  const referenced = new Set<string>();

  for (const [file, text] of texts) {
    for (const m of text.matchAll(CITE)) {
      for (const key of m[1].split(",").map((k) => k.trim()).filter(Boolean)) {
        cited.add(key);
        if (!bibKeys.has(key)) found.push({ file, line: lineAt(text, m.index!), severity: "error", message: `No bibliography entry for \\cite{${key}}` });
      }
    }
    for (const m of text.matchAll(REF)) for (const key of m[1].split(",").map((k) => k.trim())) referenced.add(key);
    // Labels inside figure and table environments are the ones a reader expects to be referred to.
    let float = 0;
    text.split("\n").forEach((line, i) => {
      float += (line.match(/\\begin\{(?:figure|table|sidewaysfigure|sidewaystable|wrapfigure)\*?\}/g) ?? []).length;
      for (const m of line.matchAll(LABEL)) labels.set(m[1], { file, line: i + 1, float: float > 0 });
      float -= (line.match(/\\end\{(?:figure|table|sidewaysfigure|sidewaystable|wrapfigure)\*?\}/g) ?? []).length;
    });
    for (const m of text.matchAll(GRAPHIC)) {
      const name = m[1].trim();
      if (!GRAPHIC_EXT.some((ext) => files.includes(name + ext))) {
        found.push({ file, line: lineAt(text, m.index!), severity: "error", message: `Image not found: ${name}` });
      }
    }
    const values = new Set(index.values.map((v) => v.name));
    for (const m of text.matchAll(VALUE)) {
      if (!values.has(m[2])) found.push({ file, line: lineAt(text, m.index!), severity: "error", message: `No notebook exports \\nb${m[1]}{${m[2]}}. Run the notebooks, or check the name.` });
    }
    for (const note of scanNotes(text)) {
      found.push({ file, line: note.line, severity: "warning", message: `${note.kind} left in the paper: ${note.text || "(no text)"}` });
    }
  }

  for (const [file, text] of texts) {
    for (const m of text.matchAll(REF)) {
      for (const key of m[1].split(",").map((k) => k.trim())) {
        if (!labels.has(key)) found.push({ file, line: lineAt(text, m.index!), severity: "error", message: `\\ref to a label that doesn't exist: ${key}` });
      }
    }
  }
  for (const [key, where] of labels) {
    if (where.float && !referenced.has(key)) found.push({ file: where.file, line: where.line, severity: "warning", message: `The text never refers to ${key}` });
  }
  for (const entry of index.bib) {
    if (!cited.has(entry.key)) found.push({ file: entry.file, line: entry.line, severity: "warning", message: `${entry.key} is in the bibliography but never cited` });
  }

  // Figures and numbers from notebooks that changed after they were last run.
  for (const fig of index.figures) {
    if (fig.stale && fig.used) found.push({ file: fig.notebook, line: 0, severity: "warning", message: `Figure ${fig.id} is older than its notebook. Run the notebooks again.` });
  }
  const notebooks = [...new Set(index.values.filter((v) => v.used).map((v) => v.notebook))];
  for (const nb of notebooks) {
    const info = await invoke<{ stale: string[] }>("parse_notebook", { root, rel: nb }).catch(() => null);
    if (info?.stale.includes("values")) found.push({ file: nb, line: 0, severity: "warning", message: "The notebook changed since its numbers were last exported. Run the notebooks again." });
  }

  // arXiv: total size and file names it rejects.
  const submitted = sizes.filter((s) => !/^(build|notes|data)\//.test(s.rel) && !s.rel.startsWith("."));
  const total = submitted.reduce((sum, s) => sum + s.bytes, 0);
  if (total > 50 * MB) found.push({ file: mainFile, line: 0, severity: "warning", message: `The project is ${(total / MB).toFixed(0)} MB; arXiv accepts at most 50 MB. Shrink large figures.` });
  for (const s of submitted) {
    if (s.bytes > 10 * MB && /\.(pdf|png|jpe?g|eps)$/i.test(s.rel)) found.push({ file: s.rel, line: 0, severity: "warning", message: `${s.rel} is ${(s.bytes / MB).toFixed(0)} MB. Large figures slow down reviewers and may exceed upload limits.` });
    if (/\.(tex|bib|pdf|png|jpe?g|eps|sty|cls|bst)$/i.test(s.rel) && /[^A-Za-z0-9._\/+-]/.test(s.rel)) {
      found.push({ file: s.rel, line: 0, severity: "warning", message: `arXiv rejects file names with spaces or special characters: ${s.rel}` });
    }
  }

  const order = { error: 0, warning: 1 };
  found.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const errors = found.filter((p) => p.severity === "error").length;
  const report = found.map((p) => `${p.severity}: ${p.file}${p.line ? `:${p.line}` : ""}: ${p.message}`).join("\n");
  setProblems(found, report || "Nothing to fix.", true, "Submission check");
  setStatus(
    found.length ? `${errors ? `${errors} to fix, ` : ""}${found.length - errors} to look at before submitting` : "Ready to submit: nothing to fix",
    errors ? "err" : "ok",
  );
}
