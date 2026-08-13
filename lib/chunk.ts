export type Chunk = {
  section: string;
  position: number;
  content: string;
};

/** Roughly 300 tokens at ~4 chars per token. Sections above this get split. */
const MAX_CHARS = 1200;
/** A trailing piece shorter than this is folded back instead of standing alone. */
const MIN_CHARS = 120;
/** Section for text that appears before the first heading, or when none exist. */
const OVERVIEW = "Overview";

/**
 * Headings that appear verbatim in most English resumes and job postings.
 * Anything outside this list is caught by the shape check in `isHeading`.
 */
const KNOWN_HEADINGS =
  /^(work |professional )?(experience|employment|education|skills|technical skills|projects|certifications|publications|awards|languages|summary|profile|objective|about|responsibilities|requirements|qualifications|what you'?ll do|what we'?re looking for|benefits|perks|nice to have|compensation|contact)\b/i;

function isHeading(line: string, next: string | undefined): boolean {
  const text = line.trim().replace(/[:\s]+$/, "");
  if (!text || text.length > 60) return false;
  // A heading introduces something. A short line closing a page does not.
  if (!next?.trim()) return false;
  if (/[.,;]$/.test(text)) return false;

  if (KNOWN_HEADINGS.test(text)) return true;

  // Shape fallback for headings we have no vocabulary for, including other
  // languages ("EXPERIENCIA LABORAL"). Caps only, deliberately: title case is
  // how resumes write job titles and company names, so accepting it would
  // shred the Experience section into one section per employer.
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length >= 3 && letters === letters.toUpperCase();
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cuts an oversized section at its natural seams: blank lines first, then line
 * breaks, then sentences, and only as a last resort mid-text.
 *
 * ponytail: no overlap. Overlap exists to repair a cut made mid-thought, and
 * every seam used here is already a paragraph or bullet boundary. Revisit if
 * the eval harness shows answers missing evidence that sits at a boundary.
 */
function splitBySize(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const units = text
    .split(/\n{2,}/)
    .flatMap((block) => (block.length <= MAX_CHARS ? [block] : block.split("\n")))
    .flatMap((line) => (line.length <= MAX_CHARS ? [line] : hardWrap(line)));

  const pieces: string[] = [];
  let buffer = "";
  for (const unit of units) {
    if (!unit.trim()) continue;
    const candidate = buffer ? `${buffer}\n${unit}` : unit;
    if (candidate.length > MAX_CHARS && buffer) {
      pieces.push(buffer);
      buffer = unit;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) pieces.push(buffer);

  // A short tail on its own carries no retrievable meaning. Fold it back, which
  // can push that piece up to MIN_CHARS past the limit -- cheaper than indexing
  // a 60-character orphan that matches nothing.
  if (pieces.length > 1 && pieces[pieces.length - 1].length < MIN_CHARS) {
    const tail = pieces.pop()!;
    pieces[pieces.length - 1] += `\n${tail}`;
  }
  return pieces;
}

function hardWrap(line: string): string[] {
  const sentences = line.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [line];
  return sentences.flatMap((sentence) => {
    const trimmed = sentence.trim();
    if (trimmed.length <= MAX_CHARS) return [trimmed];
    const out: string[] = [];
    for (let i = 0; i < trimmed.length; i += MAX_CHARS) {
      out.push(trimmed.slice(i, i + MAX_CHARS));
    }
    return out;
  });
}

/**
 * Splits a document along its own headings, then by size within each section.
 *
 * Structure-first rather than fixed-size, because in this domain the heading is
 * semantic, not decorative: "5+ years of React" means the job wants it under
 * REQUIREMENTS and that the candidate has it under EXPERIENCE. A chunk that
 * loses its heading is genuinely ambiguous.
 *
 * When no headings are detected -- a two-column PDF whose columns interleave,
 * for example -- every line lands in one Overview section and the size split
 * below is what runs. That degradation to plain recursive chunking is the
 * intended fallback, not a failure.
 */
export function chunkDocument(text: string): Chunk[] {
  const lines = normalize(text).split("\n");
  const sections: { name: string; body: string[] }[] = [];
  let current = { name: OVERVIEW, body: [] as string[] };

  for (const [i, line] of lines.entries()) {
    if (isHeading(line, lines[i + 1])) {
      if (current.body.some((l) => l.trim())) sections.push(current);
      current = { name: line.trim().replace(/[:\s]+$/, ""), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.some((l) => l.trim())) sections.push(current);

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const body = section.body.join("\n").trim();
    if (!body) continue;
    for (const content of splitBySize(body)) {
      chunks.push({ section: section.name, position: chunks.length, content });
    }
  }
  return chunks;
}

/**
 * The text actually sent to the embedding model. Chunks are stored bare so
 * citations stay clean, and the lineage is prepended only here, where it
 * changes the vector.
 *
 * Without it a resume's "5+ years of React" and a job's identical requirement
 * embed to nearly the same point, and retrieval cannot tell what the candidate
 * has from what the role wants -- which is the whole product.
 *
 * Reused at prompt-build time so the model reads the same framing.
 */
export function enrich(
  chunk: Pick<Chunk, "section" | "content">,
  label: string,
): string {
  return `${label} — ${chunk.section}: ${chunk.content}`;
}
