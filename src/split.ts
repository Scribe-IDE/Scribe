// Side pane: a second text file open beside the main one, or a read-only document such as a
// diff. It has its own editor and its own unsaved state; notebooks always open in the main pane.
import { EditorView } from "codemirror";
import { invoke } from "@tauri-apps/api/core";
import { $, clamp, current, root, setStatus, VIEWABLE } from "./core";
import { createEditorState, prefEffects, view } from "./editor";
import { activeCell, cellViews, isNotebook } from "./notebook";
import { ICONS } from "./icons";
import { openFile } from "./project";
import { saveSessionSoon } from "./session";
import { FILE_ICON } from "./sidebar";

const pane = $("work-side");
const handle = $("split-handle");
const titleEl = $("side-title");
const body = $("side-body");

/** The file being edited in the side pane, if it is showing a file. */
export let sideFile: string | null = null;
export let sideView: EditorView | null = null;
let sideDirty = false;

export const sideOpen = () => !pane.hidden;

/** The editor that typing-related commands should act on: the side pane if it has the
 *  keyboard, otherwise the main editor, otherwise the notebook cell last used. */
export function activeEditor(): EditorView | null {
  if (sideView?.dom.contains(document.activeElement)) return sideView;
  if (current && !$("editor").hidden) return view;
  return isNotebook() ? cellViews[activeCell] ?? null : null;
}
/** The side editor has the keyboard, so save and edit commands should act on it. */
export const sideFocused = () => !!sideView?.hasFocus;

// Same icon and wording as a tab: a file shows its type, anything else (a diff) the git mark.
function renderTitle(text: string) {
  const icon = document.createElement("span");
  if (sideFile) {
    const ext = sideFile.slice(sideFile.lastIndexOf(".") + 1).toLowerCase();
    icon.className = `file-icon file-${ext in FILE_ICON ? ext : "text"}`;
    icon.innerHTML = FILE_ICON[ext] ?? FILE_ICON.text;
  } else {
    icon.className = "file-icon";
    icon.innerHTML = ICONS.branch;
  }
  const label = document.createElement("span");
  label.className = "side-label";
  label.textContent = text;
  titleEl.replaceChildren(icon, label);
  titleEl.title = sideFile ? `${text}. Double-click to move it to the main pane.` : text;
  titleEl.classList.toggle("dirty", sideDirty);
}

function show() {
  pane.hidden = false;
  handle.hidden = false;
}

function clear() {
  sideView?.destroy();
  sideView = null;
  sideFile = null;
  sideDirty = false;
  body.replaceChildren();
}

export async function saveSide() {
  if (!root || !sideFile || !sideView || !sideDirty) return;
  await invoke("write_file", { root, rel: sideFile, content: sideView.state.doc.toString() });
  sideDirty = false;
  renderTitle(sideFile);
}

export async function closeSide() {
  await saveSide().catch((e) => setStatus(`Couldn't save ${sideFile}: ${e}`, "err"));
  clear();
  pane.hidden = true;
  handle.hidden = true;
}

/** Open a text file in the side pane, for reading or editing beside the main file. */
export async function openToSide(rel: string) {
  if (!root) return;
  if (VIEWABLE.test(rel)) {
    setStatus("Previews open in the main pane.");
    return;
  }
  if (rel === current) {
    setStatus(`${rel} is already open on the left`);
    return;
  }
  let text: string;
  try {
    text = await invoke<string>("read_file", { root, rel });
  } catch (e) {
    setStatus(`Couldn't open ${rel}: ${e}`, "err");
    return;
  }
  // Notebook cells only run in the main pane. To put a notebook beside the paper, the two
  // trade places: the notebook takes the main pane and the file that was there moves here.
  if (rel.endsWith(".ipynb") || (rel.endsWith(".py") && /^# %%/m.test(text))) {
    const beside = current && !VIEWABLE.test(current) && !isNotebook() ? current : null;
    await openFile(rel);
    if (beside) await openToSide(beside);
    return;
  }
  await saveSide();
  clear();
  sideFile = rel;
  show();
  sideView = new EditorView({
    parent: body,
    state: createEditorState(text, rel, {
      onChange: () => {
        if (sideDirty) return;
        sideDirty = true;
        renderTitle(rel);
      },
      onSave: () => { saveSide(); },
    }),
  });
  renderTitle(rel);
  sideView.focus();
}

/** Show something read-only (a diff, say) in the side pane. */
export async function showInSide(title: string, content: HTMLElement) {
  await saveSide();
  clear();
  show();
  body.appendChild(content);
  renderTitle(title);
}

/** Bring the side editor in line with changed preferences (theme, Vim keys, line numbers). */
export function refreshSidePrefs() {
  sideView?.dispatch({ effects: prefEffects() });
}

/** The side file was renamed or moved. */
export function sideMoved(moved: (rel: string) => string) {
  if (!sideFile) return;
  sideFile = moved(sideFile);
  renderTitle(sideFile);
}

/** Files were deleted: a side pane showing one of them closes without saving it back. */
export function sideGone(gone: (rel: string) => boolean) {
  if (!sideFile || !gone(sideFile)) return;
  sideDirty = false;
  closeSide();
}

/** Put the side file in the main pane and close the side. */
export async function moveSideToMain() {
  const rel = sideFile;
  if (!rel) return;
  await closeSide();
  await openFile(rel);
}

$("side-close").onclick = () => closeSide();
titleEl.ondblclick = () => moveSideToMain();

// Drag the divider to set how the two panes share the width.
handle.addEventListener("pointerdown", (down) => {
  down.preventDefault();
  handle.setPointerCapture(down.pointerId);
  const work = $("work");
  const move = (e: PointerEvent) => {
    const box = work.getBoundingClientRect();
    const share = clamp((box.right - e.clientX) / box.width, 0.2, 0.8);
    work.style.setProperty("--side-share", `${(share * 100).toFixed(1)}%`);
  };
  const up = () => handle.removeEventListener("pointermove", move);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up, { once: true });
  handle.addEventListener("pointercancel", up, { once: true });
});
