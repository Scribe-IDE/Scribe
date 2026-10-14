// First-run tour: a few steps pointing at the parts of Scribe that work differently from other
// LaTeX editors. Shown once, the first time a project opens; Help > Take the Tour shows it again.

interface Step { target: string; title: string; body: string; }

const STEPS: Step[] = [
  {
    target: "#btn-compile",
    title: "Compile",
    body: "⌘↵ builds the PDF on the right. Double-click the PDF to jump to its source, or turn on Compile as you type in Settings.",
  },
  {
    target: "#files-panel",
    title: "Your project",
    body: "The paper, its notebooks, data and notes. Drag files to move them; right-click for more. The outline of the open file is underneath.",
  },
  {
    target: "#btn-run",
    title: "Figures and numbers from Python",
    body: "In a notebook, a cell marked [figure: name] makes figures/name.pdf, and nbval(\"name\", value) exports a number. In the paper, \\nbfig{name} and \\nbval{name} bring them in, and they update when the notebook runs.",
  },
  {
    target: "#tab-notes",
    title: "Notes",
    body: "Markdown with maths that renders as you type, for lectures and reading. ⌥⌘N jots a quick note; Q: and A: lines become revision cards.",
  },
  {
    target: "#tab-references",
    title: "References",
    body: "Add papers by DOI, arXiv ID or from Zotero. Attach a paper's PDF to read and highlight it; highlights land in its note with their page.",
  },
  {
    target: "#menubar",
    title: "Everything else",
    body: "⇧⌘P finds any command by name, and ⌘P any file. Check Before Submitting in the Build menu catches what reviewers would.",
  },
];

const KEY = "scribe.tour";
const ring = document.createElement("div");
ring.className = "tour-ring";
const card = document.createElement("div");
card.className = "tour-card";
card.setAttribute("role", "dialog");
card.setAttribute("aria-live", "polite");
let at = -1;

function place() {
  const step = STEPS[at];
  const target = document.querySelector<HTMLElement>(step.target);
  const visible = target && target.offsetParent !== null;
  const r = visible ? target!.getBoundingClientRect() : null;
  ring.hidden = !r;
  if (r) {
    ring.style.left = `${r.left - 4}px`;
    ring.style.top = `${r.top - 4}px`;
    ring.style.width = `${r.width + 8}px`;
    ring.style.height = `${r.height + 8}px`;
  }
  // Beside the target where there's room: below it, else to its right, else centred.
  const w = 320;
  const h = card.offsetHeight || 160;
  let x = window.innerWidth / 2 - w / 2;
  let y = window.innerHeight / 2 - h / 2;
  if (r) {
    if (r.bottom + 12 + h < window.innerHeight && r.height < window.innerHeight / 2) {
      x = r.left + r.width / 2 - w / 2;
      y = r.bottom + 12;
    } else {
      x = r.right + 12;
      y = r.top + 8;
    }
  }
  card.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, x))}px`;
  card.style.top = `${Math.max(12, Math.min(window.innerHeight - h - 12, y))}px`;
}

function show(i: number) {
  at = i;
  const step = STEPS[i];
  card.replaceChildren();
  const count = document.createElement("p");
  count.className = "tour-count";
  count.textContent = `${i + 1} of ${STEPS.length}`;
  const title = document.createElement("h3");
  title.textContent = step.title;
  const body = document.createElement("p");
  body.className = "tour-body";
  body.textContent = step.body;
  const actions = document.createElement("div");
  actions.className = "tour-actions";
  const skip = document.createElement("button");
  skip.className = "btn";
  skip.textContent = i === STEPS.length - 1 ? "Close" : "Skip";
  skip.onclick = end;
  actions.appendChild(skip);
  if (i > 0) {
    const back = document.createElement("button");
    back.className = "btn";
    back.textContent = "Back";
    back.onclick = () => show(i - 1);
    actions.appendChild(back);
  }
  const next = document.createElement("button");
  next.className = "btn btn-primary";
  next.textContent = i === STEPS.length - 1 ? "Start writing" : "Next";
  next.onclick = () => (i === STEPS.length - 1 ? end() : show(i + 1));
  actions.appendChild(next);
  card.append(count, title, body, actions);
  place();
  next.focus();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") { e.preventDefault(); end(); }
  else if (e.key === "ArrowRight" && at < STEPS.length - 1) show(at + 1);
  else if (e.key === "ArrowLeft" && at > 0) show(at - 1);
}

export function startTour() {
  document.body.append(ring, card);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  show(0);
}

function end() {
  ring.remove();
  card.remove();
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", place);
  try { localStorage.setItem(KEY, "done"); } catch {}
}

/** The first time a project opens on this computer, once the window has settled. */
export function tourOnFirstProject() {
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    return;
  }
  setTimeout(startTour, 700);
}
