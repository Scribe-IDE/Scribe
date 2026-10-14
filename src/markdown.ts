// Markdown for notebook text cells: headings, lists, emphasis, code, tables, and LaTeX maths
// ($...$ inline, $$...$$ on its own line). Output is sanitised: notebooks come from other
// people too, and a text cell must never be able to run code in the app.
import katex from "katex";
import { marked } from "marked";

// Code first, so `$` inside backticks stays literal; then the maths forms.
const CODE_OR_MATH =
  /(```[\s\S]*?```|`[^`\n]*`)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/g;

const ALLOWED = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "STRONG", "EM", "DEL", "CODE", "PRE", "BLOCKQUOTE",
  "A", "HR", "BR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
]);

// Keeps known formatting elements, turns anything else into its text, and drops every
// attribute. Links keep their address as data, to be opened in the browser on click.
function sanitise(root: ParentNode) {
  for (const el of [...root.querySelectorAll("*")]) {
    if (!ALLOWED.has(el.tagName)) {
      el.replaceWith(document.createTextNode(el.textContent ?? ""));
      continue;
    }
    const href = el.tagName === "A" ? el.getAttribute("href") ?? "" : "";
    for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
    if (/^(https?:|mailto:)/i.test(href)) {
      el.setAttribute("data-href", href);
      el.setAttribute("title", href);
    }
  }
}

export function renderMarkdown(source: string): string {
  const maths: string[] = [];
  const text = source.replace(CODE_OR_MATH, (match, code, block, bracket, paren, inline) => {
    if (code) return match;
    const tex = block ?? bracket ?? paren ?? inline;
    const display = block !== undefined || bracket !== undefined;
    maths.push(katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, errorColor: "var(--err)" }));
    return `@@MATH${maths.length - 1}@@`;
  });

  const template = document.createElement("template");
  template.innerHTML = marked.parse(text, { async: false, gfm: true }) as string;
  sanitise(template.content);
  // The formulas go in after sanitising: they are our own KaTeX output, not the notebook's HTML.
  return template.innerHTML.replace(/@@MATH(\d+)@@/g, (_m, i) => maths[Number(i)] ?? "");
}
