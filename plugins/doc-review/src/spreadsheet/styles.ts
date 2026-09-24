// Workbook styles: every cell format (`cellXfs` entry) resolved into the
// grid's CellStyle plus its number format, ready to be copied into a sheet's
// deduplicated style table.
import type { CellStyle } from "../../lib/sheet-model.js";
import { ColorPalette, colorSpec, type ColorSpec } from "./colors.js";
import type { CellFormatter, PreparedFormat } from "./format.js";
import type { Pacer } from "./pacer.js";
import { isTrue, numberAttribute, parseXmlPart, type XmlAttributes } from "./xml.js";
import type { ZipArchive, ZipEntry } from "./zip.js";

export interface ResolvedXf {
  /** Differences from the workbook's normal font; empty for plain cells. */
  readonly style: CellStyle;
  /** Deduplication key of `style`; "" when the style is empty. */
  readonly key: string;
  /** A fill or a border: even a blank cell with this style draws something. */
  readonly visibleWhenBlank: boolean;
  readonly format: PreparedFormat;
}

interface RawFont {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  size?: number;
  color?: ColorSpec;
  name?: string;
}

interface RawFill {
  pattern: string;
  foreground?: ColorSpec;
  gradient?: ColorSpec;
}

interface RawBorderSide {
  style: string;
  color?: ColorSpec;
}

type Side = "top" | "right" | "bottom" | "left";

interface RawAlignment {
  horizontal?: string;
  vertical?: string;
  wrap?: boolean;
  indent?: number;
}

interface RawXf {
  numFmtId: number;
  fontId: number;
  fillId: number;
  borderId: number;
  xfId: number;
  alignment?: RawAlignment;
}

/** Excel border styles as CSS width and line style. */
const BORDER_STYLES: Readonly<Record<string, readonly [number, string]>> = {
  thin: [1, "solid"],
  hair: [1, "solid"],
  medium: [2, "solid"],
  thick: [3, "solid"],
  dashed: [1, "dashed"],
  dotted: [1, "dotted"],
  dashDot: [1, "dashed"],
  dashDotDot: [1, "dotted"],
  mediumDashed: [2, "dashed"],
  mediumDashDot: [2, "dashed"],
  mediumDashDotDot: [2, "dashed"],
  slantDashDot: [2, "dashed"],
  double: [3, "double"],
};

const HORIZONTAL: Readonly<Record<string, CellStyle["horizontal"]>> = {
  left: "left",
  fill: "left",
  center: "center",
  centerContinuous: "center",
  right: "right",
  justify: "justify",
  distributed: "justify",
};

/** Bottom is Excel's default, so it maps to "absent". */
const VERTICAL: Readonly<Record<string, CellStyle["vertical"]>> = {
  top: "top",
  justify: "top",
  center: "middle",
  distributed: "middle",
};

const BORDER_SIDES: Readonly<Record<string, Side>> = {
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
  // Newer writers use logical sides; spreadsheets are left-to-right here.
  start: "left",
  end: "right",
};

const DEFAULT_XF: RawXf = { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, xfId: 0 };

export class StyleSheet {
  readonly #fonts: readonly RawFont[];
  readonly #fills: readonly RawFill[];
  readonly #borders: readonly Partial<Record<Side, RawBorderSide>>[];
  readonly #cellXfs: readonly RawXf[];
  readonly #styleXfs: readonly RawXf[];
  readonly #numFmts: ReadonlyMap<number, string>;
  readonly #palette: ColorPalette;
  readonly #formatter: CellFormatter;
  readonly #resolved: (ResolvedXf | undefined)[] = [];
  readonly #defaultFontColor: string;

  constructor(parts: {
    fonts: readonly RawFont[];
    fills: readonly RawFill[];
    borders: readonly Partial<Record<Side, RawBorderSide>>[];
    cellXfs: readonly RawXf[];
    styleXfs: readonly RawXf[];
    numFmts: ReadonlyMap<number, string>;
    palette: ColorPalette;
    formatter: CellFormatter;
  }) {
    this.#fonts = parts.fonts;
    this.#fills = parts.fills;
    this.#borders = parts.borders;
    this.#cellXfs = parts.cellXfs;
    this.#styleXfs = parts.styleXfs;
    this.#numFmts = parts.numFmts;
    this.#palette = parts.palette;
    this.#formatter = parts.formatter;
    this.#defaultFontColor = this.#palette.resolve(parts.fonts[0]?.color) ?? "#000000";
  }

  /** Styles of a workbook without a styles part. */
  static empty(palette: ColorPalette, formatter: CellFormatter): StyleSheet {
    return new StyleSheet({
      fonts: [],
      fills: [],
      borders: [],
      cellXfs: [],
      styleXfs: [],
      numFmts: new Map(),
      palette,
      formatter,
    });
  }

  /** The resolved style for a cell's `s`; unknown indexes fall back to the default format. */
  xf(index: number): ResolvedXf {
    const known = this.#resolved[index];
    if (known) return known;
    const raw = this.#cellXfs[index] ?? this.#cellXfs[0] ?? DEFAULT_XF;
    const resolved = this.#resolve(raw);
    if (index >= 0 && index < 1_000_000) this.#resolved[index] = resolved;
    return resolved;
  }

