// Generates the two client-reply fixture PDFs under fixtures/box/reply-v{N}/.
// Each is a minimal one-page Helvetica text document — one Tj per line, so
// pdfjs yields one text item per line and extractSections sees the numbered
// headings as top-level sections.
//
// Usage: node scripts/make-reply-fixtures.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const escapePdfText = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

// A one-page PDF: catalog, pages, page, font, content stream — correct xref
// byte offsets so any standards-based reader (pdfjs) parses it.
function textPdf(lines: string[]): Uint8Array {
  const body = lines
    .map((line, i) => `${i === 0 ? "" : "0 -16 Td "}(${escapePdfText(line)}) Tj`)
    .join(" ");
  const content = `BT /F1 11 Tf 72 720 Td ${body} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// v1: an upfront deposit that is too small against the v2 cash numbers —
// $3,000 versus the $5,000 shortfall, so it must fail.
const V1_LINES = [
  "SYNTHETIC CLIENT REPLY - TEST FIXTURE",
  "1. Response",
  "Thank you for the proposed change to the escrow schedule in the Second Amendment.",
  "2. Counterproposal",
  "We propose that $3,000 of the escrow funding be paid to you as an upfront",
  "deposit on October 1, 2026, with the January 2, 2027 release reduced by the",
  "same amount.",
  "3. Other Terms",
  "All other terms of the Second Amendment remain unchanged.",
];

// v2: a milestone split that exactly covers the $5,000 shortfall — $6,000 in
// two parts, the first on November 2, 2026, so it must pass.
const V2_LINES = [
  "SYNTHETIC CLIENT REPLY - TEST FIXTURE",
  "1. Response",
  "Thank you for the proposed change to the escrow schedule in the Second Amendment.",
  "2. Counterproposal",
  "We propose that $6,000 of the January 2, 2027 release be paid in two monthly",
  "parts, the first on November 2, 2026.",
  "3. Other Terms",
  "All other terms of the Second Amendment remain unchanged.",
];

for (const [dir, lines] of [
  ["reply-v1", V1_LINES],
  ["reply-v2", V2_LINES],
] as const) {
  const outDir = join(ROOT, "fixtures", "box", dir);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "04-client-reply.pdf");
  const bytes = textPdf(lines);
  writeFileSync(path, bytes);
  console.log(`wrote ${path} (${bytes.length} bytes)`);
}
