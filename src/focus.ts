// Focus mode: only the text, centred at a reading width, the line being written kept mid-screen,
// and a quiet count of today's words (from the file's saved versions) against an optional goal.
import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import { current, root } from "./core";
import { editorPrefs, view } from "./editor";
import { promptInput } from "./palette";
import { countWords, proseKind } from "./prose";

const GOAL_KEY = "scribe.dailyGoal";
let on = false;
let meter: HTMLElement | null = null;
/** Words in the file at the start of today, per file. */
const baseline = new Map<string, number>();
let timer = 0;

export const focusOn = () => on;

function goal(): number {
  try {
    return Number(localStorage.getItem(GOAL_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** The file's words when today began: its last version from before today, or the version saved
 *  before today's first change. Null when there's nothing to compare with. */
async function wordsAtStartOfDay(rel: string): Promise<number | null> {
  const kind = proseKind(rel);
  if (!root || !kind) return null;
  const versions = await invoke<{ id: number }[]>("history_list", { root, rel }).catch(() => []);
  if (!versions.length) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() / 1000;
  const sorted = [...versions].sort((a, b) => a.id - b.id);
  const before = sorted.filter((v) => v.id < start).pop() ?? sorted[0];
  const text = await invoke<string>("history_read", { root, rel, id: before.id }).catch(() => null);
  return text == null ? null : countWords(text, kind);
}

async function updateMeter() {
  if (!meter || !current) return;
  const kind = proseKind(current);
  if (!kind) {
    meter.textContent = "";
    return;
  }
  const words = countWords(view.state.doc.toString(), kind);
  if (!baseline.has(current)) {
    const start = await wordsAtStartOfDay(current);
    baseline.set(current, start ?? words);
  }
  const today = Math.max(0, words - (baseline.get(current) ?? words));
  const target = goal();
  meter.replaceChildren();
  const text = document.createElement("span");
  text.textContent = `${words.toLocaleString()} words · ${today.toLocaleString()} today${target ? ` of ${target.toLocaleString()}` : ""}`;
  meter.append(text);
  if (target) {
    const bar = document.createElement("span");
    bar.className = "focus-bar";
    bar.style.setProperty("--done", `${Math.min(100, (today / target) * 100)}%`);
    meter.append(bar);
  }
}

export function focusChanged() {
  if (!on) return;
  clearTimeout(timer);
  timer = window.setTimeout(updateMeter, 400);
}

function leaveOnEscape(e: KeyboardEvent) {
  // Escape belongs to Vim and to open completion lists first
  if (e.key !== "Escape" || editorPrefs.vim || document.querySelector(".cm-tooltip-autocomplete")) return;
  toggleFocus(false);
}

export function toggleFocus(force?: boolean) {
  on = force ?? !on;
  document.documentElement.toggleAttribute("data-focus", on);
  editorPrefs.typewriter = on;
  if (on) {
    meter = document.createElement("button");
    meter.id = "focus-meter";
    meter.title = "Set a goal for the words you write today";
    meter.onclick = () => promptInput({
      placeholder: "Words to write today",
      hint: "A number, or 0 for no goal. Kept on this computer.",
      value: String(goal() || 500),
      validate: (v) => (/^\d+$/.test(v.trim()) ? null : "A whole number of words"),
      submit: (v) => {
        try {
          localStorage.setItem(GOAL_KEY, String(Number(v)));
        } catch { /* no storage */ }
        updateMeter();
      },
    });
    document.body.append(meter);
    window.addEventListener("keydown", leaveOnEscape);
    updateMeter();
  } else {
    meter?.remove();
    meter = null;
    window.removeEventListener("keydown", leaveOnEscape);
  }
  for (const el of [document.documentElement, document.body, document.getElementById("app")]) if (el) el.scrollTop = 0;
  view.requestMeasure();
  view.focus();
  if (on) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
}
