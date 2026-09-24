// A minimal zip reader for OOXML packages.
//
// Why not a library: a workbook needs random access to a handful of named
// parts, each inflated as a stream so a 200 MB sheet never sits in memory.
// That is the central directory plus node:zlib — the code below — and it keeps
// the plugin free of a dependency whose extra features (writing, CP437 names,
// multi-disk archives, callback APIs) this reader never uses. Inflation runs
// on libuv's thread pool, off the event loop.
import { open, type FileHandle } from "node:fs/promises";
import { pipeline, type Transform } from "node:stream";
import { createInflateRaw } from "node:zlib";

export interface ZipEntry {
  /** Name as stored, with `/` separators and no leading slash. */
  readonly name: string;
  /** 0 = stored, 8 = deflate; anything else is refused when read. */
  readonly method: number;
  readonly flags: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

/** The file is not a readable zip archive. */
export class ZipFormatError extends Error {}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;
const UINT32_MAX = 0xffffffff;
const FLAG_ENCRYPTED = 0x1;
/** A central directory this big is not a workbook; refuse instead of allocating. */
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
/**
 * Size of the chunks handed to the XML scanner. Big enough that inflation is
 * not dominated by per-chunk overhead, small enough that scanning one chunk
 * stays far below the event-loop budget.
 */
const CHUNK_BYTES = 128 * 1024;

export class ZipArchive {
  readonly #handle: FileHandle;
  readonly #entries: ReadonlyMap<string, ZipEntry>;
  readonly #dataOffsets = new Map<ZipEntry, number>();
  #activeReads = 0;
  #closing = false;
  #closed: Promise<void> | null = null;

  private constructor(handle: FileHandle, entries: ReadonlyMap<string, ZipEntry>) {
    this.#handle = handle;
    this.#entries = entries;
  }

  static async open(path: string): Promise<ZipArchive> {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      return new ZipArchive(handle, await readCentralDirectory(handle, size));
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  /** The entry for a part name; OPC compares part names case-insensitively. */
  get(name: string): ZipEntry | undefined {
    return this.#entries.get(entryKey(name));
  }

  entries(): IterableIterator<ZipEntry> {
    return this.#entries.values();
  }

  /** Streams an entry's uncompressed bytes in chunks of up to 128 KB. */
  async *read(entry: ZipEntry, signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (this.#closing) throw new Error("The spreadsheet has been closed.");
    if (entry.flags & FLAG_ENCRYPTED) {
      throw new ZipFormatError(`Zip entry ${entry.name} is encrypted.`);
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipFormatError(
        `Zip entry ${entry.name} uses unsupported compression method ${entry.method}.`,
      );
    }
    this.#activeReads += 1;
    let inflate: Transform | undefined;
    try {
      const start = await this.#dataOffset(entry);
      const compressed = readRange(this.#handle, start, entry.compressedSize);
      let output: AsyncIterable<Buffer> = compressed;
      if (entry.method === 8) {
        inflate = createInflateRaw({ chunkSize: CHUNK_BYTES });
        output = pipeline(compressed, inflate, () => {
          // Errors surface through the iteration below; early exits are fine.
        });
      }
      for await (const chunk of output) {
        signal?.throwIfAborted();
        yield chunk;
      }
    } finally {
      inflate?.destroy();
      this.#activeReads -= 1;
      if (this.#closing && this.#activeReads === 0) void this.#closeHandle();
    }
  }

  /**
   * Releases the file. Reads still in flight finish first, so a cache can
   * evict a reader without breaking a request that is using it.
   */
  close(): Promise<void> {
    this.#closing = true;
    if (this.#activeReads === 0) return this.#closeHandle();
    return Promise.resolve();
  }

  #closeHandle(): Promise<void> {
    this.#closed ??= this.#handle.close().catch(() => undefined);
    return this.#closed;
  }

  /** Where the entry's data starts: after its local header, whose extra field may differ from the central one. */
  async #dataOffset(entry: ZipEntry): Promise<number> {
    const known = this.#dataOffsets.get(entry);
    if (known !== undefined) return known;
    const header = Buffer.alloc(LOCAL_HEADER_SIZE);
    await readExactly(this.#handle, header, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ZipFormatError(`Zip entry ${entry.name} has no local header.`);
    }
    const offset =
      entry.localHeaderOffset +
      LOCAL_HEADER_SIZE +
      header.readUInt16LE(26) +
      header.readUInt16LE(28);
    this.#dataOffsets.set(entry, offset);
    return offset;
  }
}

/** Lookup key: forward slashes, no leading slash, ASCII case folded. */
function entryKey(name: string): string {
  return normalizeEntryName(name).toLowerCase();
}

/** Some Windows tools store `xl\worksheets\sheet1.xml`; OPC names use `/`. */
function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Reads a byte range in chunks. Hand-rolled rather than
 * FileHandle.createReadStream, whose destroy() closes the shared handle
 * even with autoClose off.
 */
async function* readRange(handle: FileHandle, start: number, length: number): AsyncGenerator<Buffer> {
  let position = start;
  const end = start + length;
  while (position < end) {
    const size = Math.min(CHUNK_BYTES, end - position);
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, position);
    if (bytesRead === 0) throw new ZipFormatError("Unexpected end of the zip file.");
    position += bytesRead;
    yield bytesRead === size ? buffer : buffer.subarray(0, bytesRead);
  }
}

async function readExactly(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new ZipFormatError("Unexpected end of the zip file.");
    offset += bytesRead;
  }
}

/** Finds the end-of-central-directory record, which sits before an optional comment. */
async function readCentralDirectory(handle: FileHandle, size: number): Promise<Map<string, ZipEntry>> {
  if (size < EOCD_SIZE) throw new ZipFormatError("The file is too small to be a zip archive.");
  const tailSize = Math.min(size, EOCD_SIZE + MAX_COMMENT_SIZE + ZIP64_LOCATOR_SIZE);
  const tail = Buffer.alloc(tailSize);
  await readExactly(handle, tail, size - tailSize);

  let eocd = -1;
  for (let i = tailSize - EOCD_SIZE; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE && i + EOCD_SIZE + tail.readUInt16LE(i + 20) <= tailSize) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ZipFormatError("No zip central directory found.");

  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);
  const locator = eocd - ZIP64_LOCATOR_SIZE;
  if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR_SIGNATURE) {
    const record = Buffer.alloc(56);
    await readExactly(handle, record, Number(tail.readBigUInt64LE(locator + 8)));
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      throw new ZipFormatError("Broken ZIP64 end of central directory.");
    }
    directorySize = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
  }
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + directorySize > size) {
    throw new ZipFormatError("The zip central directory is out of bounds.");
  }

  const directory = Buffer.alloc(directorySize);
  await readExactly(handle, directory, directoryOffset);
  return parseCentralDirectory(directory, size);
}

