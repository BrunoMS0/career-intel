import { splitBySize, type Chunk } from "./chunk.ts";

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

type Section = { name: string; body: string[] };

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

/**
 * Splits LlamaParse markdown along its own headings.
 *
 * Markdown states where a section starts, so none of the guessing in
 * ./chunk.ts is needed here: no heading vocabulary, no caps rule, no
 * Title-Case-above-a-bullet rule. What it does need is a correction for
 * headings the parser invents.
 *
 * Two behaviours are worth knowing, both measured on the real corpus:
 *
 * Every heading comes back as `#`. Across thirteen documents LlamaParse emitted
 * 77 headings and not one `##`, so the depth the markdown format could carry is
 * simply absent and sections come out flat.
 *
 * ponytail: depth is therefore ignored rather than turned into a lineage like
 * "What You Bring — Required". Building that machinery for a level the parser
 * has never once emitted is speculation; chunk-markdown.test.ts holds a canary
 * that fails the day a document arrives with real `##`, which is when to write
 * it.
 *
 * A heading with an empty body is not a section. In Job #1 the entries of a
 * skills list -- "Git/GitHub", "Azure DevOps", "CI/CD Pipelines" -- each came
 * back promoted to a heading with nothing underneath. In Job #6 the genuine
 * parent "What You'll Do" has the same shape. They are indistinguishable, so
 * rather than guess a hierarchy this folds the text back into the section it
 * interrupted, which keeps the skills as content and costs only the parent
 * label in the rarer case.
 */
export function chunkMarkdown(markdown: string): Chunk[] {
  const lines = normalize(markdown).split("\n");
  const sections: Section[] = [];
  let current: Section = { name: OVERVIEW, body: [] };
  let pending: { name: string; depth: number }[] = [];
  let inFence = false;

  const flush = () => {
    if (current.body.some((line) => line.trim())) sections.push(current);
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = inFence ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*$/);

    if (!heading) {
      // A heading only earns its own section once text arrives under it.
      // Anything still pending was a promoted list item, so it becomes content.
      if (line.trim() && pending.length) {
        const opened = pending.pop()!;
        current.body.push(...pending.map((p) => p.name));
        pending = [];
        flush();
        current = { name: opened.name, body: [] };
      }
      current.body.push(line);
      continue;
    }

    // Emphasis inside a heading is formatting, not name. A revision of the
    // corpus set its headings in bold and LlamaParse passed the markers
    // through, so sections arrived called "**ABOUT THE ROLE**" and "*Required*"
    // -- and that string is not cosmetic here: enrich() embeds it, and the
    // model quotes it back in every citation.
    const name = heading[2]
      .trim()
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim()
      .replace(/[:\s]+$/, "");
    const depth = heading[1].length;
    // A page break repeats the heading it split; joining the pages produced the
    // duplicate, so the two halves belong to one section.
    if (name === current.name && !pending.length) continue;
    if (pending.at(-1)?.name === name) continue;

    pending.push({ name, depth });
  }
  current.body.push(...pending.map((p) => p.name));
  flush();

  const chunks: Chunk[] = [];
  for (const section of sections) {
    // Folded headings are appended after the body, so a section can end up with
    // a run of blank lines between its text and them.
    const body = section.body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!body) continue;
    for (const content of restoreTableHeaders(splitBySize(body))) {
      chunks.push({ section: section.name, position: chunks.length, content });
    }
  }
  return chunks;
}
