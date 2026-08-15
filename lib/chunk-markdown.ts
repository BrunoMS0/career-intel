import { MAX_CHARS, splitBySize, type Chunk } from "./chunk.ts";

/** Section for text that appears before the first heading, or when none exist. */
const OVERVIEW = "Overview";

/**
 * Repairs what LlamaParse hands back before it is split.
 *
 * The ligature glyphs these PDF producers emit arrive as modifier letters --
 * "deᶠⁱning" for "defining" -- and sometimes carry a space the parser inserted
 * mid-word, which is how "Benefits" became the section label "Beneᶠⁱ ts". The
 * explicit pass absorbs that space; NFKC then covers any other compatibility
 * glyph. The entity unescape undoes the `&` LlamaParse escapes even in prose.
 */
function normalize(markdown: string): string {
  return markdown
    .replace(/ᶠⁱ ?/g, "fi")
    .replace(/ᶠˡ ?/g, "fl")
    .normalize("NFKC")
    .replace(/&#x26;|&amp;/g, "&")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Node = { name: string; depth: number; body: string[]; children: Node[] };

/**
 * Re-attaches a markdown table's header to the pieces it was split across.
 *
 * `splitBySize` cuts on line breaks, which inside a table drops the reader into
 * bare data rows: Afficiency's skills table splits mid-way and the second piece
 * opens at "| Cloud & DevOps | Git/GitHub, Azure DevOps |" with nothing left
 * saying the first column is an Area and the second its Technologies. Tables
 * only started appearing once the postings were restructured, which is also
 * when LlamaParse began earning its keep -- rendering them is the thing it does
 * that a layout parser cannot.
 */
function restoreTableHeaders(pieces: string[]): string[] {
  const DIVIDER = /^\s*\|[\s:|-]+\|\s*$/;
  let header = "";

  return pieces.map((piece) => {
    const lines = piece.split("\n");
    const divider = lines.findIndex((line) => DIVIDER.test(line));

    if (divider > 0) {
      header = lines.slice(divider - 1, divider + 1).join("\n");
      return piece;
    }
    // A piece that opens on table rows without a header of its own continues
    // the table the previous piece began.
    return header && /^\s*\|/.test(lines[0]) ? `${header}\n${piece}` : piece;
  });
}

/** The heading text, without the emphasis a parser may have carried into it. */
function headingName(raw: string): string {
  // A revision of the corpus set its headings in bold and LlamaParse passed the
  // markers through, so sections arrived called "**ABOUT THE ROLE**" and
  // "*Required*" -- and that string is not cosmetic here: enrich() embeds it,
  // and the model quotes it back in every citation.
  return raw
    .trim()
    .replace(/^[*_]+|[*_]+$/g, "")
    .trim()
    .replace(/[:\s]+$/, "");
}

/** A node and everything under it, rendered back to markdown. */
function render(node: Node): string {
  return [
    node.body.join("\n"),
    ...node.children.map(
      (child) => `${"#".repeat(child.depth)} ${child.name}\n${render(child)}`,
    ),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Splits markdown along its own headings, using their depth.
 *
 * Markdown states where a section starts, so none of the guessing in ./chunk.ts
 * is needed: no heading vocabulary, no caps rule, no Title-Case-above-a-bullet
 * rule. Depth then answers two questions that were previously guessed at.
 *
 * **Which heading is a section.** A parent absorbs its whole subtree when the
 * subtree fits in one chunk, and gives its children sections of their own when
 * it does not. Two documents in the corpus want opposite answers at the same
 * depth and this is what separates them: Job #3's six technology groups are 49
 * to 310 characters and belong together under `Technical Skills / Exposure` --
 * splitting them cost `missing-job3` two of its three expected sections, with
 * the one holding Flask at rank 10 -- while the resume's six employers run 400
 * to 900 characters each and have to stay apart, because "what did I build at
 * RedMuqui" is answered by one of them. No new constant decides this: a section
 * is what fits in a chunk, and `MAX_CHARS` already says how big that is.
 *
 * **Which heading is not a section at all.** Job #1's skills list came back
 * with every entry promoted to a heading -- "Git/GitHub", "Azure DevOps" --
 * while Job #6's genuine parent "What You'll Do" has the same empty-bodied
 * shape. Flat, they are indistinguishable and the old rule folded both back
 * into the interrupted section. With depth they separate cleanly: a real parent
 * is followed by something deeper, a promoted list item by a sibling.
 */
export function chunkMarkdown(markdown: string): Chunk[] {
  const lines = normalize(markdown).split("\n");
  const root: Node = { name: OVERVIEW, depth: 0, body: [], children: [] };
  const stack: Node[] = [root];
  // Where a promoted list item goes back to: the last section that had text.
  let lastWithText: Node = root;
  let inFence = false;

  const hasText = (node: Node) => node.body.some((line) => line.trim());

  /** Undoes the last heading when it turned out to be a promoted list item. */
  const demoteEmpty = (incoming: number) => {
    const open = stack[stack.length - 1];
    if (open === root || hasText(open) || open.children.length > 0) return;
    if (incoming > open.depth) return; // something deeper follows: a real parent
    stack.pop();
    stack[stack.length - 1].children.pop();
    lastWithText.body.push(open.name);
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = inFence ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*$/);

    if (!heading) {
      const open = stack[stack.length - 1];
      open.body.push(line);
      if (line.trim()) lastWithText = open;
      continue;
    }

    const depth = heading[1].length;
    const name = headingName(heading[2]);
    const open = stack[stack.length - 1];
    // A page break repeats the heading it split; joining the pages produced the
    // duplicate, so the two halves belong to one section.
    if (name === open.name && depth === open.depth) continue;

    demoteEmpty(depth);
    while (stack.length > 1 && depth <= stack[stack.length - 1].depth) stack.pop();

    const node: Node = { name, depth, body: [], children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  demoteEmpty(1);

  const chunks: Chunk[] = [];
  const emit = (node: Node) => {
    const whole = render(node);
    if (node !== root && whole.length <= MAX_CHARS) {
      if (whole) add(node.name, whole);
      return;
    }
    const own = node.body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (own) add(node === root ? OVERVIEW : node.name, own);
    for (const child of node.children) emit(child);
  };
  const add = (section: string, body: string) => {
    for (const content of restoreTableHeaders(splitBySize(body))) {
      chunks.push({ section, position: chunks.length, content });
    }
  };

  emit(root);
  return chunks;
}
