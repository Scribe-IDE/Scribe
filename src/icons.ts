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
  page: icon(PAGE),
  folder: icon(FOLDER),
  pencil: icon(PENCIL),
  trash: icon(TRASH),
  out: icon(OUT),
  play: icon(PLAY),
  close: icon(CLOSE),
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
  "view.zoomReset": icon('<path d="M13 8a5 5 0 01-9.3 2.5M3 8a5 5 0 019.3-2.5"/><path d="M12.5 2.75V5.5H9.75M3.5 13.25V10.5h2.75"/>'),

  "build.compile": ICONS.play,
  "build.runNotebooks": icon('<path d="M2.75 3.5v9l5.5-4.5-5.5-4.5zM8.75 3.5v9l5.5-4.5-5.5-4.5z"/>'),
  "build.runCell": icon('<path d="M4.75 2.75H3v10.5h1.75M11.25 2.75H13v10.5h-1.75M6.5 5.5v5L10.25 8 6.5 5.5z"/>'),
  "build.restartKernel": icon('<path d="M13 8a5 5 0 11-1.75-3.8"/><path d="M13 2.5v3h-3"/>'),
  "build.runFile": ICONS.play,
  "build.stop": icon('<rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.5"/>'),
  "build.openPdf": ICONS.out,
  "build.showInPdf": icon('<circle cx="8" cy="8" r="4.25"/><path d="M8 1.75v3M8 11.25v3M1.75 8h3M11.25 8h3"/>'),
  "build.compileOnSave": icon('<path d="M9 1.75L3.5 9h4l-.75 5.25L12.5 7h-4L9 1.75z"/>'),
  "view.terminal": icon(FRAME + '<path d="M4.75 6.25L6.75 8l-2 1.75M8.25 10h3"/>'),

  "help.shortcuts": icon('<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4.25 6.75h.01M6.75 6.75h.01M9.25 6.75h.01M11.75 6.75h.01M5 9.5h6"/>'),
  "help.about": icon('<circle cx="8" cy="8" r="6"/><path d="M8 7.25v3.5M8 5.1v.01"/>'),
};
