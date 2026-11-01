// The Assistant panel: a chat with the user's model that knows the paper (its outline, labels and
// references, the open file, the selection). LaTeX in a reply can go straight into the file.
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { $, current, localKeys, mainFile, root, setStatus } from "./core";
import { aiConfig, aiListeners, aiReady, aiStream, PROVIDERS, type ChatMessage } from "./ai";
import { renderMarkdown } from "./markdown";
import { activeEditor } from "./split";
import { index, scanOutline } from "./texindex";

const panel = $("assistant-panel");
let history: ChatMessage[] = [];
let streaming: AbortController | null = null;

/** The largest part of the open file sent with a question. Longer files are sent around the cursor, and the panel says so. */
const FILE_LIMIT = 80000;

export const SYSTEM = `You are the writing assistant in Scribe, a desktop LaTeX editor for scientific papers. You help the author with their own paper: answer questions about it, explain LaTeX, find problems, and suggest edits.

When you suggest new or replacement LaTeX, put exactly that text in a \`\`\`latex code block, ready to paste, so the author can insert it with one click. Keep their notation, macros, labels, citation keys and spelling (British or American) as they are. Don't invent citations: suggest a \\cite only with keys from the bibliography listed below. Be concise and specific.`;

/** What the model is told about the paper, and a short description of it for the panel. */
export async function paperContext(withFile = true): Promise<{ text: string; summary: string }> {
  const parts: string[] = [];
  const said: string[] = [];
  const main = mainFile ? await invoke<string>("read_file", { root, rel: mainFile }).catch(() => "") : "";
  if (main) {
    const outline = scanOutline(main).filter((i) => i.kind !== "input").map((i) => `${"  ".repeat(Math.max(0, i.level - 1))}${i.kind === "heading" ? "" : `${i.kind}: `}${i.title}`);
    if (outline.length) parts.push(`Outline of the paper (${mainFile}):\n${outline.join("\n")}`);
    said.push("outline");
  }
  if (index.labels.length) parts.push(`Labels: ${index.labels.slice(0, 300).join(", ")}`);
  if (index.bib.length) {
    parts.push(`Bibliography keys: ${index.bib.slice(0, 400).map((b) => `${b.key} (${b.title.slice(0, 60)})`).join("; ")}`);
    said.push(`${index.bib.length} references`);
  }
  const editor = activeEditor();
  const path = editor?.dom.dataset.path ?? current;
  if (withFile && editor && path) {
    const doc = editor.state.doc.toString();
    let text = doc;
    let note = "";
    if (doc.length > FILE_LIMIT) {
      const head = editor.state.selection.main.head;
      const start = Math.max(0, Math.min(doc.length - FILE_LIMIT, head - FILE_LIMIT / 2));
      text = doc.slice(start, start + FILE_LIMIT);
      note = ` (characters ${start}–${start + FILE_LIMIT} of ${doc.length}, around the cursor)`;
    }
    parts.push(`The open file, ${path}${note}:\n\`\`\`latex\n${text}\n\`\`\``);
    said.push(note ? `part of ${path}` : path);
    const sel = editor.state.selection.main;
    if (!sel.empty) {
      parts.push(`The author has selected this (line ${editor.state.doc.lineAt(sel.from).number}):\n\`\`\`latex\n${editor.state.sliceDoc(sel.from, sel.to)}\n\`\`\``);
      said.push("the selection");
    }
  }
  return { text: parts.join("\n\n"), summary: said.join(", ") };
}

// ---------- drawing ----------
function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Buttons on each code block of a reply: insert it, replace the selection with it, copy it. */
function addCodeActions(bubble: HTMLElement) {
  for (const pre of bubble.querySelectorAll("pre")) {
    if (pre.parentElement?.classList.contains("ai-code")) continue;
    const code = pre.textContent ?? "";
    const wrap = el("div", "ai-code");
    pre.replaceWith(wrap);
    const bar = el("div", "ai-code-bar");
    const button = (label: string, title: string, run: (editor: EditorView) => void) => {
      const b = el("button", "btn", label) as HTMLButtonElement;
      b.title = title;
      b.onclick = () => {
        const editor = activeEditor();
        if (!editor) return setStatus("Open a file to put this in");
        run(editor);
        editor.focus();
      };
      return b;
    };
    const copy = el("button", "btn", "Copy") as HTMLButtonElement;
    copy.onclick = () => navigator.clipboard.writeText(code.replace(/\n$/, "")).then(() => setStatus("Copied", "ok"));
    bar.append(
      button("Insert", "Put it at the cursor", (editor) => {
        const at = editor.state.selection.main.head;
        editor.dispatch({ changes: { from: at, insert: code.replace(/\n$/, "") }, userEvent: "input" });
      }),
      button("Replace Selection", localKeys("Put it in place of the selected text (⌘Z undoes it)"), (editor) => {
        const sel = editor.state.selection.main;
        if (sel.empty) return setStatus("Select the text to replace first");
        editor.dispatch({ changes: { from: sel.from, to: sel.to, insert: code.replace(/\n$/, "") }, userEvent: "input" });
      }),
      copy,
    );
    wrap.append(bar, pre);
  }
}

