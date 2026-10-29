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
  // the ANSI colours are the theme's syntax colours, so the terminal matches the editor
  return {
    background: v("--panel"),
    foreground: v("--fg"),
    cursor: v("--accent"),
    cursorAccent: v("--panel"),
    selectionBackground: v("--select"),
    black: v("--raised"), red: v("--syn-kw"), green: v("--syn-str"), yellow: v("--syn-type"),
    blue: v("--syn-math"), magenta: v("--syn-num"), cyan: v("--syn-meta"), white: v("--fg-dim"),
    brightBlack: v("--faint"), brightRed: v("--err"), brightGreen: v("--ok"), brightYellow: v("--accent"),
    brightBlue: v("--syn-cmd"), brightMagenta: v("--syn-num"), brightCyan: v("--syn-meta"), brightWhite: v("--fg"),
  };
}

// One step below the editor's size, so zooming the editor zooms the terminal with it.
const fontSize = () => Math.max(10, (parseInt(getComputedStyle(document.documentElement).getPropertyValue("--editor-fs")) || 13) - 1);

// The editor's font, chosen in Settings.
const monoFamily = () => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";

/** Call when the app theme or the editor font size changes. */
export function refreshTerminalTheme() {
  if (!term) return;
  term.options.theme = palette();
  const family = monoFamily();
  if (term.options.fontSize !== fontSize() || term.options.fontFamily !== family) {
    term.options.fontSize = fontSize();
    term.options.fontFamily = family;
    if (!termPanel.hidden) fit?.fit();
  }
}

// Created on first use: xterm measures its container, which has no size while the panel is hidden.
function ensureTerminal(): Terminal {
  if (term) return term;
  term = new Terminal({
    fontFamily: monoFamily(),
    fontSize: fontSize(),
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
