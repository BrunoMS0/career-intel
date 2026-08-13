import { google } from "@ai-sdk/google";
import { embed, embedMany } from "ai";

/**
 * Both sides of retrieval live in this file on purpose.
 *
 * Gemini embeds asymmetrically: the same text yields a different vector
 * depending on the task type it is given. Stored passages have to go in as
 * RETRIEVAL_DOCUMENT and searches as RETRIEVAL_QUERY, otherwise a question
 * lands near other questions instead of near the passage that answers it.
 * Nothing throws when they drift apart -- results just quietly get worse -- so
 * the two calls sit a few lines from each other where neither can be changed
 * without seeing the other.
 *
 * Changing the model or the dimensions means re-indexing every document: old
 * vectors live in a different space and are not comparable to new ones.
 */

const model = google.textEmbeddingModel("gemini-embedding-001");

/** Must match the vector(1536) column in db/schema.sql. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Passages being stored for later retrieval. */
export async function embedForIndex(values: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model,
    values,
    providerOptions: {
      google: {
        outputDimensionality: EMBEDDING_DIMENSIONS,
        taskType: "RETRIEVAL_DOCUMENT",
      },
    },
  });
  return embeddings;
}

/** A question searching for those passages. */
export async function embedForQuery(value: string): Promise<number[]> {
  const { embedding } = await embed({
    model,
    value,
    providerOptions: {
      google: {
        outputDimensionality: EMBEDDING_DIMENSIONS,
        taskType: "RETRIEVAL_QUERY",
      },
    },
  });
  return embedding;
}

/**
 * pgvector parses its own bracketed text format. Handing postgres.js a JS array
 * would send a Postgres array literal, which fails to cast to vector.
 */
export function toVector(embedding: number[]): string {
  return JSON.stringify(embedding);
}
