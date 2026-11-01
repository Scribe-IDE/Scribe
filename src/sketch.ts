// Sketching in notes: a drawing canvas for a diagram or a graph from the board. Strokes follow
// pen pressure, the result is saved as a PNG next to the note (images/sketch-….png) and shown in
// it. Double-clicking a sketch in a note opens it again to draw more.
import { invoke } from "@tauri-apps/api/core";
import { $, baseName, localKeys, root, setStatus } from "./core";
import { activeEditor } from "./split";

interface Point { x: number; y: number; p: number; }
interface Stroke { color: string; width: number; erase: boolean; points: Point[]; }

const W = 1200;
const H = 720;
// Ink on paper. In the dark theme the note shows sketches inverted, so black reads as light.
const COLORS = [["#1d2021", "Black"], ["#b5832c", "Amber"], ["#cc241d", "Red"], ["#076678", "Blue"], ["#79740e", "Green"]];

const dialog = $<HTMLDialogElement>("sketch");
const canvas = $<HTMLCanvasElement>("sketch-canvas");
const ctx = canvas.getContext("2d")!;
let strokes: Stroke[] = [];
let undone: Stroke[] = [];
let background: HTMLImageElement | null = null;
let pen = { color: COLORS[0][0], width: 3, erase: false };
let editing: { note: string; rel: string | null } | null = null;

const dpr = () => Math.max(1, window.devicePixelRatio || 1);

function setup() {
  canvas.width = W * dpr();
  canvas.height = H * dpr();
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
}

function drawStroke(s: Stroke) {
  const pts = s.points;
  if (!pts.length) return;
  ctx.save();
  ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, (s.width * (0.5 + pts[0].p)) / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  // Short segments through the midpoints, each as thick as the pressure there.
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1] ?? b;
    ctx.beginPath();
    ctx.lineWidth = s.width * (0.5 + (a.p + b.p) / 2);
    ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
    ctx.stroke();
  }
  ctx.restore();
}

function redraw() {
  ctx.clearRect(0, 0, W, H);
  if (background) ctx.drawImage(background, 0, 0, W, H);
  for (const s of strokes) drawStroke(s);
}

function point(e: PointerEvent): Point {
  const r = canvas.getBoundingClientRect();
  // A mouse reports 0.5 (or 0); a pen reports what it feels.
  const p = e.pointerType === "pen" ? e.pressure : 0.5;
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H, p };
}

let current: Stroke | null = null;
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  current = { color: pen.color, width: pen.erase ? 24 : pen.width, erase: pen.erase, points: [point(e)] };
  strokes.push(current);
  undone = [];
  redraw();
});
canvas.addEventListener("pointermove", (e) => {
  if (!current) return;
  for (const ev of e.getCoalescedEvents?.() ?? [e]) current.points.push(point(ev));
  redraw();
});
const finish = () => { current = null; };
canvas.addEventListener("pointerup", finish);
canvas.addEventListener("pointercancel", finish);

function tools() {
  const bar = $("sketch-tools");
  bar.replaceChildren();
  for (const [color, name] of COLORS) {
    const b = document.createElement("button");
    b.className = "sketch-swatch" + (!pen.erase && pen.color === color ? " active" : "");
    b.style.setProperty("--ink", color);
    b.title = name;
    b.setAttribute("aria-label", `${name} ink`);
    b.onclick = () => { pen = { ...pen, color, erase: false }; tools(); };
    bar.appendChild(b);
  }
  const gap = () => Object.assign(document.createElement("span"), { className: "sketch-gap" });
  bar.appendChild(gap());
  for (const [w, label] of [[2, "Fine"], [3.5, "Medium"], [6, "Bold"]] as const) {
    const b = document.createElement("button");
    b.className = "btn sketch-width" + (!pen.erase && pen.width === w ? " active" : "");
    b.textContent = label;
    b.onclick = () => { pen = { ...pen, width: w, erase: false }; tools(); };
    bar.appendChild(b);
  }
  const eraser = document.createElement("button");
  eraser.className = "btn" + (pen.erase ? " active" : "");
  eraser.textContent = "Eraser";
  eraser.onclick = () => { pen = { ...pen, erase: !pen.erase }; tools(); };
  bar.append(eraser, gap());
  const undo = document.createElement("button");
  undo.className = "btn";
  undo.textContent = "Undo";
  undo.title = localKeys("⌘Z");
  undo.onclick = () => { const s = strokes.pop(); if (s) undone.push(s); redraw(); };
  const clear = document.createElement("button");
  clear.className = "btn";
  clear.textContent = "Clear";
  clear.onclick = () => { strokes = []; background = null; redraw(); };
  bar.append(undo, clear);
}

dialog.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) { const s = undone.pop(); if (s) strokes.push(s); }
    else { const s = strokes.pop(); if (s) undone.push(s); }
    redraw();
  }
});

function open(note: string, rel: string | null, image: HTMLImageElement | null) {
  editing = { note, rel };
  strokes = [];
  undone = [];
  background = image;
  setup();
  tools();
  redraw();
  $("sketch-save").textContent = rel ? "Save" : "Insert";
  dialog.showModal();
}

/** A new sketch, inserted at the cursor of the open note. */
export function newSketch() {
  const editor = activeEditor();
  const note = editor?.dom.dataset.path;
  if (!note || !/\.md$/i.test(note)) {
    setStatus("Open a note to add a sketch to it");
    return;
  }
  open(note, null, null);
}

/** Draw more on a sketch already in a note. `rel` is the image's path in the project. */
export async function editSketch(note: string, rel: string) {
  try {
    const bytes = await invoke<ArrayBuffer>("read_binary", { root, rel });
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    await img.decode();
    open(note, rel, img);
  } catch (e) {
    setStatus(`Couldn't open the sketch: ${e}`, "err");
  }
}

/** Fired after a sketch is saved over an existing file, so the note shows the new picture. */
export const sketchSaved: ((rel: string) => void)[] = [];

async function saveSketch() {
  if (!editing || !root) return;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const { note, rel } = editing;
  const folder = note.includes("/") ? note.slice(0, note.lastIndexOf("/") + 1) : "";
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const name = `sketch-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.png`;
  const target = rel ?? `${folder}images/${name}`;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await invoke("write_binary", bytes, { headers: { "x-root": encodeURIComponent(root), "x-rel": encodeURIComponent(target) } });
  } catch (e) {
    setStatus(`Couldn't save the sketch: ${e}`, "err");
    return;
  }
  dialog.close();
  if (rel) {
    for (const fn of sketchSaved) fn(rel);
    setStatus(`Saved ${baseName(rel)}`, "ok");
    return;
  }
  const editor = activeEditor();
  if (!editor || editor.dom.dataset.path !== note) return;
  const { from } = editor.state.selection.main;
  const line = editor.state.doc.lineAt(from);
  const insert = `${from > line.from ? "\n" : ""}![sketch](images/${name})\n`;
  editor.dispatch({ changes: { from, insert }, selection: { anchor: from + insert.length }, userEvent: "input" });
  editor.focus();
}

$("sketch-save").onclick = saveSketch;
$("sketch-cancel").onclick = () => dialog.close();
