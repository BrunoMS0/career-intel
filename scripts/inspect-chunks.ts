import { MAX_CHARS } from "../lib/chunk.ts";
import { sql } from "../lib/db.ts";

/**
 * Lists what is actually indexed, straight from the database. `pnpm inspect`
 * shows how a PDF *would* chunk; this shows how one already did.
 *
 *   pnpm chunks                    every document
 *   pnpm chunks "Job #3"           one document
 *   pnpm chunks "Job #3" --full    with the whole text of each chunk
 */
const args = process.argv.slice(2);
const full = args.includes("--full");
const label = args.filter((arg) => !arg.startsWith("--")).join(" ");

type Row = {
  label: string;
  kind: string;
  section: string;
  position: number;
  content: string;
};

const rows = await sql<Row[]>`
  select d.label, d.kind, c.section, c.position, c.content
  from chunks c
  join documents d on d.id = c.document_id
  ${label ? sql`where d.label = ${label}` : sql``}
  order by d.kind desc, d.label, c.position
`;

if (rows.length === 0) {
  console.error(label ? `no document labelled "${label}"` : "nothing indexed yet");
  process.exit(1);
}

console.log(`chunks are capped at ${MAX_CHARS} chars and never span two sections.`);
console.log("a section longer than the cap becomes several; anything shorter stays whole.\n");

let document = "";
let section = "";

for (const row of rows) {
  if (row.label !== document) {
    document = row.label;
    section = "";
    const own = rows.filter((r) => r.label === document);
    const chars = own.reduce((sum, r) => sum + r.content.length, 0);
    console.log(`\n═══ ${row.label} (${row.kind}) — ${own.length} chunks, ${chars} chars`);
  }

  if (row.section !== section) {
    section = row.section;
    const pieces = rows.filter((r) => r.label === document && r.section === section);
    const chars = pieces.reduce((sum, r) => sum + r.content.length, 0);
    const split = pieces.length > 1 ? `  <- split ${pieces.length} ways, ${chars} chars total` : "";
    console.log(`\n  # ${section}${split}`);
  }

  const body = row.content.replace(/\n+/g, " | ");
  console.log(
    `    [${String(row.position).padStart(2)}] ${String(row.content.length).padStart(4)} chars  ` +
      (full ? "" : body.slice(0, 88)),
  );
  if (full) console.log(row.content.replace(/^/gm, "         ") + "\n");
}

const chars = rows.reduce((sum, row) => sum + row.content.length, 0);
const sizes = rows.map((row) => row.content.length).sort((a, b) => a - b);
console.log(
  `\n${rows.length} chunks, ${chars} chars total. ` +
    `smallest ${sizes[0]}, median ${sizes[Math.floor(sizes.length / 2)]}, largest ${sizes.at(-1)}.`,
);

await sql.end();
