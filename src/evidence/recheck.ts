import { createHash } from "node:crypto";
import { fetchBoxFile, findFolderByName, listFolder } from "./box.ts";

// One file's identity + content fingerprint. fileId and versionId stay inside
// the private store; only fileName, versionTag and sha12 are displayed.
export type SourceFile = {
  fileName: string;
  fileId: string;
  versionId: string;
  sha256: string;
  size: number;
};

export type SourceTuple = SourceFile[];

export function versionTag(file: { fileId: string; versionId: string }): string {
  return createHash("sha256")
    .update(`${file.fileId}:${file.versionId}`)
    .digest("hex")
    .slice(0, 12);
}

export function sha12(sha256: string): string {
  return sha256.slice(0, 12);
}

export type StaleChange = {
  fileName: string;
  kind: "added" | "removed" | "version_changed" | "content_changed";
  oldVersionTag?: string;
  newVersionTag?: string;
  oldSha12?: string;
  newSha12?: string;
};

// Compares the tuple captured at run time (keyed by fileName) against a fresh
// listing. A new Box version of the same bytes is still a change: approvals
// bind to the version, not only the content.
export function diffSourceTuple(approved: SourceTuple, fresh: SourceTuple): StaleChange[] {
  const changes: StaleChange[] = [];
  const freshByName = new Map(fresh.map((f) => [f.fileName, f]));
  for (const old of approved) {
    const now = freshByName.get(old.fileName);
    if (now === undefined) {
      changes.push({
        fileName: old.fileName,
        kind: "removed",
        oldVersionTag: versionTag(old),
        oldSha12: sha12(old.sha256),
      });
      continue;
    }
    freshByName.delete(old.fileName);
    if (now.fileId !== old.fileId || now.versionId !== old.versionId) {
      changes.push({
        fileName: old.fileName,
        kind: "version_changed",
        oldVersionTag: versionTag(old),
        newVersionTag: versionTag(now),
        oldSha12: sha12(old.sha256),
        newSha12: sha12(now.sha256),
      });
    } else if (now.sha256 !== old.sha256) {
      changes.push({
        fileName: old.fileName,
        kind: "content_changed",
        oldVersionTag: versionTag(old),
        newVersionTag: versionTag(now),
        oldSha12: sha12(old.sha256),
        newSha12: sha12(now.sha256),
      });
    }
  }
  for (const added of freshByName.values()) {
    changes.push({
      fileName: added.fileName,
      kind: "added",
      newVersionTag: versionTag(added),
      newSha12: sha12(added.sha256),
    });
  }
  changes.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return changes;
}

export type RecheckOutcome =
  | { ok: true; tuple: SourceTuple; changes: StaleChange[] }
  | { ok: false; detail: string };

// Re-reads the folder (metadata + bytes for every file) and diffs against the
// approved tuple. Any transport or gateway failure means "unavailable" — the
// run itself is left untouched; only drift marks it stale.
export async function recheckFolder(
  gatewayBaseUrl: string,
  parentFolderId: string,
  folderName: string,
  approved: SourceTuple,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<RecheckOutcome> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const signal = AbortSignal.timeout(timeoutMs);
  const fetchImpl: typeof fetch = (url, init) =>
    (options.fetch ?? fetch)(url, { ...init, signal });

  try {
    const folder = await findFolderByName(gatewayBaseUrl, parentFolderId, folderName, {
      fetch: fetchImpl,
    });
    if (folder === undefined) {
      return { ok: false, detail: `folder ${folderName} not found` };
    }
    const entries = await listFolder(gatewayBaseUrl, folder.id, { fetch: fetchImpl });
    const tuple: SourceTuple = [];
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      const evidence = await fetchBoxFile(gatewayBaseUrl, entry.id, { fetch: fetchImpl });
      tuple.push({
        fileName: evidence.metadata.name,
        fileId: entry.id,
        versionId: evidence.metadata.fileVersionId,
        sha256: evidence.sha256,
        size: evidence.metadata.size,
      });
    }
    tuple.sort((a, b) => a.fileName.localeCompare(b.fileName));
    return { ok: true, tuple, changes: diffSourceTuple(approved, tuple) };
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    return { ok: false, detail: detail.slice(0, 400) };
  }
}
