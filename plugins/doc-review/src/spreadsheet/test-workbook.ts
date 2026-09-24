// Test helpers: hand-built zips and minimal SpreadsheetML packages, for cases
// no writer library produces (namespace prefixes, Strict OOXML, huge styled
// sheets, missing cell references). Used by tests only.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipInput {
  name: string;
  data: string | Buffer;
  /** 8 (deflate, default) or 0 (stored). */
  method?: 0 | 8;
}

/** A zip archive with the given entries, in order. */
export function buildZip(entries: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const STRICT_MAIN_NS = "http://purl.oclc.org/ooxml/spreadsheetml/main";
const STRICT_REL_NS = "http://purl.oclc.org/ooxml/officeDocument/relationships";

export interface SheetInput {
  name: string;
  /** Children of `<worksheet>` (sheetViews, cols, sheetData, mergeCells…), without the root element. */
  body: string;
  state?: "hidden" | "veryHidden";
  /** Relationships of the sheet part, as `<Relationship>` elements. */
  relationships?: string;
  /** "chartsheet" writes a chart sheet part instead. */
  kind?: "worksheet" | "chartsheet";
}

export interface WorkbookInput {
  sheets: readonly SheetInput[];
  /** Children of `<styleSheet>`. */
  styles?: string;
  /** `<si>` elements. */
  sharedStrings?: string;
  /** Attributes of `<workbookPr>`, e.g. `date1904="1"`. */
  workbookPr?: string;
  activeTab?: number;
  /** Element prefix for every SpreadsheetML element, e.g. "x:" as .NET writers do. */
  prefix?: string;
  /** Strict OOXML namespaces and relationship types. */
  strict?: boolean;
  /** Sheet part files are named in reverse order, to prove lookups go through relationships. */
  shuffleParts?: boolean;
}

/** A SpreadsheetML package built from raw parts. */
export function buildWorkbook(input: WorkbookInput): Buffer {
  const p = input.prefix ?? "";
  const ns = input.strict ? STRICT_MAIN_NS : MAIN_NS;
  const relNs = input.strict ? STRICT_REL_NS : REL_NS;
  const relType = (kind: string) => `${relNs}/${kind}`;
  const xmlns = p ? `xmlns:${p.slice(0, -1)}="${ns}"` : `xmlns="${ns}"`;
  const withPrefix = (xml: string) => (p ? xml.replace(/<(\/?)(?![?!])([A-Za-z])/g, `<$1${p}$2`) : xml);

  const entries: ZipInput[] = [];
  const overrides: string[] = [];
  const workbookRels: string[] = [];
  const sheetElements: string[] = [];
  input.sheets.forEach((sheet, index) => {
    const number = input.shuffleParts ? input.sheets.length - index : index + 1;
    const chart = sheet.kind === "chartsheet";
    const part = chart ? `xl/chartsheets/sheet${number}.xml` : `xl/worksheets/sheet${number}.xml`;
    const id = `rId${index + 1}`;
    workbookRels.push(
      `<Relationship Id="${id}" Type="${relType(chart ? "chartsheet" : "worksheet")}" Target="${part.slice(3)}"/>`,
    );
    overrides.push(
      `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${
        chart ? "chartsheet" : "worksheet"
      }+xml"/>`,
    );
    const state = sheet.state ? ` state="${sheet.state}"` : "";
    sheetElements.push(
      withPrefix(`<sheet name="${sheet.name}" sheetId="${index + 1}"${state} r:id="${id}"/>`),
    );
    const root = chart ? "chartsheet" : "worksheet";
    entries.push({
      name: part,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${withPrefix(
        `<${root} ${xmlns} xmlns:r="${relNs}">`,
      )}${withPrefix(sheet.body)}${withPrefix(`</${root}>`)}`,
    });
    if (sheet.relationships) {
      entries.push({
        name: part.replace(/([^/]+)$/, "_rels/$1.rels"),
        data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheet.relationships}</Relationships>`,
      });
    }
  });

  let nextId = input.sheets.length + 1;
  if (input.styles !== undefined) {
    workbookRels.push(`<Relationship Id="rId${nextId++}" Type="${relType("styles")}" Target="styles.xml"/>`);
    overrides.push(
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
    );
    entries.push({
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>${withPrefix(`<styleSheet ${xmlns}>`)}${withPrefix(
        input.styles,
      )}${withPrefix("</styleSheet>")}`,
    });
  }
  if (input.sharedStrings !== undefined) {
    workbookRels.push(
      `<Relationship Id="rId${nextId++}" Type="${relType("sharedStrings")}" Target="sharedStrings.xml"/>`,
    );
    overrides.push(
      `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`,
    );
    entries.push({
      name: "xl/sharedStrings.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>${withPrefix(`<sst ${xmlns}>`)}${withPrefix(
        input.sharedStrings,
      )}${withPrefix("</sst>")}`,
    });
  }

  const views = input.activeTab !== undefined ? `<bookViews><workbookView activeTab="${input.activeTab}"/></bookViews>` : "";
  const workbookPr = input.workbookPr ? `<workbookPr ${input.workbookPr}/>` : "";
  entries.unshift(
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides.join(
        "",
      )}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relType(
        "officeDocument",
      )}" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?>${withPrefix(`<workbook ${xmlns} xmlns:r="${relNs}">`)}${withPrefix(
        `${workbookPr}${views}<sheets>`,
      )}${sheetElements.join("")}${withPrefix("</sheets></workbook>")}`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels.join(
        "",
      )}</Relationships>`,
    },
  );
  return buildZip(entries);
}

/** A temporary directory removed by the returned cleanup function. */
export async function temporaryDirectory(): Promise<{ path: (name: string) => string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "pdf-viewer-sheets-"));
  return {
    path: (name) => join(directory, name),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function writeTemporary(path: string, data: Buffer): Promise<string> {
  await writeFile(path, data);
  return path;
}
