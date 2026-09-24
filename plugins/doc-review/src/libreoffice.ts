// LibreOffice as a headless converter: finds an installation, runs one
// conversion at a time in the plugin's own profile, and kills a conversion
// that hangs.
//
// The dedicated profile matters twice: a LibreOffice window the user already
// has open would otherwise swallow the headless request (the second process
// hands its arguments to the first and exits without converting), and the
// profile's lock files stay out of the user's own LibreOffice settings.
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The LibreOffice modules the viewer drives; each imports its own formats. */
export type OfficeComponent = "writer" | "impress" | "calc";

export interface LibreOfficeInstall {
  executable: string;
  components: Record<OfficeComponent, boolean>;
}

/**
 * Debian, Ubuntu and Fedora split LibreOffice into per-module packages, and
 * each package ships its module's core library into `program/`. Its presence
 * is the cheapest honest answer to "can this install open a .pptx".
 */
const COMPONENT_LIBRARIES: Record<OfficeComponent, string> = {
  writer: "libswlo",
  impress: "libsdlo",
  calc: "libsclo",
};

const LIBRARY_SUFFIXES = [".so", ".dylib", ".dll", ""];

function wellKnownExecutables(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        path.join(os.homedir(), "Applications/LibreOffice.app/Contents/MacOS/soffice"),
      ];
    case "win32":
      return [
        "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
        "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
      ];
    default:
      return [
        "/usr/bin/soffice",
        "/usr/bin/libreoffice",
        "/usr/local/bin/soffice",
        "/usr/lib/libreoffice/program/soffice",
        "/usr/lib64/libreoffice/program/soffice",
        "/opt/libreoffice/program/soffice",
      ];
  }
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) return false;
    if (process.platform === "win32") return true;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `soffice` on PATH, then the vendor install locations, then /opt/libreofficeX.Y. */
async function executableCandidates(): Promise<string[]> {
  const names =
    process.platform === "win32"
      ? ["soffice.exe", "soffice.com"]
      : ["soffice", "libreoffice"];
  const fromPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => path.join(directory, name)));

  // The Document Foundation's own .deb/.rpm builds install versioned folders
  // such as /opt/libreoffice24.8 and link nothing onto PATH.
  const versioned: string[] = [];
  if (process.platform !== "win32" && process.platform !== "darwin") {
    const entries = await readdir("/opt").catch(() => [] as string[]);
    for (const entry of entries.sort().reverse()) {
      if (/^libreoffice/i.test(entry)) {
        versioned.push(path.join("/opt", entry, "program", "soffice"));
      }
    }
  }
  return [...fromPath, ...wellKnownExecutables(), ...versioned];
}

async function detectComponents(
  executable: string,
): Promise<Record<OfficeComponent, boolean>> {
  const resolved = await realpath(executable).catch(() => executable);
  const programDir = path.dirname(resolved);
  // macOS keeps the libraries in the bundle's Frameworks folder.
  const directories = [programDir, path.join(programDir, "..", "Frameworks")];
  const found: Record<OfficeComponent, boolean> = {
    writer: false,
    impress: false,
    calc: false,
  };
  let sawAnyLibrary = false;
  for (const directory of directories) {
    const entries = new Set(await readdir(directory).catch(() => [] as string[]));
    for (const component of Object.keys(COMPONENT_LIBRARIES) as OfficeComponent[]) {
      const stem = COMPONENT_LIBRARIES[component];
      if (LIBRARY_SUFFIXES.some((suffix) => entries.has(`${stem}${suffix}`))) {
        found[component] = true;
        sawAnyLibrary = true;
      }
    }
  }
  // An unfamiliar layout proves nothing either way: let a conversion try and
  // report its own failure rather than refuse up front.
  if (!sawAnyLibrary) return { writer: true, impress: true, calc: true };
  return found;
}

/**
 * Finds a usable LibreOffice. An explicit path from the settings wins and is
 * not second-guessed; otherwise PATH and the usual install folders are tried.
 */
export async function findLibreOffice(
  explicitPath: string | undefined,
): Promise<LibreOfficeInstall | null> {
  const override = explicitPath?.trim();
  const candidates = override ? [override] : await executableCandidates();
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return {
        executable: candidate,
        components: await detectComponents(candidate),
      };
    }
  }
  return null;
}

export type ConversionFormat = "pdf" | "xlsx";

export interface ConversionRequest {
  install: LibreOfficeInstall;
  /** The document to convert; LibreOffice names its output after this file. */
  input: string;
  /** An empty directory the output lands in. */
  outDir: string;
  format: ConversionFormat;
  signal?: AbortSignal;
}

