// Zotero: the user's library, read through Zotero 7's local API. Items can be picked from a list
// or completed inside \cite{...}; either way the entry is added to the project's .bib file.
import { invoke } from "@tauri-apps/api/core";
import { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { addToBibliography } from "./cite";
import { setStatus } from "./core";
import { CITE_COMMAND } from "./editor";
import { openPalette } from "./palette";
import { index, refreshIndex } from "./texindex";

export interface ZoteroItem {
  key: string;
  title: string;
  authors: string;
  year: string;
  bibtex: string;
}

interface Creator { creatorType: string; firstName?: string; lastName?: string; name?: string; }
type ItemData = Record<string, unknown> & { itemType: string; title?: string; creators?: Creator[]; date?: string; extra?: string };

const TYPE: Record<string, string> = {
  journalArticle: "article", magazineArticle: "article", newspaperArticle: "article", book: "book",
  bookSection: "incollection", conferencePaper: "inproceedings", thesis: "phdthesis", report: "techreport",
  manuscript: "unpublished", preprint: "misc", webpage: "misc",
};

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const person = (c: Creator) => (c.lastName ? (c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName) : text(c.name));
const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]/g, "");

/** The citation key Zotero or Better BibTeX gave the item, else surname + year + first word. */
function keyFor(data: ItemData, year: string): string {
  const own = text(data.citationKey) || /^Citation Key:\s*(\S+)/m.exec(text(data.extra))?.[1];
  if (own) return own;
  const first = data.creators?.find((c) => c.creatorType === "author") ?? data.creators?.[0];
  const surname = ascii(first ? first.lastName ?? first.name?.split(/\s+/).pop() ?? "" : "").toLowerCase() || "anon";
  const word = ascii((text(data.title).split(/\s+/).find((w) => w.length > 3) ?? "").toLowerCase());
  return `${surname}${year}${word}`;
}

export function toBibtex(data: ItemData): ZoteroItem {
  const year = /\d{4}/.exec(text(data.date))?.[0] ?? "";
  const key = keyFor(data, year);
  const authors = (data.creators ?? []).filter((c) => c.creatorType === "author");
  const editors = (data.creators ?? []).filter((c) => c.creatorType === "editor");
  let kind = TYPE[data.itemType] ?? "misc";
  if (data.itemType === "thesis" && /master/i.test(text(data.thesisType))) kind = "mastersthesis";
  const container = text(data.publicationTitle) || text(data.proceedingsTitle) || text(data.bookTitle);
  const fields: [string, string][] = [
    ["author", authors.map(person).join(" and ")],
    ["editor", editors.map(person).join(" and ")],
    ["title", text(data.title)],
    [kind === "article" ? "journal" : "booktitle", kind === "article" || kind === "incollection" || kind === "inproceedings" ? container : ""],
    ["year", year],
    ["volume", text(data.volume)],
    ["number", text(data.issue) || text(data.number)],
    ["pages", text(data.pages).replace(/(\d)\s*[-–]\s*(\d)/, "$1--$2")],
    ["publisher", text(data.publisher)],
    [kind === "techreport" ? "institution" : "school", kind === "techreport" ? text(data.institution) || text(data.publisher) : /thesis/.test(kind) ? text(data.university) : ""],
    ["doi", text(data.DOI)],
    ["isbn", text(data.ISBN)],
    ["url", text(data.DOI) ? "" : text(data.url)],
  ];
  const arxiv = /arxiv\.org\/abs\/([\w.\/-]+)/i.exec(text(data.url))?.[1] ?? /arXiv:\s*([\w.\/-]+)/i.exec(text(data.extra))?.[1];
  if (arxiv) fields.push(["eprint", arxiv], ["archivePrefix", "arXiv"]);
  const body = fields.filter(([, v]) => v).map(([k, v]) => `  ${k.padEnd(9)} = {${k === "title" ? `{${v}}` : v}}`);
  return {
    key,
    title: text(data.title) || "(no title)",
    authors: authors.map((c) => c.lastName ?? c.name ?? "").filter(Boolean).slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : ""),
    year,
    bibtex: `@${kind}{${key},\n${body.join(",\n")}\n}\n`,
  };
}

