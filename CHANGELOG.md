# Changelog

Each version's notes become its release notes on GitHub.

## 1.2.2

- The compile shortcut works with the cursor in the editor again, instead of adding a blank line.
- On Windows and Linux, shortcuts are shown as Ctrl+… instead of with the Mac's symbols, and the
  title bar no longer leaves room for window buttons that aren't there.
- Linux AppImage: notebooks run with your own Python again, instead of stopping at
  "No module named 'encodings'".
- After an update, Scribe shows what changed. Help > What's New shows it again.

## 1.2.1

- macOS: the app is signed as a whole, so a downloaded copy can be opened with Open Anyway in
  System Settings > Privacy & Security instead of being reported as damaged.
- The welcome screen and About show the right version.

## 1.2.0

- Track changes and comments, kept in the source with the `changes` package: typing and deleting
  are marked as you go, comments sit in the margin of the PDF, and the Review panel accepts or
  rejects each one.
- Shorter menus, with Insert, Review and Notes menus of their own.

## 1.1.0

The first release.

- An assistant with the model of your choice (Claude, GPT, Gemini, any OpenAI-compatible
  service, or Ollama on this computer): a chat that knows the paper, edits to the selection
  reviewed word by word, fixes for compile errors, and suggestions as you type. Keys stay in the
  system keychain.
- A LaTeX editor that knows the paper: completion for labels, citations, figures and notebook
  values; hover cards for `\ref`, `\cite` and `\nbval`; writing checks with fixes; snippets; a
  visual equation editor; tables edited as a grid.
- Python notebooks (`# %%` files and `.ipynb`) whose figures and numbers go straight into the
  paper, rerun when they change.
- Compiles on your machine with Tectonic or TeX Live, as you type if you like; errors explained
  in plain words; SyncTeX both ways.
- TikZ previewed as you type, with points, nodes and shapes drawn and moved on a grid.
- Compare the paper with an earlier version (latexdiff), and a letter to answer the reviewers.
- References from a DOI, an arXiv ID or Zotero; a check before submitting; an export for arXiv.
- Notes with maths, a PDF reader with highlights, revision cards.
- Themes, your own themes, editor fonts, PDFs in the dark, a focus mode.
