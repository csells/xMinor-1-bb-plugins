// SpreadsheetML colors: explicit ARGB, theme slots with tint, the legacy
// indexed palette, and "auto".
import type { Pacer } from "./pacer.js";
import { numberAttribute, parseXmlPart, type XmlAttributes } from "./xml.js";
import type { ZipArchive, ZipEntry } from "./zip.js";

/** A `<color>`-like element as written: at most one source plus a tint. */
export interface ColorSpec {
  rgb?: string;
  theme?: number;
  indexed?: number;
  auto?: boolean;
  tint?: number;
}

/**
 * Theme color slots in the order SpreadsheetML's `theme` attribute indexes
 * them. Note the swapped pairs: index 0 is lt1 and 1 is dk1, although the
 * theme part lists dk1 first — that is how Excel reads the attribute.
 */
const THEME_SLOTS = [
  "lt1",
  "dk1",
  "lt2",
  "dk2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
] as const;

/** The Office 2016–2022 theme, for workbooks without a theme part. */
const DEFAULT_THEME = [
  "FFFFFF",
  "000000",
  "E7E6E6",
  "44546A",
  "4472C4",
  "ED7D31",
  "A5A5A5",
  "FFC000",
  "5B9BD5",
  "70AD47",
  "0563C1",
  "954F72",
];

/** ECMA-376 §18.8.27: the default indexed palette; 64 and 65 are the system foreground and background. */
const DEFAULT_INDEXED = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
  "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
  "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
  "000000", "FFFFFF",
];

const HEX6 = /^[0-9a-fA-F]{6}$/;

/** Reads a `<color>`-like element's attributes. */
export function colorSpec(attributes: XmlAttributes): ColorSpec {
  const spec: ColorSpec = {};
  if (attributes.rgb) spec.rgb = attributes.rgb;
  const theme = numberAttribute(attributes.theme);
  if (theme !== undefined) spec.theme = theme;
  const indexed = numberAttribute(attributes.indexed);
  if (indexed !== undefined) spec.indexed = indexed;
  if (attributes.auto === "1" || attributes.auto === "true") spec.auto = true;
  const tint = numberAttribute(attributes.tint);
  if (tint !== undefined && tint !== 0) spec.tint = Math.max(-1, Math.min(1, tint));
  return spec;
}

export class ColorPalette {
  readonly #theme: readonly string[];
  readonly #indexed: readonly string[];

  constructor(theme: readonly string[] = DEFAULT_THEME, customIndexed?: readonly string[]) {
    this.#theme = theme;
    // A custom <indexedColors> replaces the palette from index 0; the system
    // colors past it keep their meaning.
    this.#indexed =
      customIndexed && customIndexed.length > 0
        ? [...customIndexed, ...DEFAULT_INDEXED.slice(customIndexed.length)]
        : DEFAULT_INDEXED;
  }

  /**
   * `#rrggbb`, or undefined for "auto" and unresolvable colors — callers
   * decide what automatic means (black text, no fill).
   */
  resolve(spec: ColorSpec | undefined): string | undefined {
    if (!spec || spec.auto) return undefined;
    let hex: string | undefined;
    if (spec.rgb !== undefined) {
      // ARGB; alpha is ignored the way Excel ignores it for cell colors.
      const rgb = spec.rgb.length === 8 ? spec.rgb.slice(2) : spec.rgb;
      if (HEX6.test(rgb)) hex = rgb;
    } else if (spec.theme !== undefined) {
      hex = this.#theme[spec.theme];
    } else if (spec.indexed !== undefined) {
      hex = this.#indexed[spec.indexed];
    }
    if (hex === undefined) return undefined;
    if (spec.tint) hex = applyTint(hex, spec.tint);
    return `#${hex.toLowerCase()}`;
  }
}

/**
 * The `tint` of ECMA-376's CT_Color: convert to HLS, scale luminance toward
 * black (tint < 0) or white (tint > 0), convert back. Continuous HLS rather
 * than Windows' 0..240 integer steps, so a channel can differ from Excel's
 * swatch by one.
 */
export function applyTint(hex: string, tint: number): string {
  const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
  const [hue, luminance, saturation] = rgbToHls(r, g, b);
  const tinted = tint < 0 ? luminance * (1 + tint) : luminance * (1 - tint) + tint;
  const [nr, ng, nb] = hlsToRgb(hue, Math.min(1, Math.max(0, tinted)), saturation);
  return [nr, ng, nb].map((channel) => toHexByte(channel)).join("");
}

function toHexByte(channel: number): string {
  return Math.round(channel * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const luminance = (max + min) / 2;
  if (max === min) return [0, luminance, 0];
  const delta = max - min;
  const saturation = luminance > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return [hue / 6, luminance, saturation];
}

function hlsToRgb(hue: number, luminance: number, saturation: number): [number, number, number] {
  if (saturation === 0) return [luminance, luminance, luminance];
  const q = luminance < 0.5 ? luminance * (1 + saturation) : luminance + saturation - luminance * saturation;
  const p = 2 * luminance - q;
  return [hueToChannel(p, q, hue + 1 / 3), hueToChannel(p, q, hue), hueToChannel(p, q, hue - 1 / 3)];
}

function hueToChannel(p: number, q: number, hue: number): number {
  let t = hue;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/**
 * Theme colors in `theme`-attribute order. System colors (`sysClr`) use the
 * `lastClr` the writer saw, which is what Excel shows.
 */
export async function readThemeColors(zip: ZipArchive, entry: ZipEntry, pacer: Pacer): Promise<string[]> {
  const bySlot = new Map<string, string>();
  let slot: string | null = null;
  let inScheme = false;
  await parseXmlPart(
    zip,
    entry,
    {
      open(name: string, attributes: XmlAttributes) {
        if (name === "clrScheme") {
          inScheme = true;
        } else if (inScheme && (THEME_SLOTS as readonly string[]).includes(name)) {
          slot = name;
        } else if (inScheme && slot !== null && !bySlot.has(slot)) {
          const hex = schemeColorHex(name, attributes);
          if (hex) bySlot.set(slot, hex);
        }
      },
      close(name: string) {
        if (name === "clrScheme") inScheme = false;
        else if (name === slot) slot = null;
      },
    },
    pacer,
  );
  return THEME_SLOTS.map((name, index) => bySlot.get(name) ?? (DEFAULT_THEME[index] as string));
}

function schemeColorHex(name: string, attributes: XmlAttributes): string | undefined {
  if (name === "srgbClr" && attributes.val && HEX6.test(attributes.val)) return attributes.val;
  if (name === "sysClr") {
    if (attributes.lastClr && HEX6.test(attributes.lastClr)) return attributes.lastClr;
    if (attributes.val === "windowText") return "000000";
    if (attributes.val === "window") return "FFFFFF";
  }
  if (name === "scrgbClr") {
    // Percentages in thousandths.
    const channels = [attributes.r, attributes.g, attributes.b].map((value) => numberAttribute(value));
    if (channels.every((value) => value !== undefined)) {
      return channels.map((value) => toHexByte(Math.min(1, Math.max(0, (value as number) / 100000)))).join("");
    }
  }
  return undefined;
}
