import { cohere } from "@ai-sdk/cohere";
import { rerank } from "ai";

/**
 * Reordering the bi-encoder's candidates with a cross-encoder.
 *
 * The bi-encoder embeds the question and the passage separately, so it can only
 * measure what a passage is *about*. That is the measured cause of every
 * section this corpus fails to retrieve: asked which jobs are remote, Job #3's
 * `BENEFITS` beats Job #3's header because it mentions work-from-home
 * equipment, while the header is the thing that actually states the location.
 * A cross-encoder reads the question and the passage together and can separate
 * "this states a location" from "this mentions working from home".
 *
 * Why it runs before the budget and not after: the sections that miss rank 5th
 * to 8th inside their own document against a budget of 3 or 4. After the cut
 * they no longer exist, so reranking there would reorder three sections that
 * already made it -- and since the payload is the whole section, their order
 * barely matters once they are all in the prompt.
 */

/** Pinned, not an alias, so a rerun stays comparable -- same rule as CHAT_MODEL. */
export const RERANK_MODEL = process.env.RERANK_MODEL ?? "rerank-v3.5";

/**
 * How many chunks per document the reranker gets to look at.
 *
 * Ten because the misses sit between rank 5 and rank 8 and the widest net worth
 * paying for is the one that covers them with room to spare. Job #3 is the
 * largest document at 12 chunks, so this is close to "everything" for the
 * documents that matter and exactly "everything" for the small ones.
 */
export const CANDIDATES_PER_DOCUMENT = 10;

/**
 * What the reranker is shown for a chunk.
 *
 * The section name and the text, without the `Job #3` label that `enrich()`
 * prefixes for the index. The label is an internal handle with no meaning to a
 * model reading English, while the section name is the signal these misses turn
 * on -- `REQUIRED EXPERIENCE` against `ABOUT US` is most of the judgement.
 *
 * Untested against the alternative. Passing `enrich()`'s exact string would
 * make the reranker see what the embedder saw; that is the variant to try if
 * this one underperforms.
 */
export const passageFor = (chunk: { section: string; content: string }) =>
  `${chunk.section}: ${chunk.content}`;

/**
 * Relevance for every passage, in the order they were given.
 *
 * One call for every document at once, rather than one call per document. A
 * cross-encoder scores each (query, passage) pair on its own -- nothing in the
 * result depends on which other passages were in the batch -- so batching is
 * the same measurement at a fraction of the requests. The per-document budget
 * is then applied to the scores afterwards by `pickPerDocument`, which is what
 * keeps every posting its guaranteed look.
 */
export async function scorePassages(query: string, passages: string[]): Promise<number[]> {
  if (passages.length === 0) return [];

  const { ranking } = await rerank({
    model: cohere.reranking(RERANK_MODEL),
    documents: passages,
    query,
    // Everything back, not a top slice: the caller partitions by document and a
    // global top-N would starve a document whose best passage scores low.
    topN: passages.length,
    // One retry, for the reason written up in scripts/eval-answers.ts: rerunning
    // against the cache is the cheaper retry.
    maxRetries: 1,
  });

  const scores = new Array<number>(passages.length).fill(0);
  for (const row of ranking) scores[row.originalIndex] = row.score;
  return scores;
}

/**
 * The budget, applied to the reranked order instead of the distance order.
 *
 * Per document, deliberately. A global top-N was already measured in another
 * form -- phase 5's global distance band -- and it starved ten documents that a
 * question needed, because a document whose best passage scores low contributes
 * nothing at all. Three questions in the eval set need every posting present.
 * And it is not needed: every miss ranks 5th to 8th *within its own document*,
 * so reordering inside the partition reaches all of them.
 */
export function pickPerDocument<T extends { label: string; budget: number; score: number }>(
  candidates: T[],
): T[] {
  const byDocument = new Map<string, T[]>();
  for (const candidate of candidates) {
    const own = byDocument.get(candidate.label) ?? [];
    own.push(candidate);
    byDocument.set(candidate.label, own);
  }

  return [...byDocument.values()].flatMap((own) =>
    [...own].sort((a, b) => b.score - a.score).slice(0, own[0].budget),
  );
}
