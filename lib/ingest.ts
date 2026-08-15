// Explicit .ts extensions: scripts/ and the eval harness import these modules
// through plain Node, which does not resolve extensionless specifiers.
import { enrich, unlabeledShare } from "./chunk.ts";
import { chunkMarkdown } from "./chunk-markdown.ts";
import { sql } from "./db.ts";
import { embedForIndex, toVector } from "./embedding.ts";
import {
  compareFidelity,
  extractOrderedText,
  PARSE_MODE,
  STRUCTURE_INSTRUCTION,
  unpromotedLabels,
} from "./pdf-llama.ts";
import { extractOrderedText as extractVerbatim } from "./pdf.ts";

export type DocumentKind = "resume" | "job";

/**
 * Above this share of unlabeled text, the layout was not recognised. Real
 * documents in the corpus sit between 0.6% and 32% -- a job posting with a long
 * preamble before its first heading is normal, half the document is not.
 */
const UNSTRUCTURED_THRESHOLD = 0.5;

/**
 * Below this share of the source vocabulary, the parse lost text rather than
 * reformatting it. Measured on the corpus: five of six postings come back at
 * 99-100%, and the one that dropped two sentences -- including the one naming
 * its location requirement -- came back at 95%. The gap between those two
 * populations is wide, so the line sits in the middle of it.
 */
const FIDELITY_THRESHOLD = 0.98;

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Parses a PDF to markdown, splits it along its own headings, embeds every
 * chunk and stores the lot. The document and its chunks go in one transaction
 * so a failure halfway through cannot leave a document with a partial index
 * behind it.
 *
 * Both parsers run. LlamaParse produces the markdown that is actually indexed;
 * unpdf reads the text layer locally in milliseconds and exists here only as
 * the yardstick the fidelity check measures against, because a hosted model
 * writing the markdown can quietly drop a sentence and nothing else would
 * notice.
 */
export async function ingest(input: {
  file: File;
  kind: DocumentKind;
  label: string;
  /**
   * How a person would name this posting. Optional, and null is a working
   * state rather than a broken one: `resolveScope` still matches the label, so
   * a document with no identity behaves exactly as every document did before
   * phase 7. What it loses is being findable by company or title -- which is
   * how people actually ask -- so the upload form asks for them.
   *
   * Not parsed out of the document, deliberately. Five of the seven postings
   * state "**Company:**" in their first section, Job #6 states it three
   * sections later and Job #7 never states it at all, so the extraction rule
   * would be three rules and a fallback. The person uploading already knows.
   */
  company?: string | null;
  roleTitle?: string | null;
}) {
  const data = new Uint8Array(await input.file.arrayBuffer());
  const [markdown, verbatim] = await Promise.all([
    extractOrderedText(data, input.file.name, PARSE_MODE, {
      system_prompt_append: STRUCTURE_INSTRUCTION,
    }),
    extractVerbatim(data).catch(() => ""),
  ]);

  const chunks = chunkMarkdown(markdown);
  if (chunks.length === 0) {
    throw new IngestError("No text could be extracted from this PDF.", 422);
  }

  const fidelity = compareFidelity(verbatim, markdown);
  const orphans = unpromotedLabels(markdown);

  const embeddings = await embedForIndex(chunks.map((chunk) => enrich(chunk, input.label)));

  return sql.begin(async (tx) => {
    // A new resume replaces the one already indexed rather than joining it:
    // the app compares one candidate, and db/schema.sql holds that invariant
    // with a partial unique index. Same transaction as the insert, so a failed
    // parse cannot leave the user with no resume at all.
    const replaced =
      input.kind === "resume"
        ? await tx<{ label: string }[]>`delete from documents where kind = 'resume' returning label`
        : [];

    const [document] = await tx<{ id: string }[]>`
      insert into documents (kind, label, company, role_title, filename, content)
      values (${input.kind}, ${input.label}, ${input.company ?? null},
              ${input.roleTitle ?? null}, ${input.file.name}, ${markdown})
      returning id
    `;

    await tx`
      insert into chunks ${tx(
        chunks.map((chunk, i) => ({
          document_id: document.id,
          position: chunk.position,
          section: chunk.section,
          content: chunk.content,
          embedding: toVector(embeddings[i]),
        })),
      )}
    `;

    const warnings: string[] = [];
    if (unlabeledShare(chunks) > UNSTRUCTURED_THRESHOLD) {
      warnings.push(
        "Most of this document had no detectable section headings, so it fell back to size-based chunks.",
      );
    }
    if (fidelity.kept < FIDELITY_THRESHOLD) {
      // Naming the words is what makes this actionable: it is the difference
      // between "something changed" and seeing "NYC" go missing.
      warnings.push(
        `The parser returned ${Math.round(fidelity.kept * 100)}% of this document's wording, so some text was dropped or rewritten. Missing: ${fidelity.missing.slice(0, 12).join(", ")}.`,
      );
    }
    // The failure the fidelity check cannot see, because it loses no words: a
    // section label left as bold body text instead of promoted to a heading.
    // Its content then joins the previous section and is cited under that
    // section's name, which is a wrong attribution rather than a missing one.
    // Measured cause is a page break: a two-page resume left its sixth employer
    // behind while a one-page version of the same resume left none.
    //
    // ponytail: warns on the first one. Every document in the corpus scores 0,
    // so anything above that is signal here; raise the bar if real uploads
    // prove noisier than the eight measured.
    if (orphans > 0) {
      warnings.push(
        `${orphans} label${orphans === 1 ? "" : "s"} in this document look like section headings the parser did not recognise, most often just after a page break. Text under them is attributed to the section above instead. A single-page layout avoids it.`,
      );
    }

    return {
      id: document.id,
      label: input.label,
      chunks: chunks.length,
      replaced: replaced[0]?.label,
      sections: [...new Set(chunks.map((chunk) => chunk.section))],
      warning: warnings.length
        ? `${warnings.join(" ")} Run \`pnpm compare <file.pdf>\` to see what was parsed.`
        : undefined,
    };
  });
}
