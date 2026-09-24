// Read-only surface: listDir, statPath, searchDir, entry mapping (§11.1).
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_LIST_ENTRIES, STAGING_DIR_NAME } from "../../contract";
import { isFileManagerError } from "../../src/errors";
import {
  buildEntry,
  detectArchiveFormat,
  listDir,
  searchDir,
  statPath,
} from "../../src/listing";
import { initRoot } from "../../src/root";

let root = "";
let outside = "";

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => {
      throw new Error(`expected the call to reject with ${code}`);
    },
    (reason: unknown) => reason,
  );
  expect(isFileManagerError(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-list-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-outside-")));
  await initRoot(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("detectArchiveFormat", () => {
  it.each([
    ["photos.zip", "zip"],
    ["backup.tar", "tar"],
    ["backup.tar.gz", "tar.gz"],
    ["backup.TAR.GZ", "tar.gz"],
    ["backup.tgz", "tar.gz"],
    ["backup.tar.bz2", "tar.bz2"],
    ["backup.tbz2", "tar.bz2"],
    ["backup.tar.xz", "tar.xz"],
    ["backup.txz", "tar.xz"],
    ["blob.7z", "7z"],
    ["scans.RAR", "rar"],
    ["backup.tbz", "tar.bz2"],
  ])("maps %s to %s", (name, format) => {
    expect(detectArchiveFormat(name)).toBe(format);
  });

  it.each(["notes.txt", "archive", "a.gz", ".zip", ".tar.gz", "zip"])(
    "returns null for %s",
    (name) => {
      expect(detectArchiveFormat(name)).toBeNull();
    },
  );
});

describe("listDir", () => {
  it("returns size and mtime for files and zero size for directories", async () => {
    await writeFile(path.join(root, "a.txt"), "hello");
    await mkdir(path.join(root, "sub"));
    const when = new Date("2024-03-04T05:06:07.000Z");
    await utimes(path.join(root, "a.txt"), when, when);

    const result = await listDir({ path: "", showHidden: false });
    const file = result.entries.find((entry) => entry.name === "a.txt");
    const dir = result.entries.find((entry) => entry.name === "sub");

    expect(file).toMatchObject({
      kind: "file",
      sizeBytes: 5,
      isHidden: false,
      isSymlink: false,
      escapesRoot: false,
      targetKind: null,
      archiveFormat: null,
      path: path.join(root, "a.txt"),
    });
    expect(file?.modifiedAtMs).toBe(when.getTime());
    expect(dir).toMatchObject({ kind: "directory", sizeBytes: 0 });
  });

  it("reports the root, its parent and writability", async () => {
    const result = await listDir({ path: "", showHidden: false });
    expect(result.path).toBe(root);
    expect(result.isRoot).toBe(true);
    expect(result.parentPath).toBeNull();
    expect(result.writable).toBe(true);

    await mkdir(path.join(root, "sub"));
    const sub = await listDir({ path: "sub", showHidden: false });
    expect(sub.isRoot).toBe(false);
    expect(sub.parentPath).toBe(root);
  });

  it("carries volume information", async () => {
    const result = await listDir({ path: "", showHidden: false });
    expect(result.volume).not.toBeNull();
    expect(result.volume?.totalBytes).toBeGreaterThan(0);
    expect(result.volume?.freeBytes).toBeGreaterThanOrEqual(0);
  });

  it("filters hidden entries unless asked, and counts what it removed", async () => {
    await writeFile(path.join(root, "visible.txt"), "v");
    await writeFile(path.join(root, ".secret"), "s");
    await mkdir(path.join(root, ".config"));

    const hidden = await listDir({ path: "", showHidden: false });
    expect(hidden.entries.map((entry) => entry.name)).toEqual(["visible.txt"]);
    expect(hidden.totalEntries).toBe(3);
    expect(hidden.hiddenCount).toBe(2);

    const shown = await listDir({ path: "", showHidden: true });
    expect(shown.entries.map((entry) => entry.name)).toEqual([
      ".config",
      ".secret",
      "visible.txt",
    ]);
    expect(shown.hiddenCount).toBe(0);
    expect(shown.entries.find((entry) => entry.name === ".secret")?.isHidden).toBe(true);
  });

  it("hides .bb-file-manager at the root in both modes, and only at the root", async () => {
    await mkdir(path.join(root, STAGING_DIR_NAME));
    await mkdir(path.join(root, "sub"));
    await mkdir(path.join(root, "sub", STAGING_DIR_NAME));

    for (const showHidden of [false, true]) {
      const result = await listDir({ path: "", showHidden });
      expect(result.entries.map((entry) => entry.name)).not.toContain(STAGING_DIR_NAME);
      expect(result.totalEntries).toBe(1); // staging is not counted either
    }

    // A directory of the same name deeper in the tree is an ordinary dotfile.
    const sub = await listDir({ path: "sub", showHidden: true });
    expect(sub.entries.map((entry) => entry.name)).toContain(STAGING_DIR_NAME);
  });

  it("marks symlinks without resolving them, and flags escaping targets", async () => {
    await mkdir(path.join(root, "real"));
    await writeFile(path.join(root, "real", "inner.txt"), "i");
    await symlink(path.join(root, "real"), path.join(root, "dir-link"));
    await symlink(path.join(root, "real", "inner.txt"), path.join(root, "file-link"));
    await symlink("/etc", path.join(root, "etc-link"));
    await symlink(path.join(root, "ghost"), path.join(root, "broken-link"));

    const result = await listDir({ path: "", showHidden: false });
    const byName = new Map(result.entries.map((entry) => [entry.name, entry]));

    expect(byName.get("dir-link")).toMatchObject({
      kind: "symlink",
      isSymlink: true,
      targetKind: "directory",
      escapesRoot: false,
    });
    expect(byName.get("file-link")).toMatchObject({
      kind: "symlink",
      targetKind: "file",
      escapesRoot: false,
    });
    expect(byName.get("etc-link")).toMatchObject({
      kind: "symlink",
      targetKind: null,
      escapesRoot: true,
    });
    expect(byName.get("broken-link")).toMatchObject({
      kind: "symlink",
      targetKind: null,
      escapesRoot: true,
    });
    // lstat size of a symlink is the length of its target string.
    expect(byName.get("etc-link")?.sizeBytes).toBe("/etc".length);
  });

  it("flags archive names", async () => {
    await writeFile(path.join(root, "photos.tar.gz"), "z");
    const result = await listDir({ path: "", showHidden: false });
    expect(result.entries[0]?.archiveFormat).toBe("tar.gz");
  });

  it("truncates at MAX_LIST_ENTRIES and still reports the real total", async () => {
    const total = MAX_LIST_ENTRIES + 1;
    const names = Array.from({ length: total }, (_, index) =>
      `f${String(index).padStart(5, "0")}.txt`,
    );
    for (let index = 0; index < names.length; index += 500) {
      await Promise.all(
        names
          .slice(index, index + 500)
          .map((name) => writeFile(path.join(root, name), "")),
      );
    }

    const result = await listDir({ path: "", showHidden: false });
    expect(result.totalEntries).toBe(total);
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(MAX_LIST_ENTRIES);
    // Truncation is deterministic: sorted by name, first page kept.
    expect(result.entries[0]?.name).toBe("f00000.txt");
  });

  it("rejects a file, a missing path and anything outside the root", async () => {
    await writeFile(path.join(root, "a.txt"), "a");
    await expectCode(listDir({ path: "a.txt", showHidden: false }), "not_a_directory");
    await expectCode(listDir({ path: "ghost", showHidden: false }), "not_found");
    await expectCode(listDir({ path: "/etc", showHidden: false }), "path_escape");
    await symlink(outside, path.join(root, "out-link"));
    await expectCode(listDir({ path: "out-link", showHidden: false }), "path_escape");
  });
});

describe("statPath", () => {
  it("describes the root with a null parent", async () => {
    const result = await statPath({ path: "" });
    expect(result.parentPath).toBeNull();
    expect(result.entry.path).toBe(root);
    expect(result.entry.kind).toBe("directory");
  });

  it("describes a file and its parent", async () => {
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "a.txt"), "abc");
    const result = await statPath({ path: "sub/a.txt" });
    expect(result.entry).toMatchObject({ name: "a.txt", kind: "file", sizeBytes: 3 });
    expect(result.parentPath).toBe(path.join(root, "sub"));
  });

  it("describes the link, not its target", async () => {
    await writeFile(path.join(root, "real.txt"), "r");
    await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
    const result = await statPath({ path: "link.txt" });
    expect(result.entry.kind).toBe("symlink");
    expect(result.entry.targetKind).toBe("file");
    expect(result.entry.escapesRoot).toBe(false);
  });

  it("rejects missing and escaping paths", async () => {
    await expectCode(statPath({ path: "ghost" }), "not_found");
    await expectCode(statPath({ path: "/etc/passwd" }), "path_escape");
  });
});

describe("searchDir", () => {
  beforeEach(async () => {
    await mkdir(path.join(root, "a", "b", "c"), { recursive: true });
    await writeFile(path.join(root, "Report.txt"), "1");
    await writeFile(path.join(root, "a", "report-2.txt"), "2");
    await writeFile(path.join(root, "a", "b", "report-3.txt"), "3");
    await writeFile(path.join(root, "a", "b", "c", "report-4.txt"), "4");
    await writeFile(path.join(root, ".hidden-report.txt"), "5");
    await mkdir(path.join(root, STAGING_DIR_NAME, "uploads"), { recursive: true });
    await writeFile(path.join(root, STAGING_DIR_NAME, "uploads", "report.part"), "6");
  });

  it("matches case-insensitively across the depth limit", async () => {
    const result = await searchDir({ path: "", query: "REPORT", showHidden: false, maxDepth: 4 });
    expect(result.entries.map((entry) => entry.name).sort()).toEqual([
      "Report.txt",
      "report-2.txt",
      "report-3.txt",
      "report-4.txt",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("honours maxDepth: 1 sees only direct children", async () => {
    const result = await searchDir({ path: "", query: "report", showHidden: false, maxDepth: 1 });
    expect(result.entries.map((entry) => entry.name)).toEqual(["Report.txt"]);
  });

  it("excludes hidden entries unless asked, and always excludes staging", async () => {
    const withoutHidden = await searchDir({
      path: "",
      query: "report",
      showHidden: false,
      maxDepth: 4,
    });
    expect(withoutHidden.entries.map((entry) => entry.name)).not.toContain(
      ".hidden-report.txt",
    );

    const withHidden = await searchDir({
      path: "",
      query: "report",
      showHidden: true,
      maxDepth: 4,
    });
    expect(withHidden.entries.map((entry) => entry.name)).toContain(".hidden-report.txt");
    expect(withHidden.entries.map((entry) => entry.name)).not.toContain("report.part");
  });

  // §8.8: the mention provider asks for a short list under a wall-clock
  // budget, because bb drops its answer after 2s and an abandoned walk would
  // otherwise keep reading directories nobody is waiting for.
  it("stops at `limit` matches and reports the rest as truncated", async () => {
    const result = await searchDir({
      path: "",
      query: "report",
      showHidden: false,
      maxDepth: 4,
      limit: 2,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("stops when the budget is spent", async () => {
    const result = await searchDir({
      path: "",
      query: "report",
      showHidden: false,
      maxDepth: 4,
      budgetMs: 0,
    });
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("never follows a symlinked directory", async () => {
    await mkdir(path.join(outside, "escape"));
    await writeFile(path.join(outside, "escape", "report-out.txt"), "x");
    await symlink(path.join(outside, "escape"), path.join(root, "escape-link"));
    const result = await searchDir({ path: "", query: "report", showHidden: false, maxDepth: 4 });
    expect(result.entries.map((entry) => entry.name)).not.toContain("report-out.txt");
  });

  it("rejects a search root outside the plugin root", async () => {
    await expectCode(
      searchDir({ path: "/etc", query: "passwd", showHidden: false, maxDepth: 1 }),
      "path_escape",
    );
  });
});

describe("buildEntry", () => {
  it("maps an absolute path through lstat", async () => {
    await writeFile(path.join(root, "x.zip"), "1234");
    const entry = await buildEntry(path.join(root, "x.zip"));
    expect(entry).toMatchObject({
      name: "x.zip",
      kind: "file",
      sizeBytes: 4,
      archiveFormat: "zip",
    });
  });

  it("reports a missing path as not_found", async () => {
    await expectCode(buildEntry(path.join(root, "ghost")), "not_found");
  });
});
