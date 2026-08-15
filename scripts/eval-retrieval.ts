import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "../lib/db.ts";
import { embedForQuery, toVector } from "../lib/embedding.ts";
import { WEAK_DISTANCE } from "../lib/guardrail.ts";
import {
  CANDIDATES_PER_DOCUMENT,
  passageFor,
  RERANK_MODEL,
  scorePassages,
} from "../lib/rerank.ts";
import {
  CHUNKS_PER_DOCUMENT,
  MAX_FOCUSED_DOCUMENTS,
  RESUME_CHUNKS,
  resolveScope,
  retrieve,
} from "../lib/retrieval.ts";

/**
 * Measures retrieval alone: which sections a question pulls in, how near they
 * are, and what the guardrail decides. No chat model is involved, because a
 * wrong answer has two possible causes and only one of them lives here -- the
 * section holding the fact never reached the context. The other cause, a model
 * that had the fact and answered around it, is the other harness.
 *
 * Every distance is measured once and cached in eval/distances.json. Candidate
 * retrieval rules are then arithmetic over that file: no re-embedding, and two
 * rules compared on the same numbers instead of two runs of a hosted service
 * that need not agree. Rerunning after an interruption only embeds what is
 * missing, which is the difference between a pass that finishes and one that
 * does not.
 *
 *   pnpm eval           report over the cached snapshot, embedding what is new
 *   pnpm eval --verbose per-question detail, not just the failures
 */

const QUESTIONS = "eval/questions.json";
const SNAPSHOT = "eval/distances.json";
/**
 * Cross-encoder scores, cached the same way and for the same reason as the
 * distances: they cost a hosted call, they are the same for every replay, and
 * a rule that needs 200 requests to evaluate does not get evaluated twice.
 */
const RERANKED = "eval/rerank.json";
const SEPARATOR = " — ";

type Question = {
  id: string;
  q: string;
  class: "answerable" | "absent" | "domain" | "unrelated" | "injection";
  /**
   * The best hit measured when the corpus was last rebaselined. Absent on a
   * question added since, which prints its measured value so it can be written
   * back. A corpus change invalidates all of them at once.
   */
  recorded?: number;
  scope: string[];
  refuse: boolean;
  evidence: string[];
  coverage: string[];
  why: string;
};

/** One indexed chunk, in a fixed order so distance arrays can align to it. */
type Chunk = {
  label: string;
  kind: string;
  section: string;
  position: number;
  chars: number;
};

type Snapshot = {
  /** Order is the contract: distances[id][i] belongs to chunks[i]. */
  chunks: Chunk[];
  distances: Record<string, number[]>;
  /** What resolveScope() found, recorded so the filter can be replayed offline. */
  scope: Record<string, string[]>;
};

/**
 * The budget comes from lib/retrieval.ts rather than being restated here. The
 * ranking below is a reimplementation and has to be; the constants are not, and
 * a copy of them would drift silently on the first tuning pass.
 */
const BUDGET = {
  ...CHUNKS_PER_DOCUMENT,
  resume: RESUME_CHUNKS,
  maxFocusedDocuments: MAX_FOCUSED_DOCUMENTS,
};

const verbose = process.argv.includes("--verbose");
/**
 * Measures the cross-encoder as a *candidate* rule, replayed over the same
 * snapshot as the current one, so the two are compared on identical numbers and
 * nothing is wired into the app before it has earned it.
 */
const reranking = process.argv.includes("--rerank");
const questions: Question[] = JSON.parse(readFileSync(QUESTIONS, "utf8"));

// ---------------------------------------------------------------- the snapshot

const chunks = await sql<Chunk[]>`
  select d.label, d.kind, c.section, c.position, length(c.content)::int as chars
  from chunks c join documents d on d.id = c.document_id
  order by d.label, c.position
`;

const snapshot: Snapshot = existsSync(SNAPSHOT)
  ? JSON.parse(readFileSync(SNAPSHOT, "utf8"))
  : { chunks: [...chunks], distances: {}, scope: {} };

// A re-ingested corpus invalidates every cached distance, and silently: the
// numbers still parse, they just describe chunks that no longer exist.
if (snapshot.chunks.length !== chunks.length) {
  console.error(
    `snapshot holds ${snapshot.chunks.length} chunks, the database has ${chunks.length}.\n` +
      `the corpus changed -- delete ${SNAPSHOT} and measure again.`,
  );
  process.exit(1);
}

