// File list (icons, drag to move, right-click actions), project search and git marks.
import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { COMMAND_ICONS, ICONS } from "./icons";
import { openContextMenu } from "./menubar";
import { openPalette, promptInput } from "./palette";
import { $, baseName, CREATABLE, current, VIEWABLE, dirty, GIT_CLASS, GIT_LABEL, insideProject, listed, mainFile, NOTEBOOK_SOURCE, PAGE, parentOf, renderCrumb, root, setCurrent, setMainFile, setStatus, svg } from "./core";
import { renderReferences } from "./cite";
import { renderGallery } from "./gallery";
import { renderGit } from "./git";
import { sizes, togglePane } from "./layout";
import { emptyIpynb } from "./notebook";
import { renderNotes } from "./notes";
import { renderOutline } from "./outline";
import { renderReview } from "./review";
import { listDirs, listFiles, openFile, revealLine, save } from "./project";
import { saveSettings, settings } from "./settings";
import { openToSide, sideGone, sideMoved } from "./split";
import { saveSessionSoon } from "./session";
import { refreshBranch } from "./statusbar";
import { renderSymbols } from "./symbols";
import { dropTabs, renameTabs } from "./tabs";
import { NotebookInfo } from "./types";

export async function takenPaths(): Promise<Set<string>> {
  const [files, dirs] = await Promise.all([listFiles(), listDirs()]);
  return new Set([...files, ...dirs]);
}

// `suggestion` prefills a file name (its base name is preselected), e.g. "untitled.ipynb".
export async function newFile(dir = "", suggestion = "") {
  if (!root) return;
  const taken = await takenPaths();
  const prefill = (dir ? `${dir}/` : "") + suggestion;
  promptInput({
    placeholder: suggestion.endsWith(".ipynb") ? "New notebook name" : "New file name",
    hint: "Path inside the project. .tex for LaTeX, .py for a Python script, .ipynb for a notebook.",
    value: prefill || undefined,
    validate: (rel) => {
      if (!insideProject(rel)) return "The file has to live inside the project.";
      if (!CREATABLE.test(rel)) return "Use one of these extensions: .tex, .py, .ipynb, .bib, .sty, .cls, .txt, .md, .csv";
      if (taken.has(rel)) return `${rel} already exists.`;
      return null;
    },
    submit: async (rel) => {
      const content = rel.endsWith(".ipynb") ? JSON.stringify(emptyIpynb(), null, 1) + "\n" : "";
      await invoke("write_file", { root, rel, content });
      collapsedDirs.delete(parentOf(rel));
      await openFile(rel);
    },
  });
}

/** Copy files from elsewhere on the computer into the project (into `dir`, or the root). */
export async function uploadFiles(dir = "") {
  if (!root) return;
  const picked = await open({ multiple: true, title: dir ? `Add files to ${dir}` : "Add files to the project" });
  const sources = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (!sources.length) return;
  try {
    const added = await invoke<string[]>("import_files", { root, dir, sources });
    collapsedDirs.delete(dir);
    setStatus(added.length === 1 ? `Added ${added[0]}` : `Added ${added.length} files`, "ok");
  } catch (e) {
    setStatus(`Couldn't add the files: ${e}`, "err");
  }
  await refreshFiles();
}

export async function newFolder(dir = "") {
  if (!root) return;
  const taken = await takenPaths();
  promptInput({
    placeholder: "New folder name",
    hint: "Path inside the project, for example sections or figures/raw",
    value: dir ? `${dir}/` : undefined,
    validate: (rel) => {
      if (!insideProject(rel)) return "The folder has to live inside the project.";
      if (taken.has(rel)) return `${rel} already exists.`;
      return null;
    },
    submit: async (rel) => {
      try {
        await invoke("create_dir", { root, rel });
      } catch (e) {
        setStatus(`Couldn't create ${rel}: ${e}`, "err");
      }
      await refreshFiles();
    },
  });
}

export async function renameEntry(from: string, isDir: boolean) {
  if (!root) return;
  const taken = await takenPaths();
  promptInput({
    placeholder: isDir ? "Rename or move folder" : "Rename or move file",
    hint: "Edit the path. Changing the folder part moves it.",
    value: from,
    validate: (to) => {
      if (to === from) return "That is the current name.";
      if (!insideProject(to)) return "It has to stay inside the project.";
      if (isDir && to.startsWith(`${from}/`)) return "A folder can't be moved inside itself.";
      if (!isDir && !listed(to)) return "Keep a supported extension, or the file disappears from the list.";
      if (taken.has(to)) return `${to} already exists.`;
      return null;
    },
    submit: async (to) => {
      if (dirty) await save();
      try {
        await invoke("rename_path", { root, from, to });
      } catch (e) {
        setStatus(`Couldn't rename ${from}: ${e}`, "err");
        return;
      }
      applyMove(from, to, isDir);
      await refreshFiles();
    },
  });
}

