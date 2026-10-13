// Leaf module: DOM handles, shared state, status line and small helpers. It imports no other
// app module, so anything may depend on it, including at load time.


export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const statusEl = $<HTMLButtonElement>("status");
export const logEl = $<HTMLPreElement>("log");
export const logPanel = $("log-panel");
export const welcomeEl = $("welcome");
export const appEl = $("app");
export const layoutEl = $("layout");
export const tabEl = $("tab");

export const ICON_PLAY = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8v10.4a.6.6 0 00.9.5l8.4-5.2a.6.6 0 000-1L5.4 2.3a.6.6 0 00-.9.5z"/></svg>';
export const ICON_CLOSE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

// ---------- shared state ----------
// Read these directly (imports are live); write them through the setters below.
export let root: string | null = null;
export let mainFile = "main.tex";
export let current: string | null = null;
export let dirty = false;

export const setRoot = (value: string | null) => { root = value; };
export const setMainFile = (value: string) => { mainFile = value; };
export const setCurrent = (value: string | null) => { current = value; };
/** Sets the flag only. `setDirty` also updates the title bar. */
export const assignDirty = (value: boolean) => { dirty = value; };

export type StatusKind = "" | "busy" | "ok" | "err";

export function setStatus(msg: string, kind: StatusKind = "") {
  $("status-text").textContent = msg;
  statusEl.className = "status " + kind;
  statusEl.hidden = !msg;
}

/** The log panel shows either the parsed problem list or the raw output. */
export function setLogView(which: "problems" | "output") {
  $("problems").hidden = which !== "problems";
  logEl.hidden = which !== "output";
  $("log-tab-problems").setAttribute("aria-selected", String(which === "problems"));
  $("log-tab-output").setAttribute("aria-selected", String(which === "output"));
}

export function showLog(title: string, text: string, visible = true) {
  $("log-title").textContent = title;
  logEl.textContent = text;
  setLogView("output");
  logPanel.hidden = !visible || !text;
  if (!logPanel.hidden) logEl.scrollTop = logEl.scrollHeight;
}

/** Lets modules above this one react to state changes without core importing them: each
 *  function here runs whenever the open file or its unsaved state is redrawn. */
export const changeListeners: (() => void)[] = [];

export function renderCrumb() {
  for (const listener of changeListeners) listener();
  tabEl.replaceChildren();
  tabEl.classList.toggle("dirty", dirty);
  tabEl.title = dirty ? "Unsaved changes" : "";
  if (!current) return;
  const cut = current.lastIndexOf("/") + 1;
  if (cut) {
    const dir = document.createElement("span");
    dir.className = "crumb-dir";
    dir.textContent = current.slice(0, cut);
    tabEl.appendChild(dir);
  }
  const name = document.createElement("span");
  name.className = "crumb-name";
  name.textContent = current.slice(cut);
  tabEl.appendChild(name);
}

export function setDirty(value: boolean) {
  if (dirty === value) return;
  assignDirty(value);
  renderCrumb();
}

export function baseName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

// ---------- files ----------
export const EDITABLE = /\.(tex|py|ipynb|bib|sty|cls|txt|md|pdf)$/;
export const NOTEBOOK_SOURCE = /\.(py|ipynb)$/; // files that can hold figure cells
export const VIEWABLE = /\.(pdf|png|jpe?g|gif|svg)$/i; // opened as a preview, never as text
export const listed = (f: string) => EDITABLE.test(f) || VIEWABLE.test(f);
export const GIT_CLASS: Record<string, string> = { M: "mod", A: "add", "?": "new", D: "del" };
export const GIT_LABEL: Record<string, string> = { M: "Modified", A: "Added", "?": "Untracked", D: "Deleted" };

export const CREATABLE = /\.(tex|py|ipynb|bib|sty|cls|txt|md)$/;

export const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
export const insideProject = (rel: string) => !rel.startsWith("/") && !rel.split("/").some((part) => part === ".." || part === "");

export const svg = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const PAGE = '<path d="M4 1.75h5.25l3.25 3.25v8.75a.5.5 0 01-.5.5H4a.5.5 0 01-.5-.5V2.25a.5.5 0 01.5-.5z"/><path d="M9.25 1.75V5h3.25"/>';

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
