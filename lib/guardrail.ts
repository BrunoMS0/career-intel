/**
 * The distance past which a question is treated as off-topic and the model is
 * never called.
 *
 * Measured, not chosen, and refitted to the eight-document corpus. All 31
 * questions in eval/questions.json were run against the index. The highest one
 * that has to pass is the injection at 0.3705, which clears on purpose so the
 * prompt gets to refuse it; the highest with a real answer is "compare all the
 * postings for me" at 0.3589. The nearest question that has to refuse is "how
 * should I prepare for a system design interview?" at 0.4040. Nothing lands
 * between 0.3705 and 0.4040, so that band is empty and this is its middle.
 *
 * It used to be 0.40, fitted to a six-posting corpus whose band was 0.3705 to
 * 0.4048 -- nearly the same band, which is why 0.40 still separates all 31
 * correctly and why moving it changes no outcome. What moves is the margin.
 * 0.40 sat 0.0040 under the refusing floor, and a single corpus edit has
 * already moved that same question 0.0063 (0.4048 to 0.3985), which is more
 * than the whole margin: the constant was one heading rewrite away from
 * answering a question it is supposed to refuse. At 0.387 the nearest question
 * on either side is 0.0165 away.
 *
 * The asymmetry the old value bought is not lost, because the two sides do not
 * cost the same. A false refusal is the expensive failure, and the nearest
 * question that would suffer one is 0.0281 away (compare-all); the nearest
 * false answer is 0.0170 away. Wider margin still faces the expensive side.
 *
 * What it deliberately does *not* catch: a question about a real document whose
 * answer the document does not contain ("what is the dress code at Job #1?",
 * best hit 0.3584 -- inside the answerable range, and now just under its
 * ceiling). Those are indistinguishable from good questions by distance,
 * because the embedding measures what the question is *about* and that question
 * really is about Job #1. Absence of an answer is not a geometric property, so
 * it is the system prompt's job, not this constant's.
 */
export const WEAK_DISTANCE = 0.387;

/** What the user sees when the guardrail stops a question before the model. */
export const REFUSAL =
  "That question is outside the documents I have. I can only answer from the " +
  "indexed resume and job postings — ask about your fit for a role, what a " +
  "posting requires, or what it says about pay, location or process.";

export type RetrievalAssessment = {
  /** Distance of the nearest chunk. Null when nothing is indexed at all. */
  top: number | null;
  /**
   * Distance spread inside the document that owns the nearest chunk. Recorded
   * but not enforced: it ranks the good and bad questions in almost the right
   * order, but "how much does Job #2 pay?" (0.0551 on the current corpus) lands
   * under three unanswerable ones, and refusing a valid question is the
   * expensive failure. Phase 5 measured it properly and it lost; CLAUDE.md
   * carries the numbers.
   */
  spread: number | null;
  weak: boolean;
};

/**
 * Decides whether retrieval was strong enough to be worth a model call.
 *
 * Takes the sections rather than a bare number so the caller cannot pair the
 * distance of one section with the spread of another.
 */
export function assessRetrieval(
  sections: readonly { distance: number; spread: number }[],
): RetrievalAssessment {
  if (sections.length === 0) return { top: null, spread: null, weak: true };

  // Scanned rather than assuming sections[0], so a caller that re-sorts them
  // cannot silently flip the decision.
  const nearest = sections.reduce((best, s) => (s.distance < best.distance ? s : best));
  return {
    top: nearest.distance,
    spread: nearest.spread,
    weak: nearest.distance > WEAK_DISTANCE,
  };
}
