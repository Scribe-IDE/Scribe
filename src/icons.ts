// Menu icons. One family: 16px grid, 1.5 stroke, round caps and joins, drawn at 14px.

const icon = (body: string) =>
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const PAGE = '<path d="M4 1.75h5.25l3.25 3.25v8.75a.5.5 0 01-.5.5H4a.5.5 0 01-.5-.5V2.25a.5.5 0 01.5-.5z"/><path d="M9.25 1.75V5h3.25"/>';
const FOLDER = '<path d="M2 4.25a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1v6.5a1 1 0 01-1 1H3a1 1 0 01-1-1v-8z"/>';
const LENS = '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25L13.5 13.5"/>';
const FRAME = '<rect x="2" y="2.75" width="12" height="10.5" rx="1.5"/>';
const PLAY = '<path d="M4.75 3.1v9.8a.5.5 0 00.76.43l8-4.9a.5.5 0 000-.86l-8-4.9a.5.5 0 00-.76.43z"/>';
const OUT = '<path d="M9.5 2.75h3.75V6.5M13.25 2.75L7.5 8.5M11.25 9.5v2.75a1 1 0 01-1 1h-6.5a1 1 0 01-1-1v-6.5a1 1 0 011-1H6.5"/>';
const PENCIL = '<path d="M10.75 2.75l2.5 2.5L6 12.5l-3.25.75L3.5 10l7.25-7.25z"/><path d="M9 4.5L11.5 7"/>';
const TRASH = '<path d="M2.75 4.5h10.5M6.25 4.5V2.75h3.5V4.5M4.25 4.5l.6 8.1a1 1 0 001 .9h4.3a1 1 0 001-.9l.6-8.1"/>';
const CLOSE = '<path d="M4 4l8 8M12 4l-8 8"/>';

export const ICONS = {
  read: icon('<path d="M8 4.25C6.75 3.25 4.75 2.75 2.25 2.75v9.5c2.5 0 4.5.5 5.75 1.5 1.25-1 3.25-1.5 5.75-1.5v-9.5c-2.5 0-4.5.5-5.75 1.5zM8 4.25v9.5"/>'),
  page: icon(PAGE),
  folder: icon(FOLDER),
  pencil: icon(PENCIL),
  trash: icon(TRASH),
  out: icon(OUT),
  play: icon(PLAY),
  close: icon(CLOSE),
  figure: icon(FRAME + '<path d="M4.5 10.5l2.25-2.5 1.75 1.75 1.5-1.5 1.5 2.25"/>'),
  table: icon(FRAME + '<path d="M2 6.25h12M2 9.75h12M6.5 2.75v10.5"/>'),
  split: icon(FRAME + '<path d="M8 2.75v10.5"/>'),
  branch: icon('<circle cx="4.5" cy="3.75" r="1.5"/><circle cx="4.5" cy="12.25" r="1.5"/><circle cx="11.5" cy="5.75" r="1.5"/><path d="M4.5 5.25v5.5M11.5 7.25c0 2.25-2.25 2.5-4 2.75-1.5.2-3 .5-3 1"/>'),
  rerun: icon('<path d="M13 8a5 5 0 11-1.75-3.8"/><path d="M13 2.5v3h-3"/>'),
  error: icon('<circle cx="8" cy="8" r="6"/><path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"/>'),
  check: icon('<circle cx="8" cy="8" r="6"/><path d="M5.5 8.25l1.75 1.75 3.25-3.75"/>'),
  warn: icon('<path d="M8 2.5l6 10.5H2L8 2.5z"/><path d="M8 6.75v2.75M8 11.25v.01"/>'),
  help: icon('<circle cx="8" cy="8" r="6"/><path d="M6.4 6.3a1.7 1.7 0 113 1.1c-.6.6-1.4.9-1.4 1.85M8 11.5v.01"/>'),
  layout: icon(FRAME + '<path d="M6 2.75v10.5"/>'),
  recent: icon('<circle cx="8" cy="8" r="6"/><path d="M8 4.75V8l2.25 1.5"/>'),
  theme: icon('<circle cx="8" cy="8" r="5.75"/><path d="M8 2.25a5.75 5.75 0 010 11.5z" fill="currentColor"/>'),
  notebook: icon('<rect x="3.5" y="2" width="9.5" height="12" rx="1.5"/><path d="M2 5h2.5M2 8h2.5M2 11h2.5M7 5.5h3.5"/>'),
};

