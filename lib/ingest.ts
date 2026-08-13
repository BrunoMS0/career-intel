import { openai } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { extractText } from "unpdf";
import { chunkDocument, enrich } from "./chunk";
import { sql } from "./db";

export type DocumentKind = "resume" | "job";

// 1536 dimensions, matching the vector(1536) column in db/schema.sql.
const embeddingModel = openai.textEmbeddingModel("text-embedding-3-small");

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
  const { text } = await extractText(new Uint8Array(await input.file.arrayBuffer()), {
    mergePages: true,
  });

  const chunks = chunkDocument(text);
  if (chunks.length === 0) {
    // unpdf reads the text layer, which a scanned or image-only PDF does not
    // have. OCR would be the fix; for now say so instead of storing nothing.
    throw new IngestError(
      "No text could be extracted. Scanned or image-only PDFs are not supported.",
      422,
    );
  }

  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: chunks.map((chunk) => enrich(chunk, input.label)),
  });

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
          // pgvector parses its own bracketed text format. A JS array would be
          // sent as a Postgres array literal and fail to cast.
          embedding: JSON.stringify(embeddings[i]),
        })),
      )}
    `;

    return { id: document.id, label: input.label, chunks: chunks.length };
  });
}
