// Suggestions as you type: after a pause, the model's guess at what comes next appears in grey at
// the cursor. Tab takes it; typing anything else, moving, or Escape lets it go. Off unless turned
// on in Settings > AI, since every pause sends the text around the cursor.
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { aiConfig, aiReady, aiStream } from "./ai";

const PAUSE = 750;
const BEFORE = 3000;
const AFTER = 800;

const SYSTEM = `You continue the author's text in a LaTeX or Markdown document, as autocomplete. You get the text before the cursor and after it. Reply with only what goes at the cursor: usually the rest of the sentence, at most two sentences or a few lines of LaTeX. No explanation, no code fences, no repetition of text already there. If nothing useful fits, reply with nothing.`;

interface Suggestion { pos: number; text: string }

const setSuggestion = StateEffect.define<Suggestion | null>();

class Ghost extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: Ghost) { return other.text === this.text; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return true; }
}

const suggestion = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSuggestion)) return e.value;
    // any edit or cursor move makes the suggestion stale
    return tr.docChanged || tr.selection ? null : value;
  },
  provide: (f) => EditorView.decorations.from(f, (s): DecorationSet =>
    s ? Decoration.set([Decoration.widget({ widget: new Ghost(s.text), side: 1 }).range(s.pos)]) : Decoration.none),
});

const asker = ViewPlugin.fromClass(class {
  timer = 0;
  pending: AbortController | null = null;
  constructor(readonly view: EditorView) {}

  update(u: ViewUpdate) {
    if (!u.docChanged && !u.selectionSet) return;
    this.pending?.abort();
    this.pending = null;
    clearTimeout(this.timer);
    // only after typing, with nothing selected, at the end of a line or before a space
    const typed = u.transactions.some((tr) => tr.isUserEvent("input.type"));
    if (!typed || !aiConfig.inline || !aiReady()) return;
    this.timer = window.setTimeout(() => this.ask(), PAUSE);
  }

  async ask() {
    const { state } = this.view;
    const sel = state.selection.main;
    if (!sel.empty) return;
    const pos = sel.head;
    const next = state.sliceDoc(pos, pos + 1);
    if (next && !/\s/.test(next)) return;
    const before = state.sliceDoc(Math.max(0, pos - BEFORE), pos);
    if (before.trim().length < 20) return;
    const after = state.sliceDoc(pos, Math.min(state.doc.length, pos + AFTER));
    const pending = (this.pending = new AbortController());
    try {
      const { text, reason } = await aiStream({
        system: SYSTEM,
        messages: [{ role: "user", content: `Text before the cursor:\n${before}\n\nText after the cursor:\n${after}\n\nWhat goes at the cursor?` }],
        maxTokens: 600,
        speed: "low",
        stop: ["\n\n"],
      }, undefined, pending.signal);
      if (reason === "cancelled" || pending.signal.aborted || this.view.state.selection.main.head !== pos) return;
      let guess = text.replace(/^```\w*\n?|```$/g, "").replace(/\s+$/, "");
      // a space where the sentence needs one, never a doubled one
      if (/\S$/.test(before) && /^[A-Za-z0-9\\(]/.test(guess) && !/[([{]$/.test(before)) guess = ` ${guess}`;
      if (!guess.trim()) return;
      this.view.dispatch({ effects: setSuggestion.of({ pos, text: guess }) });
    } catch {
      // a failed suggestion is simply not shown
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  destroy() {
    this.pending?.abort();
    clearTimeout(this.timer);
  }
});

/** Tab takes the suggestion (above snippets and indentation); Escape dismisses it. */
const keys = Prec.highest(keymap.of([
  {
    key: "Tab",
    run: (view) => {
      const s = view.state.field(suggestion, false);
      if (!s || view.state.selection.main.head !== s.pos) return false;
      view.dispatch({ changes: { from: s.pos, insert: s.text }, selection: { anchor: s.pos + s.text.length }, userEvent: "input.complete" });
      return true;
    },
  },
  {
    key: "Escape",
    run: (view) => {
      if (!view.state.field(suggestion, false)) return false;
      view.dispatch({ effects: setSuggestion.of(null) });
      return true;
    },
  },
]));

/** Suggestions for writing files: LaTeX and Markdown. */
export function aiSuggestions(path: string): Extension {
  return /\.(tex|md)$/.test(path) ? [suggestion, asker, keys] : [];
}
