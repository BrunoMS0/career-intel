import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRetrieval, WEAK_DISTANCE } from "./guardrail.ts";

// Distances here are injected, never embedded. The real ones come from a hosted
// model that can move without notice, so asserting on them would make this suite
// fail for a reason that has nothing to do with the logic. What the numbers
// below encode is the *measurement*, and the measurement is re-run by the eval
// harness, not here.

const section = (distance: number, spread = 0.05) => ({ distance, spread });

test("a best hit past the floor is weak", () => {
  assert.equal(assessRetrieval([section(0.5118)]).weak, true);
});

test("a best hit inside the floor is not", () => {
  assert.equal(assessRetrieval([section(0.3640)]).weak, false);
});

test("the floor sits between the two measured populations", () => {
  // The band the constant was picked from. If someone tightens it to 0.30 --
  // the value the original two-question sample suggested -- this fails and says
  // which real question it would have refused.
  assert.ok(
    WEAK_DISTANCE > 0.364,
    "would refuse 'compare all the postings for me', measured at 0.3640",
  );
  assert.ok(
    WEAK_DISTANCE < 0.4048,
    "would admit 'how should I prepare for a system design interview?', measured at 0.4048",
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
