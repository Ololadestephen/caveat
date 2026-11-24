import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type PdfPageLines = { page: number; lines: string[] };

export type TextItemLike = { str: string; y: number; hasEOL?: boolean };

const Y_TOLERANCE = 2;

// Group text items into lines: a y-position change or an item flagged hasEOL
// ends the current line. Empty lines are dropped.
export function groupItemsIntoLines(items: TextItemLike[]): string[] {
  const lines: string[] = [];
  let current: string[] = [];
  let currentY: number | undefined;
  const flush = (): void => {
    const text = current.join("").trim();
    if (text.length > 0) lines.push(text);
    current = [];
    currentY = undefined;
  };
  for (const item of items) {
    if (currentY !== undefined && Math.abs(item.y - currentY) > Y_TOLERANCE) flush();
    current.push(item.str);
    currentY = item.y;
    if (item.hasEOL === true) flush();
  }
  flush();
  return lines;
}

// Extract text lines from PDF bytes via pdfjs-dist. No OCR, no system fonts —
// text items only (pdfjs 6.x never evaluates embedded JavaScript).
export async function extractPdfLines(data: Uint8Array): Promise<PdfPageLines[]> {
  const loadingTask = getDocument({ data, useSystemFonts: false });
  const pdf = await loadingTask.promise;
  try {
    const pages: PdfPageLines[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const items: TextItemLike[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y: unknown = item.transform[5];
        items.push({
          str: item.str,
          y: typeof y === "number" ? y : 0,
          hasEOL: item.hasEOL,
        });
      }
      pages.push({ page: pageNum, lines: groupItemsIntoLines(items) });
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}
