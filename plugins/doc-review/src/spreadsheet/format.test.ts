import { describe, expect, it } from "vitest";

import { CellFormatter, isoToSerial } from "./format";

const NBSP = "\u00a0";
const en = new CellFormatter({ locale: "en-US", date1904: false });
const ru = new CellFormatter({ locale: "ru-RU", date1904: false });
const noCustom = new Map<number, string>();

describe("General", () => {
  it("shows at most eleven characters of a number, like Excel", () => {
    expect(en.number(0.1 + 0.2, en.general)).toBe("0.3");
    expect(en.number(1 / 3, en.general)).toBe("0.333333333");
    expect(en.number(123456789012, en.general)).toBe("1.23457E+11");
    expect(en.number(12345678901, en.general)).toBe("12345678901");
    expect(en.number(-1234567.891234, en.general)).toBe("-1234567.891");
    expect(en.number(0.00001, en.general)).toBe("0.00001");
    expect(en.number(1.5e-10, en.general)).toBe("1.5E-10");
    expect(en.number(-5, en.general)).toBe("-5");
  });

  it("uses the locale's decimal separator and no grouping", () => {
    expect(ru.number(1234.5, ru.general)).toBe("1234,5");
    expect(ru.number(1.5e-10, ru.general)).toBe("1,5E-10");
    expect(ru.number(42, ru.general)).toBe("42");
  });

  it("treats a lone @ as General for numbers", () => {
    expect(en.number(123.5, en.prepare("@"))).toBe("123.5");
    expect(ru.number(123.5, ru.prepare("@"))).toBe("123,5");
  });
});

describe("number formats", () => {
  it("renders en-US conventions unchanged", () => {
    expect(en.number(1234567.891, en.prepare("#,##0.00"))).toBe("1,234,567.89");
    expect(en.number(0.125, en.prepare("0.0%"))).toBe("12.5%");
    expect(en.number(12345.678, en.prepare("0.00E+00"))).toBe("1.23E+04");
    expect(en.number(1.5, en.prepare("# ?/?"))).toBe("1 1/2");
    expect(en.number(-1234.5, en.prepare("#,##0.00;[Red]-#,##0.00"))).toBe("-1,234.50");
    expect(en.number(123456789, en.prepare('0.0,,"M"'))).toBe("123.5M");
  });

  it("swaps separators only in the digits of ru-RU output", () => {
    expect(ru.number(1234567.891, ru.prepare("#,##0.00"))).toBe(`1${NBSP}234${NBSP}567,89`);
    expect(ru.number(0.125, ru.prepare("0.0%"))).toBe("12,5%");
    expect(ru.number(12345.678, ru.prepare("0.00E+00"))).toBe("1,23E+04");
    expect(ru.number(1.5, ru.prepare("# ?/?"))).toBe("1 1/2");
  });

  it("never touches literal text in a format", () => {
    expect(ru.number(1234.5, ru.prepare('#,##0.00" руб."'))).toBe(`1${NBSP}234,50 руб.`);
    expect(ru.number(1234.5, ru.prepare("#,##0.00\\ [$руб.-419]"))).toBe(`1${NBSP}234,50 руб.`);
    expect(ru.number(1234.5, ru.prepare('#,##0.0" т.р., всего"'))).toBe(`1${NBSP}234,5 т.р., всего`);
    // An escaped dot is a literal between integer digits, as in part numbers.
    expect(ru.number(1234, ru.prepare("00\\.00"))).toBe("12.34");
    expect(en.number(1234.5, en.prepare('#,##0.00" руб."'))).toBe("1,234.50 руб.");
  });

  it("drops locale-only tags and reads codes SSF would reject", () => {
    // SSF prints "$" for a bare [$-419].
    expect(en.number(1234.5, en.prepare("[$-419]#,##0.00"))).toBe("1,234.50");
    expect(en.number(1234.5, en.prepare("#,##0.00 ₽"))).toBe("1,234.50 ₽");
    expect(ru.number(1234.5, ru.prepare("#,##0.00\\ ₽"))).toBe(`1${NBSP}234,50 ₽`);
    expect(en.number(1234.5, en.prepare("[$€-2] #,##0.00"))).toBe("€ 1,234.50");
  });

  it("pads accounting formats instead of failing", () => {
    const accounting = '_-* #,##0.00\\ _₽_-;\\-* #,##0.00\\ _₽_-;_-* "-"??\\ _₽_-;_-@_-';
    expect(ru.number(1234.5, ru.prepare(accounting)).trim()).toBe(`1${NBSP}234,50`);
    expect(ru.number(-1234.5, ru.prepare(accounting)).trim()).toBe(`-1${NBSP}234,50`);
    expect(ru.number(0, ru.prepare(accounting)).trim()).toBe("-");
  });
});

