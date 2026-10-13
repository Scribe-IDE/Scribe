// Terminal panel: the user's own shell, running in the project folder.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { $, current, dirty, root } from "./core";
import { notebookMode } from "./notebook";
import { save } from "./project";

export const termPanel = $("term-panel");
const host = $("term-host");

let term: Terminal | null = null;
let fit: FitAddon | null = null;
/** A shell is running behind the panel. */
export let shellAlive = false;

// A standalone script: a .py that is not being shown as notebook cells.
export const canRunFile = () => !!current && current.endsWith(".py") && !notebookMode;
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// xterm draws on a canvas-like grid and can't read CSS variables, so resolve them to colours.
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const light = document.documentElement.getAttribute("data-theme") === "light";
  return {
    background: v("--panel"),
    foreground: v("--fg"),
    cursor: v("--accent"),
    cursorAccent: v("--panel"),
    selectionBackground: light ? "rgba(184, 134, 46, .28)" : "rgba(212, 165, 86, .3)",
    // gruvbox, dark or light to match the app
    black: light ? "#3c3836" : "#282828", red: light ? "#9d0006" : "#fb4934", green: light ? "#79740e" : "#b8bb26",
    yellow: light ? "#b57614" : "#fabd2f", blue: light ? "#076678" : "#83a598", magenta: light ? "#8f3f71" : "#d3869b",
    cyan: light ? "#427b58" : "#8ec07c", white: light ? "#7c6f64" : "#d5c4a1",
    brightBlack: "#928374", brightRed: light ? "#cc241d" : "#fb4934", brightGreen: light ? "#98971a" : "#b8bb26",
    brightYellow: light ? "#d79921" : "#fabd2f", brightBlue: light ? "#458588" : "#83a598",
    brightMagenta: light ? "#b16286" : "#d3869b", brightCyan: light ? "#689d6a" : "#8ec07c",
    brightWhite: light ? "#282828" : "#fbf1c7",
  };
}

/** Call when the app theme changes. */
export function refreshTerminalTheme() {
  if (term) term.options.theme = palette();
}

// Created on first use: xterm measures its container, which has no size while the panel is hidden.
function ensureTerminal(): Terminal {
  if (term) return term;
  term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.3,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: palette(),
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((data) => {
    if (shellAlive) invoke("pty_write", { data }).catch(() => {});
    else startShell(); // any key restarts a shell that has exited
  });
  term.onResize(({ cols, rows }) => {
    invoke("pty_resize", { cols, rows }).catch(() => {});
  });
  new ResizeObserver(() => {
    if (!termPanel.hidden) fit?.fit();
  }).observe(host);
  return term;
}

async function startShell() {
  if (shellAlive || !root) return;
  const t = ensureTerminal();
  fit?.fit();
  try {
    await invoke("pty_start", { root, cols: t.cols, rows: t.rows });
    shellAlive = true;
  } catch (e) {
    t.writeln(`\r\nCouldn't start a shell: ${e}`);
  }
}

export async function showTerminal(show: boolean) {
  termPanel.hidden = !show;
  if (!show) return;
  ensureTerminal();
  await startShell();
  fit?.fit();
  term?.focus();
}

/** Type a command into the shell as if the user had. */
async function sendLine(command: string) {
  await showTerminal(true);
  if (shellAlive) await invoke("pty_write", { data: `${command}\r` }).catch(() => {});
}

export async function runFile() {
  if (!canRunFile()) return;
  if (dirty) await save();
  const python = await invoke<string>("python_bin").catch(() => "python3");
  await sendLine(`${python} -u ${shellQuote(current!)}`);
}

/** Ctrl+C: interrupts whatever is running in the shell. */
export const stopTerminal = async () => {
  if (shellAlive) await invoke("pty_write", { data: "\x03" }).catch(() => {});
};

/** The project changed: end its shell and start clean. */
export async function resetTerminal() {
  await invoke("pty_kill").catch(() => {});
  shellAlive = false;
  term?.reset();
  termPanel.hidden = true;
}

listen<string>("pty-output", (e) => term?.write(e.payload)).catch(() => {});
listen("pty-exit", () => {
  shellAlive = false;
  term?.write("\r\n\x1b[2m[shell exited. Press any key to start a new one.]\x1b[0m\r\n");
}).catch(() => {});

$("term-stop").onclick = () => { stopTerminal(); term?.focus(); };
$("term-clear").onclick = () => { term?.clear(); term?.focus(); };
$("term-close").onclick = () => showTerminal(false);
$("btn-run-file").onclick = runFile;
