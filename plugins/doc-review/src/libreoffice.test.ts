import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findLibreOffice, LibreOfficeRunner, type LibreOfficeInstall } from "./libreoffice";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pdf-viewer-lo-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A stand-in for soffice: reads --convert-to, --outdir and the input like the
 * real one, then behaves as the test asks — write the output, print
 * LibreOffice's load failure, or hang.
 */
async function fakeSoffice(behaviour: "convert" | "fail" | "hang"): Promise<string> {
  const programDir = path.join(dir, "program");
  await mkdir(programDir, { recursive: true });
  const script = path.join(programDir, "soffice");
  await writeFile(
    script,
    `#!/bin/sh
format=""; outdir=""; input=""
while [ $# -gt 0 ]; do
  case "$1" in
    --convert-to) format="$2"; shift 2 ;;
    --outdir) outdir="$2"; shift 2 ;;
    -*) shift ;;
    *) input="$1"; shift ;;
  esac
done
case "${behaviour}" in
  convert)
    name=$(basename "$input"); stem="\${name%.*}"
    printf 'converted %s' "$name" > "$outdir/$stem.$format"
    echo "convert $input -> $outdir/$stem.$format" ;;
  fail) echo "Error: source file could not be loaded" >&2 ;;
  hang) sleep 30 ;;
esac
`,
  );
  await chmod(script, 0o755);
  return script;
}

function install(executable: string): LibreOfficeInstall {
  return {
    executable,
    components: { writer: true, impress: true, calc: true },
  };
}

async function request(format: "pdf" | "xlsx" = "pdf") {
  const input = path.join(dir, "source.docx");
  await writeFile(input, "doc");
  const outDir = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
  await mkdir(outDir);
  return { input, outDir, format };
}

describe("findLibreOffice", () => {
  it("takes an explicit executable as given", async () => {
    const script = await fakeSoffice("convert");
    const found = await findLibreOffice(script);
    expect(found?.executable).toBe(script);
  });

  it("reads installed modules from their libraries", async () => {
    const script = await fakeSoffice("convert");
    await writeFile(path.join(dir, "program", "libswlo.so"), "");
    await writeFile(path.join(dir, "program", "libsdlo.so"), "");
    const found = await findLibreOffice(script);
    expect(found?.components).toEqual({ writer: true, impress: true, calc: false });
  });

  it("assumes every module when the layout is unfamiliar", async () => {
    const script = await fakeSoffice("convert");
    const found = await findLibreOffice(script);
    expect(found?.components).toEqual({ writer: true, impress: true, calc: true });
  });

  it("returns null for a path that is not an executable", async () => {
    expect(await findLibreOffice(path.join(dir, "missing"))).toBeNull();
  });
});

describe("LibreOfficeRunner", () => {
  it("resolves to the file LibreOffice wrote", async () => {
    const runner = new LibreOfficeRunner({
      profileDir: path.join(dir, "profile"),
      timeoutMs: 10_000,
    });
    const output = await runner.convert({
      install: install(await fakeSoffice("convert")),
      ...(await request()),
    });
    expect(path.basename(output)).toBe("source.pdf");
    expect(await readFile(output, "utf8")).toBe("converted source.docx");
  });

  it("turns LibreOffice's silent failure into a readable error", async () => {
    const runner = new LibreOfficeRunner({
      profileDir: path.join(dir, "profile"),
      timeoutMs: 10_000,
    });
    await expect(
      runner.convert({ install: install(await fakeSoffice("fail")), ...(await request()) }),
    ).rejects.toThrow(/could not open this file/);
  });

  it("kills a conversion that hangs and keeps the queue moving", async () => {
    const runner = new LibreOfficeRunner({
      profileDir: path.join(dir, "profile"),
      timeoutMs: 300,
    });
    const hanging = runner.convert({
      install: install(await fakeSoffice("hang")),
      ...(await request()),
    });
    await expect(hanging).rejects.toThrow(/did not finish/);

    const quick = new LibreOfficeRunner({
      profileDir: path.join(dir, "profile"),
      timeoutMs: 10_000,
    });
    const output = await quick.convert({
      install: install(await fakeSoffice("convert")),
      ...(await request()),
    });
    expect(path.basename(output)).toBe("source.pdf");
  });

  it("runs conversions one at a time, in order", async () => {
    const runner = new LibreOfficeRunner({
      profileDir: path.join(dir, "profile"),
      timeoutMs: 10_000,
    });
    const soffice = install(await fakeSoffice("convert"));
    // Prepare every request first: queued in a known order, they must finish
    // in that order.
    const requests = [await request(), await request(), await request()];
    const finished: number[] = [];
    await Promise.all(
      requests.map((prepared, index) =>
        runner.convert({ install: soffice, ...prepared }).then(() => {
          finished.push(index);
        }),
      ),
    );
    expect(finished).toEqual([0, 1, 2]);
  });

  it("refuses new work after dispose", async () => {
    const runner = new LibreOfficeRunner({
      profileDir: path.join(dir, "profile"),
      timeoutMs: 10_000,
    });
    runner.dispose();
    await expect(
      runner.convert({ install: install(await fakeSoffice("convert")), ...(await request()) }),
    ).rejects.toThrow(/shutting down/);
  });
});

// A real conversion when this machine has LibreOffice: the slowest test here
// (a cold profile takes a few seconds), and the one that proves the flags.
const realInstall = await findLibreOffice(undefined);

describe.skipIf(realInstall === null)("LibreOfficeRunner with the real LibreOffice", () => {
  it("converts an RTF document to PDF", async () => {
    const runner = new LibreOfficeRunner({
      profileDir: path.join(dir, "profile"),
      timeoutMs: 120_000,
    });
    const input = path.join(dir, "letter.rtf");
    await writeFile(input, "{\\rtf1\\ansi{\\fonttbl\\f0\\fswiss Helvetica;}\\f0\\pard Hello from the viewer.\\par}");
    const outDir = path.join(dir, "out");
    await mkdir(outDir);
    const output = await runner.convert({
      install: realInstall!,
      input,
      outDir,
      format: "pdf",
    });
    const bytes = await readFile(output);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 120_000);
});
