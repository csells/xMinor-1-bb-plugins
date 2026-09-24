import { describe, expect, it } from "vitest";

import { applyTint, ColorPalette } from "./colors";

/** Channel-wise distance between two RRGGBB colors. */
function distance(a: string, b: string): number {
  let max = 0;
  for (let i = 0; i < 6; i += 2) {
    max = Math.max(max, Math.abs(Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16)));
  }
  return max;
}

describe("applyTint", () => {
  it("matches the swatches Excel shows for theme tints", () => {
    // Accent 1 of the Office 2016 theme, darker 25% / lighter 40% / lighter 80%.
    expect(applyTint("4472C4", -0.249977111117893)).toBe("2F5597");
    expect(distance(applyTint("4472C4", 0.3999755851924192), "8EA9DB")).toBeLessThanOrEqual(1);
    expect(distance(applyTint("4472C4", 0.7999816888943144), "D9E1F2")).toBeLessThanOrEqual(2);
    // White darker 15%, black lighter 50%.
    expect(applyTint("FFFFFF", -0.1499984740745262)).toBe("D9D9D9");
    expect(applyTint("000000", 0.499984740745262)).toBe("7F7F7F");
  });

  it("keeps a color without tint and clamps full tints to black and white", () => {
    expect(applyTint("4472C4", -1)).toBe("000000");
    expect(applyTint("4472C4", 1)).toBe("FFFFFF");
  });
});

describe("ColorPalette", () => {
  const theme = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72"];
  const palette = new ColorPalette(theme);

  it("reads the theme attribute with light and dark swapped", () => {
    expect(palette.resolve({ theme: 0 })).toBe("#ffffff");
    expect(palette.resolve({ theme: 1 })).toBe("#000000");
    expect(palette.resolve({ theme: 4 })).toBe("#4472c4");
    expect(palette.resolve({ theme: 4, tint: -0.249977111117893 })).toBe("#2f5597");
    expect(palette.resolve({ theme: 99 })).toBeUndefined();
  });

  it("reads ARGB and plain RGB, ignoring alpha", () => {
    expect(palette.resolve({ rgb: "FFAABBCC" })).toBe("#aabbcc");
    expect(palette.resolve({ rgb: "00AABBCC" })).toBe("#aabbcc");
    expect(palette.resolve({ rgb: "AABBCC" })).toBe("#aabbcc");
    expect(palette.resolve({ rgb: "zz" })).toBeUndefined();
  });

  it("uses the legacy palette and its system colors", () => {
    expect(palette.resolve({ indexed: 10 })).toBe("#ff0000");
    expect(palette.resolve({ indexed: 22 })).toBe("#c0c0c0");
    expect(palette.resolve({ indexed: 64 })).toBe("#000000");
    expect(palette.resolve({ indexed: 65 })).toBe("#ffffff");
  });

  it("lets a workbook replace the indexed palette", () => {
    const custom = new ColorPalette(theme, ["123456", "ABCDEF"]);
    expect(custom.resolve({ indexed: 1 })).toBe("#abcdef");
    expect(custom.resolve({ indexed: 10 })).toBe("#ff0000");
  });

  it("leaves automatic colors to the caller", () => {
    expect(palette.resolve({ auto: true })).toBeUndefined();
    expect(palette.resolve(undefined)).toBeUndefined();
  });
});
