import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  diffSourceTuple,
  recheckFolder,
  sha12,
  versionTag,
} from "./recheck.ts";
import type { SourceTuple } from "./recheck.ts";

const BASE = "http://gw.invalid/box";

type FileState = { id: string; name: string; versionId: string; bytes: string };

function sha1Of(bytes: string): string {
  return createHash("sha1").update(bytes).digest("hex");
}

// A minimal Box gateway: folders/0/items -> folder, folders/F1/items -> files,
// files/<id> metadata + /content bytes.
function stubFetch(files: FileState[], fail?: (url: string) => Response | undefined) {
  return (url: unknown, _init?: unknown): Promise<Response> => {
    const u = String(url);
    const failed = fail?.(u);
    if (failed !== undefined) return Promise.resolve(failed);
    if (u.startsWith(`${BASE}/2.0/folders/0/items`)) {
      return Promise.resolve(
        Response.json({ entries: [{ id: "F1", type: "folder", name: "caveat_TEST" }] }),
      );
    }
    if (u.startsWith(`${BASE}/2.0/folders/F1/items`)) {
      return Promise.resolve(
        Response.json({
          entries: files.map((f) => ({ id: f.id, type: "file", name: f.name })),
        }),
      );
    }
    const meta = /\/2\.0\/files\/([^/]+)\?/.exec(u);
    if (meta !== null) {
      const f = files.find((x) => x.id === decodeURIComponent(meta[1]!));
      if (f === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
      return Promise.resolve(
        Response.json({
          id: f.id,
          name: f.name,
          size: f.bytes.length,
          sha1: sha1Of(f.bytes),
          file_version: { id: f.versionId },
          modified_at: "2026-11-24T00:00:00Z",
        }),
      );
    }
    const content = /\/2\.0\/files\/([^/]+)\/content/.exec(u);
    if (content !== null) {
      const f = files.find((x) => x.id === decodeURIComponent(content[1]!));
      if (f === undefined) return Promise.resolve(new Response("nope", { status: 404 }));
      return Promise.resolve(new Response(f.bytes));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
}

const APPROVED: SourceTuple = [
  { fileName: "01-consulting-agreement.pdf", fileId: "f01", versionId: "v1", sha256: createHash("sha256").update("one").digest("hex"), size: 3 },
  { fileName: "03-second-amendment.pdf", fileId: "f03", versionId: "v1", sha256: createHash("sha256").update("three").digest("hex"), size: 5 },
];

const SAME_FILES: FileState[] = [
  { id: "f01", name: "01-consulting-agreement.pdf", versionId: "v1", bytes: "one" },
  { id: "f03", name: "03-second-amendment.pdf", versionId: "v1", bytes: "three" },
];

describe("diffSourceTuple", () => {
  it("reports no changes for an identical tuple", () => {
    expect(diffSourceTuple(APPROVED, APPROVED)).toEqual([]);
  });

  it("reports a new version of the same bytes as version_changed", () => {
    const fresh = APPROVED.map((f) =>
      f.fileName === "03-second-amendment.pdf" ? { ...f, versionId: "v2" } : f,
    );
    const changes = diffSourceTuple(APPROVED, fresh);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("version_changed");
    expect(changes[0]?.oldVersionTag).not.toBe(changes[0]?.newVersionTag);
    expect(changes[0]?.oldSha12).toBe(changes[0]?.newSha12);
  });

  it("reports changed content, added and removed files", () => {
    const fresh: SourceTuple = [
      { ...APPROVED[0]!, sha256: createHash("sha256").update("different").digest("hex") },
      { fileName: "04-new.pdf", fileId: "f04", versionId: "v1", sha256: "a".repeat(64), size: 1 },
    ];
    const changes = diffSourceTuple(APPROVED, fresh);
    expect(changes.map((c) => [c.fileName, c.kind])).toEqual([
      ["01-consulting-agreement.pdf", "content_changed"],
      ["03-second-amendment.pdf", "removed"],
      ["04-new.pdf", "added"],
    ]);
  });
});

describe("versionTag", () => {
  it("changes when the version changes even if the file id does not", () => {
    const f = { fileId: "f03", versionId: "v1" };
    expect(versionTag(f)).toHaveLength(12);
    expect(versionTag({ ...f, versionId: "v2" })).not.toBe(versionTag(f));
  });
  it("sha12 truncates", () => {
    expect(sha12("a".repeat(64))).toBe("aaaaaaaaaaaa");
  });
});

describe("recheckFolder", () => {
  it("returns the fresh tuple and no changes when the folder is unchanged", async () => {
    const out = await recheckFolder(BASE, "0", "caveat_TEST", APPROVED, {
      fetch: stubFetch(SAME_FILES),
    });
    expect(out).toMatchObject({ ok: true, changes: [] });
    if (out.ok) expect(out.tuple.map((f) => f.fileId)).toEqual(["f01", "f03"]);
  });

  it("flags a re-uploaded version", async () => {
    const files = SAME_FILES.map((f) =>
      f.id === "f03" ? { ...f, versionId: "v2" } : f,
    );
    const out = await recheckFolder(BASE, "0", "caveat_TEST", APPROVED, {
      fetch: stubFetch(files),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.changes).toEqual([
        {
          fileName: "03-second-amendment.pdf",
          kind: "version_changed",
          oldVersionTag: versionTag({ fileId: "f03", versionId: "v1" }),
          newVersionTag: versionTag({ fileId: "f03", versionId: "v2" }),
          oldSha12: APPROVED[1]!.sha256.slice(0, 12),
          newSha12: APPROVED[1]!.sha256.slice(0, 12),
        },
      ]);
    }
  });

  it("returns unavailable on a gateway 403", async () => {
    const out = await recheckFolder(BASE, "0", "caveat_TEST", APPROVED, {
      fetch: stubFetch(SAME_FILES, () => new Response("{}", { status: 403 })),
    });
    expect(out.ok).toBe(false);
  });

  it("returns unavailable on a network error", async () => {
    const out = await recheckFolder(BASE, "0", "caveat_TEST", APPROVED, {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(out.ok).toBe(false);
  });

  it("returns unavailable when the recheck times out", async () => {
    const hang = (_url: unknown, init?: unknown): Promise<Response> =>
      new Promise((_res, rej) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener("abort", () =>
          rej(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
        );
      });
    const out = await recheckFolder(BASE, "0", "caveat_TEST", APPROVED, {
      timeoutMs: 5,
      fetch: hang as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain("TimeoutError");
  });
});
