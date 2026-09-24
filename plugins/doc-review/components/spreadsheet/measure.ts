// Text measurement for numbers that do not fit their cell. Excel never lets a
// number overflow: it rounds General-format decimals to the width, and fills
// the cell with "#" otherwise. A canvas measures without touching layout.

let context: CanvasRenderingContext2D | null | undefined;
let contextFont = "";

function measuringContext(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    context =
      typeof document === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d");
  }
  return context;
}

function measure(text: string, font: string): number | null {
  const canvas = measuringContext();
  if (!canvas) return null;
  if (contextFont !== font) {
    canvas.font = font;
    contextFont = font;
  }
  return canvas.measureText(text).width;
}

/** Characters that are never wider than 0.62em in the fonts sheets use. */
const NARROW_TEXT = /^[\d\s.,:;/+\-−()%'$€£¥₽]*$/;

/**
 * The text to show for a number or date in `available` px: the text itself
 * when it fits, a General-format decimal rounded to fit, or "###".
 */
export function fitNumber(
  text: string,
  font: string,
  fontSizePx: number,
  available: number,
): string {
  if (available <= 0) return "";
  if (NARROW_TEXT.test(text) && text.length * fontSizePx * 0.62 <= available) {
    return text;
  }
  const width = measure(text, font);
  if (width === null || width <= available) return text;

  // Long plain decimals come from the General format, which Excel rounds to
  // the column's width; formatted numbers keep their digits and turn to ###.
  const decimal = /^(-?\d+)([.,])(\d{4,})$/.exec(text);
  if (decimal) {
    const [, whole, separator, fraction] = decimal;
    const value = Number(`${whole}.${fraction}`);
    for (let digits = fraction.length - 1; digits >= 0; digits -= 1) {
      const rounded = value.toFixed(digits).replace(".", separator);
      const roundedWidth = measure(rounded, font);
      if (roundedWidth !== null && roundedWidth <= available) return rounded;
    }
  }
  const hash = measure("#", font) ?? fontSizePx * 0.5;
  return "#".repeat(Math.max(1, Math.floor(available / Math.max(1, hash))));
}
