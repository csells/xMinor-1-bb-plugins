import { writeFile } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildZip, temporaryDirectory } from "./test-workbook";
import { ZipArchive, ZipFormatError } from "./zip";

async function readAll(zip: ZipArchive, name: string): Promise<string> {
  const entry = zip.get(name);
  if (!entry) throw new Error(`missing ${name}`);
  const chunks: Buffer[] = [];
  for await (const chunk of zip.read(entry)) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
beforeAll(async () => {
  directory = await temporaryDirectory();
});
afterAll(async () => {
  await directory.cleanup();
});

describe("ZipArchive", () => {
  it("reads stored and deflated entries by case-insensitive name", async () => {
    const big = "<row/>".repeat(100_000);
    const path = directory.path("plain.zip");
    await writeFile(
      path,
      buildZip([
        { name: "xl/workbook.xml", data: "<workbook/>", method: 0 },
        { name: "xl/worksheets/Sheet1.xml", data: big },
      ]),
    );
    const zip = await ZipArchive.open(path);
    expect(await readAll(zip, "xl/workbook.xml")).toBe("<workbook/>");
    expect(await readAll(zip, "/XL/worksheets/sheet1.xml")).toBe(big);
    // Repeated reads of the same entry work: the handle stays open between them.
    expect(await readAll(zip, "xl/worksheets/sheet1.xml")).toBe(big);
    expect(zip.get("xl/missing.xml")).toBeUndefined();
    await zip.close();
  });

  it("normalizes backslash names written by some Windows tools", async () => {
    const path = directory.path("backslash.zip");
    await writeFile(path, buildZip([{ name: "xl\\workbook.xml", data: "<workbook/>" }]));
    const zip = await ZipArchive.open(path);
    expect(await readAll(zip, "xl/workbook.xml")).toBe("<workbook/>");
    await zip.close();
  });

  it("reads ZIP64 sizes and offsets from the extra field", async () => {
    const data = Buffer.from("<zip64/>");
    const body = deflateRawSync(data);
    const name = Buffer.from("a.xml");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    const extra = Buffer.alloc(4 + 24);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(body.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(0xffffffff, 20);
    central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(0xffffffff, 42);
    const directoryBytes = Buffer.concat([central, name, extra]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(directoryBytes.length, 12);
    end.writeUInt32LE(local.length + name.length + body.length, 16);
    const path = directory.path("zip64.zip");
    await writeFile(path, Buffer.concat([local, name, body, directoryBytes, end]));
    const zip = await ZipArchive.open(path);
    expect(await readAll(zip, "a.xml")).toBe("<zip64/>");
    await zip.close();
  });

  it("refuses files that are not zip archives", async () => {
    const path = directory.path("not.zip");
    await writeFile(path, "just some text, long enough to have an end record search");
    await expect(ZipArchive.open(path)).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("finishes reads in flight before closing the file", async () => {
    const path = directory.path("close.zip");
    const big = "<c/>".repeat(500_000);
    await writeFile(path, buildZip([{ name: "a.xml", data: big }]));
    const zip = await ZipArchive.open(path);
    const entry = zip.get("a.xml");
    if (!entry) throw new Error("missing entry");
    const reading = (async () => {
      let length = 0;
      for await (const chunk of zip.read(entry)) length += chunk.length;
      return length;
    })();
    await zip.close();
    expect(await reading).toBe(big.length);
    await expect(readAll(zip, "a.xml")).rejects.toThrow(/closed/);
  });
});
