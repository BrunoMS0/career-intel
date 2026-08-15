import { createHash } from "node:crypto";
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
// A file rather than a flag value, so the instruction can be edited and rerun
// without quoting a paragraph on a Windows shell.
const promptPath = args.find((arg) => arg.startsWith("--prompt-file="))?.slice(14);

/** `--opt=continuous_mode=true` reaches any of the reader's flags. */
const options: Record<string, unknown> = Object.fromEntries(
  args
    .filter((arg) => arg.startsWith("--opt="))
    // Split on the first "=" only, so a value may contain its own.
    .map((arg) => arg.slice(6))
    .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)])
    .map(([key, value]) => [
      key,
      value === "true" ? true : value === "false" ? false : /^\d+$/.test(value) ? +value : value,
    ]),
);
if (promptPath) options.system_prompt_append = readFileSync(promptPath, "utf8").trim();

const paths = args.filter((arg) => !arg.startsWith("--"));

if (paths.length === 0) {
  console.error("usage: node --env-file=.env scripts/compare-parsers.ts [--sections] <file.pdf>...");
  process.exit(1);
}

async function llamaCached(path: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  // The options are part of the key: without them, changing a flag and
  // rerunning would hand back the parse made under the previous configuration.
  const fingerprint = JSON.stringify(options);
  const suffix =
    (mode ? `.${mode}` : "") +
    (fingerprint === "{}"
      ? ""
      : `.${createHash("sha1").update(fingerprint).digest("hex").slice(0, 8)}`);
  const cached = join(CACHE, `${basename(path, ".pdf")}${suffix}.md`);
  if (existsSync(cached)) return readFileSync(cached, "utf8");

  const started = Date.now();
  const text = await llamaExtract(
    new Uint8Array(readFileSync(path)),
    basename(path),
    mode as Parameters<typeof llamaExtract>[2],
    options,
  );
  // An empty parse is a failed configuration, not a result. Caching it would
  // make the next run look like it reproduced, which is how parse_document_*
  // first read as "consistently empty" instead of "never actually ran".
  if (!text.trim()) {
    console.error(`  ${basename(path)} came back empty under ${mode ?? "the default mode"}`);
    return "";
  }
  writeFileSync(cached, text);
  console.error(`  parsed ${basename(path)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return text;
}

/**
 * What the parse did with the document's structure, which the fidelity check
 * cannot see: it compares vocabulary, and a heading demoted to bold body text
 * loses no words at all. That is not hypothetical -- `parse_page_with_agent`
 * read the whole resume as a single section and still scored 100% kept.
 *
 * `orphans` counts lines that are nothing but an emphasis run: short, bold, on
 * their own. That is what a section label looks like when the parser declined
 * to promote it, and it is the shape the sixth employer came back as while the
 * other five became headings.
 */
function structure(markdown: string) {
  const level = (n: number) =>
    (markdown.match(new RegExp(`^#{${n}}\\s+\\S`, "gm")) ?? []).length;

  const orphans = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(\*{1,3}[^*\n]+\*{1,3}\s*)+$/.test(line) && line.length <= 90).length;

  return { levels: [level(1), level(2), level(3)], orphans };
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

  const { levels, orphans } = structure(markdown);

  rows.push([
    basename(path, ".pdf"),
    `${plain.length}`,
    `${a.chunks}`,
    `${a.unlabeled}%`,
    `${a.sections.length}`,
    `${markdown.length}`,
    `${b.chunks}`,
    `${b.unlabeled}%`,
    `${b.sections.length}`,
    levels.join("/"),
    `${orphans}`,
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
  "chars", "chunks", "unlab", "sect", "h1/h2/h3", "orphan", "kept",
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
