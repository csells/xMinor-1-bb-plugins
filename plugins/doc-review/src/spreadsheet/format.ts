// Display text for cell values: Excel number formats rendered by SheetJS's
// SSF, adapted to the viewer's locale.
//
// SSF renders in en-US conventions and trips over a few codes Excel accepts,
// so every format code is prepared once before SSF sees it:
// - builtin ids that follow the regional settings (14 short date, 22 date and
//   time) become the locale's pattern;
// - literal text that contains "." or "," (quoted strings, `\.`, currency
//   brackets such as `[$руб.-419]`) is fenced with private-use markers, so the
//   separator swap for the locale touches only digits SSF produced;
// - date sections get their literal dots quoted (SSF reads `dd.mm.yyyy` as
//   fractional seconds and throws), locale-only `[$-419]` tags are dropped
//   (SSF prints them as "$"), and characters SSF rejects are quoted.
import * as XLSX from "xlsx";

interface Ssf {
  format(format: string, value: unknown, options?: { date1904?: boolean }): string;
  is_date(format: string): boolean;
}

const SSF = XLSX.SSF as Ssf;

export interface PreparedFormat {
  /** The code as handed to SSF. */
  readonly code: string;
  /**
   * - general: Excel's General (also used for numbers under `@`);
   * - number / date: rendered by SSF;
   * - long-date / long-time: the `[$-F800]` / `[$-F400]` system formats,
   *   rendered by Intl in the viewer's locale.
   */
  readonly kind: "general" | "number" | "date" | "long-date" | "long-time";
  /** Whether strings go through the format's text section. */
  readonly formatsText: boolean;
}

export interface CellFormatterOptions {
  /** BCP 47 tag of the viewer, e.g. "ru-RU"; unknown tags fall back to en-US. */
  locale: string;
  /** The workbook counts days from 1904-01-01 instead of 1900-01-00. */
  date1904: boolean;
}

/** Fences literal text so the separator swap skips it; stripped from every output. */
const FENCE_OPEN = "\uE000";
const FENCE_CLOSE = "\uE001";
const FENCES = /[\uE000\uE001]/g;

/** ECMA-376 §18.8.30 builtin formats that do not depend on the locale. */
const BUILTIN_CODES: Readonly<Record<number, string>> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

const SHORT_DATE_ID = 14;
const NO_CUSTOM_FORMATS: ReadonlyMap<number, string> = new Map();
const SHORT_DATE_TIME_ID = 22;

/**
 * Builtins that render like another one: East Asian and Thai variants, and
 * the currency formats — their symbol comes from the author's regional
 * settings, which the file does not record, so they show without one.
 */
const BUILTIN_ALIASES: Readonly<Record<number, number>> = {
  5: 37, 6: 38, 7: 39, 8: 40, 42: 41, 44: 43, 63: 37, 64: 38, 65: 39, 66: 40,
  23: 0, 24: 0, 25: 0, 26: 0,
  27: 14, 28: 14, 29: 14, 30: 14, 31: 14, 32: 20, 33: 21, 34: 14, 35: 14, 36: 14,
  50: 14, 51: 14, 52: 14, 53: 14, 54: 14, 55: 14, 56: 14, 57: 14, 58: 14,
  59: 1, 60: 2, 61: 3, 62: 4, 67: 9, 68: 10, 69: 12, 70: 13, 71: 14, 72: 14,
  73: 15, 74: 16, 75: 17, 76: 20, 77: 21, 78: 22, 79: 45, 80: 46, 81: 47,
};

const LONG_DATE_TAG = /\[\$-(?:F800|x-sysdate)\]/i;
const LONG_TIME_TAG = /\[\$-(?:F400|x-systime)\]/i;
/** Letters outside quotes that SSF's tokenizer rejects; Excel shows them as text. */
const SSF_REJECTED = /[CFIJKLNOQRTUVWXZn]/;
const COLOR_OR_CONDITION = /^(?:black|blue|cyan|green|magenta|red|white|yellow|color\s*\d+|[<>=].*)$/i;
const ELAPSED_TIME = /^(?:h+|m+|s+)$/i;
const MS_PER_DAY = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

