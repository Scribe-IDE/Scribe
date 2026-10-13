// Running notebooks and compiling the paper.
import { invoke } from "@tauri-apps/api/core";
import { $, current, mainFile, NOTEBOOK_SOURCE, root, setStatus, showLog, VIEWABLE } from "./core";
import { parseLog } from "./diagnostics";
import { renderPdf } from "./preview";
import { problemSummary, setProblems } from "./problems";
import { listFiles, save } from "./project";
import { settings } from "./settings";
import { refreshIndexSoon } from "./texindex";
import { refreshFiles } from "./sidebar";
import { CompileResult, NotebookInfo, RunResult } from "./types";

// ---------- notebooks ----------
export let running = false;

export async function runStaleNotebooks(): Promise<boolean> {
  if (!root) return true;
  const files = await listFiles();
  const pyFiles = files.filter((f) => NOTEBOOK_SOURCE.test(f));

  for (const py of pyFiles) {
    try {
      const info = await invoke<NotebookInfo>("parse_notebook", { root, rel: py });
      if (info.stale.length === 0) continue;

      setStatus(`Running ${py}…`, "busy");
      const res = await invoke<RunResult>("run_notebook", { root, rel: py });
      if (!res.ok) {
        showLog(`Notebook log: ${py}`, res.log);
        setStatus(`${py} failed`, "err");
        return false;
      }
    } catch (e) {
      showLog(`Notebook log: ${py}`, String(e));
      setStatus(`Couldn't run ${py}`, "err");
      return false;
    }
  }

  // ensure scribe-figures.sty exists
  try { await invoke("generate_style", { root }); } catch (_) { /* ok if exists */ }
  return true;
}

export async function runNotebook() {
  if (!root || running) return;
  running = true;
  $<HTMLButtonElement>("btn-run").disabled = true;
  try {
    await save();
    setStatus("Running notebooks…", "busy");

    const files = await listFiles();
    const pyFiles = files.filter((f) => NOTEBOOK_SOURCE.test(f));

    for (const py of pyFiles) {
      try {
        const info = await invoke<NotebookInfo>("parse_notebook", { root, rel: py });
        if (info.figure_ids.length === 0 && info.value_names.length === 0) continue; // produces nothing for the paper

        setStatus(`Running ${py}…`, "busy");
        const res = await invoke<RunResult>("run_notebook", { root, rel: py });
        showLog(`Notebook log: ${py}`, res.log, !res.ok);
        if (!res.ok) {
          setStatus(`${py} failed`, "err");
          return;
        }
      } catch (e) {
        showLog(`Notebook log: ${py}`, String(e));
        setStatus(`Couldn't run ${py}`, "err");
        return;
      }
    }

    try { await invoke("generate_style", { root }); } catch (_) {}
    setStatus("Notebooks ran", "ok");
    refreshIndexSoon();
    await refreshFiles();
  } finally {
    running = false;
    $<HTMLButtonElement>("btn-run").disabled = false;
  }
}

// ---------- compile + preview ----------
export let compiling = false;
export async function compile() {
  if (!root || compiling) return;
  compiling = true;
  $<HTMLButtonElement>("btn-compile").disabled = true;
  try {
    await save();

    // auto-run stale notebooks before compiling
    if (!(await runStaleNotebooks())) return;

    setStatus(`Compiling ${mainFile}…`, "busy");
    const res = await invoke<CompileResult>("compile", { root, main: mainFile });
    // The parsed problems lead; the raw log stays one tab away.
    setProblems(parseLog(res.log, mainFile), res.log, !res.ok);
    const summary = problemSummary();
    if (res.ok && res.pdf) {
      await renderPdf(res.pdf);
      setStatus(`Compiled with ${res.engine}${summary ? ` · ${summary}` : ""}`, "ok");
      refreshFiles();
    } else {
      setStatus(summary ? `Compile failed: ${summary}` : `Compile failed (${res.engine})`, "err");
    }
  } catch (e) {
    showLog("Compile log", String(e));
    setStatus("Couldn't compile", "err");
  } finally {
    refreshIndexSoon(); // notebooks may have produced new figures or values
    compiling = false;
    $<HTMLButtonElement>("btn-compile").disabled = false;
  }
}

/** What ⌘S does: save, then compile if the project is set to compile on save. */
export async function saveFile() {
  await save();
  if (settings.compileOnSave && root && current && !VIEWABLE.test(current)) await compile();
}
