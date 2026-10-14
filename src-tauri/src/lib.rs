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
    // Before the first saved version of a file, keep what was there, so it can be gone back to.
    let keep = HISTORY_FILES.is_match(&rel) && !rel.starts_with('.');
    if keep && path.is_file() {
        if let Ok(root_dir) = Path::new(&root).canonicalize() {
            if history_ids(&root_dir, &rel).is_empty() {
                if let Ok(old) = std::fs::read_to_string(&path) {
                    let when = file_mtime(&path).and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_secs());
                    let _ = save_version(&root_dir, &rel, &old, when.unwrap_or(0), false);
                }
            }
        }
    }
    // Write-then-rename so a crash mid-save never truncates the user's file.
    let tmp = path.with_extension("scribe-tmp");
    std::fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    if keep {
        if let Ok(root_dir) = Path::new(&root).canonicalize() {
            let _ = save_version(&root_dir, &rel, &content, now_secs(), true);
        }
    }
    Ok(())
}

// ---------- history: earlier versions of each file, kept on save ----------
// Like Overleaf's history, for people who don't use git: every save keeps a version in
// .scribe/history/<file>/<unix seconds>.txt. Saves within ten minutes of the last version
// replace it, so a working session becomes one version rather than hundreds.

struct Pattern(&'static [&'static str]);
impl Pattern {
    fn is_match(&self, rel: &str) -> bool {
        self.0.iter().any(|ext| rel.to_lowercase().ends_with(ext))
    }
}
const HISTORY_FILES: Pattern = Pattern(&[".tex", ".bib", ".md", ".py", ".sty", ".cls", ".txt", ".ipynb"]);
const HISTORY_DIR: &str = ".scribe/history";
const HISTORY_GROUP_SECS: u64 = 600;
const HISTORY_KEEP: usize = 200;

fn now_secs() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn history_dir(root_dir: &Path, rel: &str) -> PathBuf {
    root_dir.join(HISTORY_DIR).join(rel)
}

/// Version ids (their times), oldest first.
fn history_ids(root_dir: &Path, rel: &str) -> Vec<u64> {
    let mut ids: Vec<u64> = std::fs::read_dir(history_dir(root_dir, rel))
        .map(|dir| {
            dir.filter_map(Result::ok)
                .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".txt").and_then(|s| s.parse().ok()))
                .collect()
        })
        .unwrap_or_default();
    ids.sort_unstable();
    ids
}

