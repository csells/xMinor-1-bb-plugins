import { describe, expect, it } from "vitest";
import { parseBboxLayout } from "./bbox.js";

const SAMPLE = `<doc>
  <page width="200.000000" height="100.000000">
    <flow><block xMin="0" yMin="0" xMax="200" yMax="100">
      <line xMin="10" yMin="10" xMax="190" yMax="20">
        <word xMin="10.000000" yMin="10.000000" xMax="50.000000" yMax="20.000000">Было</word>
        <word xMin="60.000000" yMin="10.000000" xMax="70.000000" yMax="20.000000">&amp;</word>
        <word xMin="80.000000" yMin="10.000000" xMax="190.000000" yMax="20.000000">&#x201C;Стало&#x201D;</word>
      </line>
      <line xMin="10" yMin="30" xMax="50" yMax="40">
        <word xMin="10.000000" yMin="30.000000" xMax="50.000000" yMax="40.000000">&lt;b&gt;</word>
      </line>
    </block></flow>
  </page>
  <page width="200.000000" height="100.000000"></page>
</doc>`;

describe("parseBboxLayout", () => {
  it("groups words by line with page-normalized boxes", () => {
    const pages = parseBboxLayout(SAMPLE);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.lines).toHaveLength(2);
    expect(pages[0]!.lines[0]![0]).toEqual([0.05, 0.1, 0.25, 0.2, "Было"]);
  });

  it("decodes XML entities", () => {
    const [first] = parseBboxLayout(SAMPLE);
    const words = first!.lines.flat().map((word) => word[4]);
    expect(words).toEqual(["Было", "&", "“Стало”", "<b>"]);
  });

  it("returns empty pages for pages without text", () => {
    expect(parseBboxLayout(SAMPLE)[1]!.lines).toEqual([]);
  });
});
