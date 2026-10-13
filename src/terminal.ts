// Terminal panel: runs commands and standalone Python files, streaming their output.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { $, current, dirty, root } from "./core";
import { notebookMode } from "./notebook";
import { save } from "./project";

// ---------- terminal ----------
// Runs commands in the project folder and streams their output. Not a full shell emulator:
// no cursor control or full-screen programs, but input() and long-running scripts work.
export const termPanel = $("term-panel");
export const termOut = $<HTMLPreElement>("term-output");
export const termInput = $<HTMLInputElement>("term-input");
export const termHistory: string[] = [];
export let termHistoryAt = 0;
export let termRunning = false;

// A standalone script: a .py that is not being shown as notebook cells.
export const canRunFile = () => !!current && current.endsWith(".py") && !notebookMode;
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function termWrite(text: string, kind?: "term-cmd" | "term-note" | "term-err") {
  const pinned = termOut.scrollHeight - termOut.scrollTop - termOut.clientHeight < 24;
  // Colour codes and carriage returns would show up as noise in a plain text view.
  const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
  if (kind) {
    const span = document.createElement("span");
    span.className = kind;
    span.textContent = clean;
    termOut.appendChild(span);
  } else {
    termOut.append(clean);
  }
  while (termOut.childNodes.length > 3000) termOut.firstChild!.remove();
  if (pinned) termOut.scrollTop = termOut.scrollHeight;
}

export function setTermRunning(running: boolean) {
  termRunning = running;
  $<HTMLButtonElement>("term-stop").disabled = !running;
  termInput.placeholder = running ? "Type input for the running program" : "Run a command in the project folder";
}

export function showTerminal(show: boolean) {
  termPanel.hidden = !show;
  if (show) termOut.scrollTop = termOut.scrollHeight;
}

export async function termRun(command: string) {
  if (!root) return;
  showTerminal(true);
  if (termRunning) {
    termWrite("A command is still running. Stop it first.\n", "term-note");
    return;
  }
  termWrite(`$ ${command}\n`, "term-cmd");
  setTermRunning(true);
  try {
    await invoke("term_run", { root, command });
  } catch (e) {
    termWrite(`${e}\n`, "term-err");
    setTermRunning(false);
  }
}

export async function runFile() {
  if (!canRunFile()) return;
  if (dirty) await save();
  const python = await invoke<string>("python_bin").catch(() => "python3");
  await termRun(`${python} -u ${shellQuote(current!)}`);
}

export const stopTerminal = async () => {
  await invoke("term_stop").catch(() => {});
};

export async function resetTerminal() {
  await stopTerminal();
  termOut.replaceChildren();
  showTerminal(false);
}

setTermRunning(false);
listen<string>("term-output", (e) => termWrite(e.payload)).catch(() => {});
listen<number | null>("term-exit", (e) => {
  const code = e.payload;
  termWrite(code === 0 ? "[finished]\n" : code === null ? "[stopped]\n" : `[exit code ${code}]\n`, code === 0 ? "term-note" : "term-err");
  setTermRunning(false);
}).catch(() => {});

termInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const text = termInput.value;
    termInput.value = "";
    if (termRunning) {
      termWrite(`${text}\n`, "term-cmd");
      invoke("term_input", { text: `${text}\n` }).catch(() => {});
    } else if (text.trim()) {
      termHistory.push(text);
      termHistoryAt = termHistory.length;
      termRun(text);
    }
  } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    if (!termHistory.length) return;
    termHistoryAt = Math.min(termHistory.length, Math.max(0, termHistoryAt + (e.key === "ArrowUp" ? -1 : 1)));
    termInput.value = termHistory[termHistoryAt] ?? "";
  } else if (e.key === "c" && e.ctrlKey && termRunning) {
    stopTerminal();
  } else {
    return;
  }
  e.preventDefault();
});
$("term-stop").onclick = stopTerminal;
$("term-clear").onclick = () => termOut.replaceChildren();
$("term-close").onclick = () => showTerminal(false);
$("btn-run-file").onclick = runFile;
