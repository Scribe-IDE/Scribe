// Revision cards from notes. A card is a `Q:` line with its `A:` below:
//
//   Q: What does the squeeze theorem say?
//   A: If $g \le f \le h$ and $g, h \to L$ then $f \to L$.
//
// Review shows the cards that are due, spaced out by how well they were known (a small SM-2);
// progress is kept in .scribe/cards.json. Cards can also go to Anki as a tab-separated file.
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { $, root, setStatus } from "./core";
import { renderMarkdown } from "./markdown";
import { listFiles } from "./project";

export interface Card { id: string; note: string; line: number; q: string; a: string; }
interface Progress { due: number; interval: number; ease: number; reps: number; }

const STORE = ".scribe/cards.json";
const DAY = 86_400_000;
const NOTE = /\.md$/i;

/** Cards in one note's text. An answer runs until a blank line or the next card. */
export function cardsIn(text: string, note: string): Card[] {
  const lines = text.split("\n");
  const out: Card[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) fenced = !fenced;
    const q = !fenced && /^\s*(?:[-*]\s+)?Q:\s*(.+)$/.exec(lines[i]);
    if (!q) continue;
    const answer: string[] = [];
    let j = i + 1;
    const a = /^\s*(?:[-*]\s+)?A:\s*(.*)$/.exec(lines[j] ?? "");
    if (!a) continue;
    answer.push(a[1]);
    for (j++; j < lines.length && lines[j].trim() && !/^\s*(?:[-*]\s+)?Q:/.test(lines[j]); j++) answer.push(lines[j]);
    out.push({ id: `${note}#${hash(q[1].trim())}`, note, line: i + 1, q: q[1].trim(), a: answer.join("\n").trim() });
    i = j - 1;
  }
  return out;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

async function allCards(only?: string[]): Promise<Card[]> {
  const notes = (await listFiles()).filter((f) => NOTE.test(f) && (!only || only.includes(f)));
  const texts = await Promise.all(notes.map((n) => invoke<string>("read_file", { root, rel: n }).catch(() => "")));
  return notes.flatMap((n, i) => cardsIn(texts[i], n));
}

async function loadProgress(): Promise<Record<string, Progress>> {
  try {
    return JSON.parse(await invoke<string>("read_file", { root, rel: STORE }));
  } catch {
    return {};
  }
}

/** How many cards are due now (for the Notes panel's Review button). */
export async function dueCount(): Promise<{ due: number; total: number }> {
  const [cards, progress] = await Promise.all([allCards(), loadProgress()]);
  const now = Date.now();
  return { due: cards.filter((c) => (progress[c.id]?.due ?? 0) <= now).length, total: cards.length };
}

type Grade = 0 | 1 | 2 | 3; // again, hard, good, easy

/** SM-2, lightly: a missed card comes back in ten minutes; known ones go further each time. */
function schedule(p: Progress | undefined, grade: Grade): Progress {
  const now = Date.now();
  let { interval, ease, reps } = p ?? { interval: 0, ease: 2.5, reps: 0 };
  if (grade === 0) {
    return { due: now + 10 * 60_000, interval: 0, ease: Math.max(1.3, ease - 0.2), reps: 0 };
  }
  ease = Math.max(1.3, ease + [0, -0.15, 0, 0.15][grade]);
  interval = reps === 0 ? [0, 1, 1, 3][grade] : reps === 1 ? [0, 3, 4, 7][grade] : Math.round(interval * (grade === 1 ? 1.2 : grade === 3 ? ease * 1.3 : ease));
  return { due: now + interval * DAY, interval, ease, reps: reps + 1 };
}

const after = (days: number) => (days < 1 ? "in 10 minutes" : days === 1 ? "tomorrow" : `in ${days} days`);

// ---------- the review ----------
const dialog = $<HTMLDialogElement>("review");

