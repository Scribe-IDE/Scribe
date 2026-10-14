// Symbol palette: click a symbol to put its LaTeX at the cursor.
import { $ } from "./core";
import { renderMath } from "./mathpreview";
import { activeEditor } from "./split";

// [what is inserted, what is shown if different]. `{}` marks where the cursor lands.
const GROUPS: [string, (string | [string, string])[]][] = [
  ["Greek", [
    "\\alpha", "\\beta", "\\gamma", "\\delta", "\\epsilon", "\\varepsilon", "\\zeta", "\\eta", "\\theta", "\\kappa",
    "\\lambda", "\\mu", "\\nu", "\\xi", "\\pi", "\\rho", "\\sigma", "\\tau", "\\phi", "\\varphi", "\\chi", "\\psi",
    "\\omega", "\\Gamma", "\\Delta", "\\Theta", "\\Lambda", "\\Xi", "\\Pi", "\\Sigma", "\\Phi", "\\Psi", "\\Omega",
  ]],
  ["Operators", [
    ["\\frac{}{}", "\\frac{a}{b}"], ["\\sqrt{}", "\\sqrt{x}"], ["\\sum_{}^{}", "\\sum"], ["\\prod_{}^{}", "\\prod"],
    ["\\int_{}^{}", "\\int"], "\\oint", "\\partial", "\\nabla", ["\\lim_{}", "\\lim"], "\\infty", "\\pm", "\\mp",
    "\\times", "\\cdot", "\\div", "\\circ", "\\otimes", "\\oplus",
  ]],
  ["Relations", [
    "\\leq", "\\geq", "\\neq", "\\approx", "\\equiv", "\\sim", "\\simeq", "\\propto", "\\ll", "\\gg", "\\in",
    "\\notin", "\\subset", "\\subseteq", "\\supset", "\\perp", "\\parallel",
  ]],
  ["Arrows", [
    "\\to", "\\leftarrow", "\\leftrightarrow", "\\Rightarrow", "\\Leftarrow", "\\Leftrightarrow", "\\mapsto",
    "\\uparrow", "\\downarrow", "\\rightleftharpoons",
  ]],
  ["Sets and logic", [
    "\\mathbb{R}", "\\mathbb{N}", "\\mathbb{Z}", "\\mathbb{Q}", "\\mathbb{C}", "\\emptyset", "\\cup", "\\cap",
    "\\setminus", "\\forall", "\\exists", "\\neg", "\\land", "\\lor", "\\therefore",
  ]],
  ["Accents and others", [
    ["\\hat{}", "\\hat{x}"], ["\\bar{}", "\\bar{x}"], ["\\vec{}", "\\vec{x}"], ["\\dot{}", "\\dot{x}"],
    ["\\ddot{}", "\\ddot{x}"], ["\\tilde{}", "\\tilde{x}"], ["\\mathcal{}", "\\mathcal{L}"], ["\\mathbf{}", "\\mathbf{x}"],
    "\\ell", "\\hbar", "\\dagger", "\\angle", "\\degree", "\\cdots", "\\ldots", "\\prime",
  ]],
];

function insert(latex: string) {
  const editor = activeEditor();
  if (!editor) return;
  const { from, to } = editor.state.selection.main;
  // Land inside the first pair of braces, ready to type the argument.
  const hole = latex.indexOf("{}");
  editor.dispatch({
    changes: { from, to, insert: latex },
    selection: { anchor: from + (hole === -1 ? latex.length : hole + 1) },
    userEvent: "input",
  });
  editor.focus();
}

let built = false;

export function renderSymbols() {
  if (built) return;
  built = true;
  const panel = $("symbols-panel");
  const filter = document.createElement("input");
  filter.type = "text";
  filter.placeholder = "Filter symbols";
  filter.spellcheck = false;
  filter.setAttribute("aria-label", "Filter symbols");
  panel.appendChild(filter);

  const sections: { heading: HTMLElement; grid: HTMLElement }[] = [];
  for (const [name, symbols] of GROUPS) {
    const heading = document.createElement("h3");
    heading.className = "gallery-heading";
    heading.textContent = name;
    const grid = document.createElement("div");
    grid.className = "symbol-grid";
    for (const symbol of symbols) {
      const [latex, shown] = typeof symbol === "string" ? [symbol, symbol] : symbol;
      const button = document.createElement("button");
      button.className = "symbol";
      button.title = latex;
      button.dataset.name = latex.toLowerCase();
      button.innerHTML = renderMath(shown);
      button.addEventListener("mousedown", (e) => e.preventDefault()); // the editor keeps the cursor
      button.onclick = () => insert(latex);
      grid.appendChild(button);
    }
    panel.append(heading, grid);
    sections.push({ heading, grid });
  }

  filter.oninput = () => {
    const query = filter.value.trim().toLowerCase().replace(/^\\/, "");
    for (const { heading, grid } of sections) {
      let any = false;
      for (const button of grid.children as HTMLCollectionOf<HTMLElement>) {
        button.hidden = !!query && !button.dataset.name!.includes(query);
        any ||= !button.hidden;
      }
      heading.hidden = grid.hidden = !any;
    }
  };
}
