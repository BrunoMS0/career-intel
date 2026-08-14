@AGENTS.md

# Career Intelligence Assistant

A hiring assignment: a RAG app that answers questions about one resume against
several job postings ("What skills am I missing for Job #2?"). Repo:
https://github.com/BrunoMS0/career-intel

## Working agreement

- Code and code comments in English. Conversation with the user in Spanish.
- The user writes `README.md` themselves. Do not add setup docs or decision
  write-ups to it — the assignment grades their own reasoning, not generated
  prose. Correcting a factual error in it is welcome; rewriting it is not.
- Work phase by phase, confirming before starting the next one.
- Commit messages: short, lowercase, plain words. No `Co-Authored-By` trailer.
- Prefer measuring over asserting. Several decisions below were settled by
  running the thing against the real corpus, and that evidence is the point.

## Stack

| Piece | Choice | Why |
| --- | --- | --- |
| App | Next.js 16, React 19, TypeScript | assignment asks fullstack |
| DB | Postgres 17 + pgvector 0.8.6 (Docker) | relational data and vectors in one container, metadata filters in the same `WHERE` as the search |
| Embeddings | `gemini-embedding-001`, 1536 dims | OpenAI account had no credits; Gemini's free tier also gives asymmetric `taskType` |
| LLM | `gemini-3.7-flash` via `CHAT_MODEL` | free tier; pinned, not an alias, so eval runs stay comparable |
| PDF | LlamaParse (`llama-cloud-services`) | markdown states its headings instead of leaving them to be guessed; `unpdf` stays as the local fidelity yardstick |
| SQL | `postgres` (postgres.js), raw SQL | three tables; `db/schema.sql` runs on container init, no migration toolchain |
| Tests | `node --test` | stdlib, no framework |

## Layout

- `lib/pdf-llama.ts` — LlamaParse extraction, `compareFidelity()`
- `lib/chunk-markdown.ts` — markdown-native chunker, what ingest uses
- `lib/pdf.ts` — unpdf extraction, rebuilds reading order from glyph positions;
  no longer the indexed text, still the fidelity yardstick
- `lib/chunk.ts` — heuristic chunker for plain text, plus `splitBySize()`,
  `enrich()` and `unlabeledShare()`, which the markdown path reuses
- `lib/embedding.ts` — `embedForIndex()` / `embedForQuery()`, deliberately paired
- `lib/retrieval.ts` — scope resolution and the search + parent-expansion query
- `lib/ingest.ts` — parse, chunk, embed, store in one transaction
- `app/api/{health,documents,chat}/route.ts`, `app/workspace.tsx` — UI
- `scripts/` — `pnpm inspect <pdf>`, `pnpm compare <pdf>...`, `pnpm retrieve "<question>"`

## Commands

```
docker compose up -d                  # Postgres + pgvector
pnpm dev                              # app on :3000
pnpm test                             # chunker and pdf tests
pnpm inspect <file.pdf> [--text]      # how a PDF chunks under unpdf, without indexing it
pnpm compare <file.pdf>...            # both parsers side by side, with fidelity
pnpm retrieve "<question>"            # what a question retrieves, with distances
docker compose exec db psql -U postgres -d career_intel
```

## Decisions worth not relitigating

The next two decisions describe `lib/chunk.ts`, which guessed headings out of
plain text. LlamaParse now states them, so neither rule runs on an ingest any
more — they are kept because the reasoning still explains why the section label
is worth this much trouble, and because `pnpm inspect` and `pnpm compare` still
exercise that path.

**Structure-based chunking, hand-rolled.** Sections are semantic here, not
decorative: "5+ years of React" under a posting's requirements means the role
wants it, under the resume's experience means the candidate has it. JS chunking
libraries (`@langchain/textsplitters`, `chonkie`) only split by size or
embedding similarity and would drop the section label entirely. Docling does
solve section detection, but it is Python — `docling-sdk` on npm is only a
bridge to the Python CLI or a hosted service, so adopting it adds a second
runtime to the container story. Revisit with eval numbers.

**Headings by vocabulary, caps, and list structure — not font size.** Font size
looked like the better signal and was measured against both real documents: the
resume's headings run 13pt over a 9.5pt body (1.37x) while its job titles run
10.5pt (1.10x), and the posting's headings are 13pt over 11pt (1.18x). Any
threshold catching the posting also promotes every employer in the resume to a
section. The rule that generalised instead: a short Title Case line directly
above a bullet list is a heading — resumes put the employer there, postings put
a list.

**No overlap between chunks.** Every cut lands on a paragraph or bullet
boundary, so there is no mid-thought break to repair.

