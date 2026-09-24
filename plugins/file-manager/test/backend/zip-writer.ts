// test/backend/zip-writer.ts — a minimal zip writer for the archive-listing
// suites (§8.13).
//
// Every entry is stored, and every field a listing reads is the caller's to
// set: the raw name bytes (so a CP866 name without the UTF-8 flag is exactly
// what Windows Explorer writes), the flags, the host and attributes, the DOS
// date. No archiver on the host will produce half of these on request.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipFixtureEntry {
  /** A string is written as UTF-8; a Buffer is written byte for byte. */
  name: string | Buffer;
  content?: string;
  /** General purpose flags: 0x0800 = UTF-8 names, 0x0001 = encrypted. */
  flags?: number;
  /** "Version made by" host: 0 = MS-DOS, 3 = Unix. */
  host?: number;
  externalAttributes?: number;
  /** MS-DOS date field; 0 means "no time recorded". */
  dosDate?: number;
  dosTime?: number;
}

/** 2024-03-15 12:30:00 in MS-DOS form. */
export const DOS_DATE = ((2024 - 1980) << 9) | (3 << 5) | 15;
export const DOS_TIME = (12 << 11) | (30 << 5);

export function makeZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = typeof entry.name === "string" ? Buffer.from(entry.name, "utf8") : entry.name;
    const data = Buffer.from(entry.content ?? "", "utf8");
    const crc = crc32(data);
    const flags = entry.flags ?? 0;
    const host = entry.host ?? 3;
    const date = entry.dosDate ?? DOS_DATE;
    const time = entry.dosTime ?? DOS_TIME;
    const attributes =
      entry.externalAttributes ?? (host === 3 ? (0o100644 << 16) >>> 0 : 0x20);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((host << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(attributes >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/* ------------------------------------------------------------------ */
/* RAR 4.x, stored members only                                        */
/* ------------------------------------------------------------------ */

export interface RarFixtureEntry {
  name: string;
  content?: string;
  directory?: boolean;
  /** Sets the header's "encrypted" flag; the bytes stay plain (we never read them). */
  encrypted?: boolean;
}

function rarBlock(type: number, flags: number, body: Buffer): Buffer {
  const rest = Buffer.alloc(5);
  rest.writeUInt8(type, 0);
  rest.writeUInt16LE(flags, 1);
  rest.writeUInt16LE(7 + body.length, 3);
  const header = Buffer.concat([rest, body]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc32(header) & 0xffff, 0);
  return Buffer.concat([crc, header]);
}

/**
 * A RAR 4 archive with stored members — enough for 7z to list it on a host
 * whose 7z carries no RAR codec, and there is no `rar` binary to make one.
 */
export function makeRar(entries: readonly RarFixtureEntry[]): Buffer {
  const parts: Buffer[] = [Buffer.from("Rar!\x1a\x07\x00", "latin1")];
  parts.push(rarBlock(0x73, 0, Buffer.alloc(6)));
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.content ?? "", "utf8");
    let flags = 0x8000;
    if (entry.directory === true) flags |= 0xe0;
    if (entry.encrypted === true) flags |= 0x04;
    const body = Buffer.alloc(25);
    body.writeUInt32LE(data.length, 0); // packed size
    body.writeUInt32LE(data.length, 4); // unpacked size
    body.writeUInt8(3, 8); // host OS: Unix
    body.writeUInt32LE(crc32(data), 9);
    body.writeUInt32LE(((DOS_DATE << 16) | DOS_TIME) >>> 0, 13);
    body.writeUInt8(29, 17); // version needed
    body.writeUInt8(0x30, 18); // method: store
    body.writeUInt16LE(name.length, 19);
    body.writeUInt32LE(entry.directory === true ? 0o40755 : 0o100644, 21);
    parts.push(rarBlock(0x74, flags, Buffer.concat([body, name])), data);
  }
  parts.push(rarBlock(0x7b, 0x4000, Buffer.alloc(0)));
  return Buffer.concat(parts);
}
