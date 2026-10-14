// Welcome screen: the typed-LaTeX demo, recent projects, setup check and New Project.
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { formatKeys, getCommand } from "./commands";
import { ICONS } from "./icons";
import { $, appEl, baseName, setStatus, welcomeEl } from "./core";
import { openPalette, promptInput } from "./palette";
import { profile } from "./profile";
import { openProject } from "./project";
import { TEMPLATES } from "./templates";

export function showWelcome(show: boolean) {
  welcomeEl.classList.toggle("hidden", !show);
  appEl.classList.toggle("hidden", show);
  if (show) startTypewriter();
  else stopTypewriter();
}

// ---------- welcome: typed LaTeX becomes a page ----------
// Source and page are written together: as each block is typed, its rendered text fills in at the same pace.
export const CURVE = Array.from({ length: 81 }, (_, i) => {
  const x = i / 8;
  const y = Math.exp(-x / 5) * Math.sin(x * 1.6);
  return `${i ? "L" : "M"}${(22 + x * 17).toFixed(1)} ${(40 - y * 30).toFixed(1)}`;
}).join("");

export const WELCOME_DOC: { src: string; html?: string }[] = [
  {
    src: `\\documentclass{article}
\\usepackage{scribe-figures}`,
  },
  {
    src: `\\title{Scribe: Papers That\\\\
  Run Their Own Figures}
\\author{You}

\\begin{document}
\\maketitle`,
    html: `<h1>Scribe: Papers That<br>Run Their Own Figures</h1><p class="paper-author">You</p>`,
  },
  {
    src: `\\begin{abstract}
Scribe is a desktop editor for LaTeX
and Python. Write the paper, run the
notebook, and the figures land in the
PDF, already up to date.
\\end{abstract}`,
    html: `<div class="paper-abstract"><strong>Abstract</strong><p>Scribe is a desktop editor for LaTeX and Python. Write the paper, run the notebook, and the figures land in the PDF, already up to date.</p></div>`,
  },
  {
    src: `\\section{Write}
A LaTeX editor with completion, project
search, and the PDF beside your source.`,
    html: `<h2><span>1</span>Write</h2><p>A LaTeX editor with completion, project search, and the PDF beside your source.</p>`,
  },
  {
    src: `\\section{Run}
Figures live in notebook cells. Change
the code and the next compile reruns
only what went stale:
\\[ y(t) = e^{-t/5} \\sin t \\]`,
    html: `<h2><span>2</span>Run</h2><p>Figures live in notebook cells. Change the code and the next compile reruns only what went stale:</p><p class="paper-eq"><i>y</i>(<i>t</i>) = <i>e</i><sup>−<i>t</i>/5</sup> sin <i>t</i></p>`,
  },
  {
    src: `\\nbfig{damped}{Straight from
  notebooks/analysis.py.}`,
    html: `<figure><svg viewBox="0 0 200 80" fill="none"><path class="axis" d="M22 6v68h172"/><path class="zero" d="M22 40h172"/><path class="curve" pathLength="1" d="${CURVE}"/></svg><figcaption>Figure 1: Straight from notebooks/analysis.py.</figcaption></figure>`,
  },
  {
    src: `\\section{Compile}
Press \\texttt{Cmd+Enter}. The PDF builds
on your machine. No upload, no queue.

\\end{document}`,
    html: `<h2><span>3</span>Compile</h2><p>Press <code>Cmd+Enter</code>. The PDF builds on your machine. No upload, no queue.</p>`,
  },
];

export const TEX_TOKEN = /(%[^\n]*)|(\\[a-zA-Z]+)|(\$[^$\n]*\$?)|(\d+(?:\.\d+)?)/g;
export const TEX_CLASS = ["tw-cmt", "tw-cmd", "tw-math", "tw-num"];

export function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightTex(text: string): string {
  let html = "";
  let last = 0;
  for (const m of text.matchAll(TEX_TOKEN)) {
    const cls = TEX_CLASS[m.slice(1).findIndex((g) => g !== undefined)];
    html += escHtml(text.slice(last, m.index)) + `<span class="${cls}">${escHtml(m[0])}</span>`;
    last = m.index! + m[0].length;
  }
  return html + escHtml(text.slice(last));
}

export let twTimer: number | null = null;

// Puts a block's rendered nodes on the page with their text reserved but hidden, and returns
// a setter that shows the first `progress` (0–1) of it. Layout never shifts as words arrive.
export function mountPaperBlock(paper: HTMLElement, html: string | undefined): (progress: number) => void {
  if (!html) return () => {};
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const nodes = [...tpl.content.children];
  const parts: { shown: HTMLElement; pending: HTMLElement; text: string }[] = [];
  for (const node of nodes) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const textNode of texts) {
      if (!textNode.data.trim()) continue;
      const shown = document.createElement("span");
      const pending = document.createElement("span");
      pending.className = "pending";
      pending.textContent = textNode.data;
      parts.push({ shown, pending, text: textNode.data });
      textNode.replaceWith(shown, pending);
    }
  }
  const curve = nodes.map((n) => n.querySelector<SVGPathElement>(".curve")).find(Boolean);
  const total = parts.reduce((sum, part) => sum + part.text.length, 0);
  paper.append(...nodes);

  return (progress) => {
    let left = Math.round(progress * total);
    for (const part of parts) {
      const take = Math.min(left, part.text.length);
      left -= take;
      part.shown.textContent = part.text.slice(0, take);
      part.pending.textContent = part.text.slice(take);
    }
    if (curve) curve.style.strokeDashoffset = String(1 - progress);
    if (progress > 0) nodes.forEach((n) => n.classList.add("in"));
  };
}

