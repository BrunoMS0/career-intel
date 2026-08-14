import { LlamaParseReader } from "llama-cloud-services";
// The package root declares ParsingMode but does not export it; the api subpath
// does.
import type { ParsingMode } from "llama-cloud-services/api";

/**
 * Same signature as `extractOrderedText` in ./pdf.ts, so the two are swappable.
 *
 * LlamaParse is a hosted service: the file is uploaded, parsed remotely and
 * returned as markdown, one Document per page. Reading order comes back solved
 * -- which is the whole reason to consider it -- at the cost of a network round
 * trip per ingest and of sending the document to a third party.
 *
 * The API key is read from LLAMA_CLOUD_API_KEY by the reader itself.
 */
export async function extractOrderedText(
  data: Uint8Array,
  filename = "document.pdf",
  mode?: ParsingMode,
): Promise<string> {
  // The default pipeline runs an LLM over each page, which is why it can
  // rewrite content rather than transcribe it. `parse_page_without_llm` is the
  // deterministic layout path.
  const reader = new LlamaParseReader({
    resultType: "markdown",
    language: ["en"],
    ...(mode ? { parse_mode: mode } : {}),
  });
  const pages = await reader.loadDataAsContent(data, filename);
  return pages.map((page) => page.text).join("\n\n");
}

/**
 * How much of the source document's vocabulary survived into the parse.
 *
 * A layout parser reorders glyphs; it does not choose words, so this should sit
 * at 100. LlamaParse writes its markdown with a language model, which is what
 * makes the structure good and also what lets it drop or reword text: on the
 * real corpus Job #1 came back missing the sentence carrying its location
 * requirement, and nothing in the output said so.
 *
 * The comparison runs against unpdf, which reads the text layer verbatim and is
 * therefore the only ground truth available locally. Words shorter than four
 * characters are ignored so ordinary rewording of articles and prepositions
 * does not register as loss.
 */
export function compareFidelity(source: string, output: string) {
  const words = (text: string) =>
    new Set(text.toLowerCase().normalize("NFKC").match(/\p{L}{4,}/gu) ?? []);

  const from = words(source);
  // A scanned PDF has no text layer for unpdf to read, so there is nothing to
  // compare against and nothing to warn about.
  if (from.size === 0) return { kept: 1, missing: [] as string[] };

  const into = words(output);
  const missing = [...from].filter((word) => !into.has(word));
  return { kept: (from.size - missing.length) / from.size, missing };
}
