import { LlamaParseReader } from "llama-cloud-services";
// The package root declares ParsingMode but does not export it; the api subpath
// does.
import type { ParsingMode } from "llama-cloud-services/api";

/**
 * Same signature as `extractOrderedText` in ./pdf.ts, so the two are swappable.
 *
 * LlamaParse is a hosted service: the file is uploaded, parsed remotely and
 * returned as markdown, one Document per page. Reading order comes back solved
 * -- which is the whole reason to consider it -- at the cost of a network round
 * trip per ingest and of sending the document to a third party.
 *
 * The API key is read from LLAMA_CLOUD_API_KEY by the reader itself.
 */
/**
 * What an ingest parses with, measured across the corpus at 1, 2, 3, 4 and 5
 * pages: zero unlabeled text, 100% fidelity and real heading depth on all
 * eight documents. The default `parse_page_with_llm` promoted list items to
 * headings, escaped `&` as an entity, split a word mid-token and returned every
 * heading flat; `parse_document_with_agent`, `parse_document_with_llm` and
 * `parse_page_with_layout_agent` return nothing at all through this SDK.
 */
export const PARSE_MODE: ParsingMode = "parse_page_with_agent";

/**
 * Appended to LlamaParse's own prompt. Every clause is here because a document
 * in the corpus needed it, and it is written in terms of shape rather than of
 * any one document's vocabulary -- an earlier version that named a resume's
 * sections worked on the resume and did nothing for the postings.
 *
 * What each clause bought: treating visual labels as headings took the resume
 * from 1 section to 10; the repeated-entry clause took Afficiency from 8
 * unpromoted labels to 0 and Golden Analytics from 4 to 0; the one convention
 * clause is what stops five entries becoming headings while a sixth does not;
 * the letter-spaced clause is what recognises "S U M M A R Y" as a title.
 *
 * What it does not fix: a repeated pattern that crosses a page boundary with
 * too few instances on the far side to establish itself. The agent parses one
 * page at a time, and no wording tried recovered the sixth employer of a
 * two-page resume. `unpromotedLabels()` below is how that is noticed.
 */
export const STRUCTURE_INSTRUCTION = `Derive the markdown structure from how the document presents itself, not from the markup it happens to carry. A label is a heading when the document treats it as one — set in bold, in a larger or letter-spaced face, alone on its line above the text it introduces — even where the source contains no heading markup at all.

Where a section holds a run of entries that each open with a short bold label, often paired with a date range, an identifier, a company or a place, and are each followed by their own paragraph or bullets, those labels are headings too. They sit one level below the section that holds them. This is the shape of a work history, a project list, a catalogue of items, or a set of case studies, and its entries are sections in their own right rather than emphasis inside one long section.

Apply one convention to the whole document. Wherever the same structural pattern repeats, every instance takes the same treatment and the same heading level: if one instance became a heading, all of them do.

Page breaks are not structure. A section, a table, a list, or a run of repeated entries that continues onto the following page is one thing continuing rather than a new one starting, and the convention established earlier in the document still holds after the break.

Use heading depth to reflect that hierarchy: labels at the same level of the document get the same number of leading #, and a label that groups others sits exactly one level above the labels it groups.

Never promote a bullet, a list item, or a sentence of body text to a heading.

Labels rendered in letter-spaced capitals — a title whose letters are separated by spaces, such as S U M M A R Y — are headings, and the spacing is presentation: write the label as ordinary text.`;

/**
 * Lines that look like a section label the parser declined to promote: short,
 * made of nothing but an emphasis run, and not sitting directly under a heading
 * where an entry's own date or employer legitimately does.
 *
 * This is the structural counterpart to compareFidelity(), which cannot see the
 * failure at all: a heading demoted to bold body text loses no vocabulary. The
 * resume that came back as one single section scored 100% kept and 16 here.
 */
export function unpromotedLabels(markdown: string): number {
  let sinceHeading = 99;
  let orphans = 0;

  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s+\S/.test(line)) {
      sinceHeading = 0;
      continue;
    }
    if (sinceHeading > 2 && line.length <= 90 && /^(\*{1,3}[^*\n]+\*{1,3}\s*)+$/.test(line)) {
      orphans++;
    }
    sinceHeading++;
  }
  return orphans;
}

export async function extractOrderedText(
  data: Uint8Array,
  filename = "document.pdf",
  mode?: ParsingMode,
  options: Record<string, unknown> = {},
): Promise<string> {
  // The default pipeline runs an LLM over each page, which is why it can
  // rewrite content rather than transcribe it. `parse_page_without_llm` is the
  // deterministic layout path.
  //
  // `options` is passed through rather than enumerated: the reader accepts
  // around seventy flags and which of them help is an open question being
  // answered by running them, so `pnpm compare --opt=key=value` reaches all of
  // them without this file growing a parameter per experiment. Two worth
  // knowing: `system_prompt_append` adds to LlamaParse's own prompt where the
  // sibling `system_prompt` would replace it, and `invalidate_cache` is what
  // stops the server returning the parse made under a previous configuration.
  const reader = new LlamaParseReader({
    resultType: "markdown",
    language: ["en"],
    ...(mode ? { parse_mode: mode } : {}),
    ...options,
  });
  const pages = await reader.loadDataAsContent(data, filename);
  return pages.map((page) => page.text).join("\n\n");
}

/**
 * How much of the source document's vocabulary survived into the parse.
 *
 * A layout parser reorders glyphs; it does not choose words, so this should sit
 * at 100. LlamaParse writes its markdown with a language model, which is what
 * makes the structure good and also what lets it drop or reword text: on the
 * real corpus Job #1 came back missing the sentence carrying its location
 * requirement, and nothing in the output said so.
 *
 * The comparison runs against unpdf, which reads the text layer verbatim and is
 * therefore the only ground truth available locally. Words shorter than four
 * characters are ignored so ordinary rewording of articles and prepositions
 * does not register as loss.
 */
export function compareFidelity(source: string, output: string) {
  const words = (text: string) =>
    new Set(text.toLowerCase().normalize("NFKC").match(/\p{L}{4,}/gu) ?? []);

  const from = words(source);
  // A scanned PDF has no text layer for unpdf to read, so there is nothing to
  // compare against and nothing to warn about.
  if (from.size === 0) return { kept: 1, missing: [] as string[] };

  const into = words(output);
  const missing = [...from].filter((word) => !into.has(word));
  return { kept: (from.size - missing.length) / from.size, missing };
}
