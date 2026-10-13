/// <reference types="vite/client" />
import "@fontsource-variable/albert-sans";
import "@fontsource/playfair-display/700.css";
import { EditorView } from "codemirror";
import { redo, selectAll, toggleComment, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { message } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { allCommands, formatKeys, installKeybindings, isEnabled, register, runCommand } from "./commands";
import { COMMAND_ICONS, ICONS } from "./icons";
import { createMenubar, MenuEntry, openContextMenu } from "./menubar";
import { closePalette, openPalette } from "./palette";
import { compile, runNotebook, saveFile } from "./build";
import { $, baseName, current, logEl, logPanel, PAGE, root, setLogView, statusEl, VIEWABLE } from "./core";
import { view } from "./editor";
import { sizes, togglePane } from "./layout";
import { activeCell, cellRunners, cellViews, isNotebook, restartKernel } from "./notebook";
import { closeProject, openFolder, openProject } from "./project";
import { canShowInPdf, focusPdfFind, hasPdf, lastPdf, showInPdf, zoomPdf } from "./preview";
import { setCompileOnSave, setTheme, settings, toggleSettings, updateSettings, zoom } from "./settings";
import { deleteEntry, newFile, newFolder, quickOpen, renameEntry, showSidebar } from "./sidebar";
import { renderProblemCount } from "./statusbar";
import { closeTab, openTabs } from "./tabs";
import { canRunFile, runFile, shellAlive, showTerminal, stopTerminal, termPanel } from "./terminal";
import { getRecent, newProject, renderRecent, renderSetup, renderShortcuts, setRecent, startTypewriter } from "./welcome";

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
function targetView(): EditorView | null {
  if (editorVisible()) return view;
  return isNotebook() ? cellViews[activeCell] ?? null : null;
}

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
  { id: "file.open", group: "File", title: "Open Project…", keys: "Mod-o", run: openFolder },
  { id: "file.newProject", group: "File", title: "New Project…", run: newProject },
  { id: "file.save", group: "File", title: "Save", keys: "Mod-s", run: saveFile, enabled: () => !!current && !VIEWABLE.test(current) },
  {
    id: "file.reveal", group: "File", title: "Reveal in Finder", enabled: hasProject,
    run: () => revealItemInDir(current ? `${root}/${current}` : root!),
  },
  {
    // With no tab left, ⌘W does what it does everywhere else on a Mac.
    id: "file.closeTab", group: "File", title: "Close Tab", keys: "Mod-w",
    run: () => (current ? closeTab(current) : openTabs.length ? closeTab(openTabs[0]) : getCurrentWindow().close()),
  },
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
  { id: "view.pdfZoomIn", group: "View", title: "Zoom In PDF", enabled: hasPdf, run: () => zoomPdf(1.2) },
  { id: "view.pdfZoomOut", group: "View", title: "Zoom Out PDF", enabled: hasPdf, run: () => zoomPdf(1 / 1.2) },
  { id: "view.pdfFit", group: "View", title: "Fit PDF to Width", enabled: hasPdf, run: () => zoomPdf("fit") },
  { id: "view.pdfFind", group: "View", title: "Find in PDF", keys: "Mod-Shift-g", enabled: hasPdf, run: focusPdfFind },
  { id: "view.sidebar", group: "View", title: "Toggle Sidebar", keys: "Mod-b", enabled: hasProject, checked: () => !sizes.hideSidebar, run: () => togglePane("sidebar") },
  { id: "view.preview", group: "View", title: "Toggle Preview", enabled: hasProject, checked: () => !sizes.hidePreview, run: () => togglePane("preview") },
  { id: "view.log", group: "View", title: "Toggle Log", keys: "Mod-j", enabled: hasProject, checked: () => !logPanel.hidden, run: toggleLog },
  { id: "view.vim", group: "View", title: "Vim Keys", enabled: hasProject, checked: () => settings.vim, run: () => updateSettings({ vim: !settings.vim }) },
  {
    id: "view.relativeNumbers", group: "View", title: "Relative Line Numbers", enabled: hasProject,
    checked: () => settings.lineNumbers === "relative",
    run: () => updateSettings({ lineNumbers: settings.lineNumbers === "relative" ? "absolute" : "relative" }),
  },
  { id: "view.zoomIn", group: "View", title: "Zoom In", keys: "Mod-=", enabled: hasProject, run: () => zoom(1) },
  { id: "view.zoomOut", group: "View", title: "Zoom Out", keys: "Mod-Minus", enabled: hasProject, run: () => zoom(-1) },
  { id: "view.zoomReset", group: "View", title: "Reset Zoom", keys: "Mod-0", enabled: hasProject, run: () => zoom("reset") },
  { id: "view.themeDark", group: "View", title: "Dark Theme", enabled: hasProject, checked: () => settings.theme === "dark", run: () => setTheme("dark") },
  { id: "view.themeLight", group: "View", title: "Light Theme", enabled: hasProject, checked: () => settings.theme === "light", run: () => setTheme("light") },

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
  { id: "build.showInPdf", group: "Build", title: "Show in PDF", keys: "Mod-Shift-j", enabled: canShowInPdf, run: showInPdf },
  {
    id: "build.compileOnSave", group: "Build", title: "Compile on Save", enabled: hasProject,
    checked: () => settings.compileOnSave, run: () => setCompileOnSave(!settings.compileOnSave),
  },
  {
    id: "build.openPdf", group: "Build", title: "Open PDF Externally", enabled: () => !!root && !!lastPdf,
    run: () => openPath(`${root}/${lastPdf}`),
  },

  { id: "help.shortcuts", group: "Help", title: "Keyboard Shortcuts", run: commandPalette },
  {
    id: "help.about", group: "Help", title: "About Scribe",
    run: async () => {
      await message("Version 0.1.0\n\nA LaTeX and Python editor where notebook figures flow straight into the paper.", { title: "Scribe", kind: "info" });
    },
  },
);

