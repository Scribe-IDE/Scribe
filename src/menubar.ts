// In-window menu bar. Menus are rebuilt from the command registry every time they open,
// so enabled/checked state and dynamic submenus are always current.
import { formatKeys, getCommand, isEnabled } from "./commands";

export interface MenuItem {
  title: string;
  icon?: string;
  keys?: string;
  enabled?: boolean;
  checked?: boolean;
  run?: () => void | Promise<void>;
  submenu?: MenuEntry[];
}

/** A command id, a separator, or an ad-hoc item (used for dynamic submenus). */
export type MenuEntry = string | "-" | MenuItem | { title: string; icon?: string; submenu: () => MenuEntry[] };

export interface Menu {
  title: string;
  /** Inline SVG shown before the title. */
  icon?: string;
  entries: MenuEntry[];
}

const ICON_CHECK = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
const ICON_CHEVRON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 4.5L10 8l-3.5 3.5"/></svg>';

function resolve(entry: MenuEntry): MenuItem | "-" | null {
  if (entry === "-") return "-";
  if (typeof entry === "string") {
    const c = getCommand(entry);
    if (!c) return null;
    return { title: c.title, icon: c.icon, keys: c.keys, enabled: isEnabled(c), checked: c.checked?.(), run: () => c.run() };
  }
  if (typeof entry.submenu === "function") return { title: entry.title, icon: entry.icon, submenu: entry.submenu() };
  return entry as MenuItem;
}

