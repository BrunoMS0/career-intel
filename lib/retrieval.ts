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

/** Sections kept per side of the comparison. */
const TOP_K = 4;

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
 * Both sides are guaranteed. Ranking is partitioned by document kind, so the
 * resume and the postings each contribute their own best matches. Every
 * question this product answers is a comparison, and a single ranked list can
 * easily return eight requirement chunks and nothing to compare them against.
 *
 * Matches are widened to their parent section. A chunk is precise enough to
 * search with but too narrow to answer from: "what am I missing for this role"
 * needs the whole requirements list, not the three bullets that happened to
 * rank. The chunk is the key; the section is the payload.
 */
export async function retrieve(query: string): Promise<RetrievedSection[]> {
  const scope = await resolveScope(query);
  const vector = toVector(await embedForQuery(query));

  return sql<RetrievedSection[]>`
    with ranked as (
      select c.document_id,
             c.section,
             c.embedding <=> ${vector} as distance,
             row_number() over (
               partition by d.kind order by c.embedding <=> ${vector}
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
      where rank <= ${TOP_K}
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
