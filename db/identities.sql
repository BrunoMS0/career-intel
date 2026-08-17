-- Who each posting is, so a question can name it the way a person would.
--
-- Not in schema.sql, which runs once when the volume is created and therefore
-- before any document exists. Not derived at ingest either: five postings state
-- "**Company:**" in their first section and Job #6 states it three sections
-- later while Job #7 never states it at all, so the extraction rule would be
-- three rules and a fallback for eight rows.
--
-- Re-run after re-ingesting the corpus. Nothing detects that these are missing:
-- an empty identity is indistinguishable from a question that named no posting.
--
--   docker compose exec -T db psql -U postgres -d career_intel < db/identities.sql
--
-- Role titles are taken from each posting's own heading, including the double
-- names -- lib/scope.ts splits those, because a question uses one half or the
-- other. The resume keeps both columns null; it is in scope for every question.

alter table documents add column if not exists company text;
alter table documents add column if not exists role_title text;

update documents set company = v.company, role_title = v.role_title
from (values
  ('Job #1', 'Gamma',            'AI Engineer — Core AI Systems'),
  ('Job #2', 'eJam',             'Mid-Level AI Product / Creative-Tools Engineer'),
  ('Job #3', 'Afficiency',       'AI Prompt Engineer / AI Application Engineer'),
  ('Job #4', 'Kargo',            'Agentic AI Engineer'),
  ('Job #5', 'Golden Analytics', 'AI Engineer'),
  ('Job #6', 'Newpage',          'Forward Deployed Engineer'),
  -- Job #7 names no company anywhere in the posting.
  ('Job #7', null,               'Senior E-Commerce Developer')
) as v(label, company, role_title)
where documents.label = v.label;

select label, company, role_title from documents order by label;