  #resolve(raw: RawXf): ResolvedXf {
    const style: CellStyle = {};
    // Font, fill and border apply whatever the applyX flags say: that is how
    // Excel draws a cell.
    this.#applyFont(style, this.#fonts[raw.fontId] ?? this.#fonts[0]);
    const background = this.#fillColor(this.#fills[raw.fillId]);
    if (background) style.background = background;
    // A cell format without its own alignment shows its cell style's.
    const alignment = raw.alignment ?? this.#styleXfs[raw.xfId]?.alignment;
    if (alignment) applyAlignment(style, alignment);
    const border = this.#borders[raw.borderId];
    let bordered = false;
    if (border) {
      for (const [side, property] of [
        ["top", "borderTop"],
        ["right", "borderRight"],
        ["bottom", "borderBottom"],
        ["left", "borderLeft"],
      ] as const) {
        const css = this.#borderCss(border[side]);
        if (css) {
          style[property] = css;
          bordered = true;
        }
      }
    }
    const key = Object.keys(style).length === 0 ? "" : JSON.stringify(style);
    return {
      style,
      key,
      visibleWhenBlank: background !== undefined || bordered,
      format: this.#formatter.formatForId(raw.numFmtId, this.#numFmts),
    };
  }

  #applyFont(style: CellStyle, font: RawFont | undefined): void {
    if (!font) return;
    const normal = this.#fonts[0];
    if (font.bold) style.bold = true;
    if (font.italic) style.italic = true;
    if (font.underline) style.underline = true;
    if (font.strike) style.strike = true;
    const color = this.#palette.resolve(font.color);
    if (color && color !== this.#defaultFontColor) style.color = color;
    if (font.size !== undefined && font.size !== normal?.size) style.fontSize = font.size;
    if (font.name && font.name !== normal?.name) style.fontFamily = font.name;
  }

  /** Solid and patterned fills show their foreground; none and gray125 show nothing. */
  #fillColor(fill: RawFill | undefined): string | undefined {
    if (!fill) return undefined;
    if (fill.gradient) return this.#palette.resolve(fill.gradient);
    if (fill.pattern === "none" || fill.pattern === "gray125") return undefined;
    return this.#palette.resolve(fill.foreground);
  }

  #borderCss(side: RawBorderSide | undefined): string | undefined {
    if (!side || side.style === "none") return undefined;
    const [width, line] = BORDER_STYLES[side.style] ?? BORDER_STYLES.thin ?? [1, "solid"];
    // "auto" and missing border colors are black in Excel.
    const color = this.#palette.resolve(side.color) ?? "#000000";
    return `${width}px ${line} ${color}`;
  }
}

function applyAlignment(style: CellStyle, alignment: RawAlignment): void {
  const horizontal = alignment.horizontal ? HORIZONTAL[alignment.horizontal] : undefined;
  if (horizontal) style.horizontal = horizontal;
  const vertical = alignment.vertical ? VERTICAL[alignment.vertical] : undefined;
  if (vertical) style.vertical = vertical;
  // Excel wraps justified and distributed text on its own.
  if (alignment.wrap || horizontal === "justify") style.wrap = true;
  if (alignment.indent !== undefined && alignment.indent > 0) style.indent = alignment.indent;
}

/** Parses the styles part; the palette needs its custom indexed colors, so it is built here. */
export async function readStyles(
  zip: ZipArchive,
  entry: ZipEntry | undefined,
  themeColors: readonly string[] | undefined,
  formatter: CellFormatter,
  pacer: Pacer,
): Promise<StyleSheet> {
  if (!entry) return StyleSheet.empty(new ColorPalette(themeColors), formatter);
  const parser = new StylesParser();
  await parseXmlPart(zip, entry, parser, pacer);
  return new StyleSheet({
    fonts: parser.fonts,
    fills: parser.fills,
    borders: parser.borders,
    cellXfs: parser.cellXfs,
    styleXfs: parser.styleXfs,
    numFmts: parser.numFmts,
    palette: new ColorPalette(themeColors, parser.indexedColors),
    formatter,
  });
}

/** Collects the raw style records; `dxfs` (conditional formats) are skipped. */
class StylesParser {
  readonly fonts: RawFont[] = [];
  readonly fills: RawFill[] = [];
  readonly borders: Partial<Record<Side, RawBorderSide>>[] = [];
  readonly cellXfs: RawXf[] = [];
  readonly styleXfs: RawXf[] = [];
  readonly numFmts = new Map<number, string>();
  readonly indexedColors: string[] = [];

  /** The top-level collection being read. */
  #section = "";
  #font: RawFont | null = null;
  #fill: RawFill | null = null;
  #inGradientStop = false;
  #border: Partial<Record<Side, RawBorderSide>> | null = null;
  #side: [Side, RawBorderSide] | null = null;
  #xf: RawXf | null = null;