export class ConversionError extends Error {
  constructor(
    message: string,
    readonly detail: string = "",
  ) {
    super(message);
    this.name = "ConversionError";
  }
}

const OUTPUT_CAPTURE_BYTES = 16 * 1024;

/**
 * Runs conversions one after another. LibreOffice cannot share one profile
 * between two live processes, and a single conversion already keeps a core
 * busy, so a queue is both the correct and the polite shape here.
 */
export class LibreOfficeRunner {
  readonly #profileDir: string;
  readonly #timeoutMs: number;
  readonly #maxQueued: number;
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;
  #active: ChildProcess | null = null;
  #disposed = false;

  constructor(options: {
    profileDir: string;
    timeoutMs: number;
    maxQueued?: number;
  }) {
    this.#profileDir = options.profileDir;
    this.#timeoutMs = options.timeoutMs;
    this.#maxQueued = options.maxQueued ?? 8;
  }

  /** Converts one file and resolves to the output path. */
  convert(request: ConversionRequest): Promise<string> {
    if (this.#disposed) {
      return Promise.reject(new ConversionError("The viewer is shutting down."));
    }
    if (this.#queued >= this.#maxQueued) {
      return Promise.reject(
        new ConversionError(
          "Too many documents are waiting to be converted. Try again in a moment.",
        ),
      );
    }
    this.#queued += 1;
    const run = this.#tail.then(() => {
      this.#queued -= 1;
      return this.#run(request);
    });
    // The queue keeps moving whether this conversion succeeds or not.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Kills the running conversion; queued ones fail as they come up. */
  dispose(): void {
    this.#disposed = true;
    if (this.#active) killTree(this.#active);
  }

  #run(request: ConversionRequest): Promise<string> {
    if (this.#disposed) {
      return Promise.reject(new ConversionError("The viewer is shutting down."));
    }
    if (request.signal?.aborted) {
      return Promise.reject(new ConversionError("The conversion was cancelled."));
    }
    const args = [
      `-env:UserInstallation=${pathToFileURL(this.#profileDir).href}`,
      "--headless",
      "--invisible",
      "--nodefault",
      "--nofirststartwizard",
      "--nolockcheck",
      "--nologo",
      "--norestore",
      "--convert-to",
      request.format,
      "--outdir",
      request.outDir,
      request.input,
    ];
    return new Promise<string>((resolve, reject) => {
      const child = spawn(request.install.executable, args, {
        // A process group of its own, so a timeout can take soffice.bin down
        // together with the launcher script that started it.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.#active = child;
      let output = "";
      const capture = (chunk: Buffer) => {
        if (output.length < OUTPUT_CAPTURE_BYTES) {
          output += chunk.toString("utf8").slice(0, OUTPUT_CAPTURE_BYTES - output.length);
        }
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);

      let settled = false;
      const finish = (error: ConversionError | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        if (this.#active === child) this.#active = null;
        if (error) {
          reject(error);
          return;
        }
        const expected = path.join(
          request.outDir,
          `${path.parse(request.input).name}.${request.format}`,
        );
        stat(expected).then(
          (stats) => {
            if (stats.isFile() && stats.size > 0) resolve(expected);
            else reject(conversionFailure(output));
          },
          () => reject(conversionFailure(output)),
        );
      };

      const timer = setTimeout(() => {
        killTree(child);
        finish(
          new ConversionError(
            `LibreOffice did not finish within ${Math.round(this.#timeoutMs / 1000)} seconds.`,
            output,
          ),
        );
      }, this.#timeoutMs);
      const onAbort = () => {
        killTree(child);
        finish(new ConversionError("The conversion was cancelled.", output));
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (cause) => {
        finish(
          new ConversionError(`Could not start LibreOffice: ${cause.message}`, output),
        );
      });
      child.on("exit", () => finish(null));
    });
  }
}

/** LibreOffice exits 0 even when it could not load the file; its words say why. */
function conversionFailure(output: string): ConversionError {
  const trimmed = output.trim();
  if (/source file could not be loaded/i.test(trimmed)) {
    return new ConversionError(
      "LibreOffice could not open this file. It may be damaged, protected with a password, or in a format this LibreOffice cannot read.",
      trimmed,
    );
  }
  return new ConversionError(
    "LibreOffice finished without producing a document.",
    trimmed,
  );
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // The group may already be gone; fall through to the direct kill.
  }
  child.kill("SIGKILL");
}
