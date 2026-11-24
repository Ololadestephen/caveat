import { createHash } from "node:crypto";

import { isRecord } from "../shape.ts";

export type BoxErrorCode =
  | "http_error"
  | "metadata_invalid"
  | "sha1_mismatch"
  | "size_mismatch"
  | "version_changed";

export class BoxError extends Error {
  readonly code: BoxErrorCode;
  constructor(code: BoxErrorCode, message: string) {
    super(message);
    this.name = "BoxError";
    this.code = code;
  }
}

export type BoxFileMetadata = {
  id: string;
  name: string;
  size: number;
  sha1: string;
  fileVersionId: string;
  modifiedAt: string;
};

export type BoxFileEvidence = {
  metadata: BoxFileMetadata;
  bytes: Uint8Array;
  sha256: string;
};

export type BoxEntry = { id: string; type: string; name: string };

function normalizeBase(gatewayBaseUrl: string): string {
  return gatewayBaseUrl.replace(/\/+$/, "");
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) {
    throw new BoxError("metadata_invalid", "response body was not a JSON object");
  }
  return body;
}

function parseFileMetadata(body: Record<string, unknown>): BoxFileMetadata {
  const fileVersion = body.file_version;
  const fileVersionId = isRecord(fileVersion) ? fileVersion.id : undefined;
  if (
    typeof body.id !== "string" ||
    typeof body.name !== "string" ||
    typeof body.size !== "number" ||
    !Number.isInteger(body.size) ||
    body.size < 0 ||
    typeof body.sha1 !== "string" ||
    body.sha1.length === 0 ||
    typeof fileVersionId !== "string" ||
    fileVersionId.length === 0 ||
    typeof body.modified_at !== "string"
  ) {
    throw new BoxError("metadata_invalid", "file metadata response lacked required fields");
  }
  return {
    id: body.id,
    name: body.name,
    size: body.size,
    sha1: body.sha1,
    fileVersionId,
    modifiedAt: body.modified_at,
  };
}

async function getFileMetadata(
  fetchImpl: typeof fetch,
  base: string,
  fileId: string,
): Promise<BoxFileMetadata> {
  const url = `${base}/2.0/files/${encodeURIComponent(fileId)}?fields=id,name,size,sha1,file_version,modified_at`;
  const response = await fetchImpl(url, { method: "GET" });
  if (!response.ok) {
    throw new BoxError("http_error", `file metadata request returned HTTP ${response.status}`);
  }
  return parseFileMetadata(await readJson(response));
}

export async function fetchBoxFile(
  gatewayBaseUrl: string,
  fileId: string,
  options: { fetch?: typeof fetch } = {},
): Promise<BoxFileEvidence> {
  const fetchImpl = options.fetch ?? fetch;
  const base = normalizeBase(gatewayBaseUrl);

  const before = await getFileMetadata(fetchImpl, base, fileId);

  // The content endpoint may redirect to a signed URL; fetch follows it and we
  // never log or expose the target.
  const contentResponse = await fetchImpl(`${base}/2.0/files/${encodeURIComponent(fileId)}/content`, {
    method: "GET",
    redirect: "follow",
  });
  if (!contentResponse.ok) {
    throw new BoxError("http_error", `file content request returned HTTP ${contentResponse.status}`);
  }
  const bytes = new Uint8Array(await contentResponse.arrayBuffer());

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  if (sha1 !== before.sha1) {
    throw new BoxError("sha1_mismatch", "downloaded bytes do not match the Box sha1");
  }
  if (bytes.byteLength !== before.size) {
    throw new BoxError("size_mismatch", "downloaded byte count differs from metadata size");
  }

  const after = await getFileMetadata(fetchImpl, base, fileId);
  if (after.fileVersionId !== before.fileVersionId) {
    throw new BoxError(
      "version_changed",
      "file version changed between the metadata reads; the download may be inconsistent",
    );
  }

  return { metadata: after, bytes, sha256 };
}

export async function listFolder(
  gatewayBaseUrl: string,
  folderId: string,
  options: { fetch?: typeof fetch } = {},
): Promise<BoxEntry[]> {
  const fetchImpl = options.fetch ?? fetch;
  const base = normalizeBase(gatewayBaseUrl);

  const entries: BoxEntry[] = [];
  let marker: string | undefined;
  do {
    const url = new URL(`${base}/2.0/folders/${encodeURIComponent(folderId)}/items`);
    url.searchParams.set("fields", "id,type,name");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("usemarker", "true");
    if (marker !== undefined) url.searchParams.set("marker", marker);

    const response = await fetchImpl(url, { method: "GET" });
    if (!response.ok) {
      throw new BoxError("http_error", `folder items request returned HTTP ${response.status}`);
    }
    const body = await readJson(response);
    if (!Array.isArray(body.entries)) {
      throw new BoxError("metadata_invalid", "folder items response lacked entries");
    }
    for (const entry of body.entries) {
      if (isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string") {
        entries.push({ id: entry.id, type: typeof entry.type === "string" ? entry.type : "", name: entry.name });
      }
    }
    marker = typeof body.next_marker === "string" && body.next_marker.length > 0 ? body.next_marker : undefined;
  } while (marker !== undefined);

  return entries;
}

export async function findFolderByName(
  gatewayBaseUrl: string,
  parentFolderId: string,
  name: string,
  options: { fetch?: typeof fetch } = {},
): Promise<BoxEntry | undefined> {
  const entries = await listFolder(gatewayBaseUrl, parentFolderId, options);
  return entries.find((entry) => entry.type === "folder" && entry.name === name);
}
