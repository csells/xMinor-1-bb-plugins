// The native reader for SpreadsheetML packages (.xlsx, .xlsm, .xltx, .xltm).
//
// Workbook-level parts — workbook, relationships, theme, styles, shared
// strings — are parsed once when the reader opens; each readSheet call then
// streams only its own sheet part.
import type { SheetData, SheetSummary, WorkbookSummary } from "../../lib/sheet-model.js";
import { readThemeColors } from "./colors.js";
import { CellFormatter } from "./format.js";
import { type ContentTypes, findPart, readRelationships, type Relationship } from "./package.js";
import { Pacer } from "./pacer.js";
import { loadSharedStrings, type SharedStrings } from "./shared-strings.js";
import { readStyles, type StyleSheet } from "./styles.js";
import type { SpreadsheetReader } from "./types.js";
import { emptySheet, readWorksheet } from "./worksheet.js";
import { isTrue, numberAttribute, parseXmlPart, type XmlAttributes } from "./xml.js";
import type { ZipArchive } from "./zip.js";

interface SheetEntry extends SheetSummary {
  /** Part name of the sheet, or null when its relationship is missing. */
  part: string | null;
}

interface WorkbookPart {
  sheets: { name: string; state: string | undefined; relationshipId: string | undefined }[];
  activeTab: number;
  date1904: boolean;
}

/** Main-part content types of SpreadsheetML workbooks, templates and add-ins — XML only, so not .xlsb. */
const WORKBOOK_CONTENT_TYPE =
  /(?:spreadsheetml\.(?:sheet|template)|ms-excel\.(?:sheet|template|addin)\.macroEnabled)\.main\+xml$/i;

/**
 * The main document part of an OOXML package when it is a SpreadsheetML
 * workbook in XML; null for Word, PowerPoint, .xlsb and anything else.
 */
export async function findWorkbookPart(
  zip: ZipArchive,
  contentTypes: ContentTypes,
  pacer: Pacer,
): Promise<string | null> {
  const relationships = await readRelationships(zip, "", pacer);
  const main = relationships.find((relationship) => !relationship.external && relationship.kind === "officeDocument");
  const candidate = main ? main.target : "xl/workbook.xml";
  const entry = findPart(zip, candidate);
  if (!entry) return null;
  const contentType = contentTypes.of(entry.name);
  // Packages without content types still count when the part sits where Excel puts it.
  const isWorkbook =
    contentType === undefined || contentType === "application/xml"
      ? /^xl\/workbook\.xml$/i.test(entry.name)
      : WORKBOOK_CONTENT_TYPE.test(contentType);
  return isWorkbook ? entry.name : null;
}

export async function openOoxmlWorkbook(
  zip: ZipArchive,
  workbookPartName: string,
  contentTypes: ContentTypes,
  options: { locale: string; signal?: AbortSignal },
): Promise<SpreadsheetReader> {
  const pacer = new Pacer(options.signal);
  const relationships = await readRelationships(zip, workbookPartName, pacer);
  const workbook = await readWorkbookPart(zip, workbookPartName, pacer);
  const byKind = (kind: string) => {
    const relationship = relationships.find((candidate) => !candidate.external && candidate.kind === kind);
    return relationship ? findPart(zip, relationship.target) : undefined;
  };

  const themeEntry = byKind("theme");
  const themeColors = themeEntry ? await readThemeColors(zip, themeEntry, pacer) : undefined;
  const formatter = new CellFormatter({ locale: options.locale, date1904: workbook.date1904 });
  const styles = await readStyles(zip, byKind("styles"), themeColors, formatter, pacer);
  const sharedStrings = await loadSharedStrings(zip, byKind("sharedStrings"), pacer);

  const byId = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  const sheets = workbook.sheets.map((sheet): SheetEntry => {
    const relationship = sheet.relationshipId ? byId.get(sheet.relationshipId) : undefined;
    return {
      name: sheet.name,
      hidden: sheet.state === "hidden" || sheet.state === "veryHidden",
      kind: sheetKind(relationship, contentTypes),
      part: relationship && !relationship.external ? relationship.target : null,
    };
  });

  return new OoxmlReader(zip, sheets, activeSheet(sheets, workbook.activeTab), {
    styles,
    sharedStrings,
    formatter,
    date1904: workbook.date1904,
  });
}

