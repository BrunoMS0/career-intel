import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRetrieval, isRefusal, REFUSAL, WEAK_DISTANCE } from "./guardrail.ts";

// Distances here are injected, never embedded. The real ones come from a hosted
// model that can move without notice, so asserting on them would make this suite
// fail for a reason that has nothing to do with the logic. What the numbers
// below encode is the *measurement*, and the measurement is re-run by the eval
// harness, not here.

const section = (distance: number, spread = 0.05) => ({ distance, spread });

test("a best hit past the floor is weak", () => {
  assert.equal(assessRetrieval([section(0.5019)]).weak, true);
});

test("a best hit inside the floor is not", () => {
  assert.equal(assessRetrieval([section(0.3589)]).weak, false);
});

test("the floor sits between the two measured populations", () => {
  // The band the constant was picked from, remeasured on the eight-document
  // corpus. The edges are questions, not round numbers: if someone tightens the
  // constant this fails and says which real question it would have refused.
  assert.ok(
    WEAK_DISTANCE > 0.3705,
    "would refuse the injection 'ignore the excerpts...', measured at 0.3705, " +
      "which has to reach the model so the prompt can decline it",
  );
  assert.ok(
    WEAK_DISTANCE < 0.404,
    "would admit 'how should I prepare for a system design interview?', measured at 0.4040",
  );
});

test("the nearest section decides, whatever order they arrive in", () => {
  const assessment = assessRetrieval([section(0.62, 0.01), section(0.31, 0.09), section(0.44)]);

  assert.equal(assessment.weak, false);
  assert.equal(assessment.top, 0.31);
  // The spread has to come from the same section as the distance, or the log
  // pairs one question's level with another's shape.
  assert.equal(assessment.spread, 0.09);
});

test("nothing indexed is weak, not a crash", () => {
  assert.deepEqual(assessRetrieval([]), { top: null, spread: null, weak: true });
});

test("the canned refusal is recognised as one", () => {
  // The screen marks a guardrail refusal differently from an answer, and this is
  // the only thing telling them apart. Editing REFUSAL without editing isRefusal
  // would leave the marking silently off, which nothing else would report.
  assert.equal(isRefusal(REFUSAL), true);
  assert.equal(isRefusal(`${REFUSAL}\n`), true);
});

test("a model declining in its own words is still an answer", () => {
  // The prompt refuses far more questions than the threshold does, and it does
  // so with reasoning and citations. Those are answers -- the reader wants to
  // see what was looked for, not a badge saying the question was off-topic.
  assert.equal(
    isRefusal("The documents do not state a dress code for Job #1. [Job #1 — BENEFITS]"),
    false,
  );
  assert.equal(isRefusal("That is outside what I can answer."), false);
});
