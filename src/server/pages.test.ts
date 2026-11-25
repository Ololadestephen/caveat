import { describe, expect, it } from "vitest";

import type { RunRow } from "../store/db.ts";
import { pageShell, renderRun, renderRunList, statusBadge } from "./pages.ts";

function runRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-20260101-000000-abcd",
    created_at: "2026-01-01T00:00:00.000Z",
    status: "reviewable",
    status_reason: null,
    source_tuple_json: "[]",
    receipt_json: "{}",
    receipt_hash: "",
    draft_text: "",
    draft_hash: "",
    superseded_by: null,
    stale_detail_json: null,
    trigger: "manual",
    ...overrides,
  };
}

describe("pageShell", () => {
  it("renders the revision footer and links the stylesheet", () => {
    const html = pageShell("T", "abc123", "<p>hi</p>");
    expect(html).toContain('<link rel="stylesheet" href="/app.css">');
    expect(html).toContain("deployed revision abc123");
    expect(html).toContain("<p>hi</p>");
  });

  it("escapes the title", () => {
    expect(pageShell("<script>", "r", "")).toContain("&lt;script&gt;");
  });
});

describe("statusBadge", () => {
  it("adds a superseded badge only when superseded_by is set", () => {
    expect(statusBadge("approved", null)).not.toContain("badge--superseded");
    expect(statusBadge("approved", "run-x")).toContain("badge--superseded");
  });
});

describe("renderRunList", () => {
  it("links each run and shows the receipt sha12", () => {
    const run = runRow({ receipt_hash: "0123456789abcdef" });
    const html = renderRunList([run], "rev");
    expect(html).toContain('href="/runs/run-20260101-000000-abcd"');
    expect(html).toContain("0123456789ab");
  });
});

describe("renderRun", () => {
  const view = { revision: "rev", approver: "O", approval: undefined, exports: [] };

  it("shows the approve form only for a reviewable run with an approver", () => {
    const html = renderRun(runRow({ status: "reviewable" }), view);
    expect(html).toContain('action="/runs/run-20260101-000000-abcd/approve"');
    const noApprover = renderRun(runRow({ status: "reviewable" }), {
      ...view,
      approver: undefined,
    });
    expect(noApprover).not.toContain("/approve");
    const running = renderRun(runRow({ status: "running" }), view);
    expect(running).not.toContain("/approve");
    expect(running).toContain("Run in progress");
  });

  it("shows the export form only for an approved run", () => {
    const html = renderRun(runRow({ status: "approved" }), view);
    expect(html).toContain('action="/runs/run-20260101-000000-abcd/export"');
    expect(renderRun(runRow({ status: "reviewable" }), view)).not.toContain("/export");
  });

  it("renders the stale banner with the change list and escapes values", () => {
    const run = runRow({
      status: "stale",
      stale_detail_json: JSON.stringify([
        {
          fileName: "03-<b>.pdf",
          kind: "version_changed",
          oldVersionTag: "aaaa",
          newVersionTag: "bbbb",
          oldSha12: "1111",
          newSha12: "1111",
        },
      ]),
    });
    const html = renderRun(run, view);
    expect(html).toContain("<strong>Stale.</strong>");
    expect(html).toContain("03-&lt;b&gt;.pdf: version_changed");
    expect(html).toContain("aaaa → bbbb");
    expect(html).not.toContain("03-<b>.pdf");
  });

  it("links a superseded run to the newer run", () => {
    const html = renderRun(runRow({ superseded_by: "run-newer" }), view);
    expect(html).toContain('href="/runs/run-newer"');
  });
});