export function startTypewriter() {
  const el = $("typewriter");
  const paper = $("paper");
  const cursor = '<span class="tw-cursor"></span>';
  stopTypewriter();
  paper.replaceChildren();

  // Plays even under the system's Reduce Motion setting: text appearing in place is not the
  // kind of movement that setting guards against, and this demo is the point of the screen.
  let block = 0;
  let char = 0;
  let typed = "";
  let setProgress = mountPaperBlock(paper, WELCOME_DOC[0].html);

  function tick() {
    const src = WELCOME_DOC[block].src;
    if (char <= src.length) {
      el.innerHTML = highlightTex(typed + src.slice(0, char)) + cursor;
      el.scrollTop = el.scrollHeight;
      setProgress(char / src.length);
      const pause = src[char - 1] === "\n" ? 110 : 14 + Math.random() * 22;
      char++;
      twTimer = window.setTimeout(tick, pause);
      return;
    }
    typed += src + "\n\n";
    block++;
    char = 0;
    if (block < WELCOME_DOC.length) {
      setProgress = mountPaperBlock(paper, WELCOME_DOC[block].html);
      twTimer = window.setTimeout(tick, 320);
    } else {
      el.innerHTML = highlightTex(typed.trimEnd()) + cursor;
      twTimer = null;
    }
  }

  el.innerHTML = "";
  twTimer = window.setTimeout(tick, 400);
}

export function stopTypewriter() {
  if (twTimer !== null) {
    clearTimeout(twTimer);
    twTimer = null;
  }
}

// ---------- recent projects ----------
export const RECENT_KEY = "scribe.recent";

export function getRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
  } catch { return []; }
}

export function setRecent(list: string[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5))); } catch {}
}

export function renderRecent() {
  const recent = getRecent();
  $("recent").hidden = recent.length === 0;
  const list = $("recent-list");
  list.replaceChildren();
  for (const path of recent) {
    const name = baseName(path);
    const openBtn = document.createElement("button");
    openBtn.className = "recent-open";
    openBtn.title = path;
    openBtn.innerHTML = ICONS.folder;
    const nameEl = document.createElement("span");
    nameEl.className = "recent-name";
    nameEl.textContent = name;
    const pathEl = document.createElement("span");
    pathEl.className = "recent-path";
    pathEl.textContent = path.slice(0, path.length - name.length).replace(/[\\/]+$/, "");
    openBtn.append(nameEl, pathEl);
    openBtn.onclick = () => openProject(path);

    const remove = document.createElement("button");
    remove.className = "icon-btn";
    remove.innerHTML = ICONS.close;
    remove.title = "Remove from this list";
    remove.setAttribute("aria-label", `Remove ${name} from recent projects`);
    remove.onclick = () => {
      setRecent(getRecent().filter((p) => p !== path));
      renderRecent();
    };

    const li = document.createElement("li");
    li.append(openBtn, remove);
    list.appendChild(li);
  }
}

// ---------- welcome: setup check, shortcuts, new project ----------
export interface Tools { tex: string | null; python: string | null; }

export function setupRow(ok: boolean, name: string, detail: string): HTMLElement {
  const li = document.createElement("li");
  li.className = ok ? "ok" : "missing";
  const icon = document.createElement("span");
  icon.className = "row-icon";
  icon.innerHTML = ok ? ICONS.check : ICONS.warn;
  const title = document.createElement("span");
  title.className = "setup-name";
  title.textContent = name;
  const sub = document.createElement("span");
  sub.className = "setup-detail";
  sub.textContent = detail;
  li.append(icon, title, sub);
  return li;
}

// No LaTeX: one click installs Tectonic, instead of a page of instructions.
function installRow(): HTMLElement {
  const li = setupRow(false, "LaTeX not found", "Scribe can install Tectonic (about 20 MB) for you, or install TeX Live yourself.");
  const button = document.createElement("button");
  button.className = "btn btn-outline setup-install";
  button.textContent = "Install LaTeX";
  button.onclick = () => installLatex();
  li.appendChild(button);
  return li;
}

let installing = false;

/** Download Tectonic into Scribe's own folder; afterwards papers compile with no TeX installed. */
export async function installLatex() {
  if (installing) return;
  installing = true;
  setStatus("Downloading Tectonic (about 20 MB)…", "busy");
  for (const b of document.querySelectorAll<HTMLButtonElement>(".setup-install")) {
    b.disabled = true;
    b.textContent = "Installing…";
  }
  try {
    const version = await invoke<string>("install_tectonic");
    setStatus(`Installed ${version}. The first compile downloads the LaTeX packages the paper uses, so it takes a minute.`, "ok");
  } catch (e) {
    setStatus(String(e), "err");
  } finally {
    installing = false;
    renderSetup();
  }
}

