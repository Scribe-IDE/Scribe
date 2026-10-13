// One floating input used three ways: command palette, quick open, and a single-line prompt.

export interface PaletteItem {
  label: string;
  detail?: string;
  hint?: string;
  run(): void | Promise<void>;
}

interface PickOptions {
  placeholder: string;
  items: PaletteItem[];
  empty: string;
}

interface PromptOptions {
  placeholder: string;
  hint: string;
  /** Starting text; the file name part (without folder or extension) is preselected. */
  value?: string;
  /** Return a message to block submission, or null when the value is fine. */
  validate?(value: string): string | null;
  submit(value: string): void | Promise<void>;
}

const MAX_RESULTS = 60;

let el: HTMLElement | null = null;
let input: HTMLInputElement;
let list: HTMLElement;
let note: HTMLElement;
let restoreFocus: HTMLElement | null = null;
let onInput: () => void = () => {};
let onEnter: () => void = () => {};
let shown: PaletteItem[] = [];
let active = 0;

/** Subsequence match; higher is better, -1 means no match. */
function score(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let total = 0;
  let from = 0;
  let streak = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return -1;
    streak = at === from ? streak + 1 : 0;
    const wordStart = at === 0 || /[\s/._:-]/.test(t[at - 1]);
    total += 1 + streak * 2 + (wordStart ? 4 : 0);
    from = at + 1;
  }
  return total - t.length * 0.01; // prefer shorter targets on ties
}

function ensure() {
  if (el) return;
  el = document.createElement("div");
  el.id = "palette";
  el.setAttribute("role", "dialog");
  el.hidden = true;
  input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  list = document.createElement("div");
  list.className = "palette-list";
  list.setAttribute("role", "listbox");
  note = document.createElement("div");
  note.className = "palette-note";
  el.append(input, list, note);
  document.body.appendChild(el);

  input.addEventListener("input", () => onInput());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePalette();
    else if (e.key === "Enter") onEnter();
    else if (e.key === "ArrowDown") setActive(active + 1);
    else if (e.key === "ArrowUp") setActive(active - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  list.addEventListener("mousedown", (e) => e.preventDefault());
  document.addEventListener("pointerdown", (e) => {
    if (el && !el.hidden && !el.contains(e.target as Node)) closePalette();
  });
}

function setActive(index: number) {
  if (!shown.length) return;
  active = (index + shown.length) % shown.length;
  list.querySelector(".active")?.classList.remove("active");
  const row = list.children[active] as HTMLElement | undefined;
  row?.classList.add("active");
  row?.scrollIntoView({ block: "nearest" });
}

function setNote(text: string, isError = false) {
  note.textContent = text;
  note.hidden = !text;
  note.classList.toggle("err", isError);
}

function show(placeholder: string) {
  ensure();
  if (el!.hidden) restoreFocus = document.activeElement as HTMLElement | null;
  input.value = "";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  el!.hidden = false;
  input.focus();
}

export function closePalette() {
  if (!el || el.hidden) return;
  el.hidden = true;
  list.replaceChildren();
  shown = [];
  restoreFocus?.focus();
  restoreFocus = null;
}

export function isPaletteOpen() {
  return !!el && !el.hidden;
}

export function openPalette({ placeholder, items, empty }: PickOptions) {
  show(placeholder);

  const choose = (item: PaletteItem) => {
    closePalette(); // restores focus first, so commands act on the editor
    item.run();
  };

  onInput = () => {
    const query = input.value.trim();
    shown = items
      .map((item) => ({ item, s: Math.max(score(query, item.label), score(query, `${item.detail ?? ""} ${item.label}`)) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_RESULTS)
      .map((r) => r.item);

    const frag = document.createDocumentFragment();
    for (const item of shown) {
      const row = document.createElement("div");
      row.className = "palette-item";
      row.setAttribute("role", "option");
      const label = document.createElement("span");
      label.className = "palette-label";
      label.textContent = item.label;
      row.appendChild(label);
      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "palette-detail";
        detail.textContent = item.detail;
        row.appendChild(detail);
      }
      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "palette-hint";
        hint.textContent = item.hint;
        row.appendChild(hint);
      }
      row.addEventListener("mousemove", () => {
        const at = [...list.children].indexOf(row);
        if (at !== active) setActive(at);
      });
      row.addEventListener("click", () => choose(item));
      frag.appendChild(row);
    }
    list.replaceChildren(frag);
    list.hidden = shown.length === 0;
    setNote(shown.length ? "" : items.length ? `Nothing matches “${query}”.` : empty);
    setActive(0);
  };
  onEnter = () => {
    if (shown[active]) choose(shown[active]);
  };
  onInput();
}

export function promptInput({ placeholder, hint, value, validate, submit }: PromptOptions) {
  show(placeholder);
  if (value) {
    input.value = value;
    const start = value.lastIndexOf("/") + 1;
    const dot = value.lastIndexOf(".");
    input.setSelectionRange(start, dot > start ? dot : value.length);
  }
  list.replaceChildren();
  list.hidden = true;
  shown = [];
  setNote(hint);
  onInput = () => setNote(hint);
  onEnter = () => {
    const value = input.value.trim();
    if (!value) return;
    const problem = validate?.(value) ?? null;
    if (problem) {
      setNote(problem, true);
      return;
    }
    closePalette();
    submit(value);
  };
}