const pending = questions.filter((question) => !snapshot.distances[question.id]);
if (pending.length > 0) {
  console.log(`measuring ${pending.length} of ${questions.length} questions\n`);
}

for (const [index, question] of pending.entries()) {
  try {
    const vector = toVector(await embedForQuery(question.q));
    const distances = await sql<{ d: number }[]>`
      select (c.embedding <=> ${vector})::float8 as d
      from chunks c join documents d on d.id = c.document_id
      order by d.label, c.position
    `;
    snapshot.distances[question.id] = distances.map((row) => Number(row.d.toFixed(6)));
    // Written after every question, not at the end: an interrupted run keeps
    // what it paid for and the next one resumes instead of starting over.
    writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 1));
    console.log(`  ${String(index + 1).padStart(2)}/${pending.length}  ${question.id}`);
  } catch (error) {
    console.error(
      `\nstopped at ${question.id} after ${index} of ${pending.length}: ` +
        `${error instanceof Error ? error.message : error}\n` +
        `${Object.keys(snapshot.distances).length} questions cached. rerun to continue.`,
    );
    await sql.end();
    process.exit(1);
  }
}

// Scope is remeasured every run, unlike the distances above. It costs one local
// query and no embedding call, and caching it is exactly how a change to
// resolveScope would go unnoticed: the numbers would still parse, they would
// just describe the rule that used to run. Phase 7 changed that rule.
for (const question of questions) {
  snapshot.scope[question.id] = await resolveScope(question.q);
}
writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 1));

// -------------------------------------------------------------- the rerank pass

/** Scores aligned to snapshot.chunks, null for anything the net did not reach. */
type Reranked = { model: string; scores: Record<string, (number | null)[]> };

const reranks: Reranked = existsSync(RERANKED)
  ? JSON.parse(readFileSync(RERANKED, "utf8"))
  : { model: RERANK_MODEL, scores: {} };

/**
 * The wide net: the bi-encoder's top CANDIDATES_PER_DOCUMENT per document, as
 * indices into snapshot.chunks. This is what the cross-encoder gets to reorder,
 * and it is computed here rather than in SQL so the offline replay and the
 * measurement see exactly the same set.
 */
function candidatesFor(question: Question): number[] {
  const scope = snapshot.scope[question.id] ?? [];
  const distances = snapshot.distances[question.id];
  const rows = snapshot.chunks
    .map((chunk, index) => ({ ...chunk, index, distance: distances[index] }))
    .filter(
      (chunk) => chunk.kind === "resume" || scope.length === 0 || scope.includes(chunk.label),
    );

  return [...new Set(rows.map((row) => row.label))].flatMap((label) =>
    rows
      .filter((row) => row.label === label)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, CANDIDATES_PER_DOCUMENT)
      .map((row) => row.index),
  );
}

if (reranking) {
  if (reranks.model !== RERANK_MODEL) {
    console.error(
      `cached scores are from ${reranks.model}, this run is ${RERANK_MODEL}.\n` +
        `delete ${RERANKED} and measure again.`,
    );
    await sql.end();
    process.exit(1);
  }

  // The passage text lives in the database, not in the snapshot, which only
  // keeps section names and lengths.
  const contents = await sql<{ content: string }[]>`
    select c.content from chunks c join documents d on d.id = c.document_id
    order by d.label, c.position
  `;

  const owed = questions.filter((question) => !reranks.scores[question.id]);
  if (owed.length > 0) console.log(`\nreranking ${owed.length} of ${questions.length} questions\n`);

  for (const [index, question] of owed.entries()) {
    const candidates = candidatesFor(question);
    try {
      const scored = await scorePassages(
        question.q,
        candidates.map((i) =>
          passageFor({ section: snapshot.chunks[i].section, content: contents[i].content }),
        ),
      );
      const aligned: (number | null)[] = snapshot.chunks.map(() => null);
      candidates.forEach((chunk, at) => (aligned[chunk] = scored[at]));
      reranks.scores[question.id] = aligned;
      writeFileSync(RERANKED, JSON.stringify(reranks, null, 1));
      console.log(
        `  ${String(index + 1).padStart(2)}/${owed.length}  ${question.id.padEnd(26)}` +
          `${candidates.length} passages`,
      );
    } catch (error) {
      console.error(
        `\nstopped at ${question.id} after ${index} of ${owed.length}: ` +
          `${error instanceof Error ? error.message : error}\n` +
          `${Object.keys(reranks.scores).length} questions cached. rerun to continue.`,
      );
      await sql.end();
      process.exit(1);
    }
  }
}