interface LocaleConventions {
  decimal: string;
  group: string;
  /** The locale's numeric short date as an Excel code, e.g. `dd"."mm"."yyyy`. */
  shortDate: string;
  /** Created on first use: most workbooks never show a long system date. */
  longDate(): Intl.DateTimeFormat;
  longTime(): Intl.DateTimeFormat;
}

const conventionsByLocale = new Map<string, LocaleConventions>();

export class CellFormatter {
  readonly #conventions: LocaleConventions;
  readonly #date1904: boolean;
  readonly #ssfOptions: { date1904?: boolean };
  readonly #prepared = new Map<string, PreparedFormat>();
  readonly #swapSeparators: boolean;
  readonly #general: PreparedFormat;

  constructor(options: CellFormatterOptions) {
    this.#conventions = localeConventions(options.locale);
    this.#date1904 = options.date1904;
    this.#ssfOptions = options.date1904 ? { date1904: true } : {};
    this.#swapSeparators = this.#conventions.decimal !== "." || this.#conventions.group !== ",";
    this.#general = this.prepare("General");
  }

  get general(): PreparedFormat {
    return this.#general;
  }

  /** The format for a `numFmtId`: the workbook's own code first, then Excel's builtins. */
  formatForId(id: number, custom: ReadonlyMap<number, string>): PreparedFormat {
    const builtin = BUILTIN_ALIASES[id] ?? id;
    // The regional short date wins even over a code the file repeats for it:
    // Excel always renders these two ids in the reader's own convention.
    if (builtin === SHORT_DATE_ID) return this.prepare(this.#conventions.shortDate);
    if (builtin === SHORT_DATE_TIME_ID) return this.prepare(`${this.#conventions.shortDate} h:mm`);
    const code = custom.get(id);
    if (code !== undefined) return this.prepare(code);
    return this.prepare(BUILTIN_CODES[builtin] ?? "General");
  }

  /** The locale's short date, with time when the value has one; for ISO dates under General. */
  dateFormatFor(serial: number): PreparedFormat {
    return this.formatForId(serial % 1 === 0 ? SHORT_DATE_ID : SHORT_DATE_TIME_ID, NO_CUSTOM_FORMATS);
  }

  prepare(code: string): PreparedFormat {
    let prepared = this.#prepared.get(code);
    if (!prepared) {
      prepared = prepareFormat(code);
      this.#prepared.set(code, prepared);
    }
    return prepared;
  }

  number(value: number, format: PreparedFormat): string {
    switch (format.kind) {
      case "general":
        return this.#localize(SSF.format("General", value));
      case "long-date":
      case "long-time": {
        const time = serialToUtcMs(value, this.#date1904);
        if (time !== null) {
          const intl = format.kind === "long-date" ? this.#conventions.longDate() : this.#conventions.longTime();
          return intl.format(time);
        }
        break;
      }
      default:
        break;
    }
    let text: string;
    try {
      text = SSF.format(format.code, value, this.#ssfOptions);
    } catch {
      // A code SSF still cannot read: show the value rather than nothing.
      return this.#localize(SSF.format("General", value));
    }
    return format.kind === "number" ? this.#localize(text) : text.replace(FENCES, "");
  }

  /** Strings pass through unless the format has a text section (`"Total: "@`). */
  text(value: string, format: PreparedFormat): string {
    if (!format.formatsText) return value;
    try {
      return SSF.format(format.code, value).replace(FENCES, "");
    } catch {
      return value;
    }
  }

  /** Excel shows booleans as TRUE/FALSE whatever the format. */
  boolean(value: boolean): string {
    return value ? "TRUE" : "FALSE";
  }

  /** Swaps SSF's "." and "," for the locale's separators outside fenced literals. */
  #localize(text: string): string {
    if (!this.#swapSeparators) return text.indexOf(FENCE_OPEN) === -1 ? text : text.replace(FENCES, "");
    const { decimal, group } = this.#conventions;
    const swap = (part: string): string =>
      part.replace(/[.,]/g, (separator) => (separator === "." ? decimal : group));
    if (text.indexOf(FENCE_OPEN) === -1) return swap(text);
    let result = "";
    let cursor = 0;
    while (cursor < text.length) {
      const open = text.indexOf(FENCE_OPEN, cursor);
      if (open === -1) {
        result += swap(text.slice(cursor));
        break;
      }
      result += swap(text.slice(cursor, open));
      const close = text.indexOf(FENCE_CLOSE, open + 1);
      const end = close === -1 ? text.length : close;
      result += text.slice(open + 1, end);
      cursor = end + 1;
    }
    return result;
  }
}

/** Rewrites a format code into one SSF renders the way Excel does. */
export function prepareFormat(code: string): PreparedFormat {
  if (LONG_DATE_TAG.test(code)) return { code, kind: "long-date", formatsText: false };
  if (LONG_TIME_TAG.test(code)) return { code, kind: "long-time", formatsText: false };
  const sections = splitSections(code);
  const prepared = sections.map((section) => prepareSection(section, SSF.is_date(section)));
  const joined = prepared.join(";");
  const first = (prepared[0] ?? "").trim();
  const textSection = sections.length === 4 ? sections[3] : sections.length > 1 && (sections.at(-1) ?? "").includes("@") ? sections.at(-1) : undefined;
  const formatsText = textSection !== undefined && textSection.trim() !== "@";
  if (sections.length === 1 && (first === "" || /^general$/i.test(first) || first === "@")) {
    return { code: "General", kind: "general", formatsText: false };
  }
  return {
    code: joined,
    kind: SSF.is_date(joined) ? "date" : "number",
    formatsText,
  };
}

/** Splits at `;` outside quotes and escapes, the way SSF counts sections. */
function splitSections(code: string): string[] {
  const sections: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i];
    if (char === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (char === "\\" || char === "_" || char === "*") i += 1;
    else if (char === ";") {
      sections.push(code.slice(start, i));
      start = i + 1;
    }
  }
  sections.push(code.slice(start));
  // Excel reads at most four sections.
  return sections.slice(0, 4);
}

function prepareSection(section: string, isDate: boolean): string {
  let out = "";
  let i = 0;
  while (i < section.length) {
    const char = section[i] as string;
    if (char === '"') {
      const end = section.indexOf('"', i + 1);
      out += quoteLiteral(end === -1 ? section.slice(i + 1) : section.slice(i + 1, end), isDate);
      i = end === -1 ? section.length : end + 1;
    } else if (char === "\\") {
      const escaped = section[i + 1] ?? "";
      out += escaped === "." || escaped === "," || escaped.charCodeAt(0) > 127 ? quoteLiteral(escaped, isDate) : `\\${escaped}`;
      i += 2;
    } else if (char === "_") {
      // Padding as wide as the next character: SSF renders it as a space.
      out += "_ ";
      i += 2;
    } else if (char === "*") {
      // Fill repeats the next character across the cell; text has no width to fill.
      i += 2;
    } else if (char === "[") {
      const end = section.indexOf("]", i);
      if (end === -1) break;
      out += prepareBracket(section.slice(i + 1, end), isDate);
      i = end + 1;
    } else if (char === "G" || char === "g") {
      if (section.slice(i, i + 7).toLowerCase() === "general") {
        out += "General";
        i += 7;
      } else {
        out += char === "g" ? char : quoteLiteral(char, isDate);
        i += 1;
      }
    } else if (isDate && char === "." && section[i + 1] !== "0") {
      // In a date a dot is a separator unless it starts fractional seconds.
      out += quoteLiteral(char, isDate);
      i += 1;
    } else if (char.charCodeAt(0) > 127 || SSF_REJECTED.test(char)) {
      out += quoteLiteral(char, isDate);
      i += 1;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

/** Brackets keep colors, conditions and elapsed time; `[$text-lcid]` becomes its text. */
function prepareBracket(content: string, isDate: boolean): string {
  if (content.startsWith("$")) {
    const dash = content.indexOf("-");
    const text = dash === -1 ? content.slice(1) : content.slice(1, dash);
    return text === "" ? "" : quoteLiteral(text, isDate);
  }
  if (COLOR_OR_CONDITION.test(content) || ELAPSED_TIME.test(content)) return `[${content}]`;
  // DBNum, natnum and other display switches SSF does not know.
  return "";
}

function quoteLiteral(text: string, isDate: boolean): string {
  const clean = text.replace(/"/g, "");
  if (!isDate && (clean.includes(".") || clean.includes(","))) return `"${FENCE_OPEN}${clean}${FENCE_CLOSE}"`;
  return `"${clean}"`;
}

function localeConventions(requested: string): LocaleConventions {
  const cached = conventionsByLocale.get(requested);
  if (cached) return cached;
  let locale = "en-US";
  try {
    locale = Intl.getCanonicalLocales(requested)[0] ?? locale;
  } catch {
    // An invalid tag: keep en-US.
  }
  const numberParts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
  const dateParts = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).formatToParts(Date.UTC(2006, 0, 2));
  const conventions: LocaleConventions = {
    decimal: numberParts.find((part) => part.type === "decimal")?.value ?? ".",
    group: numberParts.find((part) => part.type === "group")?.value ?? ",",
    shortDate: dateParts
      .map((part) => {
        const long = part.value.length > 1;
        if (part.type === "day") return long ? "dd" : "d";
        if (part.type === "month") return long ? "mm" : "m";
        if (part.type === "year") return part.value.length === 2 ? "yy" : "yyyy";
        return part.type === "literal" ? `"${part.value.replace(/"/g, "")}"` : "";
      })
      .join(""),
    longDate: lazy(() => new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" })),
    longTime: lazy(() => new Intl.DateTimeFormat(locale, { timeStyle: "medium", timeZone: "UTC" })),
  };
  conventionsByLocale.set(requested, conventions);
  return conventions;
}

function lazy<T>(create: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= create());
}

/**
 * Epoch milliseconds of a serial date, or null outside Excel's calendar.
 * Serial 60 is the 1900-02-29 that never was (Excel copied Lotus's leap-year
 * bug), so the 1900 system counts from 1899-12-31 below it and from
 * 1899-12-30 above it.
 */
export function serialToUtcMs(serial: number, date1904: boolean): number | null {
  if (!(serial >= 0) || serial > 2_958_465) return null;
  const days = Math.floor(serial);
  const seconds = Math.round((serial - days) * 86_400);
  if (date1904) return EPOCH_1904 + days * MS_PER_DAY + seconds * 1000;
  if (days === 0 || days === 60) return null;
  const epoch = days < 60 ? EPOCH_1900 + MS_PER_DAY : EPOCH_1900;
  return epoch + days * MS_PER_DAY + seconds * 1000;
}

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * The serial of an ISO 8601 value from a `t="d"` cell, read as wall-clock
 * time (Excel has no time zones); NaN when it does not parse.
 */
export function isoToSerial(value: string, date1904: boolean): number {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second, fraction] = match;
  const time = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
    fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0,
  );
  if (date1904) return (time - EPOCH_1904) / MS_PER_DAY;
  const serial = (time - EPOCH_1900) / MS_PER_DAY;
  // Before 1900-03-01 the phantom leap day has not happened yet.
  return serial < 61 ? serial - 1 : serial;
}