let library: Promise<ZoteroItem[]> | null = null;

/** The library's top-level items (not notes or attachments). Read once, then cached. */
export function zoteroLibrary(refresh = false): Promise<ZoteroItem[]> {
  if (!library || refresh) {
    library = (async () => {
      const items: ZoteroItem[] = [];
      for (let start = 0; start < 5000; start += 100) {
        const page = JSON.parse(await invoke<string>("zotero_get", { path: `/api/users/0/items/top?format=json&limit=100&start=${start}` })) as { data: ItemData }[];
        for (const { data } of page) if (data.itemType !== "note" && data.itemType !== "attachment") items.push(toBibtex(data));
        if (page.length < 100) break;
      }
      return items;
    })();
    library.catch(() => { library = null; }); // try again next time, e.g. once Zotero is open
  }
  return library;
}

/** Choose an item from Zotero; `use` gets it (to add it to the .bib and cite it). */
export async function pickFromZotero(use: (item: ZoteroItem) => void) {
  setStatus("Reading your Zotero library…", "busy");
  let items: ZoteroItem[];
  try {
    items = await zoteroLibrary(true);
  } catch (e) {
    setStatus(String(e), "err");
    return;
  }
  setStatus("");
  openPalette({
    placeholder: "Search your Zotero library",
    empty: items.length ? "Nothing matches." : "Your Zotero library is empty.",
    items: items.map((item) => ({
      label: item.title,
      detail: [item.authors, item.year].filter(Boolean).join(" · "),
      run: () => use(item),
    })),
  });
}

/** Inside \cite{...}: items from Zotero that aren't in the bibliography yet. Choosing one adds
 *  its entry to the .bib file. Nothing is offered when Zotero isn't running. */
export async function zoteroCiteCompletion(context: CompletionContext): Promise<CompletionResult | null> {
  const arg = context.matchBefore(/\\[a-zA-Z]+\*?(?:\[[^\]\n]*\]){0,2}\{[^{}\n]*/);
  if (!arg) return null;
  const [, command, inside] = /^\\([a-zA-Z]+\*?)(?:\[[^\]\n]*\]){0,2}\{([^{}\n]*)$/.exec(arg.text) ?? [];
  if (!command || !CITE_COMMAND.test(command)) return null;
  // A library that isn't there shouldn't hold up the list of keys already in the .bib.
  const items = await Promise.race([zoteroLibrary().catch(() => []), new Promise<ZoteroItem[]>((r) => setTimeout(() => r([]), 1500))]);
  const have = new Set(index.bib.map((b) => b.key));
  const partial = inside.slice(inside.lastIndexOf(",") + 1).trimStart();
  return {
    from: context.pos - partial.length,
    validFor: /^[^{},\s]*$/,
    options: items.filter((item) => !have.has(item.key)).map((item) => ({
      label: item.key,
      detail: `Zotero · ${item.title}`,
      type: "text",
      boost: -1,
      apply: (view: EditorView, _c: Completion, from: number, to: number) => {
        view.dispatch({ changes: { from, to, insert: item.key }, selection: { anchor: from + item.key.length }, userEvent: "input.complete" });
        addToBibliography(item).then(async ({ key, file }) => {
          // The .bib already had that key for another paper: cite the name it was given.
          if (key !== item.key) {
            const at = view.state.sliceDoc(from, from + item.key.length) === item.key ? from : -1;
            if (at >= 0) view.dispatch({ changes: { from: at, to: at + item.key.length, insert: key } });
          }
          setStatus(`Added ${key} from Zotero to ${file}`, "ok");
          await refreshIndex();
        }).catch((e) => setStatus(`Couldn't add it to the bibliography: ${e}`, "err"));
      },
    })),
  };
}