**No vector index.** Under a hundred chunks scan in well under a millisecond.
Add HNSW past a few thousand rows.

**Reranking deferred** until the eval harness shows whether it helps.

## Gotchas

- Ports 5432 and 5433 are taken by locally installed PostgreSQL 16 and 17, so
  the container binds `DB_PORT=5544`. A port clash there surfaces as "password
  authentication failed", not a connection error.
- `gemini-2.5-*` models return 404 for API keys created recently, and the
  `models` listing endpoint still lists them. Verify a model with a real call.
- Windows: use `curl.exe`, not `curl` — PowerShell aliases it to
  `Invoke-WebRequest`, whose multipart body undici rejects.
- `db/schema.sql` only runs when the volume is created. Schema changes need
  `docker compose down -v && docker compose up -d`.
- Internal imports inside `lib/` carry explicit `.ts` extensions so `scripts/`
  and the eval harness can import them through plain Node.

## Status

Phases 1-3 done: setup, ingestion, retrieval and grounded chat with citations.

**Done: the PDF parser is LlamaParse** (`llama-cloud-services` 0.5.4, key in
`LLAMA_CLOUD_API_KEY`). `pnpm compare <file.pdf>...` runs both parsers over the
same documents and prints sections, chunks and fidelity; that is the evidence
the swap was decided on and the tool for judging a new document.

What the measurement actually found, since two of the assumptions above it were
wrong:

- **Heading depth is not explicit.** LlamaParse emitted 77 headings across the
  corpus and not one `##`. The hope that `Required` would come back as a child
  of `What You Bring` did not survive; sections are flat and
  `lib/chunk-markdown.ts` says so.
- **A heading with an empty body is ambiguous.** In Job #6 it is a real parent
  (`What You'll Do`); in Job #1 it is a skills-list entry the model promoted
  (`Git/GitHub`, `Azure DevOps`). Same shape, so no hierarchy is inferred and
  the text folds back into the section it interrupted.
- **The markdown is written by a language model, not extracted.**
  `parse_mode: "parse_page_without_llm"` returns no markdown at all — the
  result endpoint 404s — so structure and rewriting are the same feature. Two
  earlier revisions of the corpus proved what that costs: on one it translated
  a whole posting into Spanish, twice, differently each time; on the next it
  silently dropped two sentences from the Afficiency posting, one of them the
  location requirement.
- Hence `compareFidelity()` in `lib/pdf-llama.ts`: unpdf still runs on every
  ingest, purely as the verbatim yardstick, and a parse below 98% of the source
  vocabulary warns with the missing words. The current corpus — postings the
  user restructured with explicit headings — scores 100% across all six, so the
  check is quiet. It stays because nothing about the parser changed, only the
  input did.

Input structure turned out to matter more than any parser setting. The
restructured postings took unlabeled text from 28%/17%/7%/5%/4% down to 0% on
four of six, and fixed the fidelity loss outright. What it did **not** change is
heading depth: still 56 headings, still no `##`.

Costs that belong in the README: it is a hosted service, so documents are
uploaded to a third party (the user's real resume among them), ingestion stops
working offline, output is not reproducible run to run, and the package prints
its own deprecation notice (maintained to 1 May 2026, successor
`@llamaindex/llama-cloud`).

`chunkDocument()` and its heuristics in `lib/chunk.ts` are no longer in the
ingest path — only `splitBySize`, `enrich` and `unlabeledShare` are. They still
back `pnpm inspect` and the unpdf column of `pnpm compare`.

Then phase 4 (guardrails and observability: a score threshold that skips the
model call when retrieval is weak, refusal rules, a `query_logs` table), phase 5
(eval harness) and phase 6 (UI polish, app Dockerfile).

Known and deliberate, not yet fixed:

- Exactly one resume is assumed and nothing enforces it. Retrieval takes every
  document of kind `resume` on every question, so a second CV would be mixed
  into the same answer with no way to tell whose experience is whose. Scope
  resolution covers postings only.
- Chunks per document is a fixed number, so the share of a document actually
  searched falls as it gets longer: 4 of the current resume's 10 chunks is 40%,
  the same 4 out of a 25-chunk CV is 16%. A relative distance cutoff would
  adapt on its own, which is the phase 4 conversation.
- `documents.content` is stored and read by nothing yet.
- Retrieval runs against the latest question only; a follow-up leaning on the
  previous turn retrieves against the wrong text.
- Answers render as plain text, so markdown shows raw `*` and `###`.
- No score threshold yet: weak retrieval still reaches the model.
