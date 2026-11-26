// Renders the saved Aviat EDGAR exhibit HTML into the two text PDFs used by the
// "any contract" flow: 01-agreement.pdf (the agreement body through the
// signature block) and 02-exhibit-a.pdf (Exhibit A only). One Tj per line so
// pdfjs yields one text item per line, wrapped to the text width and paginated.
// Text stays verbatim — only HTML markup and entities are decoded.
//
// Usage: node scripts/make-contract-pdfs.ts
//   Reads $CAVEAT_PRIVATE/m10/aviat.htm (CAVEAT_PRIVATE defaults to
//   ~/caveat-private) and writes the PDFs to $CAVEAT_PRIVATE/m10/box/.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PRIVATE = process.env.CAVEAT_PRIVATE ?? join(homedir(), "caveat-private");
const SOURCE = join(PRIVATE, "m10", "aviat.htm");
const OUT_DIR = join(PRIVATE, "m10", "box");

// --- HTML -> lines -----------------------------------------------------------

const decodeEntities = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");

// Block-level elements (div, tr, br, hr) end a line; table cells inside a row
// join with a space, matching the two-column signature block. Nested font/img
// tags and empty layout divs drop out as empty chunks.
function htmlToLines(html: string): string[] {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const marked = body
    // A font run with padding-left is a hanging-indent gap ("1." + indent +
    // title, bullet + indent + text); the gap renders as space, so keep one.
    .replace(/<font\b[^>]*padding-left[^>]*>/gi, " ")
    .replace(/<\/(td|th)>/gi, "\u0001")
    .replace(/<\/(div|tr|p|h[1-6])>|<br\b[^>]*>|<hr\b[^>]*>/gi, "\u0002");
  const lines: string[] = [];
  for (const chunk of marked.split("\u0002")) {
    const cells = chunk
      .split("\u0001")
      .map((cell) =>
        decodeEntities(cell.replace(/<[^>]+>/g, ""))
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((cell) => cell.length > 0);
    if (cells.length > 0) lines.push(cells.join(" "));
  }
  return lines;
}

// --- PDF writer (wrapped, multi-page, WinAnsi) --------------------------------

const FONT_SIZE = 10;
const LEADING = 14;
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const WRAP_WIDTH = 90; // ~90 chars x 5.5pt avg at 10pt Helvetica < 468pt text width
const LINES_PER_PAGE = Math.floor(
  (PAGE_HEIGHT - 2 * MARGIN - FONT_SIZE) / LEADING,
) + 1;

// Literal strings are written as WinAnsi bytes; every byte outside printable
// ASCII becomes an octal escape so the file stays pure ASCII.
const WINANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

const pdfText = (s: string): string => {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x5c || cp === 0x28 || cp === 0x29) {
      out += `\\${ch}`;
    } else if (cp >= 0x20 && cp <= 0x7e) {
      out += ch;
    } else {
      const byte = cp >= 0xa0 && cp <= 0xff ? cp : WINANSI_EXTRA[cp];
      if (byte === undefined) {
        throw new Error(`no WinAnsi mapping for U+${cp.toString(16)} (${ch})`);
      }
      out += `\\${byte.toString(8).padStart(3, "0")}`;
    }
  }
  return out;
};

function wrapLine(line: string): string[] {
  if (line.length <= WRAP_WIDTH) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > WRAP_WIDTH) {
    let cut = rest.lastIndexOf(" ", WRAP_WIDTH);
    if (cut <= 0) cut = WRAP_WIDTH;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

function textPdf(lines: string[]): Uint8Array {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  const fontId = 3 + pages.length * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages
      .map((_p, i) => `${3 + i * 2} 0 R`)
      .join(" ")}] /Count ${pages.length} >>`,
  ];
  pages.forEach((pageLines, i) => {
    const pageId = 3 + i * 2;
    const content = pageLines
      .map(
        (line, j) => `${j === 0 ? "" : `0 -${LEADING} Td `}(${pdfText(line)}) Tj`,
      )
      .join(" ");
    const stream = `BT /F1 ${FONT_SIZE} Tf ${MARGIN} ${PAGE_HEIGHT - MARGIN - FONT_SIZE} Td ${content} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  objects.push(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );

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

// --- build the two documents ---------------------------------------------------

const lines = htmlToLines(readFileSync(SOURCE, "utf8"));
const exhibitA = lines.findIndex((l) => l === "EXHIBIT A");
const exhibitB = lines.findIndex((l) => l === "EXHIBIT B");
if (exhibitA < 0 || exhibitB < 0 || exhibitB <= exhibitA) {
  throw new Error(`EXHIBIT A/B markers not found (A=${exhibitA}, B=${exhibitB})`);
}

const docs: [string, string[]][] = [
  ["01-agreement.pdf", lines.slice(0, exhibitA)],
  ["02-exhibit-a.pdf", lines.slice(exhibitA, exhibitB)],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, docLines] of docs) {
  const rendered = docLines.flatMap((line) => wrapLine(line));
  const bytes = textPdf(rendered);
  writeFileSync(join(OUT_DIR, name), bytes);
  console.log(
    `wrote ${join(OUT_DIR, name)} (${bytes.length} bytes, ` +
      `${docLines.length} source lines -> ${rendered.length} rendered lines)`,
  );
  // A wrapped continuation that looks like a section heading would open a
  // phantom section; list every rendered line that could match so it can be
  // eyeballed against the known headings.
  rendered.forEach((line, i) => {
    if (/^\d{1,2}\.\d{0,2}\s/.test(line)) {
      console.log(`  heading-like line ${i}: ${line.slice(0, 80)}`);
    }
  });
}
