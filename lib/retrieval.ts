import { sql } from "./db.ts";
import { embedForQuery, toVector } from "./embedding.ts";
import type { DocumentKind } from "./ingest.ts";

export type RetrievedSection = {
  label: string;
  kind: DocumentKind;
  section: string;
  /** Every chunk of the section, rejoined in document order. */
  content: string;
  /** Cosine distance of the closest chunk in this section. Lower is nearer. */
  distance: number;
  /**
   * Distance spread across every chunk of this section's document, picked or
   * not. Not used to retrieve anything -- it rides along so the chat route can
   * log it. A question the document cannot answer flattens it: asking Job #1
   * about its dress code puts all six of its chunks within 0.0186 of each
   * other, while asking about its compensation spreads them over 0.0963.
   */
  spread: number;
};

/**
 * Chunks ranked per document, not per side.
 *
 * Ranking by document kind gave the resume four slots and made all six postings
 * share the other four, so "which role fits me best?" answered from two of them
 * and the model never saw the rest. Per document every posting is guaranteed a
 * look, which is the whole premise of a question that compares them.
 *
 * The budget therefore has to shrink as the field widens: a question naming one
 * posting has two documents in play and can afford depth, while an unscoped one
 * has seven and needs breadth. Measured with `pnpm retrieve` on the six-posting
 * corpus, "which role fits me best?" went from 8 sections drawn from two
 * postings to 16 covering all six, and the context it builds from 3.8k
 * characters to 10k. Scoped questions come out byte for byte as before.
 *
 * The broad budget is 3 and not 2 because `pnpm eval` priced the difference: it
 * recovers one more of the 19 sections the question set demands, for 26% more
 * context (7.4k characters at the median, up from 5.9k). Everything else
 * measured cost more and returned the same or less -- a budget proportional to
 * document length spent 47% more context to recover nothing, and both relative
 * bands are written up in CLAUDE.md as the losers they turned out to be.
 */
export const CHUNKS_PER_DOCUMENT = { focused: 4, broad: 3 };
/** The most documents that still get the focused budget; past this, coverage wins. */
export const MAX_FOCUSED_DOCUMENTS = 3;
/**
 * The resume keeps its full allowance no matter how wide the field gets. It is
 * one document but it is one *side* of every comparison, and letting it shrink
 * to a posting's share answered "which role fits me best?" with 12% of the
 * context describing the candidate.
 */
export const RESUME_CHUNKS = 4;

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Finds which documents a question is about, so "How does my experience align
 * with Job #2?" reads Job #2 and not the other five postings.
 *
 * Labels are matched literally rather than inferred by a model: they are short,
 * unique and user-chosen, and a wrong guess here silently answers about the
 * wrong job. Punctuation and spacing are squashed so "Job #2", "job 2" and
 * "JOB2" all land.
 *
 * ponytail: substring match, so with more than nine postings "Job #1" would
 * also match a question about "Job #12". Match on word boundaries if the corpus
 * ever gets that big.
 */
export async function resolveScope(query: string): Promise<string[]> {
  const documents = await sql<{ label: string }[]>`
    select label from documents where kind = 'job'
  `;
  const asked = squash(query);
  return documents.map((d) => d.label).filter((label) => asked.includes(squash(label)));
}

/**
 * Retrieves evidence for a question as whole sections rather than raw chunks.
 *
 * Two things happen here that a plain top-k does not do:
 *
 * Every document is guaranteed a look. Ranking is partitioned by document, so
 * the resume and each posting in scope contribute their own best matches. A
 * single ranked list can easily return eight requirement chunks from one
 * posting and nothing to compare them against, and every question this product
 * answers is a comparison.
 *
 * Matches are widened to their parent section. A chunk is precise enough to
 * search with but too narrow to answer from: "what am I missing for this role"
 * needs the whole requirements list, not the three bullets that happened to
 * rank. The chunk is the key; the section is the payload.
 */
export async function retrieve(query: string): Promise<RetrievedSection[]> {
  const scope = await resolveScope(query);
  const vector = toVector(await embedForQuery(query));
  const { perDocument } = await budget(scope);

  return sql<RetrievedSection[]>`
    with ranked as (${rankChunks(vector, scope, perDocument)}),
    picked as (
      select document_id, section, min(distance) as distance
      from ranked
      where rank <= budget
      group by document_id, section
    ),
    -- Over every chunk, not just the picked ones: the question is how flat the
    -- whole document went, and the budget would hide the far end of it.
    spread as (
      select document_id, max(distance) - min(distance) as spread
      from ranked
      group by document_id
    )
    select d.label,
           d.kind,
           p.section,
           p.distance::float8 as distance,
           s.spread::float8 as spread,
           string_agg(c.content, E'\n' order by c.position) as content
    from picked p
    join chunks c
      on c.document_id = p.document_id and c.section = p.section
    join documents d on d.id = p.document_id
    join spread s on s.document_id = p.document_id
    group by d.label, d.kind, p.section, p.distance, s.spread
    order by p.distance
  `;
}

/** How many documents a question puts in play, and the budget that implies. */
async function budget(scope: string[]) {
  // The resume is always in play; postings narrow to the ones asked about.
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int from documents
    where kind = 'resume' or ${scope.length === 0 ? sql`true` : sql`label = any(${scope})`}
  `;
  return {
    documents: count,
    perDocument:
      count > MAX_FOCUSED_DOCUMENTS
        ? CHUNKS_PER_DOCUMENT.broad
        : CHUNKS_PER_DOCUMENT.focused,
    resume: RESUME_CHUNKS,
  };
}

/**
 * The chunk-level ranking, written once because two callers read it: the
 * retriever above and `pnpm retrieve --chunks`. An explanation that drifts from
 * what actually ran is worse than none.
 */
function rankChunks(vector: string, scope: string[], perDocument: number) {
  return sql`
    select c.document_id,
           c.section,
           c.position,
           length(c.content) as chars,
           d.label,
           d.kind,
           c.embedding <=> ${vector} as distance,
           row_number() over (
             partition by c.document_id order by c.embedding <=> ${vector}
           ) as rank,
           case when d.kind = 'resume' then ${RESUME_CHUNKS}::int else ${perDocument}::int end as budget
    from chunks c
    join documents d on d.id = c.document_id
    where d.kind = 'resume' or ${
      scope.length === 0 ? sql`true` : sql`d.label = any(${scope})`
    }
  `;
}

export type RankedChunk = {
  label: string;
  kind: DocumentKind;
  section: string;
  position: number;
  chars: number;
  distance: number;
  rank: number;
  /** Within its document's budget, so this chunk is one of the search hits. */
  picked: boolean;
};

/**
 * Every chunk the search considered, ranked, with the budget that decided which
 * ones counted. Nothing in the answer path calls this -- it exists so the two
 * stages can be read on a terminal instead of inferred from the output.
 */
export async function explainRetrieval(query: string) {
  const scope = await resolveScope(query);
  const vector = toVector(await embedForQuery(query));
  const limits = await budget(scope);

  const chunks = await sql<RankedChunk[]>`
    with ranked as (${rankChunks(vector, scope, limits.perDocument)})
    select label, kind, section, position, chars,
           distance::float8 as distance,
           rank::int as rank,
           (rank <= budget) as picked
    from ranked
    order by label, rank
  `;

  return { scope, limits, chunks };
}
