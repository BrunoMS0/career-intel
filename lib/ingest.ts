// Explicit .ts extensions: scripts/ and the eval harness import these modules
// through plain Node, which does not resolve extensionless specifiers.
import { enrich, unlabeledShare } from "./chunk.ts";
import { chunkMarkdown } from "./chunk-markdown.ts";
import { sql } from "./db.ts";
import { embedForIndex, toVector } from "./embedding.ts";
import { compareFidelity, extractOrderedText } from "./pdf-llama.ts";
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
}) {
  const data = new Uint8Array(await input.file.arrayBuffer());
  const [markdown, verbatim] = await Promise.all([
    extractOrderedText(data, input.file.name),
    extractVerbatim(data).catch(() => ""),
  ]);

  const chunks = chunkMarkdown(markdown);
  if (chunks.length === 0) {
    throw new IngestError("No text could be extracted from this PDF.", 422);
  }

  const fidelity = compareFidelity(verbatim, markdown);

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
      insert into documents (kind, label, filename, content)
      values (${input.kind}, ${input.label}, ${input.file.name}, ${markdown})
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
