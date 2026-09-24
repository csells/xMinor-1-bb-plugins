import { describe, expect, it } from "vitest";

import { decodeEntities, decodeOoxmlEscapes, type XmlAttributes, XmlTokenizer } from "./xml";

/** Tokenizes a document fed in the given pieces; returns a readable event log. */
function events(pieces: readonly string[], captured: readonly string[] = ["t", "v"]): string[] {
  const log: string[] = [];
  const tokenizer = new XmlTokenizer({
    open(name: string, attributes: XmlAttributes, prefix: string) {
      log.push(`open ${prefix}${name} ${JSON.stringify(attributes)}`);
      return captured.includes(name);
    },
    close(name: string) {
      log.push(`close ${name}`);
    },
    text(text: string) {
      log.push(`text ${JSON.stringify(text)}`);
    },
  });
  for (const piece of pieces) tokenizer.write(piece);
  return log;
}

const DOCUMENT = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<!-- a comment with <tags> inside -->",
  '<x:worksheet xmlns:x="urn:main" xmlns:r="urn:rels" xmlns="urn:default">',
  '<x:c r="A1" t="s" x:foo=\'b"ar\'><x:v>12</x:v></x:c>',
  '<numFmt formatCode="[&gt;=100]0;&quot;x&quot;" data=">"/>',
  "<t>a &lt; b &amp; &#x41;&#66; _x000D_</t>",
  "<t><![CDATA[<raw> & text]]> tail</t>",
  "<t/>",
  "</x:worksheet>",
].join("");

describe("XmlTokenizer", () => {
  it("reports local names, prefixes, attributes and captured text", () => {
    expect(events([DOCUMENT])).toEqual([
      'open x:worksheet {}',
      'open x:c {"r":"A1","t":"s","foo":"b\\"ar"}',
      'open x:v {}',
      'text "12"',
      "close v",
      "close c",
      'open numFmt {"formatCode":"[>=100]0;\\"x\\"","data":">"}',
      "close numFmt",
      "open t {}",
      'text "a < b & AB _x000D_"',
      "close t",
      "open t {}",
      'text "<raw> & text tail"',
      "close t",
      "open t {}",
      "close t",
      "close worksheet",
    ]);
  });

  it("gives the same events however the input is split", () => {
    const whole = events([DOCUMENT]);
    for (let size = 1; size <= 7; size += 1) {
      const pieces: string[] = [];
      for (let i = 0; i < DOCUMENT.length; i += size) pieces.push(DOCUMENT.slice(i, i + size));
      expect(events(pieces)).toEqual(whole);
    }
  });

  it("stops after the current event and hands back the rest", () => {
    const seen: string[] = [];
    let tokenizer: XmlTokenizer | null = null;
    tokenizer = new XmlTokenizer({
      open(name: string) {
        seen.push(name);
        if (name === "stop") tokenizer?.stop();
      },
      close() {},
    });
    tokenizer.write("<a><stop x='1'><b/></stop></a>");
    expect(seen).toEqual(["a", "stop"]);
    expect(tokenizer.remainder()).toBe("<b/></stop></a>");
  });
});

describe("text decoding", () => {
  it("decodes predefined entities and character references", () => {
    expect(decodeEntities("&lt;&gt;&amp;&quot;&apos;&#169;&#x1F600;&unknown;")).toBe("<>&\"'©😀&unknown;");
  });

  it("decodes OOXML escapes, including an escaped escape", () => {
    expect(decodeOoxmlEscapes("a_x000D__x000A_b")).toBe("a\r\nb");
    expect(decodeOoxmlEscapes("_x005F_x0041_")).toBe("_x0041_");
    expect(decodeOoxmlEscapes("_xZZZZ_ stays")).toBe("_xZZZZ_ stays");
  });
});
