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
 */
const CHUNKS_PER_DOCUMENT = { focused: 4, broad: 2 };
/** Above this many documents in play, depth gives way to coverage. */
const BROAD_AT = 3;
/**
 * The resume keeps its full allowance no matter how wide the field gets. It is
 * one document but it is one *side* of every comparison, and letting it shrink
 * to a posting's share answered "which role fits me best?" with 12% of the
 * context describing the candidate.
 */
const RESUME_CHUNKS = 4;

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

  // One document per named posting, plus the resume, which is always in play.
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int from documents
    where kind = 'resume' or ${scope.length === 0 ? sql`true` : sql`label = any(${scope})`}
  `;
  const perDocument =
    count > BROAD_AT ? CHUNKS_PER_DOCUMENT.broad : CHUNKS_PER_DOCUMENT.focused;

  return sql<RetrievedSection[]>`
    with ranked as (
      select c.document_id,
             c.section,
             d.kind,
             c.embedding <=> ${vector} as distance,
             row_number() over (
               partition by c.document_id order by c.embedding <=> ${vector}
             ) as rank
      from chunks c
      join documents d on d.id = c.document_id
      -- The resume is always in play; postings narrow to the ones asked about.
      where d.kind = 'resume' or ${
        scope.length === 0 ? sql`true` : sql`d.label = any(${scope})`
      }
    ),
    picked as (
      select document_id, section, min(distance) as distance
      from ranked
      where rank <= case when kind = 'resume' then ${RESUME_CHUNKS}::int else ${perDocument}::int end
      group by document_id, section
    )
    select d.label,
           d.kind,
           p.section,
           p.distance::float8 as distance,
           string_agg(c.content, E'\n' order by c.position) as content
    from picked p
    join chunks c
      on c.document_id = p.document_id and c.section = p.section
    join documents d on d.id = p.document_id
    group by d.label, d.kind, p.section, p.distance
    order by p.distance
  `;
}