function parseCentralDirectory(directory: Buffer, fileSize: number): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  let offset = 0;
  while (offset + CENTRAL_HEADER_SIZE <= directory.length) {
    if (directory.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const nameStart = offset + CENTRAL_HEADER_SIZE;
    const extraStart = nameStart + nameLength;
    if (extraStart + extraLength > directory.length) break;

    let compressedSize = directory.readUInt32LE(offset + 20);
    let uncompressedSize = directory.readUInt32LE(offset + 24);
    let localHeaderOffset = directory.readUInt32LE(offset + 42);
    // ZIP64 stores the real values in extra field 0x0001, in this order, only
    // for the fields that are saturated in the fixed header.
    const zip64 = findExtraField(directory, extraStart, extraLength, 0x0001);
    if (zip64) {
      let cursor = zip64.start;
      const readZip64 = (fallback: number): number => {
        if (cursor + 8 > zip64.end) return fallback;
        const value = Number(directory.readBigUInt64LE(cursor));
        cursor += 8;
        return value;
      };
      if (uncompressedSize === UINT32_MAX) uncompressedSize = readZip64(uncompressedSize);
      if (compressedSize === UINT32_MAX) compressedSize = readZip64(compressedSize);
      if (localHeaderOffset === UINT32_MAX) localHeaderOffset = readZip64(localHeaderOffset);
    }

    const name = normalizeEntryName(directory.toString("utf8", nameStart, extraStart));
    const key = name.toLowerCase();
    const isDirectory = name.endsWith("/");
    if (!isDirectory && !entries.has(key) && localHeaderOffset + LOCAL_HEADER_SIZE <= fileSize) {
      entries.set(key, {
        name,
        method: directory.readUInt16LE(offset + 10),
        flags: directory.readUInt16LE(offset + 8),
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }
    offset = extraStart + extraLength + commentLength;
  }
  if (entries.size === 0) throw new ZipFormatError("The zip archive is empty.");
  return entries;
}

/** Bounds of an extra field's data, or null. */
function findExtraField(
  buffer: Buffer,
  start: number,
  length: number,
  id: number,
): { start: number; end: number } | null {
  let cursor = start;
  const end = start + length;
  while (cursor + 4 <= end) {
    const fieldId = buffer.readUInt16LE(cursor);
    const fieldSize = buffer.readUInt16LE(cursor + 2);
    if (fieldId === id && cursor + 4 + fieldSize <= end) {
      return { start: cursor + 4, end: cursor + 4 + fieldSize };
    }
    cursor += 4 + fieldSize;
  }
  return null;
}
