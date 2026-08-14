import { sql } from "../lib/db.ts";
import { explainRetrieval, resolveScope, retrieve } from "../lib/retrieval.ts";

/**
 * Shows what a question actually retrieves, and how near each hit was, without
 * calling the chat model. This is the view the answer is built from: if an
 * answer looks wrong, the reason is usually visible here first.
 *
 *   pnpm retrieve "What skills am I missing for Job #4?"
 *   pnpm retrieve --chunks "..."   both stages: the chunks that matched, then
 *                                  the sections they pulled in
 */
const args = process.argv.slice(2);
const verbose = args.includes("--chunks");
const question = args.filter((arg) => arg !== "--chunks").join(" ");

if (!question) {
  console.error('usage: pnpm retrieve [--chunks] "<question>"');
  process.exit(1);
}

const scope = await resolveScope(question);
console.log(`question: ${question}`);
console.log(`scope:    ${scope.length ? scope.join(", ") : "all postings (no label named)"}\n`);

if (verbose) {
  const { limits, chunks } = await explainRetrieval(question);

  console.log(
    `${limits.documents} documents in play -> ${limits.perDocument} chunks each ` +
      `(${limits.resume} for the resume, which is one side of every comparison)\n`,
  );

  console.log("STAGE 1 - every chunk ranked within its own document");
  console.log("           the marked ones are inside the budget and become search hits\n");

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
  const sections = new Set(hits.map((hit) => `${hit.label}|${hit.section}`));
  console.log(
    `\n  ${hits.length} chunks matched, landing in ${sections.size} distinct sections\n`,
  );
  console.log("STAGE 2 - each section is rejoined whole, siblings of the match included");
  console.log("           a chunk is precise enough to search with, too narrow to answer from\n");
}

const sections = await retrieve(question);

console.log("distance  document          section");
for (const section of sections) {
  console.log(
    `  ${section.distance.toFixed(4)}  ${section.label.padEnd(16)}  ${section.section} ` +
      `(${section.content.length} chars)`,
  );
}

const chars = sections.reduce((sum, section) => sum + section.content.length, 0);
console.log(`\n${sections.length} sections, ${chars} chars of context`);

if (verbose) {
  const [{ total }] = await sql<{ total: number }[]>`
    select sum(length(content))::int as total from documents
  `;
  console.log(`${Math.round((chars / total) * 100)}% of the ${total}-char corpus`);
}

await sql.end();
