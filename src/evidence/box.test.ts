import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BoxError, fetchBoxFile, findFolderByName, listFolder } from "./box.ts";

const BASE = "http://box-gw.invalid";
const FILE_ID = "12345";
const BYTES = new TextEncoder().encode("synthetic contract bytes for hashing");
const SHA1 = createHash("sha1").update(BYTES).digest("hex");
const SHA256 = createHash("sha256").update(BYTES).digest("hex");

function metadataBody(versionId = "v-1", overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: FILE_ID,
    type: "file",
    name: "01-consulting-agreement.pdf",
    size: BYTES.byteLength,
    sha1: SHA1,
    file_version: { id: versionId, type: "file_version", sha1: SHA1 },
    modified_at: "2026-11-20T00:00:00Z",
    ...overrides,
  });
}

function folderItemsBody(entries: unknown[], nextMarker?: string): string {
  const body: Record<string, unknown> = { entries };
  if (nextMarker !== undefined) body.next_marker = nextMarker;
  return JSON.stringify(body);
}

type Route = (url: string, callIndex: number) => Response;

function routerFetch(route: Route, calls: { url: string; method: string | undefined }[] = []): typeof fetch {
  return (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    calls.push({ url, method: init?.method });
    return Promise.resolve(route(url, calls.length));
  };
}

function fileRoutes(overrides: {
  content?: Response;
  secondMetadata?: Response;
  firstMetadata?: Response;
} = {}): Route {
  let metadataCount = 0;
  return (url) => {
    if (url.includes(`/2.0/files/${FILE_ID}/content`)) {
      return overrides.content ?? new Response(BYTES, { status: 200 });
    }
    if (url.includes(`/2.0/files/${FILE_ID}?`)) {
      metadataCount += 1;
      if (metadataCount === 1 && overrides.firstMetadata !== undefined) return overrides.firstMetadata;
      if (metadataCount === 2 && overrides.secondMetadata !== undefined) return overrides.secondMetadata;
      return new Response(metadataBody(), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("fetchBoxFile", () => {
  it("downloads bytes, verifies sha1 and size, and re-checks the version", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const evidence = await fetchBoxFile(BASE, FILE_ID, { fetch: routerFetch(fileRoutes(), calls) });

    expect(evidence.metadata.id).toBe(FILE_ID);
    expect(evidence.metadata.name).toBe("01-consulting-agreement.pdf");
    expect(evidence.metadata.fileVersionId).toBe("v-1");
    expect(evidence.sha256).toBe(SHA256);
    expect(new Uint8Array(evidence.bytes)).toEqual(BYTES);

    const urls = calls.map((c) => c.url);
    expect(urls[0]).toContain(`/2.0/files/${FILE_ID}?fields=`);
    expect(urls[1]).toContain(`/2.0/files/${FILE_ID}/content`);
    expect(urls[2]).toContain(`/2.0/files/${FILE_ID}?fields=`);
    for (const call of calls) expect(call.method).toBe("GET");
  });

  it("rejects when the computed sha1 differs from the Box sha1", async () => {
    const routes = fileRoutes({
      firstMetadata: new Response(metadataBody("v-1", { sha1: "0".repeat(40) }), { status: 200 }),
    });
    await expect(fetchBoxFile(BASE, FILE_ID, { fetch: routerFetch(routes) })).rejects.toMatchObject({
      code: "sha1_mismatch",
    });
  });

  it("rejects when the byte count differs from the metadata size", async () => {
    const routes = fileRoutes({
      firstMetadata: new Response(metadataBody("v-1", { size: BYTES.byteLength + 10 }), { status: 200 }),
    });
    await expect(fetchBoxFile(BASE, FILE_ID, { fetch: routerFetch(routes) })).rejects.toMatchObject({
      code: "size_mismatch",
    });
  });

  it("rejects when the file version changes between reads", async () => {
    const routes = fileRoutes({ secondMetadata: new Response(metadataBody("v-2"), { status: 200 }) });
    await expect(fetchBoxFile(BASE, FILE_ID, { fetch: routerFetch(routes) })).rejects.toMatchObject({
      code: "version_changed",
    });
  });

  it("rejects on non-2xx content responses", async () => {
    const routes = fileRoutes({ content: new Response("forbidden", { status: 403 }) });
    await expect(fetchBoxFile(BASE, FILE_ID, { fetch: routerFetch(routes) })).rejects.toMatchObject({
      code: "http_error",
    });
  });

  it("rejects on non-2xx metadata responses", async () => {
    const routes = fileRoutes({ firstMetadata: new Response("gone", { status: 404 }) });
    await expect(fetchBoxFile(BASE, FILE_ID, { fetch: routerFetch(routes) })).rejects.toMatchObject({
      code: "http_error",
    });
  });

  it("rejects on malformed metadata", async () => {
    const routes = fileRoutes({
      firstMetadata: new Response(JSON.stringify({ id: FILE_ID, name: "x" }), { status: 200 }),
    });
    await expect(fetchBoxFile(BASE, FILE_ID, { fetch: routerFetch(routes) })).rejects.toMatchObject({
      code: "metadata_invalid",
    });
  });

  it("is a BoxError", async () => {
    const routes = fileRoutes({ content: new Response("err", { status: 500 }) });
    await expect(fetchBoxFile(BASE, FILE_ID, { fetch: routerFetch(routes) })).rejects.toBeInstanceOf(BoxError);
  });
});

describe("listFolder / findFolderByName", () => {
  it("lists entries across marker pages", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const route: Route = (url) => {
      if (url.includes("marker=m2")) {
        return new Response(
          folderItemsBody([{ id: "2", type: "folder", name: "caveat_TEST" }]),
          { status: 200 },
        );
      }
      return new Response(
        folderItemsBody([{ id: "1", type: "file", name: "other.pdf" }], "m2"),
        { status: 200 },
      );
    };
    const entries = await listFolder(BASE, "0", { fetch: routerFetch(route, calls) });
    expect(entries).toEqual([
      { id: "1", type: "file", name: "other.pdf" },
      { id: "2", type: "folder", name: "caveat_TEST" },
    ]);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.method).toBe("GET");
  });

  it("finds a folder by name", async () => {
    const route: Route = () =>
      new Response(
        folderItemsBody([
          { id: "9", type: "file", name: "nope" },
          { id: "7", type: "folder", name: "caveat_TEST" },
        ]),
        { status: 200 },
      );
    const folder = await findFolderByName(BASE, "0", "caveat_TEST", { fetch: routerFetch(route) });
    expect(folder).toEqual({ id: "7", type: "folder", name: "caveat_TEST" });
  });

  it("returns undefined when the folder is absent", async () => {
    const route: Route = () => new Response(folderItemsBody([]), { status: 200 });
    await expect(findFolderByName(BASE, "0", "missing", { fetch: routerFetch(route) })).resolves.toBeUndefined();
  });

  it("rejects on non-2xx folder responses", async () => {
    const route: Route = () => new Response("denied", { status: 403 });
    await expect(listFolder(BASE, "0", { fetch: routerFetch(route) })).rejects.toMatchObject({
      code: "http_error",
    });
  });
});
