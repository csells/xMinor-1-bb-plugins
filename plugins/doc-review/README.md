# Doc Review

Read and comment on documents inside bb: Markdown, PDF, Word, PowerPoint, and
Excel open in a panel tab beside the chat. Comment the way you would in Figma,
then hand every comment to an agent in one message — in the current chat or a
new one. The agent closes each comment with a note, so the tab shows what was
fixed and what still needs you.

Version 0.2 absorbed the Document Viewer plugin (`pdf-viewer`): its Word,
PowerPoint, and Excel rendering and its classic PDF view live here now.

## What it opens

| Files | How they show |
| --- | --- |
| `.md`, `.markdown` | Rendered with bb's Markdown styles; comments map to source lines |
| `.pdf` | Page by page, with a selectable text layer |
| Word: `docx`, `doc`, `odt`, `rtf` and templates | Converted to PDF by LibreOffice, then page by page |
| PowerPoint: `pptx`, `ppt`, `odp` and templates | Converted to PDF by LibreOffice, then slide by slide |
| Excel: `xlsx`, `xlsm`, `xls`, `xlsb`, `ods` and templates | A grid with sheet tabs, formatting, merged cells, frozen panes, zoom |

Any matching file opened in bb — a link in a message, the file picker,
`bb thread open` — renders in a panel tab. On pages, **Classic** switches to
the browser's own PDF viewer (search, print); the download button saves the
original file. Conversions are cached per file version, so a document
converts once and reopens at once.

## Reading pages

- **Zoom:** the bar in the corner (100% fits the width), Ctrl or Cmd with
  the scroll wheel, or a pinch on a trackpad or touch screen. The zoom stays
  anchored where you point, and pages re-render at the resolution it needs.
- **Wide pages:** every page shares one scale, so a landscape sheet, an A1
  drawing, or a wide chart is wider than the panel and scrolls sideways,
  while narrower pages stay centered. A page more than 2.5 times the typical
  width is scaled down to that.
- **Long documents:** only pages near the screen load their image and text.
  The page counter in the bar shows where you are; tap it to jump to a page.

## Commenting

- **Text:** select it and press **Comment**, right-click it, or press ⌘⌥M.
- **Area:** on pages and slides, switch to **Area** and draw a box around a
  chart or picture; the comment carries an image of that region.
- **Cells:** in a workbook, click a cell or drag over a range, then comment on
  it; commented cells show a mark in the corner.
- **Whole document:** one button at the top of the comment list.
- **On a touch screen:** select text with a long press; in **Area** mode hold,
  then drag to draw a box (a hold without a drag marks the spot); in a
  workbook tap a cell, or hold and drag over a range. A drag without the hold
  scrolls as usual.

Comments stay as drafts until you press **Send to chat** (this chat) or pick
**To a new chat** (same project, model, and workspace, fresh context). The
agent runs `bb doc-review resolve` or `bb doc-review reply`; the tab moves each
comment to *Done* or *Needs you* with the agent's note, live. The reviewed
file is never modified by the plugin; comments live in its own database.

The **Doc Review** page in the sidebar lists files with comments and their
status, recent files, and a folder browser, and opens any file by path.

## Install

```sh
bb plugin install path:"/path/to/bb-plugins" --plugin doc-review --yes
```

bb opens a file with the first matching plugin in id order, so Doc Review is
the default for these formats unless you pin another viewer under
**Settings → File openers**. *Open with → Doc Review (view and comment)* is in
every file link's context menu.

## Requirements

On the machine the bb server runs on:

| Tool | Needed for |
| --- | --- |
| poppler-utils (`pdfinfo`, `pdftoppm`, `pdftotext`) | Pages, the text layer, area images |
| LibreOffice Writer / Impress | Word and PowerPoint files |
| LibreOffice Calc (optional) | Full formatting for legacy spreadsheets (`xls`, `xlsb`, `ods`); without it they open with values and fills |

| Platform | LibreOffice |
| --- | --- |
| Debian, Ubuntu | `sudo apt install libreoffice-writer libreoffice-impress libreoffice-calc` |
| Fedora | `sudo dnf install libreoffice-writer libreoffice-impress libreoffice-calc` |
| macOS | `brew install --cask libreoffice` |

Office documents often use Calibri and Cambria: on Linux,
`fonts-crosextra-carlito` and `fonts-crosextra-caladea` keep their layout.
Pages render with the fonts installed on the server, including `~/.fonts`.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Remember recently opened documents | on | Keeps the last 12 files opened from the Doc Review page in its Recent list |
| LibreOffice executable | empty | Full path to `soffice` when it is not on `PATH` or in the usual install folders |

## For agents

The bundled skill (`skills/doc-review`) tells the agent how to apply a batch
and report back. The command:

```sh
bb doc-review list                          # comments sent to this thread, still waiting
bb doc-review list --status all --all-threads
bb doc-review show <id>
bb doc-review resolve <id...> --note "what changed"
bb doc-review reply <id> --note "question or reason"
```

## How it works

- `src/files.ts` resolves the opened path (workspace, thread storage, host
  path, or a project checkout) to an absolute path and host.
- `src/viewer.ts` (from Document Viewer) converts Word and PowerPoint files
  with LibreOffice into a size- and age-bounded cache, copies files from other
  hosts, mints links for the classic view and downloads (bb's preview
  transport, or a ranged stream for large local files), and reads workbooks
  into grid models (`src/spreadsheet`).
- `src/render.ts` renders PDF pages to PNG with `pdftoppm` on first view, at
  a width from a fixed set of steps that the panel picks for its zoom and
  pixel density (within a 16-megapixel budget), three at a time with the
  newest request first. Word boxes come from `pdftotext -bbox-layout` for an
  invisible, selectable text layer.
- `ui/page-layout.ts` places pages at one scale and keeps the reading place
  across zooms and resizes; `ui/pages-doc.tsx` mounts only the pages near the
  viewport and fetches their images with cancellation, so flicking through a
  long document does not queue hundreds of renders.
- Markdown is split into top-level blocks (`marked` lexer) and rendered with
  bb's `Markdown` component, so a selection maps back to source lines.
  Highlights use the CSS Custom Highlight API.
- `src/store.ts` keeps documents and comments in the plugin's SQLite database;
  every change publishes a realtime signal that open tabs follow. The tab also
  polls the file's version, so the agent's edits show up without reopening it.
- Sending builds one message (file, then per comment: id, location, quote,
  request) and sends it to the current thread, or spawns a thread in the same
  project and environment with the source thread's model.

## Known limits

- Rendering runs on the bb server's machine; files on other hosts are copied
  there first (up to 64 MB).
- Page numbers in Word files come from LibreOffice's layout and can differ
  from Word's own.
- A PDF without its source can be commented on, but the agent can only answer
  those comments, not rebuild the PDF.
- In the classic view, comments are not shown; switch back with **Comment**.
  Phones have no usable built-in PDF viewer, so the button is hidden there.
- A text selection that spans two pages keeps the part on the first page.

## Development

```sh
npm install
npm test           # vitest: formats, conversions, caches, workbook readers, anchors
npx tsc --noEmit
bb plugin build .
bb plugin dev .    # rebuild + reload on save
```
