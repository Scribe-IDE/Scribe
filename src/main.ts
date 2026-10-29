/// <reference types="vite/client" />
import "@fontsource-variable/albert-sans";
import "@fontsource/playfair-display/700.css";
import { EditorView } from "codemirror";
import { redo, selectAll, toggleComment, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { allCommands, formatKeys, installKeybindings, isEnabled, register, runCommand } from "./commands";
import { COMMAND_ICONS, ICONS } from "./icons";
import { createMenubar, MenuEntry, openContextMenu } from "./menubar";
import { closePalette, openPalette } from "./palette";
import { compile, runNotebook, saveFile } from "./build";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { $, baseName, current, logEl, logPanel, mainFile, PAGE, root, setLogView, setStatus, showLog, statusEl, VIEWABLE } from "./core";
import { view } from "./editor";
import { sizes, togglePane } from "./layout";
import { activeCell, cellRunners, isNotebook, restartKernel } from "./notebook";
import { closeProject, listFiles, openFile, openFolder, openProject } from "./project";
import { canShowInPdf, focusPdfFind, goToSelectionSource, hasPdf, hasPdfSelection, lastPdf, rerenderPdfSoon, showInPdf, zoomPdf } from "./preview";
import { refreshEditors, setCompileOnSave, setCompileOnType, settings, toggleSettings, updateSettings, zoom } from "./settings";
import { appearance, appearanceListeners, applyAppearance, isDark, updateAppearance } from "./appearance";
import { focusOn, toggleFocus } from "./focus";
import { editEquation } from "./equation";
import { openSnippetEditor } from "./snippets";
import { initAppearanceControls, openThemeEditor, renderAppearanceControls, useThemeOfKind } from "./themeeditor";
import { showOutline } from "./outline";
import { deleteEntry, newFile, newFolder, quickOpen, renameEntry, showSidebar, uploadFiles } from "./sidebar";
import iconUrl from "../src-tauri/icons/icon.svg?url";
import { addCitation, addFromZotero } from "./cite";
import { exportForAnki, reviewCards } from "./cards";
import { checkBeforeSubmitting } from "./check";
import { newSketch } from "./sketch";
import { editTable } from "./tables";
import { previewTikz } from "./tikz";
import { PICTURE_FILE } from "./tikzsource";
import { insertTikzPicture } from "./tikzwrite";
import { startTour } from "./tour";
import { copyAsLatex, exportNotePdf, isNote, newNote, notePrefs, quickNote, refreshNotes, todaysNote } from "./notes";
import { activeEditor, closeSide, openToSide, sideOpen } from "./split";
import { loadProfile } from "./profile";
import { renderProblemCount } from "./statusbar";
import { closeTab, openTabs } from "./tabs";
import { canRunFile, runFile, shellAlive, showTerminal, stopTerminal, termPanel } from "./terminal";
import { getRecent, importProject, installLatex, newProject, renderRecent, renderSetup, renderShortcuts, setRecent, startTypewriter } from "./welcome";

// ---------- log ----------
function toggleLog() {
  if (logPanel.hidden && !logEl.textContent) {
    $("log-title").textContent = "Log";
    logEl.textContent = "Nothing has run yet. Compile the paper or run a notebook to see its output here.";
    setLogView("output");
  }
  logPanel.hidden = !logPanel.hidden;
}

// ---------- edit commands ----------
// Menus keep focus where it was, so the focused element is still the edit target.
type TextField = HTMLTextAreaElement | HTMLInputElement;

function focusedField(): TextField | null {
  const a = document.activeElement;
  return a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && a.type === "text") ? a : null;
}

const editorVisible = () => !!current && !$("editor").hidden;

// The CodeMirror instance edit commands should act on: the main editor, or the active notebook cell.
const targetView = activeEditor;

const canEdit = () => !!focusedField() || !!targetView();

function editAction(inEditor: (target: EditorView) => void, nativeCommand: string) {
  const target = targetView();
  if (focusedField()) {
    document.execCommand(nativeCommand);
  } else if (target) {
    target.focus();
    inEditor(target);
  }
}

