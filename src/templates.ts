// Starting points for New Project. Each is a set of files written into the chosen folder.

export interface Template {
  name: string;
  /** One line shown beside the name when choosing. */
  detail: string;
  files: Record<string, string>;
}

const NOTEBOOK = `# %% [markdown]
# Figure cells export to figures/<id>.pdf and are included with \\nbfig{<id>}.
# nbval("name", value) sends a number to the paper, read back with \\nbval{name}.

# %%
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 10, 200)
y = np.exp(-x / 5) * np.sin(x)
nbval("peak", f"{y.max():.2f}")

# %% [figure: fig-example]
fig, ax = plt.subplots(figsize=(5, 3))
ax.plot(x, y, color="#d4a556", linewidth=1.5)
ax.set_xlabel("t")
ax.set_ylabel("y")
fig.tight_layout()
`;

const BIB = `@article{knuth1984,
  author  = {Donald E. Knuth},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  volume  = {27},
  number  = {2},
  pages   = {97--111},
  year    = {1984}
}
`;

const LECTURE = String.raw`# Lecture 1: Limits

Notes render as you write: maths shows typeset as soon as the cursor leaves it.
Press ⌥⌘N to jot something down without leaving this note, and ⌘V to paste a photo of the board.

## Definition

The sequence $(a_n)$ **converges** to $L \in \mathbb{R}$ if

$$
\forall \varepsilon > 0 \;\exists N \in \mathbb{N} : n \geq N \implies |a_n - L| < \varepsilon
$$

## Examples

- $\lim_{n \to \infty} \frac{1}{n} = 0$
- $\lim_{x \to 0} \frac{\sin x}{x} = 1$, see [[Lecture 2]] for the proof.

## To do

- [ ] Exercise sheet 1, questions 1 to 4
- [x] Read chapter 2 of the course book
`;

export const TEMPLATES: Template[] = [
  {
    name: "Lecture notes",
    detail: "Markdown notes with maths that render as you type; no paper needed",
    files: {
      "notes/Index.md": "# Course notes\n\n- [[Lecture 1]]\n- [[Inbox]] for quick notes (⌥⌘N)\n",
      "notes/Lecture 1.md": LECTURE,
      "notes/Inbox.md": "# Inbox\n",
    },
  },
  {
    name: "Article with a notebook",
    detail: "A short paper whose figure and one number come from a Python notebook",
    files: {
      "main.tex": `\\documentclass[11pt]{article}
\\usepackage{graphicx}
\\usepackage{amsmath}
\\usepackage{scribe-figures}

\\title{Untitled Paper}
\\author{}

\\begin{document}
\\maketitle

\\section{Introduction}
Write here, then press Cmd+Enter to compile.

\\section{Results}
Figure~\\ref{fig:example} peaks at \\nbval{peak}; the figure and the number both come from
\\texttt{notebooks/analysis.py}.

\\begin{figure}[ht]
  \\centering
  \\nbfig{fig-example}
  \\caption{A damped oscillation.}
  \\label{fig:example}
\\end{figure}

\\end{document}
`,
      "notebooks/analysis.py": NOTEBOOK,
    },
  },
  {
    name: "Plain article",
    detail: "A single .tex file with sections and a bibliography",
    files: {
      "main.tex": `\\documentclass[11pt]{article}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{Untitled Paper}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
One paragraph that says what the paper shows.
\\end{abstract}

\\section{Introduction}
Write here, then press Cmd+Enter to compile. Citations look like this~\\cite{knuth1984}.

\\section{Method}

\\section{Results}

\\section{Conclusion}

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`,
      "refs.bib": BIB,
    },
  },
  {
    name: "IEEE conference paper",
    detail: "Two-column IEEEtran layout",
    files: {
      "main.tex": `\\documentclass[conference]{IEEEtran}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{cite}

\\begin{document}

\\title{Untitled Paper}

\\author{\\IEEEauthorblockN{First Author}
\\IEEEauthorblockA{Department\\\\
University\\\\
City, Country\\\\
email@example.org}}

\\maketitle

\\begin{abstract}
One paragraph that says what the paper shows.
\\end{abstract}

\\begin{IEEEkeywords}
keyword, keyword, keyword
\\end{IEEEkeywords}

\\section{Introduction}
Write here, then press Cmd+Enter to compile. Citations look like this~\\cite{knuth1984}.

\\section{Method}

\\section{Results}

\\section{Conclusion}

\\bibliographystyle{IEEEtran}
\\bibliography{refs}

\\end{document}
`,
      "refs.bib": BIB,
    },
  },
  {
    name: "ACM conference paper",
    detail: "acmart in the sigconf format, without the ACM copyright block",
    files: {
      "main.tex": `\\documentclass[sigconf,nonacm]{acmart}

\\begin{document}

\\title{Untitled Paper}

\\author{First Author}
\\affiliation{%
  \\institution{University}
  \\city{City}
  \\country{Country}}
\\email{email@example.org}

\\begin{abstract}
One paragraph that says what the paper shows.
\\end{abstract}

\\keywords{keyword, keyword, keyword}

\\maketitle

\\section{Introduction}
Write here, then press Cmd+Enter to compile. Citations look like this~\\cite{knuth1984}.

\\section{Method}

\\section{Results}

\\section{Conclusion}

\\bibliographystyle{ACM-Reference-Format}
\\bibliography{refs}

\\end{document}
`,
      "refs.bib": BIB,
    },
  },
  {
    name: "Thesis",
    detail: "A report with a title page, contents and one file per chapter",
    files: {
      "main.tex": `\\documentclass[12pt,a4paper]{report}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{hyperref}

\\title{Thesis Title}
\\author{Your Name}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
One page that says what the thesis shows.
\\end{abstract}

\\tableofcontents

\\input{chapters/introduction}
\\input{chapters/background}
\\input{chapters/conclusion}

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`,
      "chapters/introduction.tex": `\\chapter{Introduction}
\\label{ch:introduction}

Write here. Each chapter lives in its own file under \\texttt{chapters/}.
`,
      "chapters/background.tex": `\\chapter{Background}
\\label{ch:background}

Earlier work is cited like this~\\cite{knuth1984}.
`,
      "chapters/conclusion.tex": `\\chapter{Conclusion}
\\label{ch:conclusion}

Chapter~\\ref{ch:introduction} set out the question; this chapter answers it.
`,
      "refs.bib": BIB,
    },
  },
  {
    name: "Slides",
    detail: "A Beamer presentation",
    files: {
      "main.tex": `\\documentclass[aspectratio=169]{beamer}
\\usepackage{amsmath}
\\usepackage{graphicx}

\\title{Talk Title}
\\author{Your Name}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Introduction}

\\begin{frame}{The question}
  \\begin{itemize}
    \\item One point per line.
    \\item Press Cmd+Enter to compile.
  \\end{itemize}
\\end{frame}

\\section{Results}

\\begin{frame}{The answer}
  \\[
    y(t) = e^{-t/5} \\sin t
  \\]
\\end{frame}

\\end{document}
`,
    },
  },
];
