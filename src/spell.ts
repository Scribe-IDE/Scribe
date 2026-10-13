// Spell check for prose files, using the operating system's checker. Misspelled words get a
// wavy underline; right-clicking one offers corrections.
import { EditorView } from "codemirror";
import { Decoration, DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Extension, StateEffect, StateField } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import { MenuItem, openContextMenu } from "./menubar";
import { proseKind, spellWords } from "./prose";

/** Turned on and off from settings. */
export const spellPrefs = { on: true };

// Answers are remembered for the session: a word is asked about once.
const known = new Map<string, boolean>(); // word -> misspelled
const ignored = new Set<string>();
let available: boolean | null = null;

const setMarks = StateEffect.define<DecorationSet>();
const mark = Decoration.mark({ class: "cm-misspelled" });

const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMarks)) return effect.value;
    return value.map(tr.changes); // underlines follow their words until the next check
  },
  provide: (field) => EditorView.decorations.from(field),
});

async function check(view: EditorView, kind: "tex" | "plain") {
  if (available === null) available = await invoke<boolean>("spell_available").catch(() => false);
  if (!available || !spellPrefs.on) {
    if (view.state.field(marks).size) view.dispatch({ effects: setMarks.of(Decoration.none) });
    return;
  }
  const text = view.state.doc.toString();
  const words = spellWords(text, kind);
  const unknown = [...new Set(words.map((w) => w.word).filter((w) => !known.has(w)))];
  if (unknown.length) {
    const bad = new Set(await invoke<string[]>("spell_check", { words: unknown }).catch(() => [] as string[]));
    for (const word of unknown) known.set(word, bad.has(word));
  }
  if (view.state.doc.toString() !== text) return; // typed meanwhile; the next check will cover it
  const ranges = words
    .filter((w) => known.get(w.word) && !ignored.has(w.word))
    .map((w) => mark.range(w.from, w.to));
  view.dispatch({ effects: setMarks.of(Decoration.set(ranges)) });
}

/** The misspelled word at a document position, if there is one. */
function wordAt(view: EditorView, pos: number): { from: number; to: number; word: string } | null {
  let hit: { from: number; to: number; word: string } | null = null;
  view.state.field(marks).between(pos, pos, (from, to) => {
    hit = { from, to, word: view.state.sliceDoc(from, to) };
    return false;
  });
  return hit;
}

function checker(kind: "tex" | "plain") {
  return ViewPlugin.fromClass(class {
    timer: number | null = null;
    constructor(readonly view: EditorView) {
      this.schedule(300);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.schedule(700);
    }
    schedule(delay: number) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        check(this.view, kind).catch(() => {});
      }, delay);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  });
}

const corrections = EditorView.domEventHandlers({
  contextmenu(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const hit = pos === null ? null : wordAt(view, pos);
    if (!hit) return false; // not on a misspelling: leave the normal menu alone
    event.preventDefault();
    const { clientX, clientY } = event;
    invoke<string[]>("spell_suggest", { word: hit.word }).catch(() => [] as string[]).then((guesses) => {
      const recheck = () => refreshSpelling(view);
      const items: (MenuItem | "-")[] = guesses.length
        ? guesses.map((guess) => ({
            title: guess,
            run: () => view.dispatch({ changes: { from: hit.from, to: hit.to, insert: guess }, userEvent: "input.replace" }),
          }))
        : [{ title: "No suggestions", enabled: false }];
      items.push(
        "-",
        { title: `Add “${hit.word}” to Dictionary`, run: async () => { await invoke("spell_learn", { word: hit.word }).catch(() => {}); known.set(hit.word, false); recheck(); } },
        { title: "Ignore in This Session", run: () => { ignored.add(hit.word); recheck(); } },
      );
      openContextMenu(clientX, clientY, items);
    });
    return true;
  },
});

/** Spell checking for a file, or nothing if the file isn't prose. */
export function spellExtension(path: string): Extension {
  const kind = proseKind(path);
  return kind ? [marks, checker(kind), corrections] : [];
}

/** Check again now: after a setting changes or a word is learned. */
export function refreshSpelling(view: EditorView) {
  const kind = proseKind(view.dom.dataset.path ?? null);
  if (kind && view.state.field(marks, false)) check(view, kind).catch(() => {});
}
