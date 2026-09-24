// Spreadsheet readers for the viewer's grid.
//
// The format is sniffed from the content, not the extension: a zip whose
// main part is a SpreadsheetML workbook goes to the native streaming reader;
// everything else (BIFF .xls, .xlsb, .ods, HTML or XML-2003 saved as .xls)
// goes to SheetJS.
import { open } from "node:fs/promises";
import { findWorkbookPart, openOoxmlWorkbook } from "./ooxml-reader.js";
import { readContentTypes } from "./package.js";
import { Pacer } from "./pacer.js";
import { openSheetJsWorkbook } from "./sheetjs-reader.js";
import { type OpenSpreadsheetOptions, SpreadsheetError, type SpreadsheetReader } from "./types.js";
import { ZipArchive, ZipFormatError } from "./zip.js";

export { SHEETJS_MAX_BYTES } from "./sheetjs-reader.js";
export {
  type OpenSpreadsheetOptions,
  SpreadsheetError,
  type SpreadsheetErrorCode,
  type SpreadsheetReader,
} from "./types.js";

export async function openSpreadsheet(filePath: string, options: OpenSpreadsheetOptions): Promise<SpreadsheetReader> {
  options.signal?.throwIfAborted();
  if (await startsLikeZip(filePath)) {
    const reader = await openAsOoxml(filePath, options);
    if (reader) return reader;
  }
  return openSheetJsWorkbook(filePath, options);
}

/** The native reader, or null when the zip is not a SpreadsheetML workbook (.ods, .xlsb, .docx…). */
async function openAsOoxml(filePath: string, options: OpenSpreadsheetOptions): Promise<SpreadsheetReader | null> {
  let zip: ZipArchive;
  try {
    zip = await ZipArchive.open(filePath);
  } catch (error) {
    if (error instanceof ZipFormatError) return null;
    throw error;
  }
  try {
    const pacer = new Pacer(options.signal);
    const contentTypes = await readContentTypes(zip, pacer);
    const workbookPart = await findWorkbookPart(zip, contentTypes, pacer);
    if (!workbookPart) {
      await zip.close();
      return null;
    }
    const reader = await openOoxmlWorkbook(zip, workbookPart, contentTypes, options);
    return withReadableErrors(reader);
  } catch (error) {
    await zip.close();
    throw toSpreadsheetError(error);
  }
}

async function startsLikeZip(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    // Local file header, or the end record of an empty archive.
    return bytesRead === 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5);
  } finally {
    await handle.close();
  }
}

/** Damaged zip data surfaces from zlib or the zip reader; say so in words the user can act on. */
function toSpreadsheetError(error: unknown): unknown {
  if (error instanceof SpreadsheetError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof ZipFormatError || (typeof code === "string" && code.startsWith("Z_"))) {
    return new SpreadsheetError("unreadable", "This workbook is damaged and cannot be read.", { cause: error });
  }
  return error;
}

function withReadableErrors(reader: SpreadsheetReader): SpreadsheetReader {
  return {
    summary: reader.summary,
    fidelity: reader.fidelity,
    readSheet: async (index, signal) => {
      try {
        return await reader.readSheet(index, signal);
      } catch (error) {
        throw toSpreadsheetError(error);
      }
    },
    close: () => reader.close(),
  };
}