export function createMenubar(bar: HTMLElement, menus: Menu[]) {
  let open = -1;
  let panel: HTMLElement | null = null;
  let sub: HTMLElement | null = null;
  const items = new WeakMap<HTMLElement, MenuItem>();

  bar.setAttribute("role", "menubar");
  const titles = menus.map((menu, i) => {
    const btn = document.createElement("button");
    btn.className = "menu-title";
    if (menu.icon) btn.innerHTML = menu.icon;
    btn.append(menu.title);
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    // Keep focus where it is, so Edit commands still act on the editor.
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (open === i) close();
      else show(i);
    });
    btn.addEventListener("mouseenter", () => {
      if (open !== -1 && open !== i) show(i);
    });
    // Keyboard activation (Enter/Space on a focused title) arrives as a click with detail 0.
    btn.addEventListener("click", (e) => {
      if (e.detail === 0) show(i, true);
    });
    bar.appendChild(btn);
    return btn;
  });

  function rows(el: HTMLElement) {
    return [...el.querySelectorAll<HTMLElement>('.menu-item:not([aria-disabled="true"])')];
  }

  function setActive(el: HTMLElement, row: HTMLElement | null) {
    el.querySelector(".menu-item.active")?.classList.remove("active");
    row?.classList.add("active");
    row?.scrollIntoView({ block: "nearest" });
  }

  function closeSub() {
    sub?.remove();
    sub = null;
    panel?.querySelector('[aria-expanded="true"]')?.setAttribute("aria-expanded", "false");
  }

  function openSub(row: HTMLElement, activateFirst = false) {
    const item = items.get(row);
    if (!item?.submenu) return;
    closeSub();
    const r = row.getBoundingClientRect();
    sub = build(item.submenu, true);
    document.body.appendChild(sub);
    const left = r.right + sub.offsetWidth > window.innerWidth ? r.left - sub.offsetWidth + 4 : r.right - 4;
    sub.style.left = `${Math.max(4, left)}px`;
    sub.style.top = `${r.top - 5}px`;
    row.setAttribute("aria-expanded", "true");
    if (activateFirst) setActive(sub, rows(sub)[0] ?? null);
  }

  function activate(row: HTMLElement) {
    const item = items.get(row);
    if (!item || item.enabled === false) return;
    if (item.submenu) {
      openSub(row, true);
      return;
    }
    close();
    item.run?.();
  }

  function build(entries: MenuEntry[], isSub = false): HTMLElement {
    const el = document.createElement("div");
    el.className = "menu";
    el.setAttribute("role", "menu");
    el.addEventListener("mousedown", (e) => e.preventDefault());
    for (const entry of entries) {
      const item = resolve(entry);
      if (!item) continue;
      if (item === "-") {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        sep.setAttribute("role", "separator");
        el.appendChild(sep);
        continue;
      }
      const row = document.createElement("div");
      row.className = "menu-item";
      row.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
      if (item.checked !== undefined) row.setAttribute("aria-checked", String(item.checked));
      if (item.enabled === false) row.setAttribute("aria-disabled", "true");
      if (item.submenu) {
        row.setAttribute("aria-haspopup", "menu");
        row.setAttribute("aria-expanded", "false");
      }

      const glyph = document.createElement("span");
      glyph.className = "menu-icon";
      if (item.icon) glyph.innerHTML = item.icon;
      const check = document.createElement("span");
      check.className = "menu-check";
      if (item.checked) check.innerHTML = ICON_CHECK;
      const label = document.createElement("span");
      label.className = "menu-label";
      label.textContent = item.title;
      const trail = document.createElement("span");
      trail.className = "menu-keys";
      if (item.submenu) trail.innerHTML = ICON_CHEVRON;
      else if (item.keys) trail.textContent = formatKeys(item.keys);
      row.append(glyph, label, check, trail);

      items.set(row, item);
      row.addEventListener("mouseenter", () => {
        if (item.enabled === false) return;
        setActive(el, row);
        if (isSub) return;
        if (item.submenu) openSub(row);
        else closeSub();
      });
      row.addEventListener("click", () => activate(row));
      el.appendChild(row);
    }
    return el;
  }

  function show(i: number, activateFirst = false) {
    close();
    open = i;
    const r = titles[i].getBoundingClientRect();
    panel = build(menus[i].entries);
    document.body.appendChild(panel);
    panel.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - panel.offsetWidth - 4))}px`;
    panel.style.top = `${r.bottom + 4}px`;
    titles[i].setAttribute("aria-expanded", "true");
    if (activateFirst) setActive(panel, rows(panel)[0] ?? null);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
  }

  function close() {
    if (open === -1) return;
    titles[open].setAttribute("aria-expanded", "false");
    closeSub();
    panel?.remove();
    panel = null;
    open = -1;
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
  }

  function onOutside(e: Event) {
    const target = e.target as Node;
    if (bar.contains(target) || panel?.contains(target) || sub?.contains(target)) return;
    close();
  }

  function move(el: HTMLElement, delta: number) {
    const list = rows(el);
    if (!list.length) return;
    const at = list.findIndex((r) => r.classList.contains("active"));
    const next = at === -1 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length;
    setActive(el, list[next]);
    if (el === panel) closeSub();
  }

  // Captured at the window while a menu is open, so the editor never sees these keys.
  function onKey(e: KeyboardEvent) {
    if (!panel) return;
    const focus = sub ?? panel;
    const active = focus.querySelector<HTMLElement>(".menu-item.active");
    const step = (delta: number) => show((open + delta + menus.length) % menus.length, true);
    switch (e.key) {
      case "ArrowDown": move(focus, 1); break;
      case "ArrowUp": move(focus, -1); break;
      case "ArrowRight":
        if (!sub && active && items.get(active)?.submenu) openSub(active, true);
        else step(1);
        break;
      case "ArrowLeft":
        if (sub) closeSub();
        else step(-1);
        break;
      case "Enter":
      case " ":
        if (active) activate(active);
        break;
      case "Escape":
        if (sub) closeSub();
        else close();
        break;
      default:
        // Any other key (typing, a shortcut) dismisses the menu and carries on.
        close();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  return { close };
}

/** A one-level menu at the pointer, for right-clicks. Uses the same look as the menu bar. */
export function openContextMenu(x: number, y: number, entries: (MenuItem | "-")[]) {
  const el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");
  const actions = new Map<HTMLElement, MenuItem>();

  const close = () => {
    el.remove();
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
  };
  const choose = (row: HTMLElement) => {
    const item = actions.get(row);
    if (!item || item.enabled === false) return;
    close();
    item.run?.();
  };
  const setActive = (row: HTMLElement | null) => {
    el.querySelector(".menu-item.active")?.classList.remove("active");
    row?.classList.add("active");
  };

  for (const item of entries) {
    if (item === "-") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      sep.setAttribute("role", "separator");
      el.appendChild(sep);
      continue;
    }
    const row = document.createElement("div");
    row.className = "menu-item";
    row.setAttribute("role", "menuitem");
    if (item.enabled === false) row.setAttribute("aria-disabled", "true");
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.title;
    const keys = document.createElement("span");
    keys.className = "menu-keys";
    if (item.keys) keys.textContent = formatKeys(item.keys);
    const glyph = document.createElement("span");
    glyph.className = "menu-icon";
    if (item.icon) glyph.innerHTML = item.icon;
    row.append(glyph, label, document.createElement("span"), keys);
    actions.set(row, item);
    row.addEventListener("mouseenter", () => setActive(item.enabled === false ? null : row));
    row.addEventListener("click", () => choose(row));
    el.appendChild(row);
  }

  function onOutside(e: Event) {
    if (!el.contains(e.target as Node)) close();
  }

  function onKey(e: KeyboardEvent) {
    const list = [...el.querySelectorAll<HTMLElement>('.menu-item:not([aria-disabled="true"])')];
    const at = list.findIndex((r) => r.classList.contains("active"));
    if (e.key === "ArrowDown") setActive(list[(at + 1) % list.length] ?? null);
    else if (e.key === "ArrowUp") setActive(list[(at - 1 + list.length) % list.length] ?? null);
    else if (e.key === "Enter" && at !== -1) choose(list[at]);
    else if (e.key !== "Escape") return close();
    else close();
    e.preventDefault();
    e.stopPropagation();
  }

  el.addEventListener("contextmenu", (e) => e.preventDefault());
  document.body.appendChild(el);
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4))}px`;
  window.addEventListener("keydown", onKey, true);
  // deferred, so the click that opened the menu doesn't immediately close it
  setTimeout(() => document.addEventListener("pointerdown", onOutside, true));
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
}