/** Icon per command id. */
export const COMMAND_ICONS: Record<string, string> = {
  "file.new": icon('<path d="M9 2.25H4.5a.5.5 0 00-.5.5v10.5a.5.5 0 00.5.5h7a.5.5 0 00.5-.5V8.5"/><path d="M12 2v4M10 4h4"/>'),
  "file.newNotebook": ICONS.notebook,
  "file.newFolder": icon('<path d="M14 8.5V5.75a1 1 0 00-1-1H7.5L6 3.25H3a1 1 0 00-1 1v7.5a1 1 0 001 1h5"/><path d="M12 10v4M10 12h4"/>'),
  "file.open": ICONS.folder,
  "file.export": icon('<path d="M8 2.75v7.5M5 7.25l3 3 3-3"/><path d="M2.75 10v2.25a1 1 0 001 1h8.5a1 1 0 001-1V10"/>'),
  "file.upload": icon('<path d="M8 10.5V2.75M5 5.5l3-3 3 3"/><path d="M2.75 10v2.25a1 1 0 001 1h8.5a1 1 0 001-1V10"/>'),
  "file.newProject": icon('<path d="M8 3.25v9.5M3.25 8h9.5"/>'),
  "file.save": icon('<path d="M3 3.5a1 1 0 011-1h6.5L13 5v7.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-9z"/><path d="M5.5 2.5v3h4v-3M5.5 13.5v-4h5v4"/>'),
  "file.rename": ICONS.pencil,
  "file.trash": ICONS.trash,
  "file.reveal": ICONS.out,
  "file.close": icon('<path d="M6.5 2.75H3.75a1 1 0 00-1 1v8.5a1 1 0 001 1H6.5M10.5 5.25L13.25 8l-2.75 2.75M13.25 8h-7"/>'),
  "file.closeTab": ICONS.close,

  "edit.undo": icon('<path d="M5.5 3.5l-3 3 3 3"/><path d="M2.5 6.5h6.75a3.5 3.5 0 010 7H6.5"/>'),
  "edit.redo": icon('<path d="M10.5 3.5l3 3-3 3"/><path d="M13.5 6.5H6.75a3.5 3.5 0 000 7H9.5"/>'),
  "edit.cut": icon('<circle cx="4.5" cy="11.75" r="1.75"/><circle cx="11.5" cy="11.75" r="1.75"/><path d="M5.5 10.3L11 2.5M10.5 10.3L5 2.5"/>'),
  "edit.copy": icon('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 009 2.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5"/>'),
  "edit.paste": icon('<path d="M5.75 3.25H4.5a1 1 0 00-1 1v8.5a1 1 0 001 1h7a1 1 0 001-1v-8.5a1 1 0 00-1-1h-1.25"/><rect x="5.75" y="2" width="4.5" height="2.5" rx=".75"/>'),
  "edit.selectAll": icon('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke-dasharray="2 2.4"/><path d="M5.75 8h4.5"/>'),
  "edit.find": icon(LENS),
  "edit.findInProject": icon('<path d="M2.5 3.5h8M2.5 7h3.5M2.5 10.5h2.5"/><circle cx="10" cy="9.5" r="2.75"/><path d="M12 11.5l1.75 1.75"/>'),
  "edit.comment": icon('<path d="M6.75 2.75L4.25 13.25M11.75 2.75L9.25 13.25"/>'),

  "view.palette": icon('<path d="M3 4.75L6.25 8 3 11.25M8.25 11.5H13"/>'),
  "view.quickOpen": icon('<path d="M2.5 8h7.75M7.25 4.75L10.5 8l-3.25 3.25M13.5 3.25v9.5"/>'),
  "view.files": icon('<path d="M5.5 4.5V2.75a.5.5 0 01.5-.5h4.25L13 5v6.75a.5.5 0 01-.5.5h-2"/><path d="M3 5a.5.5 0 01.5-.5h4.25L10.5 7.25v6a.5.5 0 01-.5.5H3.5a.5.5 0 01-.5-.5V5z"/>'),
  "view.sidebar": ICONS.layout,
  "view.preview": icon(FRAME + '<path d="M10 2.75v10.5"/>'),
  "view.log": icon(FRAME + '<path d="M2 9.5h12"/>'),
  "view.themeDark": icon('<path d="M13.25 9.6A5.75 5.75 0 016.4 2.75a5.75 5.75 0 106.85 6.85z"/>'),
  "view.themeLight": icon('<circle cx="8" cy="8" r="2.75"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65L12.4 3.6"/>'),
  "view.zoomIn": icon(LENS + '<path d="M5.25 7h3.5M7 5.25v3.5"/>'),
  "view.zoomOut": icon(LENS + '<path d="M5.25 7h3.5"/>'),
  "view.figures": icon(FRAME + '<path d="M4.5 10.5l2.25-2.5 1.75 1.75 1.5-1.5 1.5 2.25"/>'),
  "view.pdfZoomIn": icon(PAGE + '<path d="M6 9.5h4M8 7.5v4"/>'),
  "view.pdfZoomOut": icon(PAGE + '<path d="M6 9.5h4"/>'),
  "view.pdfFit": icon(PAGE + '<path d="M5.5 9.5h5M6.75 8.25L5.5 9.5l1.25 1.25M9.25 8.25l1.25 1.25-1.25 1.25"/>'),
  "view.pdfFind": icon(PAGE + '<circle cx="7.5" cy="9" r="1.75"/><path d="M8.75 10.25l1.5 1.5"/>'),
  "view.vim": icon('<path d="M2.5 3.5h3l2.5 6.5 2.5-6.5h3M4 3.5l4 9 4-9"/>'),
  "view.relativeNumbers": icon('<path d="M3 4.5h1.25v3.25M3 12.25h2.25c0-1.5-2.25-1.25-2.25-2.75 0-.6.5-1 1.1-1s1.1.4 1.15.9M8 5.25h5.5M8 8h5.5M8 10.75h5.5"/>'),
  "view.outline": icon('<path d="M2.5 3.5h11M5 6.5h8.5M5 9.5h8.5M7.5 12.5h6"/>'),
  "view.git": ICONS.branch,
  "view.references": icon('<path d="M3.25 2.5h7.5a1.5 1.5 0 011.5 1.5v9.5H4.75a1.5 1.5 0 01-1.5-1.5V2.5z"/><path d="M3.25 12a1.5 1.5 0 011.5-1.5h7.5M6 5.5h3.5"/>'),
  "view.symbols": icon('<path d="M12 4.5V3H4l4 5-4 5h8v-1.5"/>'),
  "view.math": icon('<path d="M2.5 9.5h1.5l1.5 3.5 2.5-10h5.5M9.5 8l3.5 4M13 8l-3.5 4"/>'),
  "edit.cite": icon('<path d="M3 9.5V7a3 3 0 013-3M9 9.5V7a3 3 0 013-3"/><path d="M3 9.5h2.5V12H3zM9 9.5h2.5V12H9z"/>'),
  "view.history": icon('<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>'),
  "edit.zotero": icon('<path d="M4 3.25h8L4 12.75h8"/>'),
  "file.import": icon('<path d="M8 2.75v7.5M5 7.25l3 3 3-3"/><path d="M2.75 10.5v1.75a1 1 0 001 1h8.5a1 1 0 001-1V10.5"/>'),
  "build.check": icon('<path d="M3 8.5l3 3 7-7"/>'),
  "build.installLatex": icon('<path d="M8 2.75v7.5M5 7.25l3 3 3-3"/><path d="M2.75 10.5v1.75a1 1 0 001 1h8.5a1 1 0 001-1V10.5"/>'),
  "file.notePdf": icon('<path d="M9 2.25H4.5a1 1 0 00-1 1v9.5a1 1 0 001 1h7a1 1 0 001-1V5.75z"/><path d="M9 2.25v3.5h3.5M6 9.5h4M6 11.5h2.5"/>'),
  "edit.table": icon('<rect x="2.25" y="3" width="11.5" height="10" rx="1.25"/><path d="M2.25 6.5h11.5M2.25 9.75h11.5M6.25 3v10M10 3v10"/>'),
  "file.review": icon('<rect x="3.75" y="2.25" width="9" height="11.5" rx="1.25"/><path d="M2 4.5v8.25a1.5 1.5 0 001.5 1.5h6.75M6.5 6.5h3.5M6.5 9h2.5"/>'),
  "file.anki": icon('<path d="M8 2.75v7.5M5 7.25l3 3 3-3"/><path d="M2.75 10.5v1.75a1 1 0 001 1h8.5a1 1 0 001-1V10.5"/>'),
  "view.notes": icon('<path d="M10.5 2.25H4.25a1 1 0 00-1 1v9.5a1 1 0 001 1h7.5a1 1 0 001-1V7"/><path d="M5.75 6.5h3M5.75 9h4.5M12.6 1.9l1.5 1.5-4.35 4.35-2 .5.5-2z"/>'),
  "file.newNote": icon('<path d="M10.5 2.25H4.25a1 1 0 00-1 1v9.5a1 1 0 001 1h7.5a1 1 0 001-1V7"/><path d="M5.75 6.5h3M5.75 9h4.5M12.6 1.9l1.5 1.5-4.35 4.35-2 .5.5-2z"/>'),
  "file.todaysNote": icon('<rect x="2.5" y="3.25" width="11" height="10.25" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v2.5M10.5 2v2.5M7 9.5h2"/>'),
  "file.quickNote": icon('<path d="M8.75 2L4 9h4l-.75 5L12 7H8z"/>'),
  "edit.copyLatex": icon('<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"/>'),
  "view.livePreview": icon('<path d="M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="1.75"/>'),
  "view.review": icon('<path d="M2.75 4.25L4 5.5l2-2.25M2.75 10.25L4 11.5l2-2.25M8.5 4.5h5M8.5 10.5h5"/>'),
  "view.openSide": ICONS.split,
  "view.closeSide": icon(FRAME + '<path d="M8 2.75v10.5M10 6.75l2.5 2.5M12.5 6.75L10 9.25"/>'),
  "view.spell": icon('<path d="M2.5 9.5l2.5-6.5 2.5 6.5M3.4 7.25h3.2M9.5 3v6.5M9.5 6a1.75 1.75 0 113.5 0v0a1.75 1.75 0 11-3.5 0"/><path d="M2.5 12.75l1.5-1 1.5 1 1.5-1 1.5 1 1.5-1 1.5 1 1.5-1"/>'),
  "view.zoomReset": icon('<path d="M13 8a5 5 0 01-9.3 2.5M3 8a5 5 0 019.3-2.5"/><path d="M12.5 2.75V5.5H9.75M3.5 13.25V10.5h2.75"/>'),

  "build.compile": ICONS.play,
  "build.runNotebooks": icon('<path d="M2.75 3.5v9l5.5-4.5-5.5-4.5zM8.75 3.5v9l5.5-4.5-5.5-4.5z"/>'),
  "build.runCell": icon('<path d="M4.75 2.75H3v10.5h1.75M11.25 2.75H13v10.5h-1.75M6.5 5.5v5L10.25 8 6.5 5.5z"/>'),
  "build.restartKernel": icon('<path d="M13 8a5 5 0 11-1.75-3.8"/><path d="M13 2.5v3h-3"/>'),
  "build.runFile": ICONS.play,
  "build.stop": icon('<rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.5"/>'),
  "build.openPdf": ICONS.out,
  "build.showInSource": icon('<path d="M13.5 8h-9M7.75 4.5L4.25 8l3.5 3.5M2.5 3.25v9.5"/>'),
  "build.showInPdf": icon('<circle cx="8" cy="8" r="4.25"/><path d="M8 1.75v3M8 11.25v3M1.75 8h3M11.25 8h3"/>'),
  "build.compileOnType": icon('<path d="M2.5 11.5h3M7 11.5h2M10.5 11.5h3M2.5 8.5h11M9 1.75L5.5 6h3l-.5 2.5"/>'),
  "build.compileOnSave": icon('<path d="M9 1.75L3.5 9h4l-.75 5.25L12.5 7h-4L9 1.75z"/>'),
  "view.terminal": icon(FRAME + '<path d="M4.75 6.25L6.75 8l-2 1.75M8.25 10h3"/>'),

  "help.shortcuts": icon('<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4.25 6.75h.01M6.75 6.75h.01M9.25 6.75h.01M11.75 6.75h.01M5 9.5h6"/>'),
  "help.about": icon('<circle cx="8" cy="8" r="6"/><path d="M8 7.25v3.5M8 5.1v.01"/>'),
};