// ------------------------------------------------------------- the current rule

type Picked = { label: string; section: string; distance: number; chars: number };

/**
 * The sections a question retrieves, replayed from the snapshot.
 *
 * This mirrors the SQL in lib/retrieval.ts rather than calling it, so a
 * candidate rule can be compared against the current one on identical numbers.
 * A mirror that drifts measures nothing, so `pnpm eval` checks it against the
 * real retrieve() before reporting anything.
 */
function pick(question: Question, band?: number, reranked = false): Picked[] {
  const scope = snapshot.scope[question.id] ?? [];
  const inPlay = (chunk: Chunk) =>
    chunk.kind === "resume" || scope.length === 0 || scope.includes(chunk.label);

  const distances = snapshot.distances[question.id];
  const rows = snapshot.chunks
    .map((chunk, index) => ({ ...chunk, index, distance: distances[index] }))
    .filter(inPlay);

  const documents = new Set(rows.map((row) => row.label));
  const perDocument =
    documents.size > BUDGET.maxFocusedDocuments ? BUDGET.broad : BUDGET.focused;

  const best = Math.min(...rows.map((row) => row.distance));
  const scores = reranked ? reranks.scores[question.id] : undefined;
  const hits = [...documents].flatMap((label) => {
    const own = rows
      .filter((row) => row.label === label)
      .sort((a, b) => a.distance - b.distance);
    const allowance = own[0].kind === "resume" ? BUDGET.resume : perDocument;
    if (scores) {
      // The wide net first, then the cross-encoder's order inside it, then the
      // same budget. The budget never moves -- only which chunks fill it.
      return own
        .slice(0, CANDIDATES_PER_DOCUMENT)
        .sort((a, b) => (scores[b.index] ?? -1) - (scores[a.index] ?? -1))
        .slice(0, allowance);
    }
    return band === undefined
      ? own.slice(0, allowance)
      : own.filter((row) => row.distance <= best + band);
  });

  // Parent expansion: the chunk is the key, the whole section is the payload.
  const sections = new Map<string, Picked>();
  for (const hit of hits) {
    const key = `${hit.label}${SEPARATOR}${hit.section}`;
    const chars = snapshot.chunks
      .filter((chunk) => chunk.label === hit.label && chunk.section === hit.section)
      .reduce((sum, chunk) => sum + chunk.chars, 0);
    const seen = sections.get(key);
    if (!seen || hit.distance < seen.distance) {
      sections.set(key, {
        label: hit.label,
        section: hit.section,
        distance: hit.distance,
        chars,
      });
    }
  }
  return [...sections.values()].sort((a, b) => a.distance - b.distance);
}

const bestHit = (question: Question) => {
  const scope = snapshot.scope[question.id] ?? [];
  const distances = snapshot.distances[question.id];
  return Math.min(
    ...snapshot.chunks
      .map((chunk, index) => ({ chunk, distance: distances[index] }))
      .filter(
        ({ chunk }) =>
          chunk.kind === "resume" || scope.length === 0 || scope.includes(chunk.label),
      )
      .map(({ distance }) => distance),
  );
};

// --------------------------------------------------- is the mirror still honest

// Three shapes, because the budget branches on how many documents are in play
// and scope now resolves two different ways: a question naming a posting by its
// label, one naming none, and one naming a company. The third is the phase 7
// path -- without it the mirror would agree with the SQL while never running the
// rule that changed.
const mirrored: string[] = [];
for (const id of ["pay-job2", "best-fit", "title-afficiency"]) {
  const question = questions.find((entry) => entry.id === id)!;
  const real = (await retrieve(question.q))
    .map((section) => `${section.label}${SEPARATOR}${section.section}`)
    .sort();
  const replayed = pick(question)
    .map((section) => `${section.label}${SEPARATOR}${section.section}`)
    .sort();
  const same = real.length === replayed.length && real.every((s, i) => s === replayed[i]);
  mirrored.push(
    `  ${same ? "ok  " : "DIFF"}  ${id.padEnd(10)} ${real.length} sections from the database, ` +
      `${replayed.length} replayed`,
  );
  if (!same && verbose) {
    mirrored.push(`        database: ${real.join(", ")}`);
    mirrored.push(`        replayed: ${replayed.join(", ")}`);
  }
}

