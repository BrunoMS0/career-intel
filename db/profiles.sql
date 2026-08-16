-- Structured extraction, applied by hand like db/identities.sql and for the same
-- reason: db/schema.sql only runs when the volume is created, and re-creating it
-- throws the corpus away.
--
-- Idempotent, so it can be re-run after a re-ingest. `pnpm profiles` fills them.

alter table documents add column if not exists profile text;
alter table documents add column if not exists extract jsonb;

-- What a broad question sends per posting instead of three sections. Not an
-- index for lookup -- it exists so `select label, profile` is obviously the
-- cheap path and nobody reaches for the chunks table to build a comparison.
comment on column documents.profile is
  'One-paragraph neutral summary written by structured extraction at ingest. 219 chars on average against 1,940 for the three sections a broad question used to draw from this document.';
comment on column documents.extract is
  'The whole extraction result: work_mode, salary, skills, technologies. Facts a question can be filtered on live here rather than in the vector index, because "which of these are remote?" is an aggregation and no embedding answers one.';