class OoxmlReader implements SpreadsheetReader {
  readonly summary: WorkbookSummary;
  readonly fidelity = "full" as const;
  readonly #zip: ZipArchive;
  readonly #sheets: readonly SheetEntry[];
  readonly #workbook: { styles: StyleSheet; sharedStrings: SharedStrings; formatter: CellFormatter; date1904: boolean };
  #closed = false;

  constructor(
    zip: ZipArchive,
    sheets: readonly SheetEntry[],
    active: number,
    workbook: { styles: StyleSheet; sharedStrings: SharedStrings; formatter: CellFormatter; date1904: boolean },
  ) {
    this.#zip = zip;
    this.#sheets = sheets;
    this.#workbook = workbook;
    this.summary = {
      sheets: sheets.map(({ name, hidden, kind }) => ({ name, hidden, kind })),
      activeSheet: active,
    };
  }

  async readSheet(index: number, signal?: AbortSignal): Promise<SheetData> {
    if (this.#closed) throw new Error("The spreadsheet has been closed.");
    const sheet = this.#sheets[index];
    if (!sheet) throw new RangeError(`The workbook has no sheet ${index}.`);
    // Chart sheets hold a drawing, not cells.
    if (sheet.kind === "chartsheet" || sheet.part === null) return emptySheet(index, sheet.name);
    const pacer = new Pacer(signal);
    const part = sheet.part;
    return readWorksheet(
      {
        zip: this.#zip,
        entry: findPart(this.#zip, part),
        index,
        name: sheet.name,
        ...this.#workbook,
        relationships: () => readRelationships(this.#zip, part, pacer),
      },
      pacer,
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#zip.close();
  }
}

async function readWorkbookPart(zip: ZipArchive, partName: string, pacer: Pacer): Promise<WorkbookPart> {
  const entry = findPart(zip, partName);
  const result: WorkbookPart = { sheets: [], activeTab: 0, date1904: false };
  if (!entry) return result;
  let inSheets = false;
  let sawView = false;
  await parseXmlPart(
    zip,
    entry,
    {
      open(name: string, attributes: XmlAttributes) {
        if (name === "sheets") {
          inSheets = true;
        } else if (name === "sheet" && inSheets) {
          result.sheets.push({
            name: attributes.name ?? `Sheet${result.sheets.length + 1}`,
            state: attributes.state,
            relationshipId: attributes.id,
          });
        } else if (name === "workbookPr") {
          result.date1904 = isTrue(attributes.date1904);
        } else if (name === "workbookView" && !sawView) {
          sawView = true;
          result.activeTab = numberAttribute(attributes.activeTab) ?? 0;
        }
      },
      close(name: string) {
        if (name === "sheets") inSheets = false;
      },
    },
    pacer,
  );
  return result;
}

/** From the relationship type, or the target's content type when the type is unfamiliar. */
function sheetKind(relationship: Relationship | undefined, contentTypes: ContentTypes): SheetSummary["kind"] {
  if (!relationship) return "other";
  if (relationship.kind === "worksheet") return "worksheet";
  if (relationship.kind === "chartsheet") return "chartsheet";
  const contentType = contentTypes.of(relationship.target) ?? "";
  if (contentType.endsWith(".worksheet+xml")) return "worksheet";
  if (contentType.endsWith(".chartsheet+xml")) return "chartsheet";
  return "other";
}

/** The tab Excel opens on, moved to the first visible worksheet when that tab is hidden or not a grid. */
function activeSheet(sheets: readonly SheetSummary[], activeTab: number): number {
  const shows = (sheet: SheetSummary | undefined) => sheet !== undefined && !sheet.hidden && sheet.kind === "worksheet";
  if (shows(sheets[activeTab])) return activeTab;
  const worksheet = sheets.findIndex((sheet) => shows(sheet));
  if (worksheet !== -1) return worksheet;
  const visible = sheets.findIndex((sheet) => !sheet.hidden);
  return visible === -1 ? 0 : visible;
}
