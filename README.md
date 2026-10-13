# Papyrus

Desktop LaTeX + Python editor where notebook figures flow straight into the paper.

**Status: step 1 of 4** — local editor, compile, PDF preview.

## Run

Prerequisites: Node 20+, Rust (stable), Tauri system deps
([tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)), and a TeX engine:

- **Tectonic** (recommended, self-contained): `cargo install tectonic` or your package manager
- or TeX Live / MiKTeX with `latexmk` (used automatically if Tectonic is missing)

```bash
npm install
npm run tauri dev        # dev window with hot reload
npm run tauri build      # installer for your OS
```

Open the `example/` folder, then `Ctrl+Enter` to compile, `Ctrl+S` to save.

## Layout

```
src/                 frontend (Vite + TS)
  main.ts            CodeMirror editor, file tree, pdf.js preview
src-tauri/src/lib.rs backend: sandboxed file IO + compile (tectonic → latexmk)
example/             sample paper + Jupytext notebook
```

Every backend command takes `(root, rel)` and rejects paths escaping the project
root, including via symlinks. Compile output goes to `<project>/build/` with SyncTeX.

## Roadmap

1. ✅ Editor, compile, PDF preview
2. Jupyter kernel + `# %% [figure: id]` cells → `figures/id.pdf`, `\nbfig{id}`, stale tracking, SyncTeX click-through
3. Yjs real-time collaboration + self-hosted sync server + auth
4. Web mode with sandboxed remote compile/kernels

## Tests

```bash
cd src-tauri && cargo test   # path-escape checks + compiles example/main.tex
```