// Says up front whether compiling and notebooks will work on this machine.
export async function renderSetup() {
  const list = $("setup-list");
  let tools: Tools;
  try {
    tools = await invoke<Tools>("check_tools");
  } catch {
    list.closest("section")!.hidden = true;
    return;
  }
  list.replaceChildren(
    tools.tex
      ? setupRow(true, "LaTeX", tools.tex)
      : installRow(),
    tools.python
      ? setupRow(true, "Python", tools.python)
      : setupRow(false, "Python not found", "Install Python 3 to run notebooks and produce figures."),
  );
}

/** Bring in a project from elsewhere: an Overleaf download (zip) or a git link. */
export function importProject() {
  openPalette({
    placeholder: "Import a project from…",
    empty: "",
    items: [
      { label: "A .zip file", detail: "From Overleaf: Menu > Download > Source", run: importZip },
      { label: "A git link", detail: "Overleaf's Git link, GitHub, GitLab…", run: importGit },
    ],
  });
}

// Shown on the welcome screen when that's where the import started, and in the status line.
function importFailed(e: unknown) {
  const errEl = $("welcome-error");
  errEl.textContent = `Couldn't import the project: ${e}`;
  errEl.hidden = false;
  setStatus(String(e), "err");
}

async function chooseParent(): Promise<string | null> {
  const parent = await open({ directory: true, title: "Choose where to put the project" });
  return typeof parent === "string" ? parent : null;
}

async function importZip() {
  const zip = await open({ title: "Choose the project's .zip", filters: [{ name: "Zip", extensions: ["zip"] }] });
  if (typeof zip !== "string") return;
  const parent = await chooseParent();
  if (!parent) return;
  setStatus("Unpacking the project…", "busy");
  try {
    const path = await invoke<string>("import_zip", { zip, parent });
    setStatus("");
    await openProject(path);
  } catch (e) {
    importFailed(e);
  }
}

function importGit() {
  promptInput({
    placeholder: "Git link",
    hint: "Overleaf: Menu > Git, with a token in the link: https://git:<token>@git.overleaf.com/<id>",
    submit: async (url) => {
      const parent = await chooseParent();
      if (!parent) return;
      setStatus("Cloning the project…", "busy");
      try {
        const path = await invoke<string>("clone_project", { url, parent });
        setStatus("");
        await openProject(path);
      } catch (e) {
        importFailed(e);
      }
    },
  });
}

export function renderShortcuts() {
  const list = $("shortcut-list");
  for (const id of ["build.compile", "build.runNotebooks", "view.palette", "view.quickOpen", "edit.findInProject"]) {
    const command = getCommand(id);
    if (!command?.keys) continue;
    const li = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = "row-icon";
    icon.innerHTML = command.icon ?? "";
    const keys = document.createElement("span");
    keys.className = "shortcut-keys";
    keys.textContent = formatKeys(command.keys);
    li.append(icon, command.title.replace("…", ""), keys);
    list.appendChild(li);
  }
}

// Templates leave the author blank or as a placeholder; fill in the profile when there is one.
function signed(content: string): string {
  if (!profile.name) return content;
  return content
    .replace("\\author{}", () => `\\author{${profile.name}}`)
    .replace(/\\author\{(Your Name|First Author)\}/, () => `\\author{${profile.name}}`)
    .replace("\\IEEEauthorblockN{First Author}", () => `\\IEEEauthorblockN{${profile.name}}`)
    .replace("email@example.org", () => profile.email || "email@example.org")
    .replace(/\\institution\{University\}/, () => `\\institution{${profile.affiliation || "University"}}`);
}

// Pick (or create) a folder. A folder that already has a paper just opens; an empty one is
// started from a template.
export async function newProject() {
  const picked = await open({ directory: true, multiple: false, title: "Choose or create a folder for the project" });
  if (typeof picked !== "string") return;
  const fail = (e: unknown) => {
    const errEl = $("welcome-error");
    errEl.textContent = `Couldn't set up the project: ${e}`;
    errEl.hidden = false;
  };

  let files: string[];
  try {
    files = await invoke<string[]>("list_files", { root: picked });
  } catch (e) {
    fail(e);
    return;
  }
  // Already a paper or a set of notes (a lone readme doesn't count): open it as it is.
  if (files.some((f) => f.endsWith(".tex") || (/\.md$/i.test(f) && !/(^|\/)readme\.md$/i.test(f)))) {
    await openProject(picked);
    return;
  }

  openPalette({
    placeholder: `Start ${baseName(picked)} from…`,
    empty: "No templates.",
    items: TEMPLATES.map((template) => ({
      label: template.name,
      detail: template.detail,
      run: async () => {
        try {
          for (const [rel, content] of Object.entries(template.files)) {
            if (!files.includes(rel)) await invoke("write_file", { root: picked, rel, content: signed(content) }); // never overwrite
          }
        } catch (e) {
          fail(e);
          return;
        }
        await openProject(picked);
      },
    })),
  });
}