/** Review the cards that are due, from every note or just `only`. */
export async function reviewCards(only?: string[]) {
  if (!root) return;
  const [cards, progress] = await Promise.all([allCards(only), loadProgress()]);
  const now = Date.now();
  const queue = cards.filter((c) => (progress[c.id]?.due ?? 0) <= now);
  if (!cards.length) {
    setStatus("No cards yet. In a note, write a line starting Q: and the answer on the next line starting A:");
    return;
  }
  if (!queue.length) {
    const next = Math.min(...cards.map((c) => progress[c.id]?.due ?? now));
    setStatus(`Nothing due. The next card comes up ${new Date(next).toLocaleString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit" })}.`, "ok");
    return;
  }
  // Shuffled, so the order of the notes isn't learned along with the answers.
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  let done = 0;
  const total = queue.length;

  const count = $("review-count");
  const where = $("review-where");
  const question = $("review-question");
  const answer = $("review-answer");
  const show = $<HTMLButtonElement>("review-show");
  const grades = $("review-grades");

  const next = () => {
    const card = queue[0];
    if (!card) {
      count.textContent = "";
      where.textContent = "";
      question.innerHTML = renderMarkdown(`**Done.** ${total} card${total === 1 ? "" : "s"} reviewed.`);
      answer.hidden = true;
      show.hidden = true;
      grades.hidden = true;
      return;
    }
    count.textContent = `${done + 1} of ${total}`;
    where.textContent = card.note.replace(/^notes\//, "").replace(NOTE, "");
    question.innerHTML = renderMarkdown(card.q);
    answer.innerHTML = renderMarkdown(card.a);
    answer.hidden = true;
    show.hidden = false;
    grades.hidden = true;
    // each grade button says when the card would come back
    const p = progress[card.id];
    for (const b of grades.querySelectorAll<HTMLButtonElement>("button")) {
      const g = Number(b.dataset.grade) as Grade;
      b.querySelector(".review-when")!.textContent = after(schedule(p, g).interval);
    }
    show.focus();
  };

  const reveal = () => {
    answer.hidden = false;
    show.hidden = true;
    grades.hidden = false;
    grades.querySelector<HTMLButtonElement>('[data-grade="2"]')?.focus();
  };

  const grade = async (g: Grade) => {
    const card = queue.shift();
    if (!card) return;
    progress[card.id] = schedule(progress[card.id], g);
    if (g === 0) queue.push(card); // again, later in this session
    else done++;
    await invoke("write_file", { root, rel: STORE, content: JSON.stringify(progress) }).catch(() => {});
    next();
  };

  show.onclick = reveal;
  for (const b of grades.querySelectorAll<HTMLButtonElement>("button")) b.onclick = () => grade(Number(b.dataset.grade) as Grade);
  dialog.onkeydown = (e) => {
    if (e.key === " " && !show.hidden) { e.preventDefault(); reveal(); }
    else if (!grades.hidden && /^[1-4]$/.test(e.key)) { e.preventDefault(); grade((Number(e.key) - 1) as Grade); }
  };
  next();
  dialog.showModal();
}

$("review-close").onclick = () => dialog.close();
dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

// ---------- Anki ----------
/** Anki writes maths as \( \) and \[ \], and lines as <br>. */
function forAnki(text: string): string {
  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, "\\[$1\\]")
    .replace(/(?<![\\$])\$((?:\\.|[^$\\\n])+?)\$/g, "\\($1\\)")
    .replace(/\t/g, " ")
    .replace(/\n/g, "<br>");
}

/** Every card as a tab-separated file Anki imports (File > Import), tagged with its note. */
export async function exportForAnki() {
  if (!root) return;
  const cards = await allCards();
  if (!cards.length) {
    setStatus("No cards to export. Cards are Q: and A: lines in notes.");
    return;
  }
  const dest = await save({ title: "Export cards for Anki", defaultPath: "scribe-cards.txt", filters: [{ name: "Text", extensions: ["txt", "tsv"] }] });
  if (!dest) return;
  const tag = (note: string) => note.replace(/^notes\//, "").replace(NOTE, "").replace(/\s+/g, "_");
  const lines = ["#separator:tab", "#html:true", "#tags column:3", ...cards.map((c) => `${forAnki(c.q)}\t${forAnki(c.a)}\t${tag(c.note)}`)];
  try {
    await invoke("save_text", { dest, content: lines.join("\n") + "\n" });
    setStatus(`Exported ${cards.length} card${cards.length === 1 ? "" : "s"}. In Anki: File > Import.`, "ok");
  } catch (e) {
    setStatus(String(e), "err");
  }
}