  open(name: string, attributes: XmlAttributes): void {
    switch (this.#section) {
      case "":
        this.#section = name === "styleSheet" ? "" : name;
        return;
      case "numFmts":
        if (name === "numFmt") {
          const id = numberAttribute(attributes.numFmtId);
          if (id !== undefined && attributes.formatCode !== undefined) this.numFmts.set(id, attributes.formatCode);
        }
        return;
      case "fonts":
        this.#openFont(name, attributes);
        return;
      case "fills":
        this.#openFill(name, attributes);
        return;
      case "borders":
        this.#openBorder(name, attributes);
        return;
      case "cellXfs":
      case "cellStyleXfs":
        if (name === "xf") this.#xf = rawXf(attributes);
        else if (name === "alignment" && this.#xf) this.#xf.alignment = rawAlignment(attributes);
        return;
      case "colors":
        if (name === "rgbColor" && attributes.rgb) {
          const rgb = attributes.rgb.length === 8 ? attributes.rgb.slice(2) : attributes.rgb;
          this.indexedColors.push(rgb);
        }
        return;
      default:
        return;
    }
  }

  close(name: string): void {
    if (name === this.#section) {
      this.#section = "";
      return;
    }
    switch (name) {
      case "font":
        if (this.#section === "fonts" && this.#font) this.fonts.push(this.#font);
        this.#font = null;
        return;
      case "fill":
        if (this.#section === "fills" && this.#fill) this.fills.push(this.#fill);
        this.#fill = null;
        return;
      case "stop":
        this.#inGradientStop = false;
        return;
      case "border":
        if (this.#section === "borders" && this.#border) this.borders.push(this.#border);
        this.#border = null;
        return;
      case "xf":
        if (this.#xf) (this.#section === "cellXfs" ? this.cellXfs : this.styleXfs).push(this.#xf);
        this.#xf = null;
        return;
      default:
        if (this.#side && name in BORDER_SIDES && this.#border) {
          this.#border[this.#side[0]] = this.#side[1];
          this.#side = null;
        }
    }
  }

  #openFont(name: string, attributes: XmlAttributes): void {
    if (name === "font") {
      this.#font = {};
      return;
    }
    const font = this.#font;
    if (!font) return;
    switch (name) {
      case "b":
        font.bold = flag(attributes);
        break;
      case "i":
        font.italic = flag(attributes);
        break;
      case "strike":
        font.strike = flag(attributes);
        break;
      case "u":
        font.underline = attributes.val !== "none";
        break;
      case "sz": {
        const size = numberAttribute(attributes.val);
        if (size !== undefined && size > 0) font.size = size;
        break;
      }
      case "color":
        font.color = colorSpec(attributes);
        break;
      case "name":
        if (attributes.val) font.name = attributes.val;
        break;
      default:
        break;
    }
  }

  #openFill(name: string, attributes: XmlAttributes): void {
    if (name === "fill") {
      this.#fill = { pattern: "none" };
      return;
    }
    const fill = this.#fill;
    if (!fill) return;
    if (name === "patternFill") {
      fill.pattern = attributes.patternType ?? "none";
    } else if (name === "fgColor") {
      fill.foreground = colorSpec(attributes);
    } else if (name === "gradientFill") {
      fill.pattern = "gradient";
    } else if (name === "stop") {
      this.#inGradientStop = true;
    } else if (name === "color" && this.#inGradientStop && !fill.gradient) {
      // Only the first stop: a flat fill is what a grid cell can show.
      fill.gradient = colorSpec(attributes);
    }
  }

  #openBorder(name: string, attributes: XmlAttributes): void {
    if (name === "border") {
      this.#border = {};
      return;
    }
    if (!this.#border) return;
    const side = BORDER_SIDES[name];
    if (side) {
      this.#side = [side, { style: attributes.style ?? "none" }];
    } else if (name === "color" && this.#side) {
      this.#side[1].color = colorSpec(attributes);
    }
  }
}

/** `<b/>` is on; `<b val="0"/>` is off. */
function flag(attributes: XmlAttributes): boolean {
  return attributes.val === undefined || isTrue(attributes.val);
}

function rawXf(attributes: XmlAttributes): RawXf {
  return {
    numFmtId: numberAttribute(attributes.numFmtId) ?? 0,
    fontId: numberAttribute(attributes.fontId) ?? 0,
    fillId: numberAttribute(attributes.fillId) ?? 0,
    borderId: numberAttribute(attributes.borderId) ?? 0,
    xfId: numberAttribute(attributes.xfId) ?? 0,
  };
}

function rawAlignment(attributes: XmlAttributes): RawAlignment {
  const alignment: RawAlignment = {};
  if (attributes.horizontal) alignment.horizontal = attributes.horizontal;
  if (attributes.vertical) alignment.vertical = attributes.vertical;
  if (isTrue(attributes.wrapText)) alignment.wrap = true;
  const indent = numberAttribute(attributes.indent);
  if (indent !== undefined) alignment.indent = indent;
  return alignment;
}
