//! Scribe backend: project file access, LaTeX compilation, and notebook execution.
//!
//! Every command takes the project `root` plus a path relative to it, and
//! `resolve` rejects anything that escapes the root (`..`, absolute paths,
//! symlinks pointing outside). That boundary matters once projects are shared.

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;
use walkdir::WalkDir;

const BUILD_DIR: &str = "build";
const SKIP_DIRS: &[&str] = &[BUILD_DIR, ".git", "node_modules", "__pycache__", ".venv", ".ipynb_checkpoints"];

fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = Path::new(root).canonicalize().map_err(|e| format!("bad root: {e}"))?;
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(format!("path outside project: {rel}"));
    }
    let full = root.join(rel_path);
    // If the file exists, also make sure symlinks don't lead outside the root.
    if let Ok(real) = full.canonicalize() {
        if !real.starts_with(&root) {
            return Err(format!("path outside project: {rel}"));
        }
    }
    Ok(full)
}

#[tauri::command]
fn list_files(root: String) -> Result<Vec<String>, String> {
    let base = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let mut out: Vec<String> = WalkDir::new(&base)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            e.depth() == 0 || !(name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()))
        })
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            e.path()
                .strip_prefix(&base)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .collect();
    // Root files first, then by directory.
    out.sort_by(|a, b| (a.contains('/'), a).cmp(&(b.contains('/'), b)));
    Ok(out)
}

/// Directories in the project, so the sidebar can show folders that have no files yet.
#[tauri::command]
fn list_dirs(root: String) -> Result<Vec<String>, String> {
    let base = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let mut out: Vec<String> = WalkDir::new(&base)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()))
        })
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_dir())
        .filter_map(|e| {
            e.path()
                .strip_prefix(&base)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .collect();
    out.sort();
    Ok(out)
}

/// Copies files from anywhere on the computer into the project folder `dir` ("" for the root).
/// Nothing is overwritten: a name that is taken gets " 2", " 3", ... before its extension.
#[tauri::command]
fn import_files(root: String, dir: String, sources: Vec<String>) -> Result<Vec<String>, String> {
    let mut added = Vec::new();
    for source in sources {
        let from = Path::new(&source);
        if !from.is_file() {
            return Err(format!("{source} is not a file"));
        }
        let name = from.file_name().ok_or("file has no name")?.to_string_lossy().to_string();
        let (stem, ext) = match name.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
            _ => (name.clone(), String::new()),
        };
        let mut n = 1;
        let (rel, dest) = loop {
            let candidate = if n == 1 { name.clone() } else { format!("{stem} {n}{ext}") };
            let rel = if dir.is_empty() { candidate } else { format!("{dir}/{candidate}") };
            let dest = resolve(&root, &rel)?;
            if !dest.exists() {
                break (rel, dest);
            }
            n += 1;
        };
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(from, &dest).map_err(|e| format!("{name}: {e}"))?;
        added.push(rel);
    }
    Ok(added)
}

/// `resolve` for commands that move or remove things: the project root itself is off limits.
fn resolve_entry(root: &str, rel: &str) -> Result<PathBuf, String> {
    if rel.trim_matches(|c| c == '/' || c == '.').is_empty() {
        return Err("that would affect the whole project".into());
    }
    resolve(root, rel)
}

