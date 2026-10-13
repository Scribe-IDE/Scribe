//! Papyrus backend: project file access and LaTeX compilation.
//!
//! Every command takes the project `root` plus a path relative to it, and
//! `resolve` rejects anything that escapes the root (`..`, absolute paths,
//! symlinks pointing outside). That boundary matters once projects are shared.

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
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
    let tmp = path.with_extension("papyrus-tmp");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![list_files, read_file, write_file, read_binary, compile])
        .run(tauri::generate_context!())
        .expect("error while running Papyrus");
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
    fn lists_and_compiles_example() {
        let files = list_files(example()).unwrap();
        assert!(files.contains(&"main.tex".to_string()));
        let res = compile_blocking(&example(), "main.tex").unwrap();
        assert!(res.ok, "compile failed:\n{}", res.log);
        assert_eq!(res.pdf.as_deref(), Some("build/main.pdf"));
    }
}
