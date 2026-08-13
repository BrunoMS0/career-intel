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
  embedding   vector(1536) not null,  -- text-embedding-3-small
  created_at  timestamptz not null default now()
);

create index chunks_document_id_idx on chunks (document_id);

-- ponytail: no vector index. A few hundred chunks scan in under a millisecond,
-- and ivfflat/hnsw trade recall for speed we do not need yet. Add
-- `create index on chunks using hnsw (embedding vector_cosine_ops)` once the
-- corpus passes a few thousand rows.