// After a rename or move on disk: anything that pointed at the old path follows it.
export function applyMove(from: string, to: string, isDir: boolean) {
  const moved = (p: string) =>
    p === from ? to : isDir && p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
  if (current) setCurrent(moved(current));
  setMainFile(moved(mainFile));
  if (isDir && collapsedDirs.delete(from)) collapsedDirs.add(to);
  renameTabs(moved);
  sideMoved(moved);
  renderCrumb();
}

export async function deleteEntry(rel: string, isDir: boolean) {
  if (!root) return;
  const confirmed = await ask(
    isDir
      ? `Move the folder “${rel}” and everything in it to the Trash?`
      : `Move “${rel}” to the Trash?`,
    { title: "Scribe", kind: "warning", okLabel: "Move to Trash", cancelLabel: "Cancel" },
  );
  if (!confirmed) return;
  try {
    await invoke("delete_path", { root, rel });
  } catch (e) {
    setStatus(`Couldn't delete ${rel}: ${e}`, "err");
    return;
  }
  // Tabs on deleted files close without saving them back into existence.
  const gone = (path: string) => path === rel || (isDir && path.startsWith(`${rel}/`));
  sideGone(gone);
  await dropTabs(gone);
  await refreshFiles();
}

export async function quickOpen() {
  if (!root) return;
  const files = (await listFiles()).filter(listed);
  openPalette({
    placeholder: "Go to file",
    empty: "This project has no files to open yet.",
    items: files.map((f) => {
      const cut = f.lastIndexOf("/") + 1;
      return { label: f.slice(cut), detail: f.slice(0, cut), run: () => openFile(f) };
    }),
  });
}

// One glyph per kind of file, all on the same 16px grid and stroke.
export const FILE_ICON: Record<string, string> = {
  tex: svg(PAGE + '<path d="M5.75 8.25h4.5M5.75 10.75h3"/>'),
  py: svg('<path d="M5.75 4.75L2.5 8l3.25 3.25M10.25 4.75L13.5 8l-3.25 3.25"/>'),
  bib: svg('<path d="M3.25 2.5h7.5a1.5 1.5 0 011.5 1.5v9.5H4.75a1.5 1.5 0 01-1.5-1.5V2.5z"/><path d="M3.25 12a1.5 1.5 0 011.5-1.5h7.5M6 5.5h3.5"/>'),
  sty: svg('<path d="M6 2.5c-1.4 0-2 .6-2 2v1.6c0 .9-.5 1.6-1.5 1.9 1 .3 1.5 1 1.5 1.9v1.6c0 1.4.6 2 2 2M10 2.5c1.4 0 2 .6 2 2v1.6c0 .9.5 1.6 1.5 1.9-1 .3-1.5 1-1.5 1.9v1.6c0 1.4-.6 2-2 2"/>'),
  pdf: svg(PAGE + '<path d="M5.75 8.25h4.5v3h-4.5z"/>'),
  text: svg(PAGE),
};
FILE_ICON.cls = FILE_ICON.sty;
FILE_ICON.csv = svg('<rect x="2" y="2.75" width="12" height="10.5" rx="1.5"/><path d="M2 6.25h12M2 9.75h12M6.5 2.75v10.5"/>');
FILE_ICON.tsv = FILE_ICON.csv;
FILE_ICON.image = svg('<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5"/><circle cx="5.75" cy="6.25" r="1.1"/><path d="M2.5 11.5l3.25-3 2.5 2.25 2-1.75 3.25 3"/>');
for (const ext of ["png", "jpg", "jpeg", "gif", "svg"]) FILE_ICON[ext] = FILE_ICON.image;
FILE_ICON.ipynb = svg('<rect x="3.5" y="2" width="9.5" height="12" rx="1.5"/><path d="M2 5h2.5M2 8h2.5M2 11h2.5M7 5.5h3.5"/>');
export const ICON_FOLDER = svg('<path d="M2 4.25a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1v6.5a1 1 0 01-1 1H3a1 1 0 01-1-1v-8z"/>');
export const ICON_CHEVRON = '<svg class="chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 4.5L10 8l-3.5 3.5"/></svg>';

