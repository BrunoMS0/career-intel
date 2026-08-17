/**
 * Which documents a question names.
 *
 * Kept free of db imports, like lib/guardrail.ts and for the same reason: this
 * is the rule that decides how wide the search gets, and it has to be testable
 * without a database or a corpus behind it.
 */

export type DocumentIdentity = {
  label: string;
  /** Null on the resume, and on a posting whose identity nobody filled in. */
  company: string | null;
  role_title: string | null;
};

/** Punctuation and spacing squashed, so "Job #2", "job 2" and "JOB2" all land. */
export const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Shortest identity part a question may be matched on. Matching is substring,
 * so a short part fires inside unrelated words: Job #2's company is "eJam",
 * and "ejam" sits inside the Spanish "dejamos" and "manejamos". Five keeps the
 * one company in the corpus that would misfire out of the rule, at the price of
 * never resolving eJam by name. Labels are exempt -- "job3" is four characters
 * and is exact by construction.
 */
const MIN_PART = 5;

/** The separators role titles in this corpus use to join two names into one. */
const TITLE_SEPARATORS = /[—–/|,]/;

/**
 * The squashed strings a question can name this posting by.
 *
 * The title is split rather than kept whole because postings name themselves
 * twice: "AI Prompt Engineer / AI Application Engineer" is one job under two
 * names, and a question uses one of them. Keeping the whole title as well would
 * add nothing -- a question containing it already contains every part of it.
 */
export function identityParts(document: DocumentIdentity): string[] {
  const named = [document.company ?? "", ...(document.role_title ?? "").split(TITLE_SEPARATORS)]
    .map(squash)
    .filter((part) => part.length >= MIN_PART);
  return [squash(document.label), ...named];
}

/**
 * Finds which documents a question is about, so "How does my experience align
 * with Job #2?" reads Job #2 and not the other six postings.
 *
 * Identity is matched literally rather than inferred by a model: labels,
 * companies and role titles are short, corpus-owned strings, and a wrong guess
 * here silently answers about the wrong job.
 *
 * The label alone was the whole rule until phase 7 measured what it costs.
 * Nobody outside this repo types "Job #3", and a question naming the same
 * posting by its company widened to all eight documents: 24.6 sections against
 * 7.9, 23.7% document precision against 90.9%, and three of six twin questions
 * answering wrongly where the labelled version answered right.
 *
 * ponytail: substring match, so with more than nine postings "Job #1" would
 * also match a question about "Job #12", and "AI Engineer" matches inside
 * "Agentic AI Engineer" -- which is why asking about the agentic role keeps
 * three postings in play rather than one. Both are the same fix: match on word
 * boundaries if the corpus ever gets big enough to care.
 */
export function scopeFor(query: string, documents: DocumentIdentity[]): string[] {
  const asked = squash(query);
  return documents
    .filter((document) => identityParts(document).some((part) => asked.includes(part)))
    .map((document) => document.label);
}

export type Segment = {
  text: string;
  /** The document this run of text names, or null for ordinary prose. */
  label: string | null;
};

/**
 * The same question, cut into the runs that name a document and the runs that do
 * not, so the composer can show which words the search is going to act on.
 *
 * It exists beside `scopeFor` rather than in the component because it has to
 * agree with it: the same parts, the same squash, the same substring test. A
 * highlight that resolved differently from the retriever would be worse than no
 * highlight at all -- it would be a confident wrong answer to "did that land?".
 *
 * `squash` drops characters, so the match runs over the squashed text and is
 * mapped back through the index of every character that survived. That is what
 * lets "Job #3" highlight whole, spaces and hash included, while still matching
 * a user who typed "job3".
 */
export function segmentByIdentity(text: string, documents: DocumentIdentity[]): Segment[] {
  const kept: number[] = [];
  let squashed = "";
  for (let i = 0; i < text.length; i++) {
    const character = squash(text[i]);
    if (character) {
      squashed += character;
      kept.push(i);
    }
  }

  // Longest first, so a part that contains another cannot be pre-empted by it.
  const found: { start: number; end: number; label: string }[] = [];
  for (const document of documents) {
    for (const part of identityParts(document).sort((a, b) => b.length - a.length)) {
      for (let at = squashed.indexOf(part); at !== -1; at = squashed.indexOf(part, at + 1)) {
        found.push({
          start: kept[at],
          end: kept[at + part.length - 1] + 1,
          label: document.label,
        });
      }
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);

  const segments: Segment[] = [];
  let at = 0;
  for (const match of found) {
    // Two parts of one document can name the same words -- "AI Engineer" inside
    // "Agentic AI Engineer" is the case in this corpus. Whoever got there first
    // owns the run.
    if (match.start < at) continue;
    if (match.start > at) segments.push({ text: text.slice(at, match.start), label: null });
    segments.push({ text: text.slice(match.start, match.end), label: match.label });
    at = match.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), label: null });
  return segments;
}