console.log("\nMIRROR — the offline rule against the one that actually runs");
console.log(mirrored.join("\n"));

// ------------------------------------------------------------------- the report

console.log("\n\nDRIFT — measured best hit against the recorded baseline\n");
let worst = { id: "", delta: 0 };
for (const question of questions) {
  // Questions added after phase 4 have nothing to drift from. Their measured
  // distance is printed once so it can be written back as their baseline.
  if (question.recorded === undefined) {
    console.log(`  ${question.id.padEnd(20)} no baseline yet, measures ${bestHit(question).toFixed(4)}`);
    continue;
  }
  const delta = Math.abs(bestHit(question) - question.recorded);
  if (delta > worst.delta) worst = { id: question.id, delta };
  if (verbose || delta > 0.001) {
    console.log(
      `  ${question.id.padEnd(20)} recorded ${question.recorded.toFixed(4)}  ` +
        `now ${bestHit(question).toFixed(4)}  delta ${delta.toFixed(4)}`,
    );
  }
}
console.log(
  worst.delta > 0.001
    ? `  largest drift ${worst.delta.toFixed(4)} on ${worst.id} -- the baseline moved`
    : `  every question within 0.0010 of its recorded value (largest ${worst.delta.toFixed(4)})`,
);

console.log(`\n\nGUARDRAIL — the ${WEAK_DISTANCE} threshold against what each question expects\n`);
const wrong = questions.filter((question) => bestHit(question) > WEAK_DISTANCE !== question.refuse);
for (const klass of ["answerable", "absent", "domain", "unrelated", "injection"]) {
  const group = questions.filter((question) => question.class === klass);
  const refused = group.filter((question) => bestHit(question) > WEAK_DISTANCE);
  const expected = group.filter((question) => question.refuse);
  console.log(
    `  ${klass.padEnd(12)} ${String(group.length).padStart(2)} questions   ` +
      `refused ${refused.length}, expected ${expected.length}   ` +
      `best hits ${Math.min(...group.map(bestHit)).toFixed(4)} to ${Math.max(...group.map(bestHit)).toFixed(4)}`,
  );
}
console.log(
  wrong.length === 0
    ? `\n  every question falls on the side it should`
    : `\n  ${wrong.length} on the wrong side: ${wrong.map((question) => question.id).join(", ")}`,
);

const answerableCeiling = Math.max(
  ...questions.filter((question) => !question.refuse).map(bestHit),
);
const refusedFloor = Math.min(...questions.filter((question) => question.refuse).map(bestHit));
console.log(
  `  band between the two: ${answerableCeiling.toFixed(4)} to ${refusedFloor.toFixed(4)}` +
    ` (${(refusedFloor - answerableCeiling).toFixed(4)} wide, threshold sits at ${WEAK_DISTANCE})`,
);

console.log("\n\nEVIDENCE — did the section holding the answer get retrieved\n");
let found = 0;
let expectedTotal = 0;
for (const question of questions.filter((entry) => entry.evidence.length > 0)) {
  const retrieved = new Set(
    pick(question).map((section) => `${section.label}${SEPARATOR}${section.section}`),
  );
  const missing = question.evidence.filter((section) => !retrieved.has(section));
  found += question.evidence.length - missing.length;
  expectedTotal += question.evidence.length;
  if (verbose || missing.length > 0) {
    console.log(
      `  ${missing.length === 0 ? "ok  " : "MISS"}  ${question.id.padEnd(20)} ` +
        `${question.evidence.length - missing.length}/${question.evidence.length}` +
        (missing.length > 0 ? `   missing: ${missing.join(", ")}` : ""),
    );
  }
}
console.log(`  ${found}/${expectedTotal} expected sections retrieved`);