function bubble(message: ChatMessage): HTMLElement {
  const b = el("div", `ai-msg ${message.role}`);
  if (message.role === "user") b.textContent = message.content;
  else {
    b.innerHTML = renderMarkdown(message.content);
    addCodeActions(b);
  }
  return b;
}

export function renderAssistant() {
  panel.replaceChildren();
  if (!aiReady()) {
    const empty = el("div", "ai-empty");
    empty.append(
      el("p", "", "Ask about the paper, have a paragraph rewritten, or a LaTeX error explained, with the model of your choice: Claude, GPT, Gemini, or one running on this computer with Ollama."),
    );
    const open = el("button", "btn btn-primary", "Choose a Model…") as HTMLButtonElement;
    open.onclick = () => {
      void import("./settings").then((m) => m.toggleSettings(true)); // not at load time: settings needs most of the app
      document.getElementById("ai-provider")?.scrollIntoView({ block: "center" });
    };
    empty.append(open);
    panel.append(empty);
    return;
  }
  const log = el("div", "ai-log");
  if (!history.length) {
    const hello = el("div", "ai-hint");
    hello.textContent = `${PROVIDERS.find((p) => p.id === aiConfig.kind)?.name ?? ""} · ${aiConfig.model}. It sees the outline, labels and references, the open file and what you select.`;
    log.append(hello);
  }
  for (const m of history) log.append(bubble(m));

  const form = el("form", "ai-form") as HTMLFormElement;
  const input = el("textarea", "ai-input") as HTMLTextAreaElement;
  input.placeholder = "Ask about the paper…";
  input.rows = 3;
  const actions = el("div", "ai-actions");
  const context = el("span", "ai-context");
  const clear = el("button", "btn", "New Chat") as HTMLButtonElement;
  clear.type = "button";
  clear.onclick = () => {
    streaming?.abort();
    history = [];
    renderAssistant();
  };
  const send = el("button", "btn btn-primary", streaming ? "Stop" : "Send") as HTMLButtonElement;
  send.type = "submit";
  actions.append(context, clear, send);
  form.append(input, actions);
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    if (streaming) {
      streaming.abort();
      return;
    }
    const question = input.value.trim();
    if (question) ask(question, log, context, send);
    input.value = "";
  };
  panel.append(log, form);
  log.scrollTop = log.scrollHeight;
  // what the next question will carry
  paperContext().then(({ summary }) => { context.textContent = summary ? `Sends: ${summary}` : ""; }).catch(() => {});
  input.focus();
}

async function ask(question: string, log: HTMLElement, context: HTMLElement, send: HTMLButtonElement) {
  const { text: paper, summary } = await paperContext();
  context.textContent = `Sent: ${summary}`;
  history.push({ role: "user", content: question });
  log.querySelector(".ai-hint")?.remove();
  log.append(bubble({ role: "user", content: question }));
  const reply: ChatMessage = { role: "assistant", content: "" };
  const shown = bubble(reply);
  shown.classList.add("streaming");
  log.append(shown);
  log.scrollTop = log.scrollHeight;
  streaming = new AbortController();
  send.textContent = "Stop";
  let frame = 0;
  try {
    // the paper goes with the latest question only, so a long chat doesn't repeat it
    const messages = history.map((m, i) => (i === history.length - 1 ? { ...m, content: `${paper}\n\n---\n\n${m.content}` } : m));
    const { text } = await aiStream({ system: SYSTEM, messages }, (sofar) => {
      reply.content = sofar;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        shown.innerHTML = renderMarkdown(sofar);
        log.scrollTop = log.scrollHeight;
      });
    }, streaming.signal);
    reply.content = text;
  } catch (err) {
    reply.content = reply.content || `*${String(err).replace(/^Error: /, "")}*`;
  } finally {
    cancelAnimationFrame(frame);
    streaming = null;
    send.textContent = "Send";
    history.push(reply);
    shown.classList.remove("streaming");
    shown.innerHTML = renderMarkdown(reply.content || "*No reply.*");
    addCodeActions(shown);
    log.scrollTop = log.scrollHeight;
  }
}

/** Ask the assistant something from elsewhere (a menu): opens the panel with the question asked. */
export function askAssistant(question: string) {
  renderAssistant();
  const input = panel.querySelector<HTMLTextAreaElement>(".ai-input");
  if (!input) return;
  input.value = question;
  panel.querySelector<HTMLFormElement>(".ai-form")?.requestSubmit();
}

aiListeners.push(() => {
  if (!panel.hidden) renderAssistant();
});
