import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPerDocument } from "./rerank.ts";

// Only the partition rule is tested here. Scoring is a hosted cross-encoder, so
// asserting on its numbers would fail for reasons that have nothing to do with
// this logic -- the same split lib/guardrail.test.ts makes. What the reranker
// actually buys is measured by `pnpm eval --rerank`, against the real corpus.

const candidate = (label: string, section: string, score: number, budget = 3) => ({
  label,
  section,
  score,
  budget,
});

test("each document keeps its own budget, whatever the scores look like", () => {
  // Job #1 outscores Job #2 everywhere. A global top-3 would return only Job #1
  // and answer "which of these jobs are remote?" from one posting.
  const picked = pickPerDocument([
    candidate("Job #1", "a", 0.9),
    candidate("Job #1", "b", 0.8),
    candidate("Job #1", "c", 0.7),
    candidate("Job #1", "d", 0.6),
    candidate("Job #2", "e", 0.2),
    candidate("Job #2", "f", 0.1),
  ]);

  assert.deepEqual(
    picked.map((row) => `${row.label} ${row.section}`),
    ["Job #1 a", "Job #1 b", "Job #1 c", "Job #2 e", "Job #2 f"],
  );
});

test("the reranked order decides, not the order it arrived in", () => {
  // The case this exists for: the section that answers ranks 5th by distance.
  const picked = pickPerDocument([
    candidate("Job #3", "BENEFITS", 0.10),
    candidate("Job #3", "REQUIREMENTS", 0.20),
    candidate("Job #3", "ABOUT", 0.05),
    candidate("Job #3", "COMPANY", 0.04),
    candidate("Job #3", "header, states the location", 0.95),
  ]);

  assert.deepEqual(
    picked.map((row) => row.section),
    ["header, states the location", "REQUIREMENTS", "BENEFITS"],
  );
});

test("the resume's larger allowance survives", () => {
  const picked = pickPerDocument([
    candidate("My resume", "a", 0.4, 4),
    candidate("My resume", "b", 0.3, 4),
    candidate("My resume", "c", 0.2, 4),
    candidate("My resume", "d", 0.1, 4),
    candidate("Job #1", "e", 0.9, 3),
  ]);

  assert.equal(picked.filter((row) => row.label === "My resume").length, 4);
});

test("a document with fewer candidates than budget returns what it has", () => {
  assert.equal(pickPerDocument([candidate("Job #7", "only", 0.5)]).length, 1);
  assert.deepEqual(pickPerDocument([]), []);
});
