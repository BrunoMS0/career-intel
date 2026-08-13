import { sql } from "../lib/db.ts";
import { resolveScope, retrieve } from "../lib/retrieval.ts";

/**
 * Shows what a question actually retrieves, and how near each hit was, without
 * calling the chat model. This is the view the answer is built from: if an
 * answer looks wrong, the reason is usually visible here first.
 *
 *   pnpm retrieve "What skills am I missing for Job #4?"
 */
const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error('usage: pnpm retrieve "<question>"');
  process.exit(1);
}

const scope = await resolveScope(question);
const sections = await retrieve(question);

console.log(`question: ${question}`);
console.log(`scope:    ${scope.length ? scope.join(", ") : "all postings (no label named)"}\n`);

console.log("distance  document          section");
for (const section of sections) {
  console.log(
    `  ${section.distance.toFixed(4)}  ${section.label.padEnd(16)}  ${section.section} ` +
      `(${section.content.length} chars)`,
  );
}

const chars = sections.reduce((sum, section) => sum + section.content.length, 0);
console.log(`\n${sections.length} sections, ${chars} chars of context`);

await sql.end();