export const collapsedDirs = new Set<string>();

export function fileRow(f: string, dir: string, gitMap: Map<string, string>): HTMLElement {
  const ext = f.slice(f.lastIndexOf(".") + 1).toLowerCase();
  const el = document.createElement("button");
  el.className = "item" + (dir ? " nested" : "") + (f === current ? " active" : "");
  el.title = f;
  el.dataset.rel = f;
  el.onclick = () => { if (!dragJustEnded) openFile(f); };
  el.addEventListener("pointerdown", (e) => beginDrag(e, f, false));
  el.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { title: "Open", icon: ICONS.page, run: () => openFile(f) },
      { title: "Open to the Side", icon: ICONS.split, enabled: !VIEWABLE.test(f), run: () => openToSide(f) },
      "-",
      { title: "New File…", icon: COMMAND_ICONS["file.new"], run: () => newFile(dir) },
      { title: "New Notebook…", icon: ICONS.notebook, run: () => newFile(dir, "untitled.ipynb") },
      { title: "New Folder…", icon: COMMAND_ICONS["file.newFolder"], run: () => newFolder(dir) },
      "-",
      { title: "Rename…", icon: ICONS.pencil, run: () => renameEntry(f, false) },
      { title: "Move to Trash", icon: ICONS.trash, run: () => deleteEntry(f, false) },
      "-",
      { title: "Reveal in Finder", icon: ICONS.out, run: () => revealItemInDir(`${root}/${f}`) },
    ]);
  };

  const icon = document.createElement("span");
  icon.className = `file-icon file-${FILE_ICON[ext] === FILE_ICON.image ? "image" : ext in FILE_ICON ? ext : "text"}`;
  icon.innerHTML = FILE_ICON[ext] ?? FILE_ICON.text;
  el.appendChild(icon);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = f.slice(dir ? dir.length + 1 : 0);
  el.appendChild(name);

  const gs = gitMap.get(f);
  if (gs) {
    const mark = document.createElement("span");
    mark.className = `git-mark git-${GIT_CLASS[gs] ?? "mod"}`;
    mark.textContent = gs === "?" ? "U" : gs;
    mark.title = GIT_LABEL[gs] ?? gs;
    el.appendChild(mark);
  }

  if (NOTEBOOK_SOURCE.test(f) && root) {
    invoke<NotebookInfo>("parse_notebook", { root, rel: f }).then((info) => {
      if (info.stale.length === 0) return;
      const mark = document.createElement("span");
      mark.className = "stale-mark";
      mark.title = "Figures are out of date. They rerun on the next compile.";
      name.after(mark);
    }).catch(() => {});
  }
  return el;
}

// ----- drag files and folders to move or reorder them -----
export type DropTarget = { dir: string; mode: "into" } | { dir: string; mode: "before" | "after"; ref: string };

export let shownByDir = new Map<string, string[]>(); // files per folder, in the order currently displayed
export let dragJustEnded = false; // swallows the click that follows a drop

