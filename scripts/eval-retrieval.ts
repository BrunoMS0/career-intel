import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "../lib/db.ts";
import { embedForQuery, toVector } from "../lib/embedding.ts";
import { WEAK_DISTANCE } from "../lib/guardrail.ts";
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
    snapshot.scope[question.id] = await resolveScope(question.q);
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
function pick(question: Question, band?: number): Picked[] {
  const scope = snapshot.scope[question.id] ?? [];
  const inPlay = (chunk: Chunk) =>
    chunk.kind === "resume" || scope.length === 0 || scope.includes(chunk.label);

  const distances = snapshot.distances[question.id];
  const rows = snapshot.chunks
    .map((chunk, index) => ({ ...chunk, distance: distances[index] }))
    .filter(inPlay);

  const documents = new Set(rows.map((row) => row.label));
  const perDocument =
    documents.size > BUDGET.maxFocusedDocuments ? BUDGET.broad : BUDGET.focused;

  const best = Math.min(...rows.map((row) => row.distance));
  const hits = [...documents].flatMap((label) => {
    const own = rows
      .filter((row) => row.label === label)
      .sort((a, b) => a.distance - b.distance);
    const allowance = own[0].kind === "resume" ? BUDGET.resume : perDocument;
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

// Two shapes, because the budget branches on how many documents are in play:
// one question naming a posting, one naming none.
const mirrored: string[] = [];
for (const id of ["pay-job2", "best-fit"]) {
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

await sql.end();
