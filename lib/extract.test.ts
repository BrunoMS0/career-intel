import test from "node:test";
import assert from "node:assert/strict";
import { numeric, profileExcerpt } from "./extract.ts";

// Only the rendering and the casting are tested: the extraction itself is a
// hosted model and asserting on its output would fail for reasons that have
// nothing to do with this code -- the same split lib/rerank.test.ts makes. What
// the extraction actually produces was measured against the corpus and is
// written up in CLAUDE.md.

test("the sentinel is not a number, and neither is zero", () => {
  assert.equal(numeric("180000"), 180000);
  assert.equal(numeric("$180,000"), 180000);
  assert.equal(numeric("unstated"), null);
  assert.equal(numeric(""), null);
  assert.equal(numeric(null), null);
  // The measured failure: a schema asking for a number got 0 for a posting that
  // states no salary. Zero is not a salary and must never reach a comparison.
  assert.equal(numeric("0"), null);
  assert.equal(numeric(0), null);
});

test("a posting profile states what the document does not say, rather than dropping it", () => {
  const rendered = profileExcerpt(
    {
      work_mode: "unstated",
      location_as_written: "unstated",
      employment_type: "unstated",
      seniority: "senior",
      salary_min: "unstated",
      salary_max: "unstated",
      salary_as_written: "unstated",
      has_equity: "unstated",
      min_years_experience: "unstated",
      education_required: "unstated",
      must_have_skills: [],
      technologies: ["Shopify"],
    },
    "Senior E-Commerce Developer building funnels and stores.",
  )!;

  // The line has to be present and say so: an omitted field reads as an
  // oversight, "unstated" reads as a fact about the posting, and `remote-jobs`
  // fails today precisely by confusing those two.
  assert.match(rendered, /Work mode: unstated \| Location: unstated/);
  assert.match(rendered, /Technologies: Shopify/);
  assert.match(rendered, /Senior E-Commerce Developer building/);
  assert.doesNotMatch(rendered, /Required:/); // empty list contributes no line
});

test("a stated salary is rendered from the parsed numbers, an unstated one from the words", () => {
  const withFigures = profileExcerpt(
    { work_mode: "hybrid", salary_min: "180000", salary_max: "300000", salary_currency: "USD", salary_period: "year", has_equity: "yes" },
    null,
  )!;
  assert.match(withFigures, /Compensation: 180000–300000 USD per year \| Equity: yes/);

  const withWords = profileExcerpt(
    { work_mode: "unstated", salary_min: "unstated", salary_max: "unstated", salary_as_written: "Competitive salary and equity (amount not disclosed)", has_equity: "yes" },
    null,
  )!;
  assert.match(withWords, /Compensation: Competitive salary and equity/);
});

test("a resume renders the candidate side, and an unextracted document renders nothing", () => {
  const resume = profileExcerpt(
    { headline: "Fullstack Engineer", years_experience_total: "3", highest_education: "Bachelor's, PUCP", technologies: ["React"], domains: ["insurance"] },
    "Fullstack Engineer with 3+ years.",
  )!;
  assert.match(resume, /Headline: Fullstack Engineer \| Experience: 3 years/);
  assert.match(resume, /Domains: insurance/);

  // Null is what keeps an un-extracted upload on the old path instead of
  // dropping it out of the answer entirely.
  assert.equal(profileExcerpt(null, null), null);
});