export function beginDrag(down: PointerEvent, rel: string, isDir: boolean) {
  if (down.button !== 0) return;
  const box = $("files");
  let ghost: HTMLElement | null = null;
  let target: DropTarget | null = null;

  const clearMarks = () => {
    box.classList.remove("drop-root");
    box.querySelectorAll(".drop-into, .drop-before, .drop-after").forEach((el) =>
      el.classList.remove("drop-into", "drop-before", "drop-after"));
  };

  const move = (e: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 5) return;
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = baseName(rel);
      document.body.appendChild(ghost);
      document.body.classList.add("dragging-file");
    }
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 8}px`;

    clearMarks();
    target = null;
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const row = under?.closest<HTMLElement>("#files .item, #files .dir");
    if (row?.dataset.rel !== undefined) {
      const over = row.dataset.rel;
      if (row.classList.contains("dir")) {
        target = { dir: over, mode: "into" };
      } else if (isDir) {
        target = { dir: parentOf(over), mode: "into" }; // folders aren't hand-ordered, only moved
      } else if (over !== rel) {
        const r = row.getBoundingClientRect();
        target = { dir: parentOf(over), mode: e.clientY > r.top + r.height / 2 ? "after" : "before", ref: over };
      }
      // A folder can't go inside itself, and "into where it already is" is not a move.
      if (target && isDir && (target.dir === rel || target.dir.startsWith(`${rel}/`))) target = null;
      if (target?.mode === "into" && target.dir === parentOf(rel)) target = null;
      if (target) {
        const mark = target.mode === "into"
          ? box.querySelector<HTMLElement>(`.dir[data-rel="${CSS.escape(target.dir)}"]`)
          : row;
        if (mark) mark.classList.add(`drop-${target.mode}`);
        else box.classList.add("drop-root");
      }
    } else if (under?.closest("#files") && parentOf(rel) !== "") {
      target = { dir: "", mode: "into" };
      box.classList.add("drop-root");
    }
  };

  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (!ghost) return; // never moved far enough: an ordinary click
    ghost.remove();
    document.body.classList.remove("dragging-file");
    clearMarks();
    dragJustEnded = true;
    setTimeout(() => { dragJustEnded = false; });
    if (target) dropEntry(rel, isDir, target);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

export async function dropEntry(rel: string, isDir: boolean, target: DropTarget) {
  if (!root) return;
  const name = baseName(rel);
  const to = target.dir ? `${target.dir}/${name}` : name;

  if (to !== rel) {
    if (dirty) await save();
    try {
      await invoke("rename_path", { root, from: rel, to });
    } catch (e) {
      setStatus(`Couldn't move ${name}: ${e}`, "err");
      return;
    }
    applyMove(rel, to, isDir);
  }

  if (!isDir) {
    // Record the new position among its neighbours, by name.
    const names = (shownByDir.get(target.dir) ?? []).map(baseName).filter((n) => n !== name);
    const at = target.mode === "into"
      ? names.length
      : names.indexOf(baseName(target.ref)) + (target.mode === "after" ? 1 : 0);
    names.splice(Math.max(0, at), 0, name);
    settings.order = { ...settings.order, [target.dir]: names };
    saveSettings();
  }
  collapsedDirs.delete(target.dir);
  await refreshFiles();
}

export function dirRow(dir: string): HTMLElement {
  const d = document.createElement("button");
  d.className = "dir";
  d.title = dir;
  d.setAttribute("aria-expanded", String(!collapsedDirs.has(dir)));
  d.innerHTML = ICON_CHEVRON + ICON_FOLDER;
  const label = document.createElement("span");
  label.className = "name";
  label.textContent = dir;
  d.appendChild(label);
  d.dataset.rel = dir;
  d.onclick = () => {
    if (dragJustEnded) return;
    if (!collapsedDirs.delete(dir)) collapsedDirs.add(dir);
    refreshFiles();
  };
  d.addEventListener("pointerdown", (e) => beginDrag(e, dir, true));
  d.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { title: "New File…", icon: COMMAND_ICONS["file.new"], run: () => newFile(dir) },
      { title: "New Notebook…", icon: ICONS.notebook, run: () => newFile(dir, "untitled.ipynb") },
      { title: "New Folder…", icon: COMMAND_ICONS["file.newFolder"], run: () => newFolder(dir) },
      { title: "Upload Files Here…", icon: COMMAND_ICONS["file.upload"], run: () => uploadFiles(dir) },
      "-",
      { title: "Rename…", icon: ICONS.pencil, run: () => renameEntry(dir, true) },
      { title: "Move to Trash", icon: ICONS.trash, run: () => deleteEntry(dir, true) },
      "-",
      { title: "Reveal in Finder", icon: ICONS.out, run: () => revealItemInDir(`${root}/${dir}`) },
    ]);
  };
  return d;
}