async function pasteFromClipboard() {
  const field = focusedField();
  const target = targetView();
  const text = await readText();
  if (!text) return;
  if (field) {
    field.setRangeText(text, field.selectionStart ?? 0, field.selectionEnd ?? 0, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (target) {
    target.dispatch(target.state.replaceSelection(text), { scrollIntoView: true });
    target.focus();
  }
}

// ---------- commands ----------
const hasProject = () => !!root;
const hasFile = () => !!current;

register(
  { id: "file.new", group: "File", title: "New File…", run: () => newFile(), enabled: hasProject },
  { id: "file.newNotebook", group: "File", title: "New Notebook…", run: () => newFile("", "notebooks/untitled.ipynb"), enabled: hasProject },
  { id: "file.newFolder", group: "File", title: "New Folder…", run: () => newFolder(), enabled: hasProject },
  { id: "file.rename", group: "File", title: "Rename…", run: () => renameEntry(current!, false), enabled: hasFile },
  { id: "file.trash", group: "File", title: "Move to Trash", run: () => deleteEntry(current!, false), enabled: hasFile },
  { id: "file.newNote", group: "File", title: "New Note…", run: newNote, enabled: hasProject },
  { id: "file.todaysNote", group: "File", title: "Today's Note", keys: "Mod-Alt-t", run: todaysNote, enabled: hasProject },
  { id: "file.quickNote", group: "File", title: "Quick Note…", keys: "Mod-Alt-n", run: quickNote, enabled: hasProject },
  { id: "file.notePdf", group: "File", title: "Export Note as PDF", run: exportNotePdf, enabled: () => isNote(activeEditor()?.dom.dataset.path) },
  { id: "file.open", group: "File", title: "Open Project…", keys: "Mod-o", run: openFolder },
  { id: "file.import", group: "File", title: "Import from Overleaf or Git…", run: importProject },
  { id: "file.newProject", group: "File", title: "New Project…", run: newProject },
  { id: "file.save", group: "File", title: "Save", keys: "Mod-s", run: saveFile, enabled: () => !!current && !VIEWABLE.test(current) && !/\.(csv|tsv)$/i.test(current) },
  {
    id: "file.reveal", group: "File", title: "Reveal in Finder", enabled: hasProject,
    run: () => revealItemInDir(current ? `${root}/${current}` : root!),
  },
  {
    // With no tab left, ⌘W does what it does everywhere else on a Mac.
    id: "file.closeTab", group: "File", title: "Close Tab", keys: "Mod-w",
    run: () => (current ? closeTab(current) : openTabs.length ? closeTab(openTabs[0]) : getCurrentWindow().close()),
  },
  { id: "file.export", group: "File", title: "Export for Submission…", run: exportForSubmission, enabled: hasProject },
  { id: "file.close", group: "File", title: "Close Project", run: closeProject, enabled: hasProject },

  { id: "edit.undo", group: "Edit", title: "Undo", keys: "Mod-z", passive: true, enabled: canEdit, run: () => editAction(undo, "undo") },
  { id: "edit.redo", group: "Edit", title: "Redo", keys: "Mod-Shift-z", passive: true, enabled: canEdit, run: () => editAction(redo, "redo") },
  { id: "edit.cut", group: "Edit", title: "Cut", keys: "Mod-x", passive: true, enabled: canEdit, run: () => editAction(() => document.execCommand("cut"), "cut") },
  { id: "edit.copy", group: "Edit", title: "Copy", keys: "Mod-c", passive: true, enabled: canEdit, run: () => editAction(() => document.execCommand("copy"), "copy") },
  { id: "edit.paste", group: "Edit", title: "Paste", keys: "Mod-v", passive: true, enabled: canEdit, run: pasteFromClipboard },
  { id: "edit.selectAll", group: "Edit", title: "Select All", keys: "Mod-a", passive: true, enabled: canEdit, run: () => editAction(selectAll, "selectAll") },
  {
    id: "edit.find", group: "Edit", title: "Find", keys: "Mod-f", enabled: editorVisible,
    run: () => { view.focus(); openSearchPanel(view); },
  },
  { id: "edit.findInProject", group: "Edit", title: "Find in Project", keys: "Mod-Shift-f", enabled: hasProject, run: () => showSidebar("search") },
  {
    id: "edit.comment", group: "Edit", title: "Toggle Comment", keys: "Mod-/", enabled: () => !!targetView(),
    run: () => editAction(toggleComment, "none"),
  },

  { id: "view.palette", group: "View", title: "Command Palette…", keys: "Mod-Shift-p", run: commandPalette },
  { id: "view.quickOpen", group: "View", title: "Go to File…", keys: "Mod-p", run: quickOpen, enabled: hasProject },
  { id: "view.files", group: "View", title: "Show Files", enabled: hasProject, run: () => showSidebar("files") },
  { id: "view.figures", group: "View", title: "Show Figures", enabled: hasProject, run: () => showSidebar("figures") },
  { id: "view.outline", group: "View", title: "Show Outline", enabled: hasProject, run: () => { showSidebar("files"); showOutline(true); } },
  { id: "view.references", group: "View", title: "Show References", enabled: hasProject, run: () => showSidebar("references") },
  { id: "view.symbols", group: "View", title: "Show Symbols", enabled: hasProject, run: () => showSidebar("symbols") },
  { id: "edit.cite", group: "Edit", title: "Add Citation by DOI or arXiv ID…", keys: "Mod-Shift-c", enabled: hasProject, run: addCitation },
  { id: "view.math", group: "View", title: "Maths Preview", enabled: hasProject, checked: () => settings.mathPreview, run: () => updateSettings({ mathPreview: !settings.mathPreview }) },
  { id: "view.notes", group: "View", title: "Show Notes", enabled: hasProject, run: () => showSidebar("notes") },
  {
    id: "view.livePreview", group: "View", title: "Render Maths in Notes", enabled: hasProject, checked: () => notePrefs.live,
    run: () => { notePrefs.live = !notePrefs.live; refreshNotes(view, activeEditor()); },
  },
  { id: "edit.copyLatex", group: "Edit", title: "Copy Note as LaTeX", enabled: () => isNote(activeEditor()?.dom.dataset.path), run: copyAsLatex },
  { id: "view.history", group: "View", title: "Show History", enabled: hasProject, run: () => showSidebar("history") },
  { id: "edit.zotero", group: "Edit", title: "Cite from Zotero…", enabled: hasProject, run: addFromZotero },
  { id: "build.check", group: "Build", title: "Check Before Submitting", enabled: hasProject, run: checkBeforeSubmitting },
  { id: "build.installLatex", group: "Build", title: "Install LaTeX (Tectonic)…", run: installLatex },
  { id: "view.review", group: "View", title: "Show Review", enabled: hasProject, run: () => showSidebar("review") },
  { id: "file.upload", group: "File", title: "Upload Files…", enabled: hasProject, run: () => uploadFiles() },
  { id: "view.git", group: "View", title: "Show Git", enabled: hasProject, run: () => showSidebar("git") },
  { id: "view.openSide", group: "View", title: "Open to the Side…", enabled: hasProject, run: pickSideFile },
  { id: "view.closeSide", group: "View", title: "Close Side Pane", enabled: sideOpen, run: closeSide },
  { id: "view.pdfZoomIn", group: "View", title: "Zoom In PDF", enabled: hasPdf, run: () => zoomPdf(1.2) },
  { id: "view.pdfZoomOut", group: "View", title: "Zoom Out PDF", enabled: hasPdf, run: () => zoomPdf(1 / 1.2) },
  { id: "view.pdfFit", group: "View", title: "Fit PDF to Width", enabled: hasPdf, run: () => zoomPdf("fit") },
  { id: "view.pdfFind", group: "View", title: "Find in PDF", keys: "Mod-Shift-g", enabled: hasPdf, run: focusPdfFind },
  { id: "view.sidebar", group: "View", title: "Toggle Sidebar", keys: "Mod-b", enabled: hasProject, checked: () => !sizes.hideSidebar, run: () => togglePane("sidebar") },
  { id: "view.preview", group: "View", title: "Toggle Preview", enabled: hasProject, checked: () => !sizes.hidePreview, run: () => togglePane("preview") },
  { id: "view.log", group: "View", title: "Toggle Log", keys: "Mod-j", enabled: hasProject, checked: () => !logPanel.hidden, run: toggleLog },
  { id: "view.spell", group: "View", title: "Spell Check", enabled: hasProject, checked: () => settings.spellCheck, run: () => updateSettings({ spellCheck: !settings.spellCheck }) },
  { id: "view.vim", group: "View", title: "Vim Keys", enabled: hasProject, checked: () => settings.vim, run: () => updateSettings({ vim: !settings.vim }) },
  {
    id: "view.relativeNumbers", group: "View", title: "Relative Line Numbers", enabled: hasProject,
    checked: () => settings.lineNumbers === "relative",
    run: () => updateSettings({ lineNumbers: settings.lineNumbers === "relative" ? "absolute" : "relative" }),
  },
  { id: "view.zoomIn", group: "View", title: "Zoom In", keys: "Mod-=", enabled: hasProject, run: () => zoom(1) },
  { id: "view.zoomOut", group: "View", title: "Zoom Out", keys: "Mod-Minus", enabled: hasProject, run: () => zoom(-1) },
  { id: "view.zoomReset", group: "View", title: "Reset Zoom", keys: "Mod-0", enabled: hasProject, run: () => zoom("reset") },
  { id: "view.themeDark", group: "View", title: "Dark Theme", checked: () => appearance.theme !== "system" && isDark(), run: () => useThemeOfKind("dark") },
  { id: "view.themeLight", group: "View", title: "Light Theme", checked: () => appearance.theme !== "system" && !isDark(), run: () => useThemeOfKind("light") },
  { id: "view.themeSystem", group: "View", title: "Match the System", checked: () => appearance.theme === "system", run: () => updateAppearance({ theme: "system" }).then(renderAppearanceControls) },
  { id: "view.themeEdit", group: "View", title: "Edit Theme…", run: openThemeEditor },
  { id: "view.focus", group: "View", title: "Focus Mode", keys: "Mod-Alt-f", enabled: () => !!current && !$("editor").hidden, checked: focusOn, run: () => toggleFocus() },
  { id: "view.pdfDark", group: "View", title: "Dark PDF", checked: () => appearance.pdfDark, run: toggleDarkPdf },

  { id: "build.compile", group: "Build", title: "Compile", keys: "Mod-Enter", enabled: hasProject, run: compile },
  { id: "build.runNotebooks", group: "Build", title: "Run Notebooks", keys: "Mod-Shift-Enter", enabled: hasProject, run: runNotebook },
  {
    id: "build.runCell", group: "Build", title: "Run Cell", keys: "Shift-Enter", passive: true,
    enabled: () => isNotebook() && !!cellRunners[activeCell],
    run: () => cellRunners[activeCell]?.(),
  },
  { id: "build.restartKernel", group: "Build", title: "Restart Kernel", enabled: hasProject, run: restartKernel },
  { id: "build.runFile", group: "Build", title: "Run Python File", keys: "Mod-r", enabled: canRunFile, run: runFile },
  { id: "build.stop", group: "Build", title: "Interrupt Terminal (Ctrl+C)", enabled: () => shellAlive, run: stopTerminal },
  {
    id: "view.terminal", group: "View", title: "Toggle Terminal", enabled: hasProject, checked: () => !termPanel.hidden,
    run: () => showTerminal(termPanel.hidden),
  },
  { id: "build.showInSource", group: "Build", title: "Show PDF Selection in Source", enabled: hasPdfSelection, run: goToSelectionSource },
  { id: "build.showInPdf", group: "Build", title: "Show in PDF", keys: "Mod-Shift-j", enabled: canShowInPdf, run: showInPdf },
  {
    id: "build.compileOnSave", group: "Build", title: "Compile on Save", enabled: hasProject,
    checked: () => settings.compileOnSave, run: () => setCompileOnSave(!settings.compileOnSave),
  },
  {
    id: "build.compileOnType", group: "Build", title: "Compile as You Type", enabled: hasProject,
    checked: () => settings.compileOnType, run: () => setCompileOnType(!settings.compileOnType),
  },
  {
    id: "build.openPdf", group: "Build", title: "Open PDF Externally", enabled: () => !!root && !!lastPdf,
    run: () => openPath(`${root}/${lastPdf}`),
  },

  { id: "help.shortcuts", group: "Help", title: "Keyboard Shortcuts", run: commandPalette },
  { id: "help.tour", group: "Help", title: "Take the Tour", enabled: hasProject, run: startTour },
  { id: "edit.table", group: "Edit", title: "Edit Table…", enabled: () => !!activeEditor()?.dom.dataset.path?.endsWith(".tex"), run: editTable },
  { id: "edit.tikz", group: "Edit", title: "Preview TikZ", keys: "Mod-Alt-k", enabled: () => PICTURE_FILE.test(activeEditor()?.dom.dataset.path ?? ""), run: () => previewTikz(activeEditor()) },
  { id: "edit.equation", group: "Edit", title: "Edit Equation…", keys: "Mod-Alt-e", enabled: () => !!activeEditor()?.dom.dataset.path?.endsWith(".tex"), run: editEquation },
  { id: "edit.snippets", group: "Edit", title: "Snippets…", run: openSnippetEditor },
  { id: "edit.tikzInsert", group: "Edit", title: "Insert TikZ Picture…", enabled: () => PICTURE_FILE.test(activeEditor()?.dom.dataset.path ?? ""), run: insertTikzPicture },
  { id: "file.sketch", group: "File", title: "Insert Sketch…", keys: "Mod-Alt-d", enabled: () => isNote(activeEditor()?.dom.dataset.path), run: newSketch },
  { id: "file.review", group: "File", title: "Review Cards", enabled: hasProject, run: () => reviewCards() },
  { id: "file.anki", group: "File", title: "Export Cards for Anki…", enabled: hasProject, run: exportForAnki },
  {
    id: "help.about", group: "Help", title: "About Scribe",
    run: () => { $<HTMLDialogElement>("about").showModal(); },
  },
);

for (const command of allCommands()) command.icon = COMMAND_ICONS[command.id];

// A zip a publisher can compile: one .tex with everything inlined, the figures, the bibliography.
async function exportForSubmission() {
  if (!root) return;
  await compile(); // so figures, values and the .bbl are current
  const dest = await save({
    title: "Export for submission",
    defaultPath: `${baseName(root)}-submission.zip`,
    filters: [{ name: "Zip archive", extensions: ["zip"] }],
  });
  if (!dest) return;
  try {
    const report = await invoke<{ files: string[]; warnings: string[] }>("export_bundle", { root, main: mainFile, dest });
    const summary = `Exported ${report.files.length} files to ${baseName(dest)}`;
    if (report.warnings.length) {
      showLog("Export", `${summary}\n\nCheck before submitting:\n${report.warnings.map((w) => `  ${w}`).join("\n")}\n\nIncluded:\n${report.files.map((f) => `  ${f}`).join("\n")}`);
      setStatus(`${summary}, with ${report.warnings.length} thing${report.warnings.length === 1 ? "" : "s"} to check`, "err");
    } else {
      setStatus(summary, "ok");
    }
  } catch (e) {
    setStatus(`Couldn't export: ${e}`, "err");
  }
}

// Choose a text file to open beside the current one.
async function pickSideFile() {
  const files = (await listFiles()).filter((f) => !VIEWABLE.test(f) && f !== current && /\.(tex|py|ipynb|bib|sty|cls|txt|md)$/.test(f));
  openPalette({
    placeholder: "Open to the side",
    empty: "No other text files in this project.",
    items: files.map((f) => {
      const cut = f.lastIndexOf("/") + 1;
      return { label: f.slice(cut), detail: f.slice(0, cut), run: () => openToSide(f) };
    }),
  });
}

function commandPalette() {
  openPalette({
    placeholder: "Run a command",
    empty: "No commands available.",
    items: allCommands()
      .filter((c) => isEnabled(c) && c.id !== "view.palette" && c.id !== "help.shortcuts")
      .map((c) => ({
        label: c.title,
        detail: c.group,
        hint: c.keys ? formatKeys(c.keys) : undefined,
        run: () => runCommand(c.id),
      })),
  });
}

function recentEntries(): MenuEntry[] {
  const recent = getRecent();
  if (!recent.length) return [{ title: "No recent projects", enabled: false }];
  return [
    ...recent.map((path) => ({ title: baseName(path), icon: ICONS.folder, run: () => openProject(path) })),
    "-",
    { title: "Clear Recent", icon: ICONS.close, run: () => setRecent([]) },
  ];
}

// Menu title icons share the sidebar's 16px grid and 1.5 stroke, drawn slightly smaller.
const menuIcon = (body: string) =>
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const MENU_ICON = {
  file: menuIcon(PAGE),
  edit: menuIcon('<path d="M10.75 2.75l2.5 2.5L6 12.5l-3.25.75L3.5 10l7.25-7.25z"/><path d="M9 4.5L11.5 7"/>'),
  view: menuIcon('<rect x="2" y="2.75" width="12" height="10.5" rx="1.5"/><path d="M6 2.75v10.5"/>'),
  build: menuIcon('<path d="M4.75 3.1v9.8a.5.5 0 00.76.43l8-4.9a.5.5 0 000-.86l-8-4.9a.5.5 0 00-.76.43z"/>'),
  help: menuIcon('<circle cx="8" cy="8" r="6"/><path d="M6.4 6.3a1.7 1.7 0 113 1.1c-.6.6-1.4.9-1.4 1.85M8 11.5v.01"/>'),
};

createMenubar($("menubar"), [
  { title: "File", icon: MENU_ICON.file, entries: ["file.new", "file.newNotebook", "file.newFolder", "file.upload", "-", "file.newNote", "file.todaysNote", "file.quickNote", "file.sketch", "file.notePdf", "file.review", "file.anki", "-", "file.newProject", "file.open", "file.import", { title: "Open Recent", icon: ICONS.recent, submenu: recentEntries }, "-", "file.save", "file.rename", "file.trash", "-", "file.export", "file.reveal", "-", "file.closeTab", "file.close"] },
  { title: "Edit", icon: MENU_ICON.edit, entries: ["edit.undo", "edit.redo", "-", "edit.cut", "edit.copy", "edit.paste", "edit.selectAll", "-", "edit.find", "edit.findInProject", "edit.comment", "-", "edit.cite", "edit.zotero", "edit.table", "edit.equation", "edit.tikz", "edit.tikzInsert", "edit.snippets", "edit.copyLatex"] },
  {
    title: "View",
    icon: MENU_ICON.view,
    entries: [
      "view.palette", "view.quickOpen", "-",
      "view.files", "edit.findInProject", "view.figures", "view.outline", "view.git", "view.references", "view.symbols", "view.notes", "view.history", "view.review", "-",
      "view.openSide", "view.closeSide", "-",
      "view.sidebar", "view.preview", "view.focus", "view.log", "view.terminal", "-",
      { title: "Theme", icon: ICONS.theme, submenu: () => ["view.themeDark", "view.themeLight", "view.themeSystem", "-", "view.pdfDark", "-", "view.themeEdit"] }, "-",
      "view.vim", "view.relativeNumbers", "view.spell", "view.math", "view.livePreview", "-",
      "view.zoomIn", "view.zoomOut", "view.zoomReset", "-",
      "view.pdfZoomIn", "view.pdfZoomOut", "view.pdfFit", "view.pdfFind",
    ],
  },
  { title: "Build", icon: MENU_ICON.build, entries: ["build.compile", "build.compileOnSave", "build.compileOnType", "build.showInPdf", "build.showInSource", "build.check", "-", "build.runNotebooks", "build.runCell", "build.restartKernel", "-", "build.runFile", "build.stop", "view.terminal", "-", "view.log", "build.openPdf", "-", "build.installLatex"] },
  { title: "Help", icon: MENU_ICON.help, entries: ["help.shortcuts", "help.tour", "help.about"] },
]);

// ---------- wire up ----------
$("btn-open").onclick = openFolder;
$("btn-compile").onclick = () => compile();
$("btn-run").onclick = runNotebook;
$("btn-settings").onclick = () => toggleSettings();
$("welcome-open").onclick = openFolder;
$("welcome-new").onclick = newProject;
$("tab-files").onclick = () => showSidebar("files");
$("tab-search").onclick = () => showSidebar("search");
$("tab-figures").onclick = () => showSidebar("figures");
$<HTMLImageElement>("about-icon").src = iconUrl;
$("about-close").onclick = () => $<HTMLDialogElement>("about").close();
// A click on the dimmed area around the dialog closes it.
$("about").addEventListener("click", (e) => { if (e.target === e.currentTarget) $<HTMLDialogElement>("about").close(); });
$("tab-references").onclick = () => showSidebar("references");
$("tab-symbols").onclick = () => showSidebar("symbols");
$("side-add-cite").onclick = addCitation;
$("tab-notes").onclick = () => showSidebar("notes");
$("tab-history").onclick = () => showSidebar("history");
$("side-zotero").onclick = addFromZotero;
$("welcome-import").onclick = importProject;
$("tab-review").onclick = () => showSidebar("review");
$("side-upload").onclick = () => uploadFiles();
$("tab-git").onclick = () => showSidebar("git");
$("side-new").onclick = () => runCommand("file.new");
$("side-new-folder").onclick = () => runCommand("file.newFolder");
// Right-click on the empty part of the file list: actions for the project root.
$("files").oncontextmenu = (e) => {
  e.preventDefault();
  if (!root) return;
  openContextMenu(e.clientX, e.clientY, [
    { title: "New File…", icon: COMMAND_ICONS["file.new"], run: () => newFile() },
    { title: "New Notebook…", icon: ICONS.notebook, run: () => newFile("", "untitled.ipynb") },
    { title: "New Folder…", icon: COMMAND_ICONS["file.newFolder"], run: () => newFolder() },
    "-",
    { title: "Reveal in Finder", icon: ICONS.out, run: () => revealItemInDir(root!) },
  ]);
};
$("log-close").onclick = () => { logPanel.hidden = true; };
$("log-tab-problems").onclick = () => setLogView("problems");
$("log-tab-output").onclick = () => setLogView("output");
statusEl.onclick = toggleLog;

document.addEventListener("pointerdown", (e) => {
  const target = e.target as Node;
  if (!$("settings-popover").contains(target) && !$("btn-settings").contains(target)) toggleSettings(false);
});

installKeybindings();

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  closePalette();
  toggleSettings(false);
  if (!$("search-panel").hidden) showSidebar("files");
});

// The traffic lights disappear in fullscreen, so the title bar reclaims their space.
try {
  const appWindow = getCurrentWindow();
  const syncFullscreen = async () => {
    document.body.classList.toggle("fullscreen", await appWindow.isFullscreen());
  };
  appWindow.onResized(syncFullscreen).catch(() => {});
  syncFullscreen().catch(() => {});
} catch { /* not running inside Tauri */ }

renderProblemCount();
loadProfile();
/** PDFs light on dark, or as printed: the pages are drawn again either way. */
async function toggleDarkPdf() {
  await updateAppearance({ pdfDark: !appearance.pdfDark });
  rerenderPdfSoon();
  if (current?.toLowerCase().endsWith(".pdf")) openFile(current);
}

$("setting-snippets").addEventListener("click", openSnippetEditor);

// the look is the computer's, not the project's: applied before any project opens
appearanceListeners.push(refreshEditors);
initAppearanceControls();
applyAppearance();
renderRecent();
renderShortcuts();
renderSetup();
startTypewriter();
