// Resizable, hideable panes.
import { rerenderPdfSoon } from "./preview";
import { clamp, layoutEl } from "./core";

// ---------- resizable panes ----------
export const LAYOUT_KEY = "scribe.layout";
// sidebar in px, preview as a fraction of the window
export const sizes = { sidebar: 232, pdf: 0.44, hideSidebar: false, hidePreview: false };

try {
  const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
  if (typeof saved.sidebar === "number") sizes.sidebar = saved.sidebar;
  if (typeof saved.pdf === "number") sizes.pdf = saved.pdf;
  sizes.hideSidebar = saved.hideSidebar === true;
  sizes.hidePreview = saved.hidePreview === true;
} catch {}

/** Width of the icon rail at the left edge of the sidebar; `sizes.sidebar` is the panel beside it. */
const RAIL = 41;

export function applySizes() {
  layoutEl.style.setProperty("--sidebar-w", `${sizes.sidebar}px`);
  layoutEl.style.setProperty("--pdf-w", `${(sizes.pdf * 100).toFixed(2)}%`);
  layoutEl.classList.toggle("no-sidebar", sizes.hideSidebar);
  layoutEl.classList.toggle("no-preview", sizes.hidePreview);
}

export function togglePane(which: "sidebar" | "preview") {
  if (which === "sidebar") sizes.hideSidebar = !sizes.hideSidebar;
  else sizes.hidePreview = !sizes.hidePreview;
  applySizes();
  commitSizes();
}

// x is the splitter's new distance from the left edge of the layout
export function resizePane(which: string, x: number) {
  const total = layoutEl.clientWidth;
  if (which === "sidebar") {
    sizes.sidebar = clamp(x - RAIL, 168, Math.min(420, total * (1 - sizes.pdf) - 280 - RAIL));
  } else {
    sizes.pdf = clamp(total - x, 280, total - sizes.sidebar - RAIL - 280) / total;
  }
  applySizes();
}

export function commitSizes() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(sizes)); } catch {}
  rerenderPdfSoon();
}

for (const handle of document.querySelectorAll<HTMLElement>(".splitter")) {
  const which = handle.dataset.split!;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing");
    const left = layoutEl.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => resizePane(which, ev.clientX - left);
    const up = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing");
      handle.removeEventListener("pointermove", move);
      commitSizes();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -16 : 16;
    const x = which === "sidebar" ? sizes.sidebar + RAIL : layoutEl.clientWidth * (1 - sizes.pdf);
    resizePane(which, x + step);
    commitSizes();
  });
}
applySizes();
