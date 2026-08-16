import { sql } from "../lib/db.ts";
import { RERANK_MODEL } from "../lib/rerank.ts";
import {
  explainRetrieval,
  resolveScope,
  retrieve,
  trim,
  SECTIONS_KEPT,
  TRUST_SCORE,
} from "../lib/retrieval.ts";

/**
 * Shows what a question actually retrieves, and how near each hit was, without
 * calling the chat model. This is the view the answer is built from: if an
 * answer looks wrong, the reason is usually visible here first.
 *
 *   pnpm retrieve "What skills am I missing for Job #4?"
 *   pnpm retrieve --chunks "..."   both stages: every chunk ranked inside its
 *                                  document with the ones kept marked, then the
 *                                  sections they pulled in. The marks come from
 *                                  the same call retrieve() makes, so on a
 *                                  scoped question they show the cross-encoder's
 *                                  choice rather than the distance ranking
 *   pnpm retrieve --rerank "..."   scores the sections that came back and prints
 *                                  the gap between them, so the candidate trim
 *                                  can be judged by eye. Costs one hosted call
 *
 * The two combine.
 */
const args = process.argv.slice(2);
const verbose = args.includes("--chunks");
const reranking = args.includes("--rerank");
const question = args.filter((arg) => !arg.startsWith("--")).join(" ");

if (!question) {
  console.error('usage: pnpm retrieve [--chunks] [--rerank] "<question>"');
  process.exit(1);
}

console.log(`question: ${question}`);

// The scope comes from explainRetrieval when it runs, so the header cannot
// report one the retriever then ignores. Without --chunks it is resolved here,
// which is one local query and no embedding call.
const named = (scope: readonly string[]) =>
  `scope:    ${scope.length ? scope.join(", ") : "all postings (no label named)"}\n`;

if (verbose) {
  const { scope, limits, chunks, reranked } = await explainRetrieval(question);

  console.log(named(scope));
  console.log(
    `${limits.documents} documents in play -> ${limits.perDocument} chunks each ` +
      `(${limits.resume} for the resume, which is one side of every comparison)\n`,
  );

  console.log("STAGE 1 - every chunk ranked within its own document, nearest first");
  console.log(
    reranked
      ? "           -> is what retrieve() keeps. The scope resolved, so a cross-encoder\n" +
          "           reordered the candidates before the budget: the marks do not follow\n" +
          "           the ranking, and a chunk 7th by distance can be kept over a 3rd.\n"
      : "           -> is what retrieve() keeps. Nothing resolved a scope, so the budget\n" +
          "           takes them in distance order and the marks follow the ranking.\n",
  );

  let current = "";
  for (const chunk of chunks) {
    if (chunk.label !== current) {
      current = chunk.label;
      console.log(`  ${chunk.label} (${chunks.filter((c) => c.label === current).length} chunks)`);
    }
    const mark = chunk.picked ? "->" : "  ";
    console.log(
      `  ${mark} #${String(chunk.rank).padStart(2)}  ${chunk.distance.toFixed(4)}  ` +
        `${chunk.section.slice(0, 38).padEnd(38)} pos ${String(chunk.position).padStart(2)}, ${chunk.chars} chars`,
    );
  }

  const hits = chunks.filter((chunk) => chunk.picked);
  const landed = new Set(hits.map((hit) => `${hit.label}|${hit.section}`));
  console.log(`\n  ${hits.length} chunks kept, landing in ${landed.size} distinct sections\n`);
  console.log("STAGE 2 - each section is rejoined whole, siblings of the match included");
  console.log("           a chunk is precise enough to search with, too narrow to answer from\n");
}

if (!verbose) console.log(named(await resolveScope(question)));

const sections = await retrieve(question);
// The trim is a candidate rule, not part of the answer path. --rerank runs it
// here so its scores and its cut can be read, and prints it as what it *would*
// keep rather than as what shipped.
const trimmed = reranking ? await trim(question, sections) : null;

console.log("distance  document          section");
for (const section of sections) {
  console.log(
    `  ${section.distance.toFixed(4)}  ${section.label.padEnd(16)}  ${section.section} ` +
      `(${section.content.length} chars)`,
  );
}

const chars = sections.reduce((sum, section) => sum + section.content.length, 0);
console.log(`\n${sections.length} sections, ${chars} chars of context`);

if (reranking && trimmed?.scores) {
  const ranked = [...trimmed.scores].sort((a, b) => b.score - a.score);
  const top = ranked[0].score;
  const trusted = trimmed.trusted ?? top >= TRUST_SCORE;
  const wouldKeep = new Set(
    trimmed.sections.map((section) => `${section.label} — ${section.section}`),
  );

  console.log(
    `\n\nCROSS-ENCODER (${RERANK_MODEL}) over the ${sections.length} sections above` +
      `\n  candidate rule, not what ships: keep the best ${SECTIONS_KEPT}\n`,
  );
  console.log(
    `  best score ${top.toFixed(4)} ${trusted ? ">=" : "<"} ${TRUST_SCORE}, so the order that would decide is ` +
      `${trusted ? "the cross-encoder's" : "the bi-encoder's distance"}\n`,
  );
  console.log("  keep  #   score    gap      dist   chars  section");
  let running = 0;
  for (const [at, section] of ranked.entries()) {
    const inCut = wouldKeep.has(`${section.label} — ${section.section}`);
    if (inCut) running += section.content.length;
    const gap = at === 0 ? 0 : ranked[at - 1].score - section.score;
    console.log(
      `  ${inCut ? " ok " : "  . "}  ${String(at + 1).padStart(2)}  ${section.score.toFixed(4)}  ` +
        `${at === 0 ? "       " : (gap > 0 ? "-" : " ") + gap.toFixed(4)}  ` +
        `${section.distance.toFixed(4)}  ${String(inCut ? running : 0).padStart(5)}  ${section.label} — ${section.section}`,
    );
  }

  const gaps = ranked.map((s, at) => (at === 0 ? -1 : ranked[at - 1].score - s.score));
  const widest = gaps.indexOf(Math.max(...gaps));
  console.log(
    `\n  widest gap ${Math.max(...gaps).toFixed(4)} between #${widest} and #${widest + 1}` +
      `\n  it would send ${trimmed.sections.length} of ${sections.length} sections, ${running} of ${chars} chars` +
      `\n  measured and not adopted: same evidence 35/45, half the context, 3-4 answers worse`,
  );
} else if (reranking) {
  console.log(`\n\n${sections.length} sections is already at or under the ${SECTIONS_KEPT} the trim keeps, so it does nothing here.`);
}

if (verbose) {
  const [{ total }] = await sql<{ total: number }[]>`
    select sum(length(content))::int as total from documents
  `;
  console.log(`${Math.round((chars / total) * 100)}% of the ${total}-char corpus`);
}

await sql.end();
