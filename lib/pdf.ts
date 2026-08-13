import { extractTextItems } from "unpdf";

export type TextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
};

/** Items within this fraction of a font size share a visual line. */
const LINE_TOLERANCE = 0.4;
/** Horizontal gap, as a fraction of font size, that counts as a real space. */
const SPACE_GAP = 0.12;

function groupIntoLines(items: TextItem[]): TextItem[][] {
  // PDF origin sits at the bottom-left, so descending y reads top to bottom.
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const lines: TextItem[][] = [];

  for (const item of sorted) {
    // Compare against the line's first item, not its last: measuring from a
    // fixed anchor stops a run of slightly-off baselines from drifting into
    // the line below.
    const anchor = lines.at(-1)?.[0];
    if (anchor && Math.abs(anchor.y - item.y) <= item.fontSize * LINE_TOLERANCE) {
      lines.at(-1)!.push(item);
    } else {
      lines.push([item]);
    }
  }
  return lines;
}

function joinLine(line: TextItem[]): string {
  const sorted = [...line].sort((a, b) => a.x - b.x);
  let text = "";
  let previous: TextItem | undefined;

  for (const item of sorted) {
    // A PDF splits words across items wherever styling changes, so "Built"
    // can arrive as "Bui" + "lt". Only the glyphs actually standing apart on
    // the page earn a space.
    if (previous && item.x - (previous.x + previous.width) > previous.fontSize * SPACE_GAP) {
      text += " ";
    }
    text += item.str;
    previous = item;
  }
  return text.trim();
}

/**
 * Rebuilds reading order from where the glyphs actually sit on the page.
 *
 * A PDF stores text in drawing order, which for any template-built resume is
 * not reading order: headings arrive glued to sidebar contact details, bullets
 * land before the job title they belong to, and the column of work locations
 * dumps out as one detached block. Chunking that stream produces sections with
 * the wrong heading attached, which is worse than no heading at all.
 *
 * ponytail: sorts by y, so a genuine side-by-side layout -- a full-height
 * skills sidebar next to the experience column -- would interleave the two.
 * Cluster the x values into columns first if a document ever needs it.
 */
export function orderItems(pages: TextItem[][]): string {
  return pages
    .flatMap((page) => groupIntoLines(page.filter((item) => item.str.trim())))
    .map(joinLine)
    .filter(Boolean)
    .join("\n");
}

export async function extractOrderedText(data: Uint8Array): Promise<string> {
  const { items } = await extractTextItems(data);
  return orderItems(items);
}