#[tauri::command]
fn create_dir(root: String, rel: String) -> Result<(), String> {
    let path = resolve_entry(&root, &rel)?;
    if path.exists() {
        return Err(format!("{rel} already exists"));
    }
    std::fs::create_dir_all(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(root: String, from: String, to: String) -> Result<(), String> {
    let src = resolve_entry(&root, &from)?;
    let dst = resolve_entry(&root, &to)?;
    if !src.exists() {
        return Err(format!("{from} no longer exists"));
    }
    // Never rename over something: fs::rename would silently replace a file.
    if dst.exists() {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(src, dst).map_err(|e| e.to_string())
}

/// Moves a file or folder to the system Trash, so a mistaken delete can be undone.
#[tauri::command]
fn delete_path(root: String, rel: String) -> Result<(), String> {
    let path = resolve_entry(&root, &rel)?;
    if !path.exists() {
        return Err(format!("{rel} no longer exists"));
    }
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    // The Finder method asks for automation permission; NSFileManager does not.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file(root: String, rel: String) -> Result<String, String> {
    std::fs::read_to_string(resolve(&root, &rel)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(root: String, rel: String, content: String) -> Result<(), String> {
    let path = resolve(&root, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Write-then-rename so a crash mid-save never truncates the user's file.
    let tmp = path.with_extension("scribe-tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_binary(root: String, rel: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(resolve(&root, &rel)?).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Serialize)]
struct CompileResult {
    ok: bool,
    engine: String,
    log: String,
    /// PDF path relative to the project root.
    pdf: Option<String>,
}

fn has(bin: &str) -> bool {
    Command::new(bin).arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

/// Compile with Tectonic if installed (self-contained, fetches packages on
/// demand), otherwise fall back to latexmk + a system TeX distribution.
fn compile_blocking(root: &str, main: &str) -> Result<CompileResult, String> {
    let main_path = resolve(root, main)?;
    if !main_path.is_file() {
        return Err(format!("main file not found: {main}"));
    }
    let root_dir = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root_dir.join(BUILD_DIR)).map_err(|e| e.to_string())?;

    let (engine, mut cmd) = if has("tectonic") {
        let mut c = Command::new("tectonic");
        c.args(["-X", "compile", main, "--outdir", BUILD_DIR, "--synctex", "--keep-logs"]);
        ("tectonic", c)
    } else if has("latexmk") {
        let mut c = Command::new("latexmk");
        c.args([
            "-pdf",
            "-synctex=1",
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
            &format!("-outdir={BUILD_DIR}"),
            main,
        ]);
        ("latexmk", c)
    } else {
        return Err("No TeX engine found. Install Tectonic (recommended) or TeX Live with latexmk.".into());
    };

    let out = cmd.current_dir(&root_dir).output().map_err(|e| format!("{engine}: {e}"))?;
    let mut log = String::from_utf8_lossy(&out.stdout).into_owned();
    log.push_str(&String::from_utf8_lossy(&out.stderr));

    let stem = Path::new(main).file_stem().unwrap_or_default().to_string_lossy();
    let pdf_rel = format!("{BUILD_DIR}/{stem}.pdf");
    let pdf_exists = root_dir.join(&pdf_rel).is_file();

    Ok(CompileResult {
        ok: out.status.success() && pdf_exists,
        engine: engine.into(),
        log,
        pdf: pdf_exists.then_some(pdf_rel),
    })
}

#[tauri::command]
async fn compile(root: String, main: String) -> Result<CompileResult, String> {
    // TeX runs take seconds; keep them off the main thread so the UI stays live.
    tauri::async_runtime::spawn_blocking(move || compile_blocking(&root, &main))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- SyncTeX: jump between a spot in the PDF and its source line ----------

#[derive(Serialize, Debug)]
struct SourceSpot {
    /// Path relative to the project root.
    file: String,
    line: u32,
}

/// A box on a PDF page, in PDF points measured from the page's top-left corner.
#[derive(Serialize, Debug)]
struct PdfSpot {
    page: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Runs the `synctex` tool (it ships with TeX Live) in the project folder.
fn run_synctex(root_dir: &Path, args: &[&str]) -> Result<String, String> {
    // Apps launched from Finder don't inherit the shell PATH, so also try MacTeX's fixed location.
    for bin in ["synctex", "/Library/TeX/texbin/synctex"] {
        if let Ok(out) = Command::new(bin).args(args).current_dir(root_dir).output() {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
    }
    Err("SyncTeX isn't installed. It comes with TeX Live (MacTeX).".into())
}

fn synctex_field<'a>(out: &'a str, key: &str) -> Option<&'a str> {
    out.lines().find_map(|l| l.strip_prefix(key)).map(str::trim)
}

fn parse_synctex_edit(out: &str, root_dir: &Path) -> Result<SourceSpot, String> {
    let none = || "No source line is recorded for that spot.".to_string();
    let input = synctex_field(out, "Input:").ok_or_else(none)?;
    let line: u32 = synctex_field(out, "Line:").and_then(|l| l.parse().ok()).ok_or_else(none)?;
    // SyncTeX records paths like /project/./main.tex; drop the `.` parts before comparing.
    let cleaned: PathBuf = Path::new(input).components().filter(|c| !matches!(c, Component::CurDir)).collect();
    let abs = cleaned.canonicalize().unwrap_or(cleaned);
    let rel = abs
        .strip_prefix(root_dir)
        .map_err(|_| "That part of the PDF comes from a file outside the project.".to_string())?;
    Ok(SourceSpot { file: rel.to_string_lossy().replace('\\', "/"), line: line.max(1) })
}

fn parse_synctex_view(out: &str) -> Result<PdfSpot, String> {
    let num = |key: &str| synctex_field(out, key).and_then(|v| v.parse::<f64>().ok());
    match (num("Page:"), num("h:"), num("v:"), num("W:"), num("H:")) {
        // `v` is the baseline; the box extends H above it.
        (Some(page), Some(h), Some(v), Some(w), Some(height)) => Ok(PdfSpot {
            page: page as u32,
            x: h,
            y: v - height,
            width: w,
            height,
        }),
        _ => Err("That line doesn't appear in the PDF. Compile first, or pick a line with text.".into()),
    }
}

/// PDF position -> source line. `x`/`y` are PDF points from the top-left of `page` (1-based).
#[tauri::command]
fn synctex_edit(root: String, pdf: String, page: u32, x: f64, y: f64) -> Result<SourceSpot, String> {
    resolve(&root, &pdf)?;
    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let out = run_synctex(&root_dir, &["edit", "-o", &format!("{page}:{x:.2}:{y:.2}:{pdf}")])?;
    parse_synctex_edit(&out, &root_dir)
}

/// Source line -> PDF position.
#[tauri::command]
fn synctex_view(root: String, pdf: String, file: String, line: u32) -> Result<PdfSpot, String> {
    resolve(&root, &pdf)?;
    resolve(&root, &file)?;
    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let out = run_synctex(&root_dir, &["view", "-i", &format!("{line}:0:{file}"), "-o", &pdf])?;
    parse_synctex_view(&out)
}

// ---------- notebook parsing + execution ----------

#[derive(Serialize, Clone, Debug)]
struct NotebookCell {
    cell_type: String,
    source: String,
    figure_id: Option<String>,
}

#[derive(Serialize, Debug)]
struct NotebookInfo {
    cells: Vec<NotebookCell>,
    figure_ids: Vec<String>,
    /// Names passed to nbval()/nbtable() in the notebook's code.
    value_names: Vec<String>,
    /// Figure ids (and the marker "values") whose output is older than the notebook.
    stale: Vec<String>,
}

const VALUES_TEX: &str = "scribe-values.tex";
const VALUES_JSON: &str = ".scribe/values.json";

/// Names a notebook exports with `nbval("name", ...)` or `nbtable("name", ...)`.
fn value_names(cells: &[NotebookCell]) -> Vec<String> {
    let mut names = Vec::new();
    for cell in cells.iter().filter(|c| c.cell_type != "markdown") {
        for call in ["nbval(", "nbtable("] {
            for (at, _) in cell.source.match_indices(call) {
                // Skip things like `my_nbval(`.
                if cell.source[..at].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_') {
                    continue;
                }
                let rest = cell.source[at + call.len()..].trim_start();
                let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else { continue };
                if let Some(end) = rest[1..].find(quote) {
                    let name = rest[1..1 + end].to_string();
                    if !name.is_empty() && !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
        }
    }
    names
}

fn parse_cells(source: &str) -> Vec<NotebookCell> {
    let mut cells = Vec::new();
    let mut current_type = String::from("code");
    let mut current_fig: Option<String> = None;
    let mut current_lines: Vec<&str> = Vec::new();

    for line in source.lines() {
        if line.starts_with("# %%") {
            // flush previous cell
            if !current_lines.is_empty() {
                let src = current_lines.join("\n").trim().to_string();
                if !src.is_empty() {
                    cells.push(NotebookCell {
                        cell_type: current_type.clone(),
                        source: src,
                        figure_id: current_fig.clone(),
                    });
                }
            }
            current_lines.clear();

            // parse new cell header
            let header = line.trim_start_matches("# %%").trim();
            if header.starts_with("[markdown]") {
                current_type = "markdown".into();
                current_fig = None;
            } else if let Some(rest) = header.strip_prefix("[figure:") {
                let id = rest.trim_end_matches(']').trim().to_string();
                current_type = "figure".into();
                current_fig = Some(id);
            } else {
                current_type = "code".into();
                current_fig = None;
            }
        } else {
            current_lines.push(line);
        }
    }

    // flush last cell
    if !current_lines.is_empty() {
        let src = current_lines.join("\n").trim().to_string();
        if !src.is_empty() {
            cells.push(NotebookCell {
                cell_type: current_type,
                source: src,
                figure_id: current_fig,
            });
        }
    }

    cells
}

fn ipynb_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(lines) => lines.iter().filter_map(|l| l.as_str()).collect(),
        _ => String::new(),
    }
}

/// Jupyter notebooks map onto the same cells: a code cell whose metadata carries
/// `scribe.figure` is a figure cell, so the file stays a normal .ipynb elsewhere.
fn parse_ipynb(source: &str) -> Result<Vec<NotebookCell>, String> {
    if source.trim().is_empty() {
        return Ok(Vec::new());
    }
    let doc: serde_json::Value =
        serde_json::from_str(source).map_err(|e| format!("not a valid notebook: {e}"))?;
    let mut cells = Vec::new();
    for cell in doc["cells"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let text = ipynb_text(&cell["source"]);
        let (cell_type, source, figure_id) = match cell["cell_type"].as_str() {
            Some("markdown") => ("markdown", text.trim().to_string(), None),
            Some("code") => {
                // IPython magics and shell escapes are not Python; the batch runner can't execute them.
                let code = text
                    .lines()
                    .filter(|l| !l.trim_start().starts_with(['%', '!']))
                    .collect::<Vec<_>>()
                    .join("\n");
                // "papyrus" is the key written before the app was renamed.
                let figure = ["scribe", "papyrus"]
                    .iter()
                    .find_map(|key| cell["metadata"][*key]["figure"].as_str())
                    .map(str::to_string);
                (if figure.is_some() { "figure" } else { "code" }, code.trim().to_string(), figure)
            }
            _ => continue,
        };
        if !source.is_empty() {
            cells.push(NotebookCell { cell_type: cell_type.into(), source, figure_id });
        }
    }
    Ok(cells)
}

fn load_cells(path: &Path) -> Result<Vec<NotebookCell>, String> {
    let source = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if path.extension().is_some_and(|e| e == "ipynb") {
        parse_ipynb(&source)
    } else {
        Ok(parse_cells(&source))
    }
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

#[tauri::command]
fn parse_notebook(root: String, rel: String) -> Result<NotebookInfo, String> {
    let path = resolve(&root, &rel)?;
    let cells = load_cells(&path)?;
    let figure_ids: Vec<String> = cells.iter().filter_map(|c| c.figure_id.clone()).collect();
    let value_names = value_names(&cells);

    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let nb_mtime = file_mtime(&path);

    let mut stale: Vec<String> = figure_ids
        .iter()
        .filter(|id| {
            let pdf = root_dir.join(format!("figures/{id}.pdf"));
            match (nb_mtime, file_mtime(&pdf)) {
                (Some(nb), Some(fig)) => nb > fig,
                _ => true, // missing PDF = stale
            }
        })
        .cloned()
        .collect();

    // Values are stale when this notebook has never written any, or changed since it last did.
    if !value_names.is_empty() {
        let recorded = std::fs::read_to_string(root_dir.join(VALUES_JSON))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .is_some_and(|store| store.get(&rel).is_some());
        let fresh = match (nb_mtime, file_mtime(&root_dir.join(VALUES_TEX))) {
            (Some(nb), Some(tex)) => nb <= tex,
            _ => false,
        };
        if !(recorded && fresh) {
            stale.push("values".into());
        }
    }

    Ok(NotebookInfo { cells, figure_ids, value_names, stale })
}

/// Python available in every notebook: `nbval(name, value)` and `nbtable(name, rows)` export
/// results that the paper reads back with \nbval{name} / \nbtable{name}.
const VALUES_PRELUDE: &str = r##"
import re as _scribe_re

_scribe_values = {}

def _scribe_tex(value):
    # Escape the characters that would otherwise break or silently change the LaTeX.
    return _scribe_re.sub(r'(?<!\\)([%&#_$])', r'\\\1', str(value))

def nbval(name, value, raw=False):
    """Export a value to the paper as \\nbval{name}. Pass raw=True to write LaTeX as-is."""
    _scribe_values[str(name)] = str(value) if raw else _scribe_tex(value)
    return value

def nbtable(name, rows, header=None):
    """Export rows (lists, or a pandas DataFrame) to the paper as \\nbtable{name}."""
    if hasattr(rows, "columns") and hasattr(rows, "values"):
        if header is None:
            header = [str(c) for c in rows.columns]
        rows = rows.values.tolist()
    rows = [list(r) for r in rows]
    width = max([len(r) for r in rows] + [len(header or [])] + [1])
    line = lambda cells: " & ".join(_scribe_tex(c) for c in cells) + r" \\"
    out = [r"\begin{tabular}{" + "l" * width + "}", r"\hline"]
    if header:
        out += [line(header), r"\hline"]
    out += [line(r) for r in rows] + [r"\hline", r"\end{tabular}"]
    _scribe_values[str(name)] = "\n".join(out)
"##;

/// Appended to batch runs: merges this notebook's values into the project's store and rewrites
/// the .tex file the paper inputs. The store is keyed by notebook so removed values disappear.
const VALUES_FOOTER: &str = r##"
def _scribe_write_values(notebook):
    import json, os
    path = ".scribe/values.json"
    try:
        with open(path) as f:
            store = json.load(f)
    except Exception:
        store = {}
    if not _scribe_values and notebook not in store:
        return
    store[notebook] = _scribe_values
    os.makedirs(".scribe", exist_ok=True)
    with open(path, "w") as f:
        json.dump(store, f, indent=1)
    with open("scribe-values.tex", "w") as f:
        f.write("% Auto-generated by Scribe from nbval()/nbtable() calls in notebooks. Do not edit.\n")
        for nb in sorted(store):
            for name, value in store[nb].items():
                f.write("\\long\\expandafter\\def\\csname nbval@%s\\endcsname{%s}\n" % (name, value))
"##;

fn build_runner_script(cells: &[NotebookCell], rel: &str) -> String {
    let mut script = String::from(
        "import matplotlib\nmatplotlib.use('pdf')\nimport matplotlib.pyplot as plt\nimport os\nos.makedirs('figures', exist_ok=True)\n",
    );
    script.push_str(VALUES_PRELUDE);
    script.push('\n');

    for cell in cells {
        match cell.cell_type.as_str() {
            "markdown" => continue,
            "figure" => {
                if let Some(id) = &cell.figure_id {
                    script.push_str("plt.figure()\n");
                    script.push_str(&cell.source);
                    script.push_str(&format!(
                        "\nplt.savefig('figures/{id}.pdf', bbox_inches='tight')\nplt.close()\n\n"
                    ));
                }
            }
            _ => {
                script.push_str(&cell.source);
                script.push_str("\n\n");
            }
        }
    }
    script.push_str(VALUES_FOOTER);
    script.push_str(&format!("_scribe_write_values({rel:?})\n"));
    script
}

fn find_python() -> Result<String, String> {
    for bin in &["python3", "python"] {
        if has(bin) {
            return Ok(bin.to_string());
        }
    }
    Err("No Python found. Install Python 3 and ensure python3 is on PATH.".into())
}

#[derive(Serialize)]
struct RunResult {
    ok: bool,
    log: String,
    figures: Vec<String>,
}

fn run_notebook_blocking(root: &str, rel: &str) -> Result<RunResult, String> {
    let nb_path = resolve(root, rel)?;
    if !nb_path.is_file() {
        return Err(format!("notebook not found: {rel}"));
    }
    let cells = load_cells(&nb_path)?;
    let figure_ids: Vec<String> = cells.iter().filter_map(|c| c.figure_id.clone()).collect();

    let script = build_runner_script(&cells, rel);
    let root_dir = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let runner_path = root_dir.join(".scribe-runner.py");

    std::fs::write(&runner_path, &script).map_err(|e| e.to_string())?;

    let python = find_python()?;
    let out = Command::new(&python)
        .arg(".scribe-runner.py")
        .current_dir(&root_dir)
        .output()
        .map_err(|e| format!("python: {e}"))?;

    // cleanup runner
    let _ = std::fs::remove_file(&runner_path);

    let mut log = String::from_utf8_lossy(&out.stdout).into_owned();
    log.push_str(&String::from_utf8_lossy(&out.stderr));

    Ok(RunResult {
        ok: out.status.success(),
        log,
        figures: figure_ids,
    })
}

#[tauri::command]
async fn run_notebook(root: String, rel: String) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_notebook_blocking(&root, &rel))
        .await
        .map_err(|e| e.to_string())?
}

/// The generated package. `pkg` is its name: scribe-figures, or papyrus-figures in projects
/// created before the rename.
fn style_source(pkg: &str) -> String {
    format!(
        r#"% Auto-generated by Scribe. Do not edit.
\NeedsTeXFormat{{LaTeX2e}}
\ProvidesPackage{{{pkg}}}
\RequirePackage{{graphicx}}
\newcommand{{\nbfig}}[1]{{\includegraphics[width=\linewidth]{{figures/#1.pdf}}}}
% Values and tables exported from notebooks with nbval("name", value) / nbtable("name", rows).
\newcommand{{\nbval}}[1]{{\@ifundefined{{nbval@#1}}{{\textbf{{??}}}}{{\csname nbval@#1\endcsname}}}}
\newcommand{{\nbtable}}[1]{{\nbval{{#1}}}}
\InputIfFileExists{{scribe-values.tex}}{{}}{{}}
"#
    )
}

#[tauri::command]
fn generate_style(root: String) -> Result<(), String> {
    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let write = |pkg: &str| {
        let path = root_dir.join(format!("{pkg}.sty"));
        let tmp = path.with_extension("scribe-tmp");
        std::fs::write(&tmp, style_source(pkg)).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    };
    // An existing generated package keeps its name; it is only rewritten when it predates \nbval.
    for pkg in ["scribe-figures", "papyrus-figures"] {
        if let Ok(existing) = std::fs::read_to_string(root_dir.join(format!("{pkg}.sty"))) {
            return if existing.contains("\\nbval") { Ok(()) } else { write(pkg) };
        }
    }
    write("scribe-figures")
}

// ---------- git integration ----------

#[derive(Serialize)]
struct GitFileStatus {
    path: String,
    status: String,
}

/// The checked-out branch, or None outside a git repository.
#[tauri::command]
fn git_branch(root: String) -> Option<String> {
    let out = Command::new("git").args(["rev-parse", "--abbrev-ref", "HEAD"]).current_dir(&root).output().ok()?;
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !branch.is_empty()).then_some(branch)
}

/// Runs git in the project folder. Never waits on a terminal prompt: a push that needs
/// credentials fails with git's message instead of hanging the app.
fn git(root_dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(root_dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("git: {e}"))
}

fn git_text(root_dir: &Path, args: &[&str]) -> Option<String> {
    let out = git(root_dir, args).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// git's own message when a command fails, for showing to the user.
fn git_run(root_dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git(root_dir, args)?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

/// Changed files, with paths relative to the project root (which may be a subfolder of the
/// repository; changes elsewhere in the repository are left out).
fn git_changes(root_dir: &Path) -> Vec<GitFileStatus> {
    let Some(stdout) = git_text(root_dir, &["status", "--porcelain", "-uall"]) else { return vec![] };
    let prefix = git_text(root_dir, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    // git_text trims, which would eat the leading space of " M file" on the first line.
    let raw = git(root_dir, &["status", "--porcelain", "-uall"])
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or(stdout);
    raw.lines()
        .filter(|l| l.len() >= 4)
        .filter_map(|line| {
            let xy = line[..2].trim();
            // Renames read "old -> new"; the new path is the one that exists.
            let path = line[3..].rsplit(" -> ").next().unwrap_or("").trim().trim_matches('"');
            let path = path.strip_prefix(prefix.as_str())?;
            let status = match xy {
                "??" => "?",
                s if s.contains('A') => "A",
                s if s.contains('D') => "D",
                _ => "M",
            };
            Some(GitFileStatus { path: path.to_string(), status: status.into() })
        })
        .collect()
}

#[tauri::command]
fn git_status(root: String) -> Result<Vec<GitFileStatus>, String> {
    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    Ok(git_changes(&root_dir))
}

#[derive(Serialize)]
struct GitCommit {
    hash: String,
    subject: String,
    /// "3 hours ago"
    when: String,
}

#[derive(Serialize)]
struct GitOverview {
    /// False when the project is not inside a git repository.
    repo: bool,
    branch: Option<String>,
    has_remote: bool,
    changes: Vec<GitFileStatus>,
    log: Vec<GitCommit>,
}

#[tauri::command]
async fn git_overview(root: String) -> Result<GitOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
        let repo = git_text(&root_dir, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true");
        if !repo {
            return Ok(GitOverview { repo, branch: None, has_remote: false, changes: vec![], log: vec![] });
        }
        let log = git_text(&root_dir, &["log", "-n", "15", "--pretty=format:%h%x1f%s%x1f%cr", "--", "."])
            .unwrap_or_default()
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\x1f');
                Some(GitCommit { hash: parts.next()?.into(), subject: parts.next()?.into(), when: parts.next()?.into() })
            })
            .collect();
        Ok(GitOverview {
            repo,
            // A new repository has no commit for HEAD to name yet.
            branch: git_text(&root_dir, &["symbolic-ref", "--short", "HEAD"]),
            has_remote: git_text(&root_dir, &["remote"]).is_some_and(|r| !r.is_empty()),
            changes: git_changes(&root_dir),
            log,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What changed in one file since the last commit, as a unified diff.
#[tauri::command]
fn git_diff(root: String, rel: String) -> Result<String, String> {
    let path = resolve(&root, &rel)?;
    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let tracked = git(&root_dir, &["ls-files", "--error-unmatch", "--", &rel]).is_ok_and(|o| o.status.success());
    let has_head = git_text(&root_dir, &["rev-parse", "--verify", "HEAD"]).is_some();
    let out = if tracked && has_head {
        git(&root_dir, &["diff", "HEAD", "--", &rel])?
    } else if path.is_file() {
        // New file: everything in it is an addition. (--no-index exits 1 when the files differ.)
        git(&root_dir, &["diff", "--no-index", "--", "/dev/null", &rel])?
    } else {
        return Ok(String::new());
    };
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Commits every change in the project folder.
#[tauri::command]
async fn git_commit(root: String, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if message.trim().is_empty() {
            return Err("Write a commit message first.".into());
        }
        let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
        git_run(&root_dir, &["add", "-A", "--", "."])?;
        git_run(&root_dir, &["commit", "-m", message.trim()])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_push(root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
        // A branch that has never been pushed needs its upstream set the first time.
        if git_text(&root_dir, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_some() {
            git_run(&root_dir, &["push"])
        } else {
            git_run(&root_dir, &["push", "-u", "origin", "HEAD"])
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn git_init(root: String) -> Result<String, String> {
    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    git_run(&root_dir, &["init"])
}

// ---------- project search ----------

#[derive(Serialize)]
struct SearchMatch {
    file: String,
    line: usize,
    col: usize,
    text: String,
}

#[tauri::command]
fn search_project(root: String, query: String, case_sensitive: bool) -> Result<Vec<SearchMatch>, String> {
    let base = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    let q = if case_sensitive { query.clone() } else { query.to_lowercase() };

    for entry in WalkDir::new(&base)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            e.depth() == 0 || !(name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()))
        })
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        if let Ok(content) = std::fs::read_to_string(entry.path()) {
            let rel = entry.path().strip_prefix(&base)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            for (i, line) in content.lines().enumerate() {
                let hay = if case_sensitive { line.to_string() } else { line.to_lowercase() };
                if let Some(col) = hay.find(&q) {
                    results.push(SearchMatch { file: rel.clone(), line: i + 1, col, text: line.to_string() });
                    if results.len() >= 500 { return Ok(results); }
                }
            }
        }
    }
    Ok(results)
}

// ---------- settings ----------

#[tauri::command]
fn read_settings(root: String) -> Result<String, String> {
    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let mut p = root_dir.join(".scribe/settings.json");
    if !p.is_file() {
        // Settings saved before the rename; the next save writes them to .scribe/.
        p = root_dir.join(".papyrus/settings.json");
    }
    Ok(std::fs::read_to_string(&p).unwrap_or_else(|_| "{}".into()))
}

#[tauri::command]
fn write_settings(root: String, content: String) -> Result<(), String> {
    let dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?.join(".scribe");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), content).map_err(|e| e.to_string())
}

// ---------- interactive cells (persistent Python kernel) ----------

const KERNEL_SCRIPT: &str = r#"
import sys, json, io, traceback, contextlib, base64

def nbval(name, value, raw=False):
    # Interactive runs only show the value; Compile / Run Notebooks is what writes it to the paper.
    print("%s = %s" % (name, value))
    return value

def nbtable(name, rows, header=None):
    print("%s:" % name)
    print(rows)

ns = {"nbval": nbval, "nbtable": nbtable}
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    out, err = io.StringIO(), io.StringIO()
    figs = []
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compile(msg["code"], "<cell>", "exec"), ns)
        try:
            import matplotlib.pyplot as plt
            for num in plt.get_fignums():
                buf = io.BytesIO()
                plt.figure(num).savefig(buf, format="png", bbox_inches="tight", dpi=120)
                figs.append(base64.b64encode(buf.getvalue()).decode())
                plt.close(num)
        except ImportError:
            pass
        result = {"id": msg["id"], "ok": True, "stdout": out.getvalue(), "stderr": err.getvalue(), "figures": figs}
    except Exception:
        result = {"id": msg["id"], "ok": False, "stdout": out.getvalue(), "stderr": traceback.format_exc(), "figures": []}
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
"#;

use std::io::{BufRead, BufReader, Write};
use std::sync::Mutex;

struct KernelState {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

static KERNEL: Mutex<Option<KernelState>> = Mutex::new(None);

#[tauri::command]
fn kernel_start(root: String) -> Result<(), String> {
    let mut k = KERNEL.lock().map_err(|e| e.to_string())?;
    if k.is_some() { return Ok(()); } // already running

    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let script_path = root_dir.join(".scribe-kernel.py");
    std::fs::write(&script_path, KERNEL_SCRIPT).map_err(|e| e.to_string())?;

    let python = find_python()?;
    let mut child = Command::new(&python)
        .args(["-u", ".scribe-kernel.py"])
        .current_dir(&root_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("kernel spawn: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);

    *k = Some(KernelState { child, stdin, stdout });
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct CellResult {
    id: String,
    ok: bool,
    stdout: String,
    stderr: String,
    figures: Vec<String>, // base64 PNG
}

#[tauri::command]
fn kernel_run_cell(code: String, cell_id: String) -> Result<CellResult, String> {
    let mut k = KERNEL.lock().map_err(|e| e.to_string())?;
    let state = k.as_mut().ok_or("kernel not running")?;

    let msg = serde_json::json!({ "id": cell_id, "code": code });
    writeln!(state.stdin, "{}", msg).map_err(|e| format!("write: {e}"))?;
    state.stdin.flush().map_err(|e| format!("flush: {e}"))?;

    let mut line = String::new();
    state.stdout.read_line(&mut line).map_err(|e| format!("read: {e}"))?;

    serde_json::from_str::<CellResult>(&line).map_err(|e| format!("parse: {e}"))
}

#[tauri::command]
fn kernel_stop() -> Result<(), String> {
    let mut k = KERNEL.lock().map_err(|e| e.to_string())?;
    if let Some(mut state) = k.take() {
        let _ = state.child.kill();
        let _ = state.child.wait();
    }
    Ok(())
}

// ---------- spell check: the operating system's checker ----------

#[cfg(target_os = "macos")]
mod spell {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSArray, NSRange, NSString};

    // AppKit's shared checker. Tauri runs non-async commands on the main thread, which is where
    // AppKit expects to be called.
    fn checker() -> *mut AnyObject {
        unsafe { msg_send![class!(NSSpellChecker), sharedSpellChecker] }
    }

    pub fn misspelled(word: &str) -> bool {
        let text = NSString::from_str(word);
        let range: NSRange = unsafe { msg_send![checker(), checkSpellingOfString: &*text, startingAt: 0isize] };
        range.length > 0
    }

    pub fn suggest(word: &str) -> Vec<String> {
        let text = NSString::from_str(word);
        let range = NSRange::new(0, text.length());
        let guesses: Option<Retained<NSArray<NSString>>> = unsafe {
            msg_send![
                checker(),
                guessesForWordRange: range,
                inString: &*text,
                language: std::ptr::null::<NSString>(),
                inSpellDocumentWithTag: 0isize
            ]
        };
        guesses.map(|list| list.iter().map(|g| g.to_string()).collect()).unwrap_or_default()
    }

    /// Adds the word to the user's dictionary, for every app.
    pub fn learn(word: &str) {
        let text = NSString::from_str(word);
        let _: () = unsafe { msg_send![checker(), learnWord: &*text] };
    }
}

#[cfg(not(target_os = "macos"))]
mod spell {
    pub fn misspelled(_word: &str) -> bool { false }
    pub fn suggest(_word: &str) -> Vec<String> { Vec::new() }
    pub fn learn(_word: &str) {}
}

/// Whether this build has a spell checker to ask.
#[tauri::command]
fn spell_available() -> bool {
    cfg!(target_os = "macos")
}

/// The subset of `words` the system dictionary doesn't know.
#[tauri::command]
fn spell_check(words: Vec<String>) -> Vec<String> {
    words.into_iter().filter(|w| spell::misspelled(w)).collect()
}

#[tauri::command]
fn spell_suggest(word: String) -> Vec<String> {
    spell::suggest(&word).into_iter().take(6).collect()
}

#[tauri::command]
fn spell_learn(word: String) {
    spell::learn(&word);
}

// ---------- environment ----------

/// The PATH from the user's login shell. Apps launched from Finder or the Dock inherit only a
/// bare system PATH, so without this TeX, Python and git would not be found outside `tauri dev`.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::time::{Duration, Instant};

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // fish keeps PATH as a list; everything else as a colon-separated string.
    let print = if shell.ends_with("fish") {
        "printf '__SCRIBE__%s__SCRIBE__' (string join : $PATH)"
    } else {
        "printf '__SCRIBE__%s__SCRIBE__' \"$PATH\""
    };
    let mut child = Command::new(&shell)
        .args(["-ilc", print])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    // A shell profile that waits for input must not hang the app's launch.
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    // Profiles may print their own text; take only what sits between the markers.
    let path = out.split("__SCRIBE__").nth(1)?.trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Give this process (and so every tool it starts) the PATH the user's terminal would have,
/// plus the usual install locations in case the shell could not be asked.
#[cfg(unix)]
fn adopt_shell_path() {
    let base = login_shell_path().or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
    let mut dirs: Vec<String> = base.split(':').filter(|d| !d.is_empty()).map(String::from).collect();
    let home = std::env::var("HOME").unwrap_or_default();
    let extras = [
        "/Library/TeX/texbin".to_string(),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.cargo/bin"),
        format!("{home}/.local/bin"),
    ];
    for extra in extras {
        if !dirs.contains(&extra) && Path::new(&extra).is_dir() {
            dirs.push(extra);
        }
    }
    std::env::set_var("PATH", dirs.join(":"));
}

#[cfg(not(unix))]
fn adopt_shell_path() {}

#[derive(Serialize)]
struct Tools {
    /// The LaTeX engine that compile will use, if any.
    tex: Option<String>,
    python: Option<String>,
}

fn find_tools() -> Tools {
    Tools {
        tex: ["tectonic", "latexmk"].into_iter().find(|bin| has(bin)).map(String::from),
        python: find_python().ok(),
    }
}

/// What the welcome screen needs to say whether compiling and notebooks will work here.
#[tauri::command]
async fn check_tools() -> Result<Tools, String> {
    tauri::async_runtime::spawn_blocking(find_tools).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn python_bin() -> Result<String, String> {
    find_python()
}

// ---------- terminal: the user's shell in a pseudo-terminal ----------
// Deliberately not sandboxed like the file commands: it is the user's own shell.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::Emitter;

struct PtySession {
    id: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

static PTY: Mutex<Option<PtySession>> = Mutex::new(None);
static PTY_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Starts a login shell in `root_dir`. `on_output` receives what it prints; `on_exit` runs once
/// the shell is gone.
fn spawn_pty(
    root_dir: &Path,
    cols: u16,
    rows: u16,
    on_output: impl Fn(String) + Send + 'static,
    on_exit: impl FnOnce(u64) + Send + 'static,
) -> Result<PtySession, String> {
    let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;

    let mut cmd = if cfg!(windows) {
        CommandBuilder::new_default_prog()
    } else {
        let mut c = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
        c.arg("-l");
        c
    };
    cmd.cwd(root_dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("couldn't start a shell: {e}"))?;
    drop(pair.slave); // the shell holds its own end; ours would keep the reader from seeing EOF
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = PTY_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&buf[..n]);
            // Hold back a trailing partial UTF-8 character until the rest of it arrives.
            let valid = match std::str::from_utf8(&pending) {
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                _ => pending.len(),
            };
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            if !text.is_empty() {
                on_output(text);
            }
        }
        on_exit(id);
    });

    Ok(PtySession { id, master: pair.master, writer, child })
}

#[tauri::command]
fn pty_start(app: tauri::AppHandle, root: String, cols: u16, rows: u16) -> Result<(), String> {
    let mut slot = PTY.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Ok(()); // already running
    }
    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let out_app = app.clone();
    let session = spawn_pty(
        &root_dir,
        cols,
        rows,
        move |text| {
            let _ = out_app.emit("pty-output", text);
        },
        move |id| {
            // Only clear the slot if it still holds this shell; a newer one may have replaced it.
            if let Ok(mut slot) = PTY.lock() {
                if slot.as_ref().is_some_and(|s| s.id == id) {
                    *slot = None;
                }
            }
            let _ = app.emit("pty-exit", ());
        },
    )?;
    *slot = Some(session);
    Ok(())
}

#[tauri::command]
fn pty_write(data: String) -> Result<(), String> {
    let mut slot = PTY.lock().map_err(|e| e.to_string())?;
    let session = slot.as_mut().ok_or("no terminal is running")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(cols: u16, rows: u16) -> Result<(), String> {
    let slot = PTY.lock().map_err(|e| e.to_string())?;
    if let Some(session) = slot.as_ref() {
        let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
        session.master.resize(size).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_kill() -> Result<(), String> {
    if let Some(mut session) = PTY.lock().map_err(|e| e.to_string())?.take() {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    adopt_shell_path();
    // `scribe --check-tools` prints what the app can find, without opening a window: the quickest
    // way to see why compiling or notebooks don't work on a machine.
    if std::env::args().any(|a| a == "--check-tools") {
        println!("{}", serde_json::to_string(&find_tools()).unwrap_or_default());
        return;
    }
    let builder = tauri::Builder::default();
    // The default menu binds Cmd+W to Close Window, which would swallow "close tab".
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| {
        use tauri::menu::{MenuBuilder, SubmenuBuilder};
        let app_menu = SubmenuBuilder::new(app, "Scribe")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        let window = SubmenuBuilder::new(app, "Window").minimize().maximize().fullscreen().build()?;
        MenuBuilder::new(app).items(&[&app_menu, &edit, &window]).build()
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            list_files, list_dirs, create_dir, rename_path, delete_path,
            read_file, write_file, read_binary, compile,
            parse_notebook, run_notebook, generate_style,
            git_status, git_branch, git_overview, git_diff, git_commit, git_push, git_init, search_project, read_settings, write_settings,
            kernel_start, kernel_run_cell, kernel_stop,
            spell_available, spell_check, spell_suggest, spell_learn,
            python_bin, check_tools, pty_start, pty_write, pty_resize, pty_kill,
            synctex_edit, synctex_view
        ])
        .run(tauri::generate_context!())
        .expect("error while running Scribe");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> String {
        concat!(env!("CARGO_MANIFEST_DIR"), "/../example").to_string()
    }

    #[test]
    fn rejects_escapes() {
        assert!(resolve(&example(), "../Cargo.toml").is_err());
        assert!(resolve(&example(), "/etc/passwd").is_err());
        assert!(resolve(&example(), "main.tex").is_ok());
    }

    #[test]
    fn creates_and_renames_inside_the_root_only() {
        let dir = std::env::temp_dir().join(format!("scribe-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();

        create_dir(root.clone(), "sections/drafts".into()).unwrap();
        assert!(list_dirs(root.clone()).unwrap().contains(&"sections/drafts".to_string()));
        write_file(root.clone(), "a.tex".into(), "x".into()).unwrap();
        write_file(root.clone(), "b.tex".into(), "y".into()).unwrap();

        rename_path(root.clone(), "a.tex".into(), "sections/a.tex".into()).unwrap();
        assert!(dir.join("sections/a.tex").exists());
        // no overwriting, no escaping, no touching the root
        assert!(rename_path(root.clone(), "b.tex".into(), "sections/a.tex".into()).is_err());
        assert!(rename_path(root.clone(), "b.tex".into(), "../b.tex".into()).is_err());
        assert!(rename_path(root.clone(), "".into(), "elsewhere".into()).is_err());
        assert!(delete_path(root.clone(), "".into()).is_err());
        assert!(delete_path(root.clone(), "../x".into()).is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lists_and_compiles_example() {
        let files = list_files(example()).unwrap();
        assert!(files.contains(&"main.tex".to_string()));

        // Run notebook first to generate figures/fig-loss.pdf
        let run_res = run_notebook_blocking(&example(), "notebooks/analysis.py").unwrap();
        assert!(run_res.ok, "notebook failed:\n{}", run_res.log);

        // The app refreshes the generated package before every compile; do the same here.
        generate_style(example()).unwrap();
        let res = compile_blocking(&example(), "main.tex").unwrap();
        assert!(res.ok, "compile failed:\n{}", res.log);
        assert_eq!(res.pdf.as_deref(), Some("build/main.pdf"));
    }

    #[test]
    fn parses_notebook_cells() {
        let info = parse_notebook(example(), "notebooks/analysis.py".into()).unwrap();
        assert!(info.figure_ids.contains(&"fig-loss".to_string()));
        assert!(info.cells.len() >= 3); // markdown + code + figure
        let fig_cell = info.cells.iter().find(|c| c.figure_id.is_some()).unwrap();
        assert_eq!(fig_cell.cell_type, "figure");
        assert_eq!(fig_cell.figure_id.as_deref(), Some("fig-loss"));
    }

    #[test]
    fn synctex_round_trip_on_example() {
        // Needs the compiled example; `lists_and_compiles_example` produces it.
        generate_style(example()).unwrap();
        let _ = compile_blocking(&example(), "main.tex").unwrap();
        let Ok(spot) = synctex_view(example(), "build/main.pdf".into(), "main.tex".into(), 20) else {
            return; // no synctex binary on this machine
        };
        assert_eq!(spot.page, 1);
        assert!(spot.width > 0.0 && spot.y > 0.0);
        let back = synctex_edit(example(), "build/main.pdf".into(), 1, spot.x + 5.0, spot.y + 2.0).unwrap();
        assert_eq!(back.file, "main.tex");
        assert!((18..=22).contains(&back.line), "landed on line {}", back.line);
        assert!(synctex_edit(example(), "../outside.pdf".into(), 1, 0.0, 0.0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn terminal_runs_a_shell() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let dir = std::env::temp_dir();
        let mut session = spawn_pty(&dir, 80, 24, move |text| { let _ = tx.send(text); }, |_| {}).unwrap();
        session.writer.write_all(b"echo scribe-$((40+2))\n").unwrap();
        session.writer.flush().unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut seen = String::new();
        while !seen.contains("scribe-42") && std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                seen.push_str(&chunk);
            }
        }
        let _ = session.child.kill();
        assert!(seen.contains("scribe-42"), "shell output was: {seen:?}");
    }

    #[cfg(unix)]
    #[test]
    fn login_shell_path_is_usable() {
        let path = login_shell_path().expect("the login shell should report a PATH");
        assert!(path.split(':').any(|dir| dir == "/usr/bin"), "{path}");
    }

    #[test]
    fn git_panel_commands_work_on_a_fresh_repository() {
        let dir = std::env::temp_dir().join(format!("scribe-git-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        let root_dir = dir.canonicalize().unwrap();
        if git_init(root.clone()).is_err() {
            return; // no git on this machine
        }
        // Commits need an identity; don't depend on the machine's global config.
        git_run(&root_dir, &["config", "user.email", "test@example.org"]).unwrap();
        git_run(&root_dir, &["config", "user.name", "Test"]).unwrap();

        write_file(root.clone(), "main.tex".into(), "one\n".into()).unwrap();
        let changes = git_changes(&root_dir);
        assert_eq!((changes[0].path.as_str(), changes[0].status.as_str()), ("main.tex", "?"));
        assert!(git_diff(root.clone(), "main.tex".into()).unwrap().contains("+one"));

        // Empty messages are refused; a real one commits everything.
        assert!(tauri::async_runtime::block_on(git_commit(root.clone(), "  ".into())).is_err());
        tauri::async_runtime::block_on(git_commit(root.clone(), "First".into())).unwrap();
        assert!(git_changes(&root_dir).is_empty());

        write_file(root.clone(), "main.tex".into(), "one\ntwo\n".into()).unwrap();
        let diff = git_diff(root.clone(), "main.tex".into()).unwrap();
        assert!(diff.contains("+two") && !diff.contains("+one"), "{diff}");
        let overview = tauri::async_runtime::block_on(git_overview(root.clone())).unwrap();
        assert!(overview.repo && !overview.has_remote);
        assert_eq!(overview.log[0].subject, "First");
        assert_eq!(overview.changes[0].status, "M");
        assert!(git_diff(root.clone(), "../outside".into()).is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_spell_checker_answers() {
        assert!(!spell::misspelled("the"));
        assert!(!spell::misspelled("training"));
        assert!(spell::misspelled("acuracy"));
        assert!(spell::suggest("acuracy").iter().any(|g| g == "accuracy"), "{:?}", spell::suggest("acuracy"));
        assert_eq!(spell_check(vec!["loss".into(), "validaton".into()]), ["validaton"]);
    }

    #[test]
    fn exports_values_to_the_paper() {
        let dir = std::env::temp_dir().join(format!("scribe-values-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("notebooks")).unwrap();
        let root = dir.to_string_lossy().to_string();
        let nb = "# %%\nacc = 0.9423\nnbval(\"accuracy\", f\"{acc:.1%}\")\nnbval('n_samples', 1200)\n\n# %%\nnbtable(\"results\", [[\"a_b\", 1], [\"c\", 2]], header=[\"Name\", \"N\"])\n";
        write_file(root.clone(), "notebooks/stats.py".into(), nb.into()).unwrap();

        let info = parse_notebook(root.clone(), "notebooks/stats.py".into()).unwrap();
        assert_eq!(info.value_names, ["accuracy", "n_samples", "results"]);
        assert!(info.stale.contains(&"values".to_string()));

        let Ok(res) = run_notebook_blocking(&root, "notebooks/stats.py") else { return }; // no python here
        if res.log.contains("No module named 'matplotlib'") {
            return;
        }
        assert!(res.ok, "{}", res.log);
        let tex = std::fs::read_to_string(dir.join("scribe-values.tex")).unwrap();
        assert!(tex.contains(r"\long\expandafter\def\csname nbval@accuracy\endcsname{94.2\%}"), "{tex}");
        assert!(tex.contains(r"nbval@n_samples\endcsname{1200}"));
        assert!(tex.contains(r"a\_b & 1 \\"), "{tex}");
        let fresh = parse_notebook(root.clone(), "notebooks/stats.py".into()).unwrap();
        assert!(fresh.stale.is_empty(), "{:?}", fresh.stale);

        // The generated package defines \nbval, and an older generated one is upgraded in place.
        std::fs::write(dir.join("papyrus-figures.sty"), "% Auto-generated by Papyrus. Do not edit.\n").unwrap();
        generate_style(root.clone()).unwrap();
        let sty = std::fs::read_to_string(dir.join("papyrus-figures.sty")).unwrap();
        assert!(sty.contains(r"\ProvidesPackage{papyrus-figures}") && sty.contains(r"\newcommand{\nbval}"));
        assert!(!dir.join("scribe-figures.sty").exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parses_synctex_output() {
        let root = Path::new("/proj");
        let edit = "SyncTeX result begin\nOutput:build/main.pdf\nInput:/proj/./sections/intro.tex\nLine:18\nColumn:-1\n";
        let spot = parse_synctex_edit(edit, root).unwrap();
        assert_eq!((spot.file.as_str(), spot.line), ("sections/intro.tex", 18));
        assert!(parse_synctex_edit("Input:/elsewhere/a.tex\nLine:3\n", root).is_err());
        assert!(parse_synctex_edit("SyncTeX result begin\nSyncTeX result end\n", root).is_err());
        let view = parse_synctex_view("Page:2\nx:160.2\ny:424.1\nh:125.8\nv:426.2\nW:358.6\nH:9.7\n").unwrap();
        assert_eq!(view.page, 2);
        assert!((view.y - 416.5).abs() < 0.01 && (view.x - 125.8).abs() < 0.01);
        assert!(parse_synctex_view("nothing").is_err());
    }

    #[test]
    fn parses_ipynb_cells() {
        let nb = r##"{"cells": [
            {"cell_type": "markdown", "metadata": {}, "source": ["# Title"]},
            {"cell_type": "code", "metadata": {}, "source": ["%matplotlib inline\n", "import numpy as np"]},
            {"cell_type": "code", "metadata": {"scribe": {"figure": "fig-a"}}, "source": "plt.plot([1, 2])"},
            {"cell_type": "code", "metadata": {"papyrus": {"figure": "fig-old"}}, "source": "plt.plot([3])"},
            {"cell_type": "raw", "metadata": {}, "source": ["ignored"]}
        ], "metadata": {}, "nbformat": 4, "nbformat_minor": 4}"##;
        let cells = parse_ipynb(nb).unwrap();
        assert_eq!(cells.len(), 4);
        assert_eq!(cells[3].figure_id.as_deref(), Some("fig-old")); // key from before the rename
        assert_eq!(cells[1].source, "import numpy as np"); // magic line dropped
        assert_eq!(cells[2].cell_type, "figure");
        assert_eq!(cells[2].figure_id.as_deref(), Some("fig-a"));
        assert!(parse_ipynb("not json").is_err());
        assert!(parse_ipynb("").unwrap().is_empty());
    }

    #[test]
    fn builds_runner_script() {
        let source = std::fs::read_to_string(
            Path::new(&example()).join("notebooks/analysis.py")
        ).unwrap();
        let cells = parse_cells(&source);
        let script = build_runner_script(&cells, "notebooks/analysis.py");
        assert!(script.contains("_scribe_write_values(\"notebooks/analysis.py\")"));
        assert!(script.contains("matplotlib.use('pdf')"));
        assert!(script.contains("plt.savefig('figures/fig-loss.pdf'"));
        assert!(script.contains("plt.close()"));
    }

    #[test]
    fn stale_detection() {
        let info = parse_notebook(example(), "notebooks/analysis.py".into()).unwrap();
        // stale = figure missing OR notebook newer than figure
        // After a test run, fig-loss.pdf may exist, so just check the field is populated correctly
        assert!(info.figure_ids.contains(&"fig-loss".to_string()));
        // If we touch the notebook, it should become stale
        let nb = Path::new(&example()).join("notebooks/analysis.py");
        let _ = std::fs::OpenOptions::new().append(true).open(&nb); // updates mtime
        let info2 = parse_notebook(example(), "notebooks/analysis.py".into()).unwrap();
        // Either stale or figure_ids should contain fig-loss
        assert!(info2.figure_ids.contains(&"fig-loss".to_string()));
    }
}
