import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sql } from "../lib/db.ts";
import { extractDocument, EXTRACT_TIER, profileExcerpt } from "../lib/extract.ts";

/**
 * Fills documents.profile and documents.extract for what is already indexed.
 *
 * Ingest does this for new uploads; this exists for the corpus that predates it,
 * and as the way to redo one document after the schema in lib/extract.ts
 * changes. Idempotent by default -- a document that already has a profile is
 * skipped, so an interrupted run resumes and a finished one costs nothing.
 *
 *   pnpm profiles <dir>            fill whatever is missing
 *   pnpm profiles <dir> --force    redo everything
 *   pnpm profiles <dir> "Job #3"   redo one document
 *
 * The PDFs are not in the database -- only their filenames are -- so the
 * directory holding them has to be passed in.
 */

const args = process.argv.slice(2);
const force = args.includes("--force");
const positional = args.filter((arg) => !arg.startsWith("--"));
const [directory, only] = positional;

if (!directory) {
  console.error(
    'usage: pnpm profiles <directory-of-pdfs> ["Job #3"] [--force]\n' +
      "the database stores filenames, not files, so the directory has to be given.",
  );
  process.exit(1);
}

const documents = await sql<
  { id: string; label: string; kind: "resume" | "job"; filename: string; profile: string | null }[]
>`select id, label, kind, filename, profile from documents order by label`;

const owed = documents
  .filter((document) => !only || document.label === only)
  .filter((document) => force || only || !document.profile);

if (owed.length === 0) {
  console.log(`nothing to do: ${documents.length} documents, all extracted`);
  await sql.end();
  process.exit(0);
}

console.log(`extracting ${owed.length} of ${documents.length} documents, tier ${EXTRACT_TIER}\n`);

let failed = 0;
for (const document of owed) {
  const path = `${directory.replace(/[\\/]$/, "")}/${basename(document.filename)}`;
  try {
    const file = readFileSync(path);
    const { extract, profile, version } = await extractDocument(
      new Uint8Array(file),
      basename(document.filename),
      document.kind,
    );
    await sql`
      update documents set profile = ${profile}, extract = ${sql.json(extract as never)}
      where id = ${document.id}
    `;
    const rendered = profileExcerpt(extract, profile) ?? "";
    console.log(
      `  ok    ${document.label.padEnd(10)} ${String(rendered.length).padStart(4)} chars` +
        `${version ? `  v${version}` : ""}  ${profile?.slice(0, 60) ?? "(no profile)"}`,
    );
  } catch (error) {
    failed++;
    // Reported, not fatal: every other document is still worth extracting, and
    // a document with no profile falls back to its sections rather than
    // disappearing from an answer.
    console.error(`  FAIL  ${document.label.padEnd(10)} ${error instanceof Error ? error.message : error}`);
  }
}

const after = await sql<{ label: string; chars: number }[]>`
  select label, coalesce(length(profile), 0)::int as chars from documents
  where kind = 'job' and profile is not null order by label
`;
const total = after.reduce((sum, row) => sum + row.chars, 0);
console.log(
  `\n${after.length} postings carry a profile, ${total} chars in total ` +
    `(${after.length ? Math.round(total / after.length) : 0} each)`,
);
if (failed > 0) console.log(`${failed} failed; those documents still answer from their sections.`);

await sql.end();