describe("dates", () => {
  it("renders builtin 14 and 22 in the viewer's convention", () => {
    expect(en.number(45678, en.formatForId(14, noCustom))).toBe("1/21/2025");
    expect(ru.number(45678, ru.formatForId(14, noCustom))).toBe("21.01.2025");
    expect(en.number(45678.5, en.formatForId(22, noCustom))).toBe("1/21/2025 12:00");
    expect(ru.number(45678.5, ru.formatForId(22, noCustom))).toBe("21.01.2025 12:00");
    // East Asian variants of the short date follow it too.
    expect(ru.number(45678, ru.formatForId(57, noCustom))).toBe("21.01.2025");
  });

  it("keeps the regional short date even when a file restates id 14", () => {
    expect(ru.number(45678, ru.formatForId(14, new Map([[14, "m/d/yy"]])))).toBe("21.01.2025");
  });

  it("reads dotted date codes that SSF alone cannot", () => {
    expect(ru.number(45678, ru.prepare("dd.mm.yyyy"))).toBe("21.01.2025");
    expect(en.number(45678.75, en.prepare("DD.MM.YYYY hh:mm"))).toBe("21.01.2025 18:00");
  });

  it("does not localize dates and times", () => {
    expect(ru.number(45678.5123, ru.prepare("dd.mm.yyyy hh:mm:ss.0"))).toBe("21.01.2025 12:17:42.7");
    expect(ru.number(1.5, ru.prepare("[h]:mm"))).toBe("36:00");
  });

  it("counts from 1904 when the workbook says so", () => {
    const mac = new CellFormatter({ locale: "en-US", date1904: true });
    expect(mac.number(0, mac.prepare("yyyy-mm-dd"))).toBe("1904-01-01");
    expect(mac.number(1, mac.prepare("yyyy-mm-dd"))).toBe("1904-01-02");
    expect(en.number(1, en.prepare("yyyy-mm-dd"))).toBe("1900-01-01");
    expect(en.number(61, en.prepare("yyyy-mm-dd"))).toBe("1900-03-01");
  });

  it("renders the system long date and time through Intl", () => {
    expect(en.number(38719, en.prepare("[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy"))).toBe("Monday, January 2, 2006");
    expect(ru.number(38719, ru.prepare("[$-x-sysdate]dddd, mmmm dd, yyyy"))).toContain("2 января 2006");
    expect(en.number(38719.5, en.prepare("[$-F400]h:mm:ss\\ AM/PM"))).toBe("12:00:00 PM");
    expect(ru.number(38719.5, ru.prepare("[$-F400]h:mm:ss\\ AM/PM"))).toBe("12:00:00");
  });

  it("converts ISO values of t=d cells to serials", () => {
    expect(isoToSerial("2025-01-21", false)).toBe(45678);
    expect(isoToSerial("2025-01-21T12:00:00", false)).toBe(45678.5);
    expect(isoToSerial("2025-01-21T12:00:00.000Z", false)).toBe(45678.5);
    expect(isoToSerial("1900-01-01", false)).toBe(1);
    expect(isoToSerial("1900-03-01", false)).toBe(61);
    expect(isoToSerial("1904-01-02", true)).toBe(1);
    expect(isoToSerial("not a date", false)).toBeNaN();
  });
});

describe("text, booleans and fallbacks", () => {
  it("applies a text section to strings only when there is one", () => {
    expect(en.text("abc", en.prepare('0.00;-0.00;0;"Name: "@'))).toBe("Name: abc");
    expect(en.text("abc", en.prepare(";;;"))).toBe("");
    expect(en.text("abc", en.prepare("0.00"))).toBe("abc");
    expect(en.text("1.5", en.prepare("@"))).toBe("1.5");
  });

  it("shows booleans the way Excel does", () => {
    expect(en.boolean(true)).toBe("TRUE");
    expect(ru.boolean(false)).toBe("FALSE");
  });

  it("falls back to General for codes nothing can read", () => {
    expect(en.number(2.5, en.prepare("0 %% ZZ"))).not.toBe("");
  });

  it("maps currency builtins to their symbol-free variants", () => {
    expect(en.number(-1234, en.formatForId(5, noCustom))).toBe("(1,234)");
    expect(ru.number(1234, ru.formatForId(3, noCustom))).toBe(`1${NBSP}234`);
    expect(en.number(1234.5, en.formatForId(44, new Map([[44, '#,##0.00" EUR"']])))).toBe("1,234.50 EUR");
  });
});
