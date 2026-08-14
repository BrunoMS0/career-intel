/**
 * The distance past which a question is treated as off-topic and the model is
 * never called.
 *
 * Measured, not chosen: 13 answerable questions and 15 out-of-domain ones were
 * run against the indexed corpus. Every answerable one had its best hit at
 * 0.3640 or nearer -- the ceiling is "compare all the postings for me", the
 * vaguest question that still has an answer. The nearest off-topic one sat at
 * 0.4048. This is the middle of that empty band, and it refuses none of the
 * measured good questions.
 *
 * What it deliberately does *not* catch: a question about a real document whose
 * answer the document does not contain ("what is the dress code at Job #1?",
 * best hit 0.3653). Those are indistinguishable from good questions by
 * distance, because the embedding measures what the question is *about* and
 * that question really is about Job #1. Absence of an answer is not a geometric
 * property, so it is the system prompt's job, not this constant's.
 */
export const WEAK_DISTANCE = 0.4;

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
   * order, but "how much does Job #2 pay?" (0.0583) lands under three
   * unanswerable ones, and refusing a valid question is the expensive failure.
   * Phase 5 has the data to decide whether it earns a threshold of its own.
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
