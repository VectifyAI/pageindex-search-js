// Citations as an agent with these tools writes them, as PageIndex's chat does: a tag after each sentence,
// <cite doc="report.pdf" page="12"/>, and, when the fact comes from a part of the page, box="x0,y0,x1,y1" (fractions
// of the page's width and height from its top left, as zoom_page takes them), to show where the answer is.
//
//     const instructions = "Answer from the documents. " + CITATIONS;
//     for (const c of citations(answer)) c.document, c.page, c.box

/** What to add to an agent's instructions for it to cite so. */
export const CITATIONS = "After each sentence drawn from the documents, cite where, with a tag for each page: " +
  "<cite doc=\"file name\" page=\"12\"/>, the file name as the tools give it. When it comes from a part of the page, " +
  "such as a table, a chart or a paragraph you zoomed into, add that part as box=\"x0,y0,x1,y1\", fractions of the " +
  "page's width and height from its top left, as zoom_page takes them.";

/**
 * A page an answer cites: the document's file name, the page (from 1), the part of it if named ([x0, y0, x1, y1]), and
 * where the tag is in the answer ([start, end)), to replace it with a link. documentId once found, by client.citations().
 */
export interface Citation {
  document: string;
  page: number;
  box: [number, number, number, number] | null;
  start: number;
  end: number;
  documentId?: string | null;
}

// Taken as models vary the tag: in single quotes or none, in capitals, closed or not, a range or a list of pages, or
// in backticks.
const TAG = /`?<cite\b([^>]*?)\/?>(?:\s*<\/cite>)?`?/gi;

/** The citations in an answer, in order: one for each page a tag names. */
export function citations(text: string): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(TAG)) {
    const pages = pagesOf(attribute(m[1], "page") || attribute(m[1], "pages"));
    const box = pages.length === 1 ? boxOf(attribute(m[1], "box")) : null;
    const document = attribute(m[1], "doc") || attribute(m[1], "document");
    const start = m.index ?? 0;
    for (const page of pages) out.push({ document, page, box, start, end: start + m[0].length });
  }
  return out;
}

function attribute(attributes: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`, "i").exec(attributes);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

/** 12, or 12 and 13 of "12-13", or 12 and 15 of "12, 15". */
function pagesOf(value: string): number[] {
  const pages: number[] = [];
  for (const part of value.split(/\s*(?:,|;|and)\s*/)) {
    const span = /^(\d+)\s*[–—-]\s*(\d+)$/.exec(part);
    if (span && Number(span[2]) - Number(span[1]) >= 0 && Number(span[2]) - Number(span[1]) < 20) {
      for (let n = Number(span[1]); n <= Number(span[2]); n++) pages.push(n);
    } else if (/^\d+$/.test(part) && Number(part) > 0) {
      pages.push(Number(part));
    }
  }
  return pages;
}

function boxOf(value: string): [number, number, number, number] | null {
  const v = value.split(/[\s,]+/).filter(Boolean).map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return null;
  const [x0, y0, x1, y1] = v;
  return x0 >= 0 && x0 < x1 && x1 <= 1 && y0 >= 0 && y0 < y1 && y1 <= 1 ? [x0, y0, x1, y1] : null;
}