export async function refreshFiles() {
  const box = $("files");
  const [allFiles, dirList, gitMap] = await Promise.all([listFiles(), listDirs(), getGitStatus()]);
  refreshBranch(); // whatever changed the files may have been a checkout
  const byDir = new Map<string, string[]>();
  for (const f of allFiles.filter(listed)) {
    const dir = parentOf(f);
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  // Files keep the order they were dragged into; anything not arranged yet follows alphabetically.
  for (const [dir, list] of byDir) {
    const order = settings.order[dir];
    if (!order) continue;
    const rank = (f: string) => {
      const at = order.indexOf(baseName(f));
      return at === -1 ? Number.MAX_SAFE_INTEGER : at;
    };
    list.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }
  shownByDir = byDir;
  // Folders show even when empty, so a newly created one has somewhere to be.
  const dirs = [...new Set([...dirList, ...byDir.keys()])].filter(Boolean).sort();
  if (!byDir.size && !dirs.length) {
    box.innerHTML = '<div class="empty">This folder is empty. Right-click here to add a file or folder.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const f of byDir.get("") ?? []) frag.appendChild(fileRow(f, "", gitMap));
  for (const dir of dirs) {
    frag.appendChild(dirRow(dir));
    for (const f of byDir.get(dir) ?? []) {
      // The open file stays visible even inside a collapsed folder.
      if (collapsedDirs.has(dir) && f !== current) continue;
      frag.appendChild(fileRow(f, dir, gitMap));
    }
  }
  box.replaceChildren(frag);
  renderGit(); // the same change that redrew the list changes what git sees
}

// ---------- sidebar tabs ----------
export type SidebarTab = "files" | "search" | "figures" | "git" | "references" | "symbols" | "notes" | "review";

const PANEL: Record<SidebarTab, string> = {
  files: "files-panel", search: "search-panel", figures: "figures-panel", git: "git-panel",
  references: "references-panel", symbols: "symbols-panel", notes: "notes-panel", review: "review-panel",
};

const PANEL_NAME: Record<SidebarTab, string> = {
  files: "File tree", search: "Search", figures: "Figures and values", git: "Git", references: "References",
  symbols: "Symbols", notes: "Notes", review: "Review",
};

/** The panel showing in the sidebar. */
export let currentSidebarTab: SidebarTab = "files";

export function showSidebar(which: SidebarTab) {
  currentSidebarTab = which;
  saveSessionSoon();
  if (sizes.hideSidebar) togglePane("sidebar");
  for (const tab of Object.keys(PANEL) as SidebarTab[]) {
    $(PANEL[tab]).hidden = tab !== which;
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === which));
  }
  $("side-name").textContent = PANEL_NAME[which];
  // Each panel shows its own actions: creating things beside the file list, refresh elsewhere.
  $("side-new").hidden = $("side-new-folder").hidden = $("side-upload").hidden = which !== "files";
  $("side-refresh").hidden = which === "files" || which === "search" || which === "symbols" || which === "notes";
  $("side-add-cite").hidden = which !== "references";
  $("side-refresh").onclick = () => showSidebar(which);
  if (which === "figures") renderGallery();
  if (which === "files") renderOutline();
  if (which === "review") renderReview();
  if (which === "notes") renderNotes();
  if (which === "references") renderReferences();
  if (which === "symbols") renderSymbols();
  if (which === "git") renderGit();
  if (which === "search") {
    const input = $<HTMLInputElement>("search-input");
    input.focus();
    input.select();
    if (!$("search-results").childElementCount) doSearch(input.value);
  }
}

// ---------- git status ----------
export interface GitFileStatus { path: string; status: string; }

export async function getGitStatus(): Promise<Map<string, string>> {
  if (!root) return new Map();
  try {
    const statuses = await invoke<GitFileStatus[]>("git_status", { root });
    return new Map(statuses.map((s) => [s.path, s.status]));
  } catch { return new Map(); }
}

// ---------- search ----------
export interface SearchMatchResult { file: string; line: number; col: number; text: string; }

export let searchTimer: number | null = null;

export function searchNote(text: string) {
  const el = document.createElement("div");
  el.className = "empty";
  el.textContent = text;
  $("search-results").replaceChildren(el);
}

export async function doSearch(query: string) {
  if (!root || !query.trim()) {
    searchNote("Search every file in the project. Matching is not case sensitive.");
    return;
  }
  try {
    const results = await invoke<SearchMatchResult[]>("search_project", { root, query, caseSensitive: false });
    if (!results.length) {
      searchNote(`Nothing matches “${query}”.`);
      return;
    }
    const frag = document.createDocumentFragment();
    let lastFile = "";
    for (const r of results) {
      if (r.file !== lastFile) {
        const g = document.createElement("div");
        g.className = "search-file";
        g.textContent = r.file;
        g.title = r.file;
        frag.appendChild(g);
        lastFile = r.file;
      }
      const hit = document.createElement("button");
      hit.className = "search-hit";
      const num = document.createElement("span");
      num.className = "search-line";
      num.textContent = String(r.line);
      const text = document.createElement("span");
      text.className = "search-text";
      text.textContent = r.text.trim();
      hit.append(num, text);
      hit.onclick = async () => {
        await revealLine(r.file, r.line, r.col);
      };
      frag.appendChild(hit);
    }
    $("search-results").replaceChildren(frag);
  } catch (e) {
    searchNote(`Search failed: ${e}`);
  }
}

$("search-input").addEventListener("input", (e) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    doSearch((e.target as HTMLInputElement).value);
  }, 250);
});
