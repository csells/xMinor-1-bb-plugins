// The viewing side of the plugin, taken over from the former Document Viewer
// (pdf-viewer) plugin: LibreOffice conversions with a per-version cache,
// local copies of files that live on other hosts, short-lived URLs for the
// classic PDF view and downloads, and workbooks read into grid models.
import { copyFile, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { contentTypeFor, extensionOf, isOoxmlSpreadsheetPath } from "../lib/formats.js";
import { baseName, directoryName, pdfNameFor, previewUrlFor } from "../lib/pdf-paths.js";
import { cacheKey, ConversionCache } from "./conversion-cache.js";
import { DocumentRegistry } from "./documents.js";
import { DOCUMENT_ROUTE, handleDocumentRequest } from "./http-routes.js";
import { LeaseCache } from "./lease-cache.js";
import { findLibreOffice, LibreOfficeRunner, type LibreOfficeInstall } from "./libreoffice.js";
import { openSpreadsheet, type SpreadsheetReader } from "./spreadsheet/index.js";

const LINK_TTL_MS = 60 * 60 * 1000;
/**
 * bb's file-preview route reads a whole file into memory and refuses anything
 * past this size, so bigger files fall back to this plugin's own ranged
 * stream. Preview is preferred below the ceiling because it is bb's native
 * transport: it reaches other hosts and keeps working when the app is open
 * remotely through bb connect.
 */
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
/** Bump when conversion output changes, so older cache entries miss. */
const CONVERTER_VERSION = 1;
const CONVERSION_TIMEOUT_MS = 3 * 60 * 1000;
/** Past this LibreOffice needs minutes and gigabytes; the viewer declines. */
const CONVERSION_MAX_BYTES = 150 * 1024 * 1024;
/** A file on another host is copied over rpc in one piece; this bounds it. */
const REMOTE_MAX_BYTES = 64 * 1024 * 1024;
const CONVERTED_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const CONVERTED_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REMOTE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const REMOTE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long a LibreOffice lookup is trusted before PATH is searched again. */
const LIBREOFFICE_LOOKUP_TTL_MS = 30 * 1000;

/** A file's place: an absolute path, on the server's machine when hostId is null. */
export interface Located {
  absPath: string;
  hostId: string | null;
}

/** A file readable on the server's own disk: the original, or a copy of a remote one. */
export interface LocalFile {
  path: string;
  /** Changes whenever the file's content can have changed. */
  identity: string;
  sizeBytes: number;
}

export interface ViewerLink {
  url: string;
  expiresAtMs: number;
}

export interface MissingLibreOffice {
  component: "writer" | "impress";
  installed: boolean;
}

interface Runtime {
  conversions: ConversionCache;
  remoteCopies: ConversionCache;
  runner: LibreOfficeRunner;
}

export function createViewer(
  bb: BbPluginApi,
  options: {
    /** The plugin's own data directory. */
    dataDir: string;
    /** The host id of the machine the bb server runs on. */
    localHostId: () => Promise<string | null>;
    /** The user's LibreOffice path setting; empty means find it automatically. */
    libreOfficePath: () => Promise<string>;
  },
) {
  const registry = new DocumentRegistry({ ttlMs: LINK_TTL_MS });
  const workbooks = new LeaseCache<SpreadsheetReader>({ maxEntries: 4, idleMs: 10 * 60 * 1000 });
  const sweepTimer = setInterval(() => workbooks.sweep(), 60 * 1000);
  sweepTimer.unref();
  let runner: LibreOfficeRunner | null = null;
  bb.onDispose(() => {
    clearInterval(sweepTimer);
    registry.clear();
    workbooks.clear();
    runner?.dispose();
  });

  bb.http.route("GET", DOCUMENT_ROUTE, (context) => handleDocumentRequest(context, registry));

  /** Cache folders and the converter, created on first use. */
  let runtimePromise: Promise<Runtime> | null = null;
  function runtime(): Promise<Runtime> {
    runtimePromise ??= (async () => {
      const root = path.join(options.dataDir, "viewer");
      await mkdir(root, { recursive: true });
      runner = new LibreOfficeRunner({
        profileDir: path.join(root, "libreoffice-profile"),
        timeoutMs: CONVERSION_TIMEOUT_MS,
      });
      const conversions = new ConversionCache({
        root: path.join(root, "converted"),
        maxBytes: CONVERTED_CACHE_MAX_BYTES,
        maxAgeMs: CONVERTED_CACHE_MAX_AGE_MS,
      });
      const remoteCopies = new ConversionCache({
        root: path.join(root, "remote"),
        maxBytes: REMOTE_CACHE_MAX_BYTES,
        maxAgeMs: REMOTE_CACHE_MAX_AGE_MS,
      });
      void conversions.prune();
      void remoteCopies.prune();
      return { conversions, remoteCopies, runner };
    })().catch((cause: unknown) => {
      runtimePromise = null;
      throw cause;
    });
    return runtimePromise;
  }

  let libreOfficeLookup: {
    override: string;
    atMs: number;
    install: Promise<LibreOfficeInstall | null>;
  } | null = null;
  async function libreOffice(): Promise<LibreOfficeInstall | null> {
    const override = (await options.libreOfficePath()).trim();
    const now = Date.now();
    if (
      !libreOfficeLookup ||
      libreOfficeLookup.override !== override ||
      now - libreOfficeLookup.atMs > LIBREOFFICE_LOOKUP_TTL_MS
    ) {
      libreOfficeLookup = { override, atMs: now, install: findLibreOffice(override || undefined) };
    }
    return await libreOfficeLookup.install;
  }

  /** Mints a URL for one file: local disk when it must, bb preview otherwise. */
  async function mintLink(file: Located): Promise<ViewerLink> {
    // Streaming from local disk lets the browser fetch ranges and has no size
    // ceiling, so it carries the files preview cannot.
    if (file.hostId === null) {
      const stats = await stat(file.absPath).catch(() => null);
      if (stats?.isFile() && stats.size > PREVIEW_MAX_BYTES) {
        const { id, expiresAtMs } = registry.register({
          path: file.absPath,
          name: baseName(file.absPath),
          sizeBytes: stats.size,
          contentType: contentTypeFor(file.absPath),
        });
        return { url: `/api/v1/plugins/${bb.pluginId}/http${DOCUMENT_ROUTE}?id=${id}`, expiresAtMs };
      }
    }
    // Name the server's own host explicitly: with several hosts connected,
    // "no host" need not mean this machine.
    const previewHost = file.hostId ?? (await options.localHostId()) ?? undefined;
    const preview = await bb.sdk.files.createPreview({
      ...(previewHost ? { hostId: previewHost } : {}),
      rootPath: directoryName(file.absPath),
      ttlMs: LINK_TTL_MS,
    });
    return {
      url: previewUrlFor(preview.baseUrl, baseName(file.absPath)),
      expiresAtMs: preview.expiresAtMs,
    };
  }

  /** The file on this server's disk, copying it over from another host if needed. */
  async function localFile(file: Located): Promise<LocalFile> {
    if (file.hostId === null) {
      const stats = await stat(file.absPath).catch(() => null);
      if (!stats?.isFile()) throw new Error(`File not found: ${file.absPath}`);
      return {
        path: file.absPath,
        identity: cacheKey(["local", file.absPath, stats.size, stats.mtimeMs]),
        sizeBytes: stats.size,
      };
    }
    const read = await bb.sdk.files.read({ hostId: file.hostId, path: file.absPath });
    if (read.sizeBytes > REMOTE_MAX_BYTES) {
      throw new Error(
        `This file is ${megabytes(read.sizeBytes)} MB on another host; files up to ${megabytes(REMOTE_MAX_BYTES)} MB are copied from there. Download it instead.`,
      );
    }
    const identity = cacheKey(["remote", read.sha256]);
    const { remoteCopies } = await runtime();
    const copy = await remoteCopies.getOrCreate(
      identity,
      `source.${extensionOf(file.absPath) || "bin"}`,
      async (staging) => {
        const target = path.join(staging, "file");
        await writeFile(target, Buffer.from(read.content, read.contentEncoding));
        return target;
      },
    );
    return { path: copy, identity, sizeBytes: read.sizeBytes };
  }

  /**
   * Converts a Word or PowerPoint file to PDF, or says which LibreOffice
   * module is missing. The output is cached per file version.
   */
  async function convertedPdf(
    file: LocalFile,
    originalName: string,
    family: "text" | "presentation",
  ): Promise<string | MissingLibreOffice> {
    const component = family === "presentation" ? "impress" : "writer";
    const install = await libreOffice();
    if (!install?.components[component]) return { component, installed: install !== null };
    if (file.sizeBytes > CONVERSION_MAX_BYTES) {
      throw new Error(
        `This file is ${megabytes(file.sizeBytes)} MB; files up to ${megabytes(CONVERSION_MAX_BYTES)} MB are converted. Download it instead.`,
      );
    }
    const { conversions, runner: converter } = await runtime();
    return await conversions.getOrCreate(
      cacheKey(["pdf", CONVERTER_VERSION, file.identity]),
      pdfNameFor(originalName),
      (staging) => convertInStaging(converter, install, file.path, originalName, staging, "pdf"),
    );
  }

  /**
   * Opens a workbook. Legacy formats (xls, xlsb, ods) go through LibreOffice
   * into xlsx when Calc is installed, so they render with full formatting;
   * without it the reader falls back to values and fills.
   */
  async function openWorkbook(file: LocalFile, originalPath: string, locale: string): Promise<SpreadsheetReader> {
    let source = file.path;
    if (!isOoxmlSpreadsheetPath(originalPath)) {
      const install = await libreOffice();
      if (install?.components.calc && file.sizeBytes <= CONVERSION_MAX_BYTES) {
        try {
          const { conversions, runner: converter } = await runtime();
          source = await conversions.getOrCreate(
            cacheKey(["xlsx", CONVERTER_VERSION, file.identity]),
            "workbook.xlsx",
            (staging) =>
              convertInStaging(converter, install, file.path, baseName(originalPath), staging, "xlsx"),
          );
        } catch (cause: unknown) {
          bb.log.warn(`LibreOffice could not convert ${originalPath}; reading it directly: ${String(cause)}`);
        }
      }
    }
    return await openSpreadsheet(source, { locale });
  }

  async function withWorkbook<R>(
    file: Located,
    locale: string,
    use: (reader: SpreadsheetReader) => Promise<R>,
  ): Promise<R> {
    const local = await localFile(file);
    return await workbooks.use(
      `${local.identity}:${locale}`,
      () => openWorkbook(local, file.absPath, locale),
      use,
    );
  }

  return { mintLink, localFile, convertedPdf, withWorkbook };
}

/**
 * Runs one LibreOffice conversion inside a staging directory. The input is
 * linked in under a neutral name, so LibreOffice's lock file and any odd
 * characters in the real name stay out of the user's folder and out of the
 * command line.
 */
async function convertInStaging(
  converter: LibreOfficeRunner,
  install: LibreOfficeInstall,
  sourcePath: string,
  originalName: string,
  staging: string,
  format: "pdf" | "xlsx",
): Promise<string> {
  const input = path.join(staging, `source.${extensionOf(originalName) || "bin"}`);
  await symlink(sourcePath, input).catch(() => copyFile(sourcePath, input));
  const outDir = path.join(staging, "out");
  await mkdir(outDir);
  return await converter.convert({ install, input, outDir, format });
}

export function serverPlatform(): "linux" | "darwin" | "win32" | "other" {
  const { platform } = process;
  return platform === "linux" || platform === "darwin" || platform === "win32" ? platform : "other";
}

export function normalizeLocale(locale: string | undefined): string {
  if (!locale) return "en-US";
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
