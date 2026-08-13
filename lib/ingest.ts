import { chunkDocument, enrich, unlabeledShare } from "./chunk";
import { sql } from "./db";
import { embedForIndex, toVector } from "./embedding";
import { extractOrderedText } from "./pdf";

export type DocumentKind = "resume" | "job";

/**
 * Above this share of unlabeled text, the layout was not recognised. Real
 * documents in the corpus sit between 0.6% and 31% -- a job posting with a long
 * preamble before its first heading is normal, half the document is not.
 */
const UNSTRUCTURED_THRESHOLD = 0.5;

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Parses a PDF, splits it along its own headings, embeds every chunk and stores
 * the lot. The document and its chunks go in one transaction so a failure
 * halfway through cannot leave a document with a partial index behind it.
 */
export async function ingest(input: {
  file: File;
  kind: DocumentKind;
  label: string;
}) {
  const text = await extractOrderedText(new Uint8Array(await input.file.arrayBuffer()));
  const chunks = chunkDocument(text);
  if (chunks.length === 0) {
    // unpdf reads the text layer, which a scanned or image-only PDF does not
    // have. OCR would be the fix; for now say so instead of storing nothing.
    throw new IngestError(
      "No text could be extracted. Scanned or image-only PDFs are not supported.",
      422,
    );
  }

  const embeddings = await embedForIndex(chunks.map((chunk) => enrich(chunk, input.label)));

  return sql.begin(async (tx) => {
    const [document] = await tx<{ id: string }[]>`
      insert into documents (kind, label, filename, content)
      values (${input.kind}, ${input.label}, ${input.file.name}, ${text})
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

    return {
      id: document.id,
      label: input.label,
      chunks: chunks.length,
      sections: [...new Set(chunks.map((chunk) => chunk.section))],
      warning:
        unlabeledShare(chunks) > UNSTRUCTURED_THRESHOLD
          ? "Most of this document had no detectable section headings, so it fell back to size-based chunks. Run `pnpm inspect <file.pdf>` to see what was parsed."
          : undefined,
    };
  });
}
