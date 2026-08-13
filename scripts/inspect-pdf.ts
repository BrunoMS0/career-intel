import { readFileSync } from "node:fs";
import { chunkDocument } from "../lib/chunk.ts";
import { extractOrderedText } from "../lib/pdf.ts";

/**
 * Shows how a PDF parses and chunks without indexing it, so a new document can
 * be checked for missed section headings before spending an embedding call.
 *
 *   pnpm inspect path/to/file.pdf         chunk summary
 *   pnpm inspect path/to/file.pdf --text  the reordered text it was built from
 */
const [path, flag] = process.argv.slice(2);
if (!path) {
  console.error("usage: pnpm inspect <file.pdf> [--text]");
  process.exit(1);
}

const text = await extractOrderedText(new Uint8Array(readFileSync(path)));

if (flag === "--text") {
  text.split("\n").forEach((line, i) => console.log(`${String(i).padStart(3)}| ${line}`));
  process.exit(0);
}

const chunks = chunkDocument(text);
console.log(`${text.length} chars -> ${chunks.length} chunks\n`);
for (const chunk of chunks) {
  const preview = chunk.content.replace(/\n/g, " | ").slice(0, 70);
  console.log(`[${chunk.position}] ${chunk.section} (${chunk.content.length}): ${preview}`);
}
