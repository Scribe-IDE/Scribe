// Revisions: the paper marked up against an earlier version (a git commit or a version saved in
// .scribe/history), compiled by latexdiff into build/diff/; and a letter answering the reviewers,
// with the changed text quoted from that PDF.
import { invoke } from "@tauri-apps/api/core";
import { $, baseName, mainFile, root, setStatus, showLog } from "./core";
import { openPalette, type PaletteItem } from "./palette";
import { openFile } from "./project";
import { pdfSelection, renderPdf } from "./preview";
import { refreshFiles } from "./sidebar";
import type { CompileResult } from "./types";

interface Commit { hash: string; subject: string; when: string }
interface Version { id: number; added: number; removed: number }

const paperPdf = () => `build/${baseName(mainFile).replace(/\.tex$/, "")}.pdf`;

async function compare(base: { git?: string; history?: number }, label: string) {
  setStatus(`Comparing with ${label}…`, "busy");
  try {
    const result = await invoke<CompileResult>("compile_diff", { root, main: mainFile, base });
    if (!result.ok || !result.pdf) {
      showLog("Compare", result.log);
      setStatus("The marked-up paper didn't compile; the log says why", "err");
      return;
    }
    await renderPdf(result.pdf);
    $("pdf-diff-text").textContent = `Changes since ${label}: new text in blue, removed text in red.`;
    $("pdf-diff").hidden = false;
    setStatus("");
  } catch (e) {
    setStatus(String(e), "err");
  }
}

/** Pick a commit or a saved version, and see the paper's changes since then. */
export async function compareWithVersion() {
  if (!root || !mainFile) return;
  const [commits, versions] = await Promise.all([
    invoke<Commit[]>("git_log", { root, limit: 60 }).catch(() => [] as Commit[]),
    invoke<Version[]>("history_list", { root, rel: mainFile }).catch(() => [] as Version[]),
  ]);
  const items: PaletteItem[] = [
    ...commits.map((c) => ({ label: c.subject, detail: `${c.hash} · ${c.when}`, hint: "commit", run: () => compare({ git: c.hash }, `“${c.subject}”`) })),
    ...[...versions].sort((a, b) => b.id - a.id).map((v) => {
      const when = new Date(v.id * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      return { label: `${baseName(mainFile)} as saved ${when}`, detail: `+${v.added} −${v.removed} lines`, hint: "saved", run: () => compare({ history: v.id }, `the version saved ${when}`) };
    }),
  ];
  openPalette({
    placeholder: "Compare the paper with…",
    empty: "No commits or saved versions yet. Versions are kept each time you save.",
    items,
  });
}

$("pdf-diff-back").addEventListener("click", () => {
  $("pdf-diff").hidden = true;
  renderPdf(paperPdf()).catch(() => setStatus("Compile the paper to see it again"));
});

// ---------- the response to the reviewers ----------
const RESPONSE = "response.tex";
const RESPONSE_TEMPLATE = String.raw`\documentclass[11pt]{article}
\usepackage[margin=2.5cm]{geometry}
\usepackage[T1]{fontenc}
\usepackage{xcolor}
\usepackage{parskip}

% A reviewer's comment, our reply, and the text as it now reads in the paper.
\newcommand{\reviewer}[1]{\section*{Reviewer #1}}
\newenvironment{comment}{\par\noindent\textbf{Comment.}\ \itshape}{\par}
\newenvironment{reply}{\par\noindent\textbf{Response.}\ }{\par\medskip}
\newcommand{\changed}[1]{\begin{quote}\color{blue!55!black}#1\end{quote}}

\begin{document}

\noindent Dear Editor,

\noindent We thank the reviewers for their careful reading. Below we answer each comment in
turn; text that changed in the manuscript is quoted in blue, with its page.

\reviewer{1}

\begin{comment}
The first comment.
\end{comment}
\begin{reply}
What we did about it.
\end{reply}

\end{document}
`;

/** Open the response letter, writing it from the template the first time. */
export async function responseLetter() {
  if (!root) return;
  const exists = await invoke<string>("read_file", { root, rel: RESPONSE }).then(() => true, () => false);
  if (!exists) {
    await invoke("write_file", { root, rel: RESPONSE, content: RESPONSE_TEMPLATE });
    await refreshFiles();
  }
  await openFile(RESPONSE);
}

/** The text selected in the PDF as a \changed{…} quote, ready to paste into the response. */
export async function quoteChange() {
  const sel = pdfSelection();
  if (!sel) {
    setStatus("Select the changed text in the PDF first");
    return;
  }
  const quote = `\\changed{${sel.text.replace(/[\\{}&%$#_]/g, (c) => `\\${c}`)} (p.~${sel.page})}`;
  await navigator.clipboard.writeText(quote).catch(() => {});
  setStatus("Copied as \\changed{…}. Paste it into the response.", "ok");
}
