// Command registry: the menu bar, the command palette and the global shortcuts all read
// from here, so a command's title, shortcut and enabled state are defined exactly once.

import { isMac } from "./core";

export type CommandGroup = "File" | "Edit" | "Insert" | "View" | "Build" | "Review" | "Notes" | "Help";

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  /** CodeMirror-style combo, e.g. "Mod-Shift-p". Shown in menus and bound globally. */
  keys?: string;
  /** Inline SVG shown beside the title in menus. */
  icon?: string;
  /** The shortcut is shown but handled elsewhere (natively, or by the focused editor). */
  passive?: boolean;
  run(): void | Promise<void>;
  enabled?(): boolean;
  checked?(): boolean;
}

const registry = new Map<string, Command>();

export function register(...commands: Command[]) {
  for (const c of commands) registry.set(c.id, c);
}

export const allCommands = () => [...registry.values()];
export const getCommand = (id: string) => registry.get(id);
export const isEnabled = (c: Command) => c.enabled?.() ?? true;

export async function runCommand(id: string) {
  const c = registry.get(id);
  if (!c || !isEnabled(c)) return;
  try {
    await c.run();
  } catch (e) {
    console.error(`Command ${id} failed`, e);
  }
}

const KEY_LABEL: Record<string, string> = {
  enter: "↵", escape: "⎋", backspace: "⌫", tab: "⇥",
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
  minus: "-", // spelled out in combos because "-" is the separator
};
const PC_KEY_LABEL: Record<string, string> = { enter: "Enter", escape: "Esc", backspace: "Backspace", tab: "Tab" };

/** "Mod-Shift-p" → "⇧⌘P" on a Mac, "Ctrl+Shift+P" elsewhere */
export function formatKeys(keys: string): string {
  const parts = keys.split("-");
  const key = parts.pop()!.toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  if (!isMac) {
    const names = [mods.has("ctrl") || mods.has("mod") ? "Ctrl" : "", mods.has("alt") ? "Alt" : "", mods.has("shift") ? "Shift" : ""];
    return [...names.filter(Boolean), PC_KEY_LABEL[key] ?? KEY_LABEL[key] ?? key.toUpperCase()].join("+");
  }
  return (
    (mods.has("ctrl") ? "⌃" : "") +
    (mods.has("alt") ? "⌥" : "") +
    (mods.has("shift") ? "⇧" : "") +
    (mods.has("mod") ? "⌘" : "") +
    (KEY_LABEL[key] ?? key.toUpperCase())
  );
}

const normalize = (keys: string) => {
  const parts = keys.toLowerCase().split("-");
  const key = parts.pop()!;
  return [...parts].sort().join("-") + "-" + key;
};

function comboOf(e: KeyboardEvent): string | null {
  // Every global shortcut uses ⌘ (or Ctrl) on a Mac and Ctrl elsewhere, where the Windows key belongs to the system.
  if (!(isMac ? e.metaKey || e.ctrlKey : e.ctrlKey)) return null;
  let key = e.key.toLowerCase();
  // ⌥ changes the character on a Mac (⌥N types ˜), so with ⌥ held go by the physical key.
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  if (key === "+") key = "="; // ⌘+ and ⌘= both zoom in
  if (key === "-") key = "minus";
  const mods = ["mod"];
  if (e.shiftKey && key !== "=") mods.push("shift");
  if (e.altKey) mods.push("alt");
  return mods.sort().join("-") + "-" + key;
}

export function installKeybindings() {
  window.addEventListener("keydown", (e) => {
    // The editor keymap runs first; anything it claimed is already handled.
    if (e.defaultPrevented || e.isComposing) return;
    const combo = comboOf(e);
    if (!combo) return;
    for (const c of registry.values()) {
      if (!c.keys || c.passive || normalize(c.keys) !== combo) continue;
      e.preventDefault();
      runCommand(c.id);
      return;
    }
  });
}