fn save_version(root_dir: &Path, rel: &str, content: &str, when: u64, group: bool) -> Result<(), String> {
    let dir = history_dir(root_dir, rel);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Versions are Scribe's own copies: keep them out of git (and out of "commit all").
    let ignore = root_dir.join(HISTORY_DIR).join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(&ignore, "*\n");
    }
    let ids = history_ids(root_dir, rel);
    let mut when = when;
    if let Some(&last) = ids.last() {
        let last_path = dir.join(format!("{last}.txt"));
        if std::fs::read_to_string(&last_path).is_ok_and(|text| text == content) {
            return Ok(());
        }
        // Still the same sitting: the newest version moves forward instead of a new one starting.
        // The first version (what the file was before Scribe saved it) is never replaced.
        if group && ids.len() > 1 && when.saturating_sub(last) < HISTORY_GROUP_SECS {
            let _ = std::fs::remove_file(&last_path);
            when = when.max(last);
        } else {
            when = when.max(last + 1); // ids are times and must stay unique
        }
    }
    std::fs::write(dir.join(format!("{when}.txt")), content).map_err(|e| e.to_string())?;
    let ids = history_ids(root_dir, rel);
    if ids.len() > HISTORY_KEEP {
        for old in &ids[..ids.len() - HISTORY_KEEP] {
            let _ = std::fs::remove_file(dir.join(format!("{old}.txt")));
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct Version {
    id: u64,
    /// Lines this version added and removed compared with the one before it.
    added: usize,
    removed: usize,
}

fn line_changes(old: &str, new: &str) -> (usize, usize) {
    let diff = similar::TextDiff::from_lines(old, new);
    let mut added = 0;
    let mut removed = 0;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => added += 1,
            similar::ChangeTag::Delete => removed += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

/// Saved versions of a file, newest first.
#[tauri::command]
async fn history_list(root: String, rel: String) -> Result<Vec<Version>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve(&root, &rel)?;
        let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
        let dir = history_dir(&root_dir, &rel);
        let ids = history_ids(&root_dir, &rel);
        let texts: Vec<String> = ids.iter().map(|id| std::fs::read_to_string(dir.join(format!("{id}.txt"))).unwrap_or_default()).collect();
        let mut out: Vec<Version> = ids
            .iter()
            .enumerate()
            .map(|(i, &id)| {
                // what this version changed relative to the one before it
                let (added, removed) = if i == 0 { (texts[0].lines().count(), 0) } else { line_changes(&texts[i - 1], &texts[i]) };
                Version { id, added, removed }
            })
            .collect();
        out.reverse();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn history_read(root: String, rel: String, id: u64) -> Result<String, String> {
    resolve(&root, &rel)?;
    let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    std::fs::read_to_string(history_dir(&root_dir, &rel).join(format!("{id}.txt"))).map_err(|_| "That version is gone.".into())
}

/// What changed from the version to the file as it is now, as a unified diff.
#[tauri::command]
fn history_diff(root: String, rel: String, id: u64, current: String) -> Result<String, String> {
    let old = history_read(root, rel.clone(), id)?;
    Ok(unified_diff(&old, &current, &rel))
}

fn unified_diff(old: &str, new: &str, rel: &str) -> String {
    similar::TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{rel}"), &format!("b/{rel}"))
        .to_string()
}

/// Undo encodeURIComponent: header values must be ASCII, paths need not be.
fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| format!("bad escape %{hex}"))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// Writes bytes sent as the raw request body (an image pasted into a note). The project and
/// the path come in the `x-root` / `x-rel` headers, percent-encoded.
#[tauri::command]
fn write_binary(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        let value = request.headers().get(name).ok_or_else(|| format!("missing {name}"))?;
        percent_decode(value.to_str().map_err(|e| e.to_string())?)
    };
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let path = resolve(&header("x-root")?, &header("x-rel")?)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("scribe-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
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
        for call in ["nbval(", "nbtable(", "nbmath("] {
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

/// A cell's text as the editor should show it. Text cells are stored as comment lines; the
/// leading "# " comes off here and is put back when the notebook is saved, so it must come off
/// exactly once or every save would add another.
fn cell_source(kind: &str, lines: &[&str]) -> String {
    if kind != "markdown" {
        return lines.join("\n").trim().to_string();
    }
    lines
        .iter()
        .map(|line| line.strip_prefix("# ").or_else(|| line.strip_prefix('#')).unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
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
                let src = cell_source(&current_type, &current_lines);
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
        let src = cell_source(&current_type, &current_lines);
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

/// Python available in every notebook. `nbval`, `nbmath` and `nbtable` export results that the
/// paper reads back with \nbval{name}, \nbmath{name} and \nbtable{name}.
const VALUES_PRELUDE: &str = r##"
import math as _scribe_math
import re as _scribe_re

_scribe_values = {}

def _scribe_tex(value):
    # Escape the characters that would otherwise break or silently change the LaTeX.
    return _scribe_re.sub(r'(?<!\\)([%&#_$])', r'\\\1', str(value))

def _scribe_number(value, err=None, sig=None):
    """A number as siunitx input, rounded the way measurements are reported: the uncertainty
    to one significant figure (two when it starts with 1), the value to the same place."""
    v = float(value)
    e = abs(float(err)) if err is not None else 0.0
    if e > 0:
        lead = _scribe_math.floor(_scribe_math.log10(e))
        digits = sig or (2 if int(e / 10 ** lead + 1e-9) == 1 else 1)
        place = lead - (digits - 1)
    elif sig and v != 0:
        place = _scribe_math.floor(_scribe_math.log10(abs(v))) - (sig - 1)
    else:
        return "%.12g" % v
    v, e = round(v, -place), round(e, -place)
    exp = _scribe_math.floor(_scribe_math.log10(abs(v))) if v != 0 else 0
    sci = exp >= 5 or exp <= -4
    scale = 10.0 ** exp if sci else 1.0
    decimals = max(0, (exp if sci else 0) - place)
    text = "%.*f" % (decimals, v / scale)
    if e > 0:
        text += " +- %.*f" % (decimals, e / scale)
    if sci:
        text += " e%d" % exp
    return text

def _scribe_is_number(value):
    return not isinstance(value, (str, bool)) and hasattr(value, "__float__")

def nbval(name, value, raw=False, unit=None, err=None, sig=None):
    """Export a value to the paper as \\nbval{name}.

    unit: a siunitx unit ("kg", "m/s^2", "\\percent"); err: its uncertainty; sig: significant
    figures. With any of these the number is typeset by siunitx. raw=True writes LaTeX as-is."""
    if raw:
        text = str(value)
    elif _scribe_is_number(value) and (unit is not None or err is not None or sig is not None):
        number = _scribe_number(value, err, sig)
        text = "\\qty{%s}{%s}" % (number, unit) if unit else "\\num{%s}" % number
    elif unit is not None:
        text = "%s~\\unit{%s}" % (_scribe_tex(value), unit)
    else:
        text = _scribe_tex(value)
    _scribe_values[str(name)] = text
    return value

def nbmath(name, expr):
    """Export a formula to the paper as \\nbmath{name}, for use inside maths.
    SymPy expressions are converted to LaTeX; a string is taken to be LaTeX already."""
    if isinstance(expr, str):
        text = expr
    else:
        try:
            import sympy
            text = sympy.latex(expr)
        except Exception:
            text = str(expr)
    _scribe_values[str(name)] = text
    return expr

def _scribe_cell(cell):
    # (value, uncertainty) pairs are typeset as value +- uncertainty.
    if isinstance(cell, tuple) and len(cell) == 2 and all(_scribe_is_number(c) for c in cell):
        number = _scribe_number(cell[0], cell[1])
        if " e" in number:
            body, exp = number.rsplit(" e", 1)
            return "$(%s) \\times 10^{%s}$" % (body.replace("+-", "\\pm"), exp)
        return "$%s$" % number.replace("+-", "\\pm")
    return _scribe_tex(cell)

def nbtable(name, rows, header=None):
    """Export rows (lists, or a pandas DataFrame) to the paper as \\nbtable{name}.
    A cell given as (value, uncertainty) is written value +- uncertainty; columns of numbers
    are right-aligned."""
    if hasattr(rows, "columns") and hasattr(rows, "values"):
        if header is None:
            header = [str(c) for c in rows.columns]
        rows = rows.values.tolist()
    rows = [list(r) for r in rows]
    width = max([len(r) for r in rows] + [len(header or [])] + [1])
    numeric = lambda c: _scribe_is_number(c) or isinstance(c, tuple)
    spec = "".join(
        "r" if rows and all(i < len(r) and numeric(r[i]) for r in rows) else "l" for i in range(width)
    )
    line = lambda cells, fmt: " & ".join(fmt(c) for c in cells) + r" \\"
    out = [r"\begin{tabular}{" + spec + "}", r"\hline"]
    if header:
        out += [line(header, _scribe_tex), r"\hline"]
    out += [line(r, _scribe_cell) for r in rows] + [r"\hline", r"\end{tabular}"]
    _scribe_values[str(name)] = "\n".join(out)
"##;

/// Appended to batch runs: records how the run was made, merges this notebook's values into the
/// project's store (keyed by notebook, so removed values disappear), and rewrites the .tex file
/// the paper inputs.
const VALUES_FOOTER: &str = r##"
def _scribe_finish(notebook):
    import datetime, json, os, platform, subprocess, sys
    os.makedirs(".scribe", exist_ok=True)

    def load(path):
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception:
            data = {}
        # Notebooks that have since been deleted or renamed don't linger.
        return {nb: v for nb, v in data.items() if os.path.exists(nb)}

    def git(*args):
        try:
            return subprocess.run(["git", *args], capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            return ""

    # How this run was made, so a result can be traced to the code and environment behind it.
    packages = {}
    for mod in ("numpy", "scipy", "pandas", "matplotlib", "sympy", "sklearn", "torch", "jax",
                "tensorflow", "statsmodels", "seaborn"):
        version = getattr(sys.modules.get(mod), "__version__", None)
        if version:
            packages[mod] = str(version)
    commit = git("rev-parse", "--short", "HEAD")
    if commit and git("status", "--porcelain", "--untracked-files=no"):
        commit += " + uncommitted changes"
    seed = None
    for key in ("SEED", "SEEDS", "RANDOM_SEED", "seed", "seeds"):
        if key in globals() and isinstance(globals()[key], (int, list, tuple, range)):
            value = globals()[key]
            seed = str(value) if isinstance(value, int) else ", ".join(str(s) for s in value)
            break
    runs = load(".scribe/runs.json")
    runs[notebook] = {
        "date": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "python": platform.python_version(),
        "packages": packages,
        "commit": commit,
        "seed": seed,
    }
    with open(".scribe/runs.json", "w") as f:
        json.dump(runs, f, indent=1)

    store = load(".scribe/values.json")
    store[notebook] = _scribe_values
    with open(".scribe/values.json", "w") as f:
        json.dump(store, f, indent=1)

    env = [r"\begin{tabular}{ll}", r"\hline"]
    for nb in sorted(runs):
        run = runs[nb]
        rows = [("Notebook", r"\texttt{%s}" % _scribe_tex(nb)), ("Python", run.get("python", ""))]
        if run.get("packages"):
            rows.append(("Packages", ", ".join("%s %s" % (k, v) for k, v in run["packages"].items())))
        if run.get("seed"):
            rows.append(("Random seed", run["seed"]))
        if run.get("commit"):
            rows.append(("Git commit", r"\texttt{%s}" % _scribe_tex(run["commit"])))
        rows.append(("Last run", run.get("date", "")))
        env += ["%s & %s \\\\" % (label, text if text.startswith("\\") else _scribe_tex(text)) for label, text in rows]
        env.append(r"\hline")
    env.append(r"\end{tabular}")

    with open("scribe-values.tex", "w") as f:
        f.write("% Auto-generated by Scribe from notebook runs. Do not edit.\n")
        if any(cmd in text for values in store.values() for text in values.values() for cmd in ("\\qty{", "\\num{", "\\unit{")):
            f.write("\\RequirePackage{siunitx}\n\\sisetup{separate-uncertainty=true}\n")
        for nb in sorted(store):
            for name, value in store[nb].items():
                f.write("\\long\\expandafter\\def\\csname nbval@%s\\endcsname{%s}\n" % (name, value))
        f.write("\\long\\expandafter\\def\\csname nbval@scribe-env\\endcsname{%s}\n" % "\n".join(env))
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
    script.push_str(&format!("_scribe_finish({rel:?})\n"));
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
/// Bumped whenever the generated package changes, so older copies are rewritten.
const STYLE_MARK: &str = "Scribe package v3";

fn style_source(pkg: &str) -> String {
    format!(
        r#"% Auto-generated by Scribe. Do not edit. ({STYLE_MARK})
\NeedsTeXFormat{{LaTeX2e}}
\ProvidesPackage{{{pkg}}}
\RequirePackage{{graphicx}}
\newcommand{{\nbfig}}[1]{{\includegraphics[width=\linewidth]{{figures/#1.pdf}}}}
% Results exported from notebooks with nbval(), nbmath() and nbtable().
\newcommand{{\nbval}}[1]{{\@ifundefined{{nbval@#1}}{{\textbf{{??}}}}{{\csname nbval@#1\endcsname}}}}
\newcommand{{\nbtable}}[1]{{\nbval{{#1}}}}
\newcommand{{\nbmath}}[1]{{\nbval{{#1}}}}
% How the notebooks were last run: Python, packages, seed, commit and date.
\newcommand{{\nbenv}}{{\nbval{{scribe-env}}}}
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
    // An existing generated package keeps its name; it is rewritten only when it is out of date.
    for pkg in ["scribe-figures", "papyrus-figures"] {
        if let Ok(existing) = std::fs::read_to_string(root_dir.join(format!("{pkg}.sty"))) {
            return if existing.contains(STYLE_MARK) { Ok(()) } else { write(pkg) };
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

#[derive(Serialize)]
struct GitIdentity {
    name: String,
    email: String,
}

/// The name and email git is configured with, to start the profile from. Read only.
#[tauri::command]
fn git_identity() -> GitIdentity {
    let read = |key: &str| {
        Command::new("git")
            .args(["config", "--global", key])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    GitIdentity { name: read("user.name"), email: read("user.email") }
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
async fn git_commit(root: String, message: String, name: Option<String>, email: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if message.trim().is_empty() {
            return Err("Write a commit message first.".into());
        }
        let root_dir = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
        git_run(&root_dir, &["add", "-A", "--", "."])?;
        // The profile's name and email sign the commit when both are set; otherwise git's own
        // configuration decides, as it would on the command line.
        match (name.filter(|n| !n.trim().is_empty()), email.filter(|e| !e.trim().is_empty())) {
            (Some(name), Some(email)) => git_run(
                &root_dir,
                &["-c", &format!("user.name={}", name.trim()), "-c", &format!("user.email={}", email.trim()), "commit", "-m", message.trim()],
            ),
            _ => git_run(&root_dir, &["commit", "-m", message.trim()]),
        }
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

def nbval(name, value, raw=False, unit=None, err=None, sig=None):
    # Interactive runs only show the value; Compile / Run Notebooks is what writes it to the paper.
    shown = str(value) if err is None else "%s +- %s" % (value, err)
    print("%s = %s%s" % (name, shown, " " + unit if unit else ""))
    return value

def nbmath(name, expr):
    print("%s = %s" % (name, expr))
    return expr

def nbtable(name, rows, header=None):
    print("%s:" % name)
    print(rows)

ns = {"nbval": nbval, "nbmath": nbmath, "nbtable": nbtable}
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

// ---------- export: a self-contained bundle for arXiv or a journal ----------
// Publishers compile the source themselves and know nothing about notebooks, so the bundle is
// plain LaTeX: \input files inlined, \nbfig turned into \includegraphics, and every \nbval,
// \nbtable, \nbmath and \nbenv replaced by the value it currently stands for.

/// The text inside the braces opening at byte `open`, and the index just past the closing brace.
fn braced_at(text: &str, open: usize) -> Option<(&str, usize)> {
    let bytes = text.as_bytes();
    if bytes.get(open) != Some(&b'{') {
        return None;
    }
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 1, // skip the escaped character
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((&text[open + 1..i], i + 1));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// name -> LaTeX, as last written by the notebooks into scribe-values.tex.
fn exported_values(root_dir: &Path) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let text = std::fs::read_to_string(root_dir.join(VALUES_TEX)).unwrap_or_default();
    let marker = "\\csname nbval@";
    let mut rest = text.as_str();
    while let Some(at) = rest.find(marker) {
        rest = &rest[at + marker.len()..];
        let Some(end) = rest.find("\\endcsname") else { break };
        let name = rest[..end].to_string();
        let after = end + "\\endcsname".len();
        match braced_at(rest, after) {
            Some((value, next)) => {
                out.insert(name, value.to_string());
                rest = &rest[next..];
            }
            None => break,
        }
    }
    out
}

/// True when `at` in `text` sits after an unescaped % on its line.
fn in_comment(text: &str, at: usize) -> bool {
    let line = &text[text[..at].rfind('\n').map_or(0, |i| i + 1)..at];
    let bytes = line.as_bytes();
    (0..bytes.len()).any(|i| bytes[i] == b'%' && (i == 0 || bytes[i - 1] != b'\\'))
}

/// Replaces every `\command{arg}` outside comments with what `f(arg)` returns.
fn replace_command(text: &str, command: &str, mut f: impl FnMut(&str) -> String) -> String {
    let needle = format!("\\{command}{{");
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    while let Some(found) = text[from..].find(&needle) {
        let at = from + found;
        let open = at + needle.len() - 1;
        match braced_at(text, open) {
            Some((arg, end)) if !in_comment(text, at) => {
                out.push_str(&text[from..at]);
                out.push_str(&f(arg.trim()));
                from = end;
            }
            _ => {
                out.push_str(&text[from..open + 1]);
                from = open + 1;
            }
        }
    }
    out.push_str(&text[from..]);
    out
}

/// The paper as one file: \input, \include and \subfile replaced by what they point to.
fn inline_inputs(root: &str, rel: &str, depth: usize, warnings: &mut Vec<String>) -> Result<String, String> {
    let text = std::fs::read_to_string(resolve(root, rel)?).map_err(|e| format!("{rel}: {e}"))?;
    if depth > 8 {
        warnings.push(format!("{rel}: files include each other too deeply; left as it is."));
        return Ok(text);
    }
    let mut text = text;
    for command in ["input", "include", "subfile"] {
        let mut failed = Vec::new();
        text = replace_command(&text, command, |target| {
            let file = if Path::new(target).extension().is_some() { target.to_string() } else { format!("{target}.tex") };
            let file = file.trim_start_matches("./").to_string();
            match inline_inputs(root, &file, depth + 1, &mut failed) {
                Ok(inner) => format!("% --- {file} ---\n{}\n% --- end of {file} ---", inner.trim_end()),
                Err(e) => {
                    failed.push(format!("Couldn't inline {file}: {e}"));
                    format!("\\{command}{{{target}}}")
                }
            }
        });
        warnings.append(&mut failed);
    }
    Ok(text)
}

struct ExportBundle {
    /// (path inside the bundle, contents)
    files: Vec<(String, Vec<u8>)>,
    warnings: Vec<String>,
}

fn build_export(root: &str, main: &str) -> Result<ExportBundle, String> {
    let root_dir = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let mut warnings = Vec::new();
    let mut tex = inline_inputs(root, main, 0, &mut warnings)?;
    let values = exported_values(&root_dir);
    if values.is_empty() && tex.contains("\\nbval{") {
        warnings.push("No notebook values were found. Compile the paper first so they exist.".into());
    }

    // figures from notebooks become ordinary graphics
    let mut graphics: Vec<String> = Vec::new();
    tex = replace_command(&tex, "nbfig", |id| {
        graphics.push(format!("figures/{id}.pdf"));
        format!("\\includegraphics[width=\\linewidth]{{figures/{id}.pdf}}")
    });
    // values, tables and formulas become the text they stand for
    for command in ["nbval", "nbtable", "nbmath"] {
        tex = replace_command(&tex, command, |name| match values.get(name) {
            Some(value) => value.clone(),
            None => {
                warnings.push(format!("\\{command}{{{name}}} has no value; it will print as ??."));
                "\\textbf{??}".into()
            }
        });
    }
    if let Some(env) = values.get("scribe-env") {
        // \nbenv takes no argument; make sure a longer command name isn't caught
        let mut out = String::new();
        let mut rest = tex.as_str();
        while let Some(at) = rest.find("\\nbenv") {
            let after = &rest[at + 6..];
            out.push_str(&rest[..at]);
            if after.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
                out.push_str("\\nbenv");
            } else {
                out.push_str(env);
            }
            rest = after;
        }
        out.push_str(rest);
        tex = out;
    }

    // the generated package goes; graphicx (and siunitx, if the values use it) take its place
    let needs_siunitx = ["\\qty{", "\\num{", "\\unit{"].iter().any(|c| tex.contains(c)) && !tex.contains("{siunitx}");
    let mut replacement = String::from("\\usepackage{graphicx}");
    if needs_siunitx {
        replacement.push_str("\n\\usepackage{siunitx}\n\\sisetup{separate-uncertainty=true}");
    }
    for pkg in ["scribe-figures", "papyrus-figures"] {
        tex = tex.replace(&format!("\\usepackage{{{pkg}}}"), &replacement);
    }

    // graphics the paper includes directly
    let mut direct = Vec::new();
    replace_command(&tex, "includegraphics", |path| {
        direct.push(path.to_string());
        String::new()
    });
    // (\includegraphics[options]{path} has its brace after the options, which the helper above
    // doesn't see; pick those up too)
    let mut rest = tex.as_str();
    while let Some(at) = rest.find("\\includegraphics[") {
        let after = &rest[at..];
        if let Some(close) = after.find(']') {
            if let Some((path, _)) = braced_at(after, close + 1) {
                direct.push(path.trim().to_string());
            }
        }
        rest = &rest[at + 1..];
    }
    for path in direct {
        let candidates = [path.clone(), format!("{path}.pdf"), format!("{path}.png"), format!("{path}.jpg")];
        if let Some(found) = candidates.iter().find(|c| resolve(root, c).is_ok_and(|p| p.is_file())) {
            graphics.push(found.clone());
        }
    }
    graphics.sort();
    graphics.dedup();

    let stem = Path::new(main).file_stem().unwrap_or_default().to_string_lossy().to_string();
    let mut files: Vec<(String, Vec<u8>)> = vec![(format!("{stem}.tex"), tex.clone().into_bytes())];
    for graphic in graphics {
        match resolve(root, &graphic).and_then(|p| std::fs::read(p).map_err(|e| e.to_string())) {
            Ok(bytes) => files.push((graphic, bytes)),
            Err(_) => warnings.push(format!("{graphic} is missing; compile the paper to produce it.")),
        }
    }

    // bibliography: the .bib sources, any local style, and the compiled .bbl that arXiv wants
    let add_if_present = |rel: String, files: &mut Vec<(String, Vec<u8>)>| {
        if let Ok(bytes) = resolve(root, &rel).and_then(|p| std::fs::read(p).map_err(|e| e.to_string())) {
            if !files.iter().any(|(name, _)| *name == rel) {
                files.push((rel, bytes));
            }
        }
    };
    let mut bibs = Vec::new();
    replace_command(&tex, "bibliography", |list| {
        bibs.extend(list.split(',').map(|b| format!("{}.bib", b.trim().trim_end_matches(".bib"))));
        String::new()
    });
    replace_command(&tex, "addbibresource", |file| {
        bibs.push(file.to_string());
        String::new()
    });
    replace_command(&tex, "bibliographystyle", |style| {
        bibs.push(format!("{style}.bst"));
        String::new()
    });
    for bib in bibs {
        add_if_present(bib, &mut files);
    }
    if let Ok(bbl) = std::fs::read(root_dir.join(BUILD_DIR).join(format!("{stem}.bbl"))) {
        files.push((format!("{stem}.bbl"), bbl));
    }

    Ok(ExportBundle { files, warnings })
}

#[derive(Serialize)]
struct ExportReport {
    files: Vec<String>,
    warnings: Vec<String>,
}

/// Writes the submission bundle for `main` to the zip file at `dest` (chosen by the user).
#[tauri::command]
async fn export_bundle(root: String, main: String, dest: String) -> Result<ExportReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = build_export(&root, &main)?;
        let file = std::fs::File::create(&dest).map_err(|e| format!("{dest}: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in &bundle.files {
            zip.start_file(name.as_str(), options).map_err(|e| e.to_string())?;
            zip.write_all(bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(ExportReport { files: bundle.files.into_iter().map(|(name, _)| name).collect(), warnings: bundle.warnings })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- citations: BibTeX for a DOI or an arXiv ID ----------

#[derive(Serialize, Debug)]
struct Citation {
    key: String,
    bibtex: String,
}

fn http_get(url: &str, accept: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("curl");
    cmd.args(["-sL", "--max-time", "20"]);
    if let Some(accept) = accept {
        cmd.args(["-H", &format!("Accept: {accept}")]);
    }
    let out = cmd.arg(url).output().map_err(|e| format!("couldn't reach the network: {e}"))?;
    if !out.status.success() {
        return Err("Couldn't reach the server. Check the internet connection.".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// "Knuth, D. E." or "Diederik P. Kingma" plus a year -> "knuth1984".
fn citation_key(first_author: &str, year: &str) -> String {
    let last = match first_author.split_once(',') {
        Some((last, _)) => last.trim(),
        None => first_author.split_whitespace().last().unwrap_or(""),
    };
    let last: String = last.chars().filter(|c| c.is_ascii_alphabetic()).collect::<String>().to_lowercase();
    format!("{}{}", if last.is_empty() { "ref".into() } else { last }, year.trim())
}

/// Splits a BibTeX entry into its type and (name, value) fields, values without their delimiters.
fn parse_bibtex(raw: &str) -> Option<(String, Vec<(String, String)>)> {
    let raw = raw.trim();
    let open = raw.find('{')?;
    let kind = raw.strip_prefix('@')?[..open - 1].trim().to_lowercase();
    let body = &raw[open + 1..raw.rfind('}')?];
    // Fields are separated by the commas that sit outside every brace and quote.
    let mut parts = Vec::new();
    let (mut depth, mut quoted, mut start) = (0i32, false, 0usize);
    for (i, c) in body.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            '"' if depth == 0 => quoted = !quoted,
            ',' if depth == 0 && !quoted => {
                parts.push(&body[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&body[start..]);
    let fields = parts
        .into_iter()
        .skip(1) // the citation key
        .filter_map(|part| {
            let (name, value) = part.split_once('=')?;
            let value = value.trim();
            let value = value
                .strip_prefix('{')
                .and_then(|v| v.strip_suffix('}'))
                .or_else(|| value.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
                .unwrap_or(value);
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    Some((kind, fields))
}

fn format_bibtex(kind: &str, key: &str, fields: &[(String, String)]) -> String {
    let width = fields.iter().map(|(name, _)| name.len()).max().unwrap_or(0);
    let lines: Vec<String> =
        fields.iter().map(|(name, value)| format!("  {name:width$} = {{{value}}}")).collect();
    format!("@{kind}{{{key},\n{}\n}}\n", lines.join(",\n"))
}

/// What doi.org returns, given our own key and laid out one field per line.
fn tidy_doi_bibtex(raw: &str) -> Result<Citation, String> {
    let (kind, mut fields) = parse_bibtex(raw).ok_or("No record was found for that DOI.")?;
    let get = |name: &str, fields: &[(String, String)]| {
        fields.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone()).unwrap_or_default()
    };
    let author = get("author", &fields);
    let key = citation_key(author.split(" and ").next().unwrap_or(""), &get("year", &fields));
    for (name, value) in fields.iter_mut() {
        if name.eq_ignore_ascii_case("pages") {
            *value = value.replace('–', "--");
        }
    }
    // Publishers' landing pages and print ISSNs add noise without helping anyone find the paper.
    fields.retain(|(name, _)| !["url", "issn", "month"].contains(&name.to_lowercase().as_str()));
    Ok(Citation { bibtex: format_bibtex(&kind, &key, &fields), key })
}

fn xml_text(xml: &str, tag: &str) -> Vec<String> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        let text = after[..end]
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'");
        out.push(text.split_whitespace().collect::<Vec<_>>().join(" "));
        rest = &after[end..];
    }
    out
}

/// A BibTeX entry built from arXiv's Atom response.
fn arxiv_bibtex(xml: &str, id: &str) -> Result<Citation, String> {
    let missing = || "arXiv has no paper with that ID.".to_string();
    let entry = &xml[xml.find("<entry>").ok_or_else(missing)?..];
    let title = xml_text(entry, "title").into_iter().next().filter(|t| !t.is_empty() && t != "Error").ok_or_else(missing)?;
    let authors = xml_text(entry, "name");
    let year: String = xml_text(entry, "published").into_iter().next().unwrap_or_default().chars().take(4).collect();
    let class = entry
        .split("primary_category")
        .nth(1)
        .and_then(|rest| rest.split("term=\"").nth(1))
        .and_then(|rest| rest.split('"').next())
        .unwrap_or("");
    let bare = id.split('v').next().unwrap_or(id); // cite the paper, not one revision of it
    let key = citation_key(authors.first().map(String::as_str).unwrap_or(""), &year);
    let mut fields = vec![
        ("author".to_string(), authors.join(" and ")),
        ("title".to_string(), title),
        ("year".to_string(), year),
        ("eprint".to_string(), bare.to_string()),
        ("archivePrefix".to_string(), "arXiv".to_string()),
    ];
    if !class.is_empty() {
        fields.push(("primaryClass".to_string(), class.to_string()));
    }
    Ok(Citation { bibtex: format_bibtex("misc", &key, &fields), key })
}

enum PaperId {
    Doi(String),
    Arxiv(String),
}

/// Recognises a DOI or an arXiv ID however it was pasted: bare, as a URL, or with a prefix.
fn classify_paper_id(input: &str) -> Option<PaperId> {
    let mut id = input.trim();
    for prefix in ["https://", "http://", "dx.doi.org/", "doi.org/", "www.", "arxiv.org/abs/", "arxiv.org/pdf/", "doi:", "DOI:", "arXiv:", "arxiv:"] {
        id = id.strip_prefix(prefix).unwrap_or(id);
    }
    let id = id.trim().trim_end_matches(".pdf");
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let unversioned = id.rsplit_once('v').filter(|(_, v)| digits(v)).map(|(base, _)| base).unwrap_or(id);
    // new style 1412.6980, old style hep-th/9901001
    let new_style = unversioned.split_once('.').is_some_and(|(a, b)| a.len() == 4 && digits(a) && (4..=5).contains(&b.len()) && digits(b));
    let old_style = unversioned.split_once('/').is_some_and(|(a, b)| !a.starts_with("10.") && a.chars().all(|c| c.is_ascii_alphabetic() || c == '-' || c == '.') && b.len() == 7 && digits(b));
    if new_style || old_style {
        return Some(PaperId::Arxiv(id.to_string()));
    }
    (id.starts_with("10.") && id.contains('/')).then(|| PaperId::Doi(id.to_string()))
}

/// Looks a paper up online and returns a BibTeX entry for it. Needs an internet connection.
#[tauri::command]
async fn fetch_bibtex(id: String) -> Result<Citation, String> {
    tauri::async_runtime::spawn_blocking(move || match classify_paper_id(&id) {
        Some(PaperId::Doi(doi)) => tidy_doi_bibtex(&http_get(&format!("https://doi.org/{doi}"), Some("application/x-bibtex"))?),
        Some(PaperId::Arxiv(arxiv)) => {
            arxiv_bibtex(&http_get(&format!("https://export.arxiv.org/api/query?id_list={arxiv}"), None)?, &arxiv)
        }
        None => Err("That doesn't look like a DOI (10.1234/…) or an arXiv ID (1412.6980).".into()),
    })
    .await
    .map_err(|e| e.to_string())?
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

// ---------- submission check: file sizes ----------

#[derive(Serialize)]
struct FileSize {
    rel: String,
    bytes: u64,
}

#[tauri::command]
fn file_sizes(root: String) -> Result<Vec<FileSize>, String> {
    let base = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    Ok(list_files(root)?
        .into_iter()
        .map(|rel| FileSize { bytes: std::fs::metadata(base.join(&rel)).map(|m| m.len()).unwrap_or(0), rel })
        .collect())
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
            list_files, list_dirs, create_dir, rename_path, delete_path, import_files,
            read_file, write_file, read_binary, compile,
            parse_notebook, run_notebook, generate_style,
            git_status, git_branch, git_overview, git_diff, git_commit, git_push, git_init, git_identity, search_project, read_settings, write_settings,
            kernel_start, kernel_run_cell, kernel_stop,
            spell_available, spell_check, spell_suggest, spell_learn, fetch_bibtex, export_bundle, write_binary,
            history_list, history_read, history_diff,             python_bin, check_tools, pty_start, pty_write, pty_resize, pty_kill,
            python_bin, check_tools, pty_start, pty_write, pty_resize, pty_kill,
            synctex_edit, synctex_view
        ])
        .run(tauri::generate_context!())
        .expect("error while running Scribe");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests that run the example's notebook or compile it share one folder; take turns.
    static EXAMPLE: Mutex<()> = Mutex::new(());

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

        let _turn = EXAMPLE.lock().unwrap_or_else(|e| e.into_inner());
        // Run notebook first to generate the figures, the results table and the values
        let run_res = run_notebook_blocking(&example(), "notebooks/experiment.py").unwrap();
        assert!(run_res.ok, "notebook failed:\n{}", run_res.log);

        // The app refreshes the generated package before every compile; do the same here.
        generate_style(example()).unwrap();
        let res = compile_blocking(&example(), "main.tex").unwrap();
        assert!(res.ok, "compile failed:\n{}", res.log);
        assert_eq!(res.pdf.as_deref(), Some("build/main.pdf"));
    }

    #[test]
    fn parses_notebook_cells() {
        let info = parse_notebook(example(), "notebooks/experiment.py".into()).unwrap();
        assert!(info.figure_ids.contains(&"fig-curves".to_string()));
        assert!(info.cells.len() >= 5); // text, three code cells, two figures
        assert!(info.figure_ids.contains(&"fig-boundary".to_string()));
        assert!(info.value_names.contains(&"best-acc".to_string()) && info.value_names.contains(&"results".to_string()));
        let fig_cell = info.cells.iter().find(|c| c.figure_id.is_some()).unwrap();
        assert_eq!(fig_cell.cell_type, "figure");
        assert_eq!(fig_cell.figure_id.as_deref(), Some("fig-curves"));
    }

    #[test]
    fn synctex_round_trip_on_example() {
        let _turn = EXAMPLE.lock().unwrap_or_else(|e| e.into_inner());
        // Needs the compiled example; build it if the other test hasn't yet.
        let _ = run_notebook_blocking(&example(), "notebooks/experiment.py");
        generate_style(example()).unwrap();
        let _ = compile_blocking(&example(), "main.tex").unwrap();
        let Ok(spot) = synctex_view(example(), "build/main.pdf".into(), "main.tex".into(), 20) else {
            return; // no synctex binary on this machine
        };
        assert_eq!(spot.page, 1);
        assert!(spot.width > 0.0 && spot.y > 0.0);
        let back = synctex_edit(example(), "build/main.pdf".into(), 1, spot.x + 5.0, spot.y + 2.0).unwrap();
        assert_eq!(back.file, "main.tex");
        assert!((13..=24).contains(&back.line), "landed on line {}", back.line); // somewhere in the abstract
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
        assert!(tauri::async_runtime::block_on(git_commit(root.clone(), "  ".into(), None, None)).is_err());
        tauri::async_runtime::block_on(git_commit(root.clone(), "First".into(), Some("Ada Lovelace".into()), Some("ada@example.org".into()))).unwrap();
        assert_eq!(git_text(&root_dir, &["log", "-1", "--pretty=%an <%ae>"]).as_deref(), Some("Ada Lovelace <ada@example.org>"));
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
    fn imports_files_without_overwriting() {
        let base = std::env::temp_dir().join(format!("scribe-import-{}", std::process::id()));
        let project = base.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let outside = base.join("plot.png");
        std::fs::write(&outside, b"one").unwrap();
        let root = project.to_string_lossy().to_string();
        let src = vec![outside.to_string_lossy().to_string()];

        assert_eq!(import_files(root.clone(), "figures".into(), src.clone()).unwrap(), ["figures/plot.png"]);
        std::fs::write(&outside, b"two").unwrap();
        assert_eq!(import_files(root.clone(), "figures".into(), src.clone()).unwrap(), ["figures/plot 2.png"]);
        assert_eq!(std::fs::read(project.join("figures/plot.png")).unwrap(), b"one"); // first copy untouched
        assert!(import_files(root.clone(), "../elsewhere".into(), src).is_err());

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn export_is_plain_latex_that_compiles_on_its_own() {
        let _turn = EXAMPLE.lock().unwrap_or_else(|e| e.into_inner());
        if run_notebook_blocking(&example(), "notebooks/experiment.py").map(|r| r.ok) != Ok(true) {
            return; // no Python with matplotlib here
        }
        generate_style(example()).unwrap();
        let _ = compile_blocking(&example(), "main.tex"); // produces the .bbl

        let bundle = build_export(&example(), "main.tex").unwrap();
        let names: Vec<&str> = bundle.files.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"main.tex") && names.contains(&"figures/fig-curves.pdf") && names.contains(&"refs.bib"), "{names:?}");
        assert!(!names.iter().any(|n| n.ends_with(".py") || n.ends_with(".sty")), "{names:?}");
        let tex = String::from_utf8(bundle.files[0].1.clone()).unwrap();
        // nothing of Scribe's is left for a publisher's TeX to trip over
        for gone in ["\\nbval", "\\nbfig", "\\nbtable", "\\nbmath", "\\nbenv", "\\input{", "scribe-figures"] {
            assert!(!tex.contains(gone), "{gone} survived the export");
        }
        assert!(tex.contains("\\includegraphics[width=\\linewidth]{figures/fig-curves.pdf}"));
        assert!(tex.contains("\\begin{tabular}") && tex.contains("\\usepackage{siunitx}"));
        assert!(tex.contains("\\section{Method}"), "sections were not inlined");
        assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);

        // and it builds in an empty folder
        let dir = std::env::temp_dir().join(format!("scribe-export-{}", std::process::id()));
        for (name, bytes) in &bundle.files {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        let res = compile_blocking(&dir.to_string_lossy(), "main.tex").unwrap();
        assert!(res.ok, "the exported paper did not compile:\n{}", res.log);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn builds_citations_from_doi_and_arxiv_responses() {
        // what doi.org answered for Knuth's paper
        let doi = " @article{Knuth_1984, title={Literate Programming}, volume={27}, ISSN={1460-2067}, url={http://dx.doi.org/10.1093/comjnl/27.2.97}, DOI={10.1093/comjnl/27.2.97}, number={2}, journal={The Computer Journal}, publisher={Oxford University Press (OUP)}, author={Knuth, D. E.}, year={1984}, month=Feb, pages={97–111} }";
        let c = tidy_doi_bibtex(doi).unwrap();
        assert_eq!(c.key, "knuth1984");
        assert!(c.bibtex.starts_with("@article{knuth1984,\n"), "{}", c.bibtex);
        assert!(c.bibtex.contains("title     = {Literate Programming}") && c.bibtex.contains("pages     = {97--111}"), "{}", c.bibtex);
        assert!(!c.bibtex.contains("ISSN") && !c.bibtex.contains("url"), "{}", c.bibtex);
        assert!(tidy_doi_bibtex("<html>DOI Not Found</html>").is_err());

        let atom = "<feed><title>arXiv Query</title><entry><id>http://arxiv.org/abs/1412.6980v9</id>\n<title>Adam: A Method for\n  Stochastic Optimization</title><published>2014-12-22T13:54:29Z</published><author><name>Diederik P. Kingma</name></author><author><name>Jimmy Ba</name></author><arxiv:primary_category term=\"cs.LG\"/></entry></feed>";
        let c = arxiv_bibtex(atom, "1412.6980v9").unwrap();
        assert_eq!(c.key, "kingma2014");
        assert!(c.bibtex.contains("author        = {Diederik P. Kingma and Jimmy Ba}"), "{}", c.bibtex);
        assert!(c.bibtex.contains("title         = {Adam: A Method for Stochastic Optimization}"), "{}", c.bibtex);
        assert!(c.bibtex.contains("eprint        = {1412.6980}") && c.bibtex.contains("primaryClass  = {cs.LG}"), "{}", c.bibtex);
        assert!(arxiv_bibtex("<feed><title>arXiv Query</title></feed>", "0000.00000").is_err());

        assert!(matches!(classify_paper_id("https://doi.org/10.1093/comjnl/27.2.97"), Some(PaperId::Doi(d)) if d == "10.1093/comjnl/27.2.97"));
        assert!(matches!(classify_paper_id("arXiv:1412.6980v9"), Some(PaperId::Arxiv(a)) if a == "1412.6980v9"));
        assert!(matches!(classify_paper_id("https://arxiv.org/abs/hep-th/9901001"), Some(PaperId::Arxiv(_))));
        assert!(classify_paper_id("knuth 1984").is_none());
    }

    #[test]
    fn exports_values_to_the_paper() {
        let dir = std::env::temp_dir().join(format!("scribe-values-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("notebooks")).unwrap();
        let root = dir.to_string_lossy().to_string();
        let nb = "# %%\nSEED = 7\nacc = 0.9423\nnbval(\"accuracy\", f\"{acc:.1%}\")\nnbval('n_samples', 1200)\nnbval(\"mass\", 3.2141e-5, unit=\"kg\", err=0.042e-5)\nnbval(\"g\", 9.8123, err=0.0162, unit=\"m/s^2\")\nnbval(\"big\", 12345.6, err=120)\nnbval(\"pi\", 3.14159265, sig=3)\nnbmath(\"law\", r\"E = mc^2\")\n\n# %%\nnbtable(\"results\", [[\"a_b\", 1, (0.957, 0.0042)], [\"c\", 2, (0.9, 0.013)]], header=[\"Name\", \"N\", \"Acc\"])\n";
        write_file(root.clone(), "notebooks/stats.py".into(), nb.into()).unwrap();

        let info = parse_notebook(root.clone(), "notebooks/stats.py".into()).unwrap();
        assert_eq!(info.value_names, ["accuracy", "n_samples", "mass", "g", "big", "pi", "law", "results"]);
        assert!(info.stale.contains(&"values".to_string()));

        let Ok(res) = run_notebook_blocking(&root, "notebooks/stats.py") else { return }; // no python here
        if res.log.contains("No module named 'matplotlib'") {
            return;
        }
        assert!(res.ok, "{}", res.log);
        let tex = std::fs::read_to_string(dir.join("scribe-values.tex")).unwrap();
        assert!(tex.contains(r"\long\expandafter\def\csname nbval@accuracy\endcsname{94.2\%}"), "{tex}");
        assert!(tex.contains(r"nbval@n_samples\endcsname{1200}"));
        // measurements: uncertainty to one figure (two if it starts with 1), value to match
        assert!(tex.contains(r"nbval@mass\endcsname{\qty{3.21 +- 0.04 e-5}{kg}}"), "{tex}");
        assert!(tex.contains(r"nbval@g\endcsname{\qty{9.812 +- 0.016}{m/s^2}}"), "{tex}");
        assert!(tex.contains(r"nbval@big\endcsname{\num{12350 +- 120}}"), "{tex}");
        assert!(tex.contains(r"nbval@pi\endcsname{\num{3.14}}"), "{tex}");
        assert!(tex.contains(r"nbval@law\endcsname{E = mc^2}"), "{tex}");
        assert!(tex.contains(r"\RequirePackage{siunitx}"), "{tex}");
        // tables: numbers right-aligned, (value, uncertainty) cells written out
        assert!(tex.contains(r"\begin{tabular}{lrr}"), "{tex}");
        assert!(tex.contains(r"a\_b & 1 & $0.957 \pm 0.004$ \\"), "{tex}");
        assert!(tex.contains(r"c & 2 & $0.900 \pm 0.013$ \\"), "{tex}");
        // the run is recorded for \nbenv
        assert!(tex.contains("nbval@scribe-env") && tex.contains("Random seed & 7"), "{tex}");
        let runs = std::fs::read_to_string(dir.join(".scribe/runs.json")).unwrap();
        assert!(runs.contains("\"python\"") && runs.contains("\"seed\": \"7\""), "{runs}");
        let fresh = parse_notebook(root.clone(), "notebooks/stats.py".into()).unwrap();
        assert!(fresh.stale.is_empty(), "{:?}", fresh.stale);

        // The generated package defines \nbval, and an older generated one is upgraded in place.
        std::fs::write(dir.join("papyrus-figures.sty"), "% Auto-generated by Papyrus. Do not edit.\n").unwrap();
        generate_style(root.clone()).unwrap();
        let sty = std::fs::read_to_string(dir.join("papyrus-figures.sty")).unwrap();
        assert!(sty.contains(r"\ProvidesPackage{papyrus-figures}") && sty.contains(r"\newcommand{\nbenv}"));
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
    fn saves_keep_versions_grouped_by_sitting() {
        let base = std::env::temp_dir().join(format!("scribe-history-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let root = base.to_string_lossy().to_string();
        std::fs::write(base.join("paper.tex"), "first draft\n").unwrap();
        write_file(root.clone(), "paper.tex".into(), "second\n".into()).unwrap();
        write_file(root.clone(), "paper.tex".into(), "third\n".into()).unwrap();
        let root_dir = base.canonicalize().unwrap();
        let ids = history_ids(&root_dir, "paper.tex");
        // the file as it was before Scribe saved it, then one version for this sitting
        assert_eq!(ids.len(), 2, "{ids:?}");
        assert_eq!(history_read(root.clone(), "paper.tex".into(), ids[0]).unwrap(), "first draft\n");
        assert_eq!(history_read(root.clone(), "paper.tex".into(), ids[1]).unwrap(), "third\n");
        let diff = history_diff(root.clone(), "paper.tex".into(), ids[0], "third\n".into()).unwrap();
        assert!(diff.contains("-first draft") && diff.contains("+third"), "{diff}");
        // other files and generated data keep no history
        write_file(root.clone(), "data.csv".into(), "1,2\n".into()).unwrap();
        assert!(history_ids(&root_dir, "data.csv").is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn percent_decoding_round_trips_paths() {
        assert_eq!(percent_decode("notes/%CE%9C%CE%AC%CE%B8%CE%B7%CE%BC%CE%B1%201.md").unwrap(), "notes/Μάθημα 1.md");
        assert_eq!(percent_decode("plain/path.png").unwrap(), "plain/path.png");
        assert!(percent_decode("%zz").is_err());
    }

    #[test]
    fn text_cells_lose_their_comment_marks_once() {
        let cells = parse_cells("# %% [markdown]\n# # Title\n#\n# Some $x^2$ text.\n\n# %%\n# a real comment\nx = 1\n");
        assert_eq!(cells[0].source, "# Title\n\nSome $x^2$ text."); // a Markdown heading survives
        assert_eq!(cells[1].source, "# a real comment\nx = 1"); // code comments are left alone
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
            Path::new(&example()).join("notebooks/experiment.py")
        ).unwrap();
        let cells = parse_cells(&source);
        let script = build_runner_script(&cells, "notebooks/experiment.py");
        assert!(script.contains("_scribe_finish(\"notebooks/experiment.py\")"));
        assert!(script.contains("matplotlib.use('pdf')"));
        assert!(script.contains("plt.savefig('figures/fig-curves.pdf'"));
        assert!(script.contains("plt.close()"));
    }

    #[test]
    fn stale_detection() {
        let info = parse_notebook(example(), "notebooks/experiment.py".into()).unwrap();
        // stale = figure missing OR notebook newer than figure
        // After a test run, fig-curves.pdf may exist, so just check the field is populated correctly
        assert!(info.figure_ids.contains(&"fig-curves".to_string()));
        // If we touch the notebook, it should become stale
        let nb = Path::new(&example()).join("notebooks/experiment.py");
        let _ = std::fs::OpenOptions::new().append(true).open(&nb); // updates mtime
        let info2 = parse_notebook(example(), "notebooks/experiment.py".into()).unwrap();
        // Either stale or figure_ids should contain fig-curves
        assert!(info2.figure_ids.contains(&"fig-curves".to_string()));
    }
}
