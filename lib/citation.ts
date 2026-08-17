/**
 * Citations, as they are read rather than as they are written.
 *
 * The prompt asks the model for `[Job #4 — EXPERIENCE]` and the eval harness
 * checks that exact string, so the contract is fixed and nothing here may touch
 * it. What it may do is display it: `documents.company` and
 * `documents.role_title` already carry the real identity on the client, so
 * "Job #4" can read "Kargo" without a byte of the answer changing on the wire.
 *
 * The rewrite produces markdown links because the answer goes through a markdown
 * renderer -- a chip is `components.a`, and the original bracket rides along as
 * the link title so a reader can still map the chip back to the sidebar.
 *
 * Deliberately not here: the excerpt behind a citation. The retrieved sections
 * are not on the stream, so nothing on the client knows what the section said.
 * Adding them is a change to the answer path and wants measuring first.
 */

export type Citable = {
  label: string;
  company: string | null;
  role_title: string | null;
};

/**
 * How a citation names a document: the label the model wrote, plus the real
 * name when there is one.
 *
 * Replacing the label outright was measured against a real answer and reads
 * worse. Asked what Job #2 pays, the model answers "Job #2 pays $120,000 –
 * $155,000" and cites the posting -- so a chip reading "eJam — …" contradicts
 * the sentence it is attached to, and on a touch screen the title attribute that
 * would have reconciled them never appears. Keeping both costs six characters
 * and the reader learns the mapping without hovering anything.
 */
export const citedName = (document: Citable) => {
  const real = document.company ?? document.role_title;
  return real ? `${document.label} (${real})` : document.label;
};

const escapeForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern matching any of these labels where one really starts.
 *
 * Longest first so "Job #1" cannot win against "Job #10", and `(?!\d)` for the
 * same reason from the other side -- this corpus has eight documents and the
 * question does not arise, the next one will.
 */
function labelPattern(documents: readonly Citable[]): RegExp | null {
  const labels = [...documents]
    .map((document) => document.label)
    .sort((a, b) => b.length - a.length);
  if (labels.length === 0) return null;
  return new RegExp(`(?:${labels.map(escapeForRegExp).join("|")})(?!\\d)`, "g");
}

/**
 * Rewrites the model's citation brackets into markdown links that name the
 * document the way a person would.
 *
 * Only brackets holding a label this corpus knows are touched. Anything else --
 * a bracket the model invented, an unfinished one mid-stream, a stray `[` in
 * prose -- is left exactly as it was, because a chip is a claim that the source
 * was resolved and an unresolvable one should look like what it is.
 *
 * Every label inside a bracket is replaced, not only the first: the model has
 * been observed citing several sections in one pair of brackets, and half a
 * rewrite reads worse than none.
 */
export function linkCitations(text: string, documents: readonly Citable[]): string {
  const labels = labelPattern(documents);
  if (!labels) return text;

  const named = new Map(documents.map((document) => [document.label, citedName(document)]));

  // The optional backtick pair is not decoration. The model sometimes writes a
  // citation as `[Job #1 — WHAT YOU'LL BRING]`, inline code, and markdown does
  // not parse anything inside a code span -- so rewriting in place produced a
  // code chip containing the raw link syntax, which is worse than what it
  // replaced. Eating the backticks turns that case into the chip the model was
  // reaching for. The backreference makes the pair symmetric or absent.
  //
  // No newlines inside a citation: an unclosed `[` would otherwise swallow the
  // rest of the answer while it streams.
  return text.replace(/(`?)\[([^\][\n]+)\]\1/g, (bracket, _tick: string, inside: string) => {
    labels.lastIndex = 0;
    if (!labels.test(inside)) return bracket;

    const display = inside.replace(labels, (label) => named.get(label) ?? label);
    // The citation the model wrote, kept as the link title so the chip stays
    // traceable to the label the sidebar and the eval both speak. Rebuilt from
    // the contents rather than from the match, so a backtick the model added
    // does not end up in the tooltip.
    const title = `[${inside}]`.replace(/"/g, "'");
    return `[${display}](#cite "${title}")`;
  });
}
