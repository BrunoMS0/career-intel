create extension if not exists vector;

-- A resume or a job posting. Both are short (1-3 pages), so we keep the full
-- text here: it lets a query about one specific document use the whole thing
-- instead of stitching chunks back together.
create table documents (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('resume', 'job')),
  -- User-facing handle, e.g. "Job #2". Unique because queries scope by it:
  -- two documents sharing a label would make "Job #2" ambiguous.
  label      text not null unique,
  filename   text not null,
  content    text not null,
  created_at timestamptz not null default now()
);

-- Retrieval unit. document_id is what lets a query scope to one job posting
-- instead of matching across the whole corpus.
create table chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  position    int not null,           -- order within the document
  -- Heading this chunk sat under. Doubles as the grouping key for parent
  -- expansion, which is why there is no separate sections table: it would
  -- store one string and never be queried on its own.
  section     text not null,
  content     text not null,
  embedding   vector(1536) not null,  -- gemini-embedding-001
  created_at  timestamptz not null default now()
);

-- Every question that reached the chat API, with the numbers its fate was
-- decided on. Two jobs, and the second is the reason the columns are these:
--
-- A refused question that deserved an answer is otherwise invisible -- the user
-- sees a refusal and closes the tab. Here it is a row with its distance, so the
-- threshold can be shown to be wrong instead of argued about.
--
-- And the threshold was fitted on 28 questions someone thought of. Real ones
-- accumulate here, which is what the eval harness fits against next.
create table query_logs (
  id           uuid primary key default gen_random_uuid(),
  question     text not null,
  -- Labels the question resolved to. Empty when it named none, which is also
  -- the split that matters: unscoped questions and scoped ones fail differently.
  scope        text[] not null default '{}',
  sections     int not null,
  -- Distance of the nearest chunk, and the spread inside the document that owns
  -- it. Null only when nothing is indexed. The spread is recorded and not
  -- enforced -- see lib/guardrail.ts for why it did not earn a threshold.
  top_distance float8,
  doc_spread   float8,
  -- False when the guardrail refused before spending a model call.
  answered     boolean not null,
  created_at   timestamptz not null default now()
);

-- The product compares one candidate against several postings, and retrieval
-- takes every resume on every question. A second one would mix two people's
-- experience into the same answer with nothing marking which is whose, so the
-- assumption is enforced where the data lives rather than in a route that a
-- second caller could skip.
create unique index documents_single_resume_idx on documents (kind) where kind = 'resume';

create index chunks_document_id_idx on chunks (document_id);

-- ponytail: no vector index. A few hundred chunks scan in under a millisecond,
-- and ivfflat/hnsw trade recall for speed we do not need yet. Add
-- `create index on chunks using hnsw (embedding vector_cosine_ops)` once the
-- corpus passes a few thousand rows.
