// Git panel: what changed, a diff per file, commit, push and recent history.
import { invoke } from "@tauri-apps/api/core";
import { $, root, setStatus } from "./core";
import { profile } from "./profile";
import { refreshFiles } from "./sidebar";
import { showInSide } from "./split";

interface Change { path: string; status: string; }
interface Commit { hash: string; subject: string; when: string; }
interface Overview { repo: boolean; branch: string | null; has_remote: boolean; changes: Change[]; log: Commit[]; }

const panel = $("git-panel");
const STATUS_LABEL: Record<string, string> = { M: "Modified", A: "Added", "?": "New", D: "Deleted" };
const STATUS_CLASS: Record<string, string> = { M: "mod", A: "add", "?": "new", D: "del" };

let job = 0;
let draft = ""; // the commit message survives redraws

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** A unified diff as coloured lines. */
export function diffView(diff: string): HTMLElement {
  const box = el("div", "diff");
  if (!diff.trim()) {
    box.appendChild(el("div", "empty", "No textual changes to show (the file may be binary or deleted)."));
    return box;
  }
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    // File headers repeat what the pane title already says.
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(line)) continue;
    const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "same";
    box.appendChild(el("div", `diff-line diff-${kind}`, line || " "));
  }
  return box;
}

async function showDiff(rel: string) {
  try {
    const diff = await invoke<string>("git_diff", { root, rel });
    await showInSide(`Changes in ${rel}`, diffView(diff));
  } catch (e) {
    setStatus(`Couldn't get the diff for ${rel}: ${e}`, "err");
  }
}

async function act(button: HTMLButtonElement, busy: string, command: string, args: Record<string, unknown>, done: string) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busy;
  try {
    await invoke(command, { root, ...args });
    setStatus(done, "ok");
    return true;
  } catch (e) {
    setStatus(String(e).split("\n")[0], "err");
    return false;
  } finally {
    button.textContent = label;
    await renderGit();
    refreshFiles();
  }
}

export async function renderGit() {
  if (panel.hidden || !root) return;
  const mine = ++job;
  let overview: Overview;
  try {
    overview = await invoke<Overview>("git_overview", { root });
  } catch (e) {
    panel.replaceChildren(el("div", "empty", `Couldn't read git status: ${e}`));
    return;
  }
  if (mine !== job) return;
  const frag = document.createDocumentFragment();

  if (!overview.repo) {
    frag.appendChild(el("div", "empty", "This project isn't under version control yet. A repository keeps every version of the paper."));
    const init = el("button", "btn btn-outline git-wide", "Create a git repository");
    init.onclick = () => act(init, "Creating…", "git_init", {}, "Repository created");
    frag.appendChild(init);
    panel.replaceChildren(frag);
    return;
  }

  // commit box
  const message = el("textarea", "git-message");
  message.placeholder = "What changed? (commit message)";
  message.rows = 2;
  message.value = draft;
  message.setAttribute("aria-label", "Commit message");
  const commit = el("button", "btn btn-primary", "Commit all");
  const sync = () => { commit.disabled = !overview.changes.length || !message.value.trim(); };
  message.oninput = () => { draft = message.value; sync(); };
  commit.onclick = async () => {
    const text = message.value;
    if (await act(commit, "Committing…", "git_commit", { message: text, name: profile.name || null, email: profile.email || null }, "Committed")) draft = "";
  };
  commit.title = "Commit every change in this project";
  sync();
  const actions = el("div", "git-actions");
  actions.appendChild(commit);
  if (overview.has_remote) {
    const push = el("button", "btn btn-outline", "Push");
    push.title = "Send commits to the remote";
    push.onclick = () => act(push, "Pushing…", "git_push", {}, "Pushed");
    actions.appendChild(push);
  }
  frag.append(message, actions);

  // changes
  frag.appendChild(el("h3", "gallery-heading", overview.changes.length ? `Changes (${overview.changes.length})` : "Changes"));
  if (!overview.changes.length) frag.appendChild(el("div", "empty", "Nothing has changed since the last commit."));
  for (const change of overview.changes) {
    const row = el("button", "git-row");
    row.title = `${STATUS_LABEL[change.status] ?? change.status}: ${change.path}. Click to see what changed.`;
    row.append(
      el("span", `git-mark git-${STATUS_CLASS[change.status] ?? "mod"}`, change.status === "?" ? "U" : change.status),
      el("span", "git-path", change.path),
    );
    row.onclick = () => showDiff(change.path);
    frag.appendChild(row);
  }

  // history
  if (overview.log.length) {
    frag.appendChild(el("h3", "gallery-heading", "Recent commits"));
    for (const c of overview.log) {
      const row = el("div", "git-commit");
      row.title = `${c.hash}  ${c.subject}`;
      row.append(el("span", "git-subject", c.subject), el("span", "git-when", c.when));
      frag.appendChild(row);
    }
  }
  panel.replaceChildren(frag);
  if (document.activeElement === document.body && draft) message.focus();
}