for (const command of allCommands()) command.icon = COMMAND_ICONS[command.id];

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
  { title: "File", icon: MENU_ICON.file, entries: ["file.new", "file.newNotebook", "file.newFolder", "-", "file.newProject", "file.open", { title: "Open Recent", icon: ICONS.recent, submenu: recentEntries }, "-", "file.save", "file.rename", "file.trash", "-", "file.reveal", "file.closeTab", "file.close"] },
  { title: "Edit", icon: MENU_ICON.edit, entries: ["edit.undo", "edit.redo", "-", "edit.cut", "edit.copy", "edit.paste", "edit.selectAll", "-", "edit.find", "edit.findInProject", "edit.comment"] },
  {
    title: "View",
    icon: MENU_ICON.view,
    entries: [
      "view.palette", "view.quickOpen", "-",
      "view.files", "edit.findInProject", "view.figures", "-",
      "view.sidebar", "view.preview", "view.log", "view.terminal", "-",
      { title: "Theme", icon: ICONS.theme, submenu: () => ["view.themeDark", "view.themeLight"] }, "-",
      "view.vim", "view.relativeNumbers", "-",
      "view.zoomIn", "view.zoomOut", "view.zoomReset", "-",
      "view.pdfZoomIn", "view.pdfZoomOut", "view.pdfFit", "view.pdfFind",
    ],
  },
  { title: "Build", icon: MENU_ICON.build, entries: ["build.compile", "build.compileOnSave", "build.showInPdf", "-", "build.runNotebooks", "build.runCell", "build.restartKernel", "-", "build.runFile", "build.stop", "view.terminal", "-", "view.log", "build.openPdf"] },
  { title: "Help", icon: MENU_ICON.help, entries: ["help.shortcuts", "help.about"] },
]);

// ---------- wire up ----------
$("btn-open").onclick = openFolder;
$("btn-compile").onclick = compile;
$("btn-run").onclick = runNotebook;
$("btn-settings").onclick = () => toggleSettings();
$("welcome-open").onclick = openFolder;
$("welcome-new").onclick = newProject;
$("tab-files").onclick = () => showSidebar("files");
$("tab-search").onclick = () => showSidebar("search");
$("tab-figures").onclick = () => showSidebar("figures");
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
renderRecent();
renderShortcuts();
renderSetup();
startTypewriter();