console.log("\n\nCOVERAGE — did every document a question needs contribute something\n");
for (const question of questions.filter((entry) => entry.coverage.length > 0)) {
  const seen = new Set(pick(question).map((section) => section.label));
  const missing = question.coverage.filter((label) => !seen.has(label));
  if (verbose || missing.length > 0) {
    console.log(
      `  ${missing.length === 0 ? "ok  " : "MISS"}  ${question.id.padEnd(20)} ` +
        `${question.coverage.length - missing.length}/${question.coverage.length}` +
        (missing.length > 0 ? `   missing: ${missing.join(", ")}` : ""),
    );
  }
}
const uncovered = questions
  .filter((question) => question.coverage.length > 0)
  .filter((question) => {
    const seen = new Set(pick(question).map((section) => section.label));
    return question.coverage.some((label) => !seen.has(label));
  });
console.log(
  uncovered.length === 0
    ? `  every question saw every document it needs`
    : `  ${uncovered.length} questions short: ${uncovered.map((q) => q.id).join(", ")}`,
);

const contexts = questions
  .filter((question) => !question.refuse)
  .map((question) => pick(question).reduce((sum, section) => sum + section.chars, 0));
console.log(
  `\n  context sent to the model: ${Math.min(...contexts)} to ${Math.max(...contexts)} chars, ` +
    `median ${contexts.sort((a, b) => a - b)[Math.floor(contexts.length / 2)]}`,
);

// ------------------------------------------------- decision 1: does spread cut

/**
 * How flat the document owning the nearest chunk went, exactly as the chat route
 * logs it in query_logs.doc_spread. The claim under test: a document with
 * nothing to say about a question answers it uniformly badly, so its chunks
 * bunch together, while a document that holds the answer separates.
 */
function spreadOf(question: Question): number {
  const scope = snapshot.scope[question.id] ?? [];
  const distances = snapshot.distances[question.id];
  const rows = snapshot.chunks
    .map((chunk, index) => ({ ...chunk, distance: distances[index] }))
    .filter(
      (chunk) => chunk.kind === "resume" || scope.length === 0 || scope.includes(chunk.label),
    );
  const nearest = rows.reduce((best, row) => (row.distance < best.distance ? row : best));
  const own = rows.filter((row) => row.label === nearest.label).map((row) => row.distance);
  return Math.max(...own) - Math.min(...own);
}

console.log("\n\nSPREAD — decision 1: does document flatness earn a threshold of its own\n");
console.log(`  Only the questions the ${WEAK_DISTANCE} threshold already lets through: the rest`);
console.log("  are refused on distance and a second rule cannot improve on that.\n");

const passing = questions
  .filter((question) => bestHit(question) <= WEAK_DISTANCE)
  .map((question) => ({ question, spread: spreadOf(question) }))
  .sort((a, b) => a.spread - b.spread);

for (const { question, spread } of passing) {
  console.log(
    `  ${spread.toFixed(4)}  ${question.class.padEnd(11)} ${question.scope.length ? "scoped  " : "unscoped"} ` +
      `${question.id}`,
  );
}

/**
 * A cutoff would refuse anything flatter than itself. Two numbers decide it:
 * how much can be caught while refusing no answerable question, and what
 * refusing every unanswerable one would cost.
 */
function verdict(label: string, group: typeof passing) {
  const absent = group.filter((row) => row.question.class === "absent");
  const answerable = group.filter((row) => row.question.class === "answerable");
  if (absent.length === 0 || answerable.length === 0) return;

  const safest = Math.min(...answerable.map((row) => row.spread));
  const free = absent.filter((row) => row.spread < safest);
  const needed = Math.max(...absent.map((row) => row.spread));
  const cost = answerable.filter((row) => row.spread < needed);

  console.log(`\n  ${label}: ${answerable.length} answerable, ${absent.length} unanswerable`);
  console.log(
    `    flattest answerable is ${safest.toFixed(4)} (${
      answerable.find((row) => row.spread === safest)!.question.id
    }), so a free cutoff catches ` +
      `${free.length}/${absent.length}${free.length ? `: ${free.map((r) => r.question.id).join(", ")}` : ""}`,
  );
  console.log(
    `    catching all ${absent.length} needs ${needed.toFixed(4)} (${
      absent.find((row) => row.spread === needed)!.question.id
    }), which refuses ` +
      `${cost.length} answerable${cost.length ? `: ${cost.map((r) => r.question.id).join(", ")}` : ""}`,
  );
}

verdict("all passing questions", passing);
verdict(
  "scoped only, where one document dominates",
  passing.filter((row) => row.question.scope.length > 0),
);

// ------------------------------------- decision 2: does a cross-encoder reorder

