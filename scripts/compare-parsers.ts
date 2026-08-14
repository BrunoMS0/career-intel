import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { chunkDocument, unlabeledShare, type Chunk } from "../lib/chunk.ts";
import { chunkMarkdown } from "../lib/chunk-markdown.ts";
import { extractOrderedText } from "../lib/pdf.ts";
import { compareFidelity, extractOrderedText as llamaExtract } from "../lib/pdf-llama.ts";

/**
 * Runs both parsers over the same documents and prints what each one produced,
 * so the swap to LlamaParse is decided on the real corpus rather than on the
 * claim in its README.
 *
 *   node --env-file=.env scripts/compare-parsers.ts <file.pdf>...
 *   node --env-file=.env scripts/compare-parsers.ts --sections <file.pdf>...
 *
 * LlamaParse output is cached under .cache/llamaparse so re-runs cost nothing:
 * every call there is an upload and a metered credit.
 */
const CACHE = ".cache/llamaparse";

const args = process.argv.slice(2);
const showSections = args.includes("--sections");
const mode = args.find((arg) => arg.startsWith("--mode="))?.slice(7);
const paths = args.filter((arg) => !arg.startsWith("--"));

if (paths.length === 0) {
  console.error("usage: node --env-file=.env scripts/compare-parsers.ts [--sections] <file.pdf>...");
  process.exit(1);
}

async function llamaCached(path: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const suffix = mode ? `.${mode}` : "";
  const cached = join(CACHE, `${basename(path, ".pdf")}${suffix}.md`);
  if (existsSync(cached)) return readFileSync(cached, "utf8");

  const started = Date.now();
  const text = await llamaExtract(
    new Uint8Array(readFileSync(path)),
    basename(path),
    mode as Parameters<typeof llamaExtract>[2],
  );
  writeFileSync(cached, text);
  console.error(`  parsed ${basename(path)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return text;
}

function summarize(chunks: Chunk[]) {
  const named = [...new Set(chunks.map((c) => c.section))].filter((s) => s !== "Overview");
  return {
    chunks: chunks.length,
    unlabeled: Math.round(unlabeledShare(chunks) * 100),
    sections: named,
  };
}

const rows: string[][] = [];

for (const path of paths) {
  const data = new Uint8Array(readFileSync(path));
  const plain = await extractOrderedText(data);
  const markdown = await llamaCached(path);

  const a = summarize(chunkDocument(plain));
  const b = summarize(chunkMarkdown(markdown));

  // Headings LlamaParse actually emitted, which is not the same as sections
  // carrying text: it flattens every level to `#`, so a real parent like
  // `# Experience` comes back with an empty body and its children as siblings.
  const headings = (markdown.match(/^#{1,6}\s+\S/gm) ?? []).length;

  rows.push([
    basename(path, ".pdf"),
    `${plain.length}`,
    `${a.chunks}`,
    `${a.unlabeled}%`,
    `${a.sections.length}`,
    `${markdown.length}`,
    `${b.chunks}`,
    `${b.unlabeled}%`,
    `${b.sections.length}/${headings}`,
    `${Math.round(compareFidelity(plain, markdown).kept * 100)}%`,
  ]);

  if (showSections) {
    console.log(`\n=== ${basename(path)} ===`);
    console.log(`  unpdf      (${a.sections.length}): ${a.sections.join(" | ") || "-"}`);
    console.log(`  llamaparse (${b.sections.length}):`);
    for (const name of b.sections) console.log(`     # ${name}`);
  }
}

const header = [
  "document", "chars", "chunks", "unlab", "sect",
  "chars", "chunks", "unlab", "sect/head", "kept",
];
const widths = header.map((h, i) =>
  Math.max(h.length, ...rows.map((row) => row[i].length)),
);
const line = (cells: string[]) =>
  cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();

console.log(`\n${" ".repeat(widths[0])}  ${"--- unpdf ---".padEnd(
  widths.slice(1, 5).reduce((sum, w) => sum + w + 2, 0),
)}--- llamaparse ---`);
console.log(line(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of rows) console.log(line(row));