if (reranking) {
  console.log(`\n\nRERANK — ${RERANK_MODEL} over the top ${CANDIDATES_PER_DOCUMENT} per document\n`);

  const withEvidence = questions.filter((question) => question.evidence.length > 0);
  const key = (section: Picked) => `${section.label}${SEPARATOR}${section.section}`;
  const found = (question: Question, on: boolean) => {
    const got = new Set(pick(question, undefined, on).map(key));
    return question.evidence.filter((section) => got.has(section));
  };

  let before = 0;
  let after = 0;
  for (const question of withEvidence) {
    const was = found(question, false);
    const now = found(question, true);
    before += was.length;
    after += now.length;
    const won = now.filter((section) => !was.includes(section));
    const lost = was.filter((section) => !now.includes(section));
    if (verbose || won.length > 0 || lost.length > 0) {
      console.log(
        `  ${won.length > lost.length ? " +  " : lost.length > won.length ? " -  " : "    "}` +
          `${question.id.padEnd(26)} ${was.length}/${question.evidence.length} -> ` +
          `${now.length}/${question.evidence.length}` +
          (won.length ? `   won ${won.join(", ")}` : "") +
          (lost.length ? `   lost ${lost.join(", ")}` : ""),
      );
    }
  }
  const total = withEvidence.reduce((sum, question) => sum + question.evidence.length, 0);
  console.log(`\n  evidence ${before}/${total} -> ${after}/${total}`);

  // The falsifiable part. These four survived every index-level change measured
  // -- finer chunks, identity in the embedding, normalised section tags -- and
  // were each traced to rank 5-8 inside their own document. They are what the
  // ordering diagnosis predicts a cross-encoder recovers. If they do not move,
  // the diagnosis was wrong and something else is going on.
  const PREDICTED: [string, string][] = [
    ["fit-job7", "Job #7 — REQUIRED EXPERIENCE"],
    ["missing-job3", "Job #3 — QUALIFICATIONS"],
    ["remote-jobs", "Job #2 — Mid-Level AI Product / Creative-Tools Engineer"],
    ["align-job5", "My resume — TECHNICAL SKILLS"],
  ];
  console.log("\n  the four the ordering diagnosis predicts\n");
  for (const [id, section] of PREDICTED) {
    const question = questions.find((entry) => entry.id === id)!;
    const got = new Set(pick(question, undefined, true).map(key));
    console.log(`    ${got.has(section) ? "recovered" : "still out"}  ${id.padEnd(14)} ${section}`);
  }

  const shortfall = questions
    .filter((question) => question.coverage.length > 0)
    .filter((question) => {
      const seen = new Set(pick(question, undefined, true).map((section) => section.label));
      return question.coverage.some((label) => !seen.has(label));
    });
  console.log(
    `\n  coverage: ${
      shortfall.length === 0
        ? "still complete"
        : `${shortfall.length} short -- ${shortfall.map((q) => q.id).join(", ")}`
    }`,
  );

  // The guardrail reads the nearest *returned* section, so reranking a chunk out
  // of the budget could raise it and refuse a question the threshold passes
  // today. This is the check for that, and it is why the app keeps the
  // bi-encoder distance on the section rather than the cross-encoder's score.
  const nearest = (question: Question, on: boolean) =>
    Math.min(...pick(question, undefined, on).map((section) => section.distance));
  const moved = questions.filter(
    (question) => Math.abs(nearest(question, false) - nearest(question, true)) > 0.00005,
  );
  const flipped = moved.filter(
    (question) =>
      nearest(question, false) > WEAK_DISTANCE !== (nearest(question, true) > WEAK_DISTANCE),
  );
  console.log(
    `  guardrail: nearest returned section moved on ${moved.length} of ${questions.length} questions, ` +
      `${flipped.length} would change side`,
  );
  for (const question of moved) {
    console.log(
      `    ${question.id.padEnd(26)} ${nearest(question, false).toFixed(4)} -> ${nearest(question, true).toFixed(4)}`,
    );
  }

  const chars = (on: boolean) =>
    questions
      .filter((question) => !question.refuse)
      .map((question) =>
        pick(question, undefined, on).reduce((sum, section) => sum + section.chars, 0),
      );
  const mean = (values: number[]) =>
    Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  console.log(`  context: ${mean(chars(false))} -> ${mean(chars(true))} chars on average`);
}

await sql.end();
