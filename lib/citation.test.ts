import { test } from "node:test";
import assert from "node:assert/strict";
import { citedName, linkCitations, type Citable } from "./citation.ts";

// The eight documents as they are actually indexed, identities included, since
// the interesting cases are the ones this corpus really has: a posting with no
// company, a resume with no identity at all, and section names carrying em
// dashes and pipes of their own.
const DOCUMENTS: Citable[] = [
  { label: "Job #1", company: "Gamma", role_title: "AI Engineer — Core AI Systems" },
  { label: "Job #4", company: "Kargo", role_title: "Agentic AI Engineer" },
  { label: "Job #7", company: null, role_title: "Senior E-Commerce Developer" },
  { label: "My resume", company: null, role_title: null },
];

test("a citation keeps the label and gains the real name", () => {
  assert.equal(citedName(DOCUMENTS[1]), "Job #4 (Kargo)");
  // No company on Job #7, so the role title is the best name available.
  assert.equal(citedName(DOCUMENTS[2]), "Job #7 (Senior E-Commerce Developer)");
  // Nothing at all on the resume, and "My resume" is already what it is called.
  assert.equal(citedName(DOCUMENTS[3]), "My resume");
});

test("the chip does not contradict the sentence it hangs off", () => {
  // Measured on a real answer: asked what Job #2 pays, the model says "Job #2
  // pays $120,000 – $155,000" in prose. A chip that renamed the posting to eJam
  // would disagree with the sentence carrying it.
  const documents = [{ label: "Job #2", company: "eJam", role_title: "AI Product Engineer" }];
  const linked = linkCitations("Job #2 pays $120,000 [Job #2 — COMPENSATION].", documents);

  assert.ok(linked.includes("Job #2 (eJam) — COMPENSATION"));
});

test("a citation becomes a link naming the company, titled with the original", () => {
  assert.equal(
    linkCitations("Python is required [Job #4 — EXPERIENCE].", DOCUMENTS),
    'Python is required [Job #4 (Kargo) — EXPERIENCE](#cite "[Job #4 — EXPERIENCE]").',
  );
});

test("the label the model wrote survives in the title, not only on screen", () => {
  // The sidebar, the eval expectations and query_logs all speak "Job #N". A chip
  // that erased it would be prettier and untraceable.
  const linked = linkCitations("[My resume — SUMMARY]", DOCUMENTS);
  assert.ok(linked.includes('"[My resume — SUMMARY]"'));
});

test("a section name with its own em dash is not mistaken for the separator", () => {
  assert.equal(
    linkCitations("[Job #1 — AI Engineer — Core AI Systems]", DOCUMENTS),
    '[Job #1 (Gamma) — AI Engineer — Core AI Systems](#cite "[Job #1 — AI Engineer — Core AI Systems]")',
  );
});

test("a section name carrying a pipe and a date is left alone", () => {
  assert.equal(
    linkCitations("[My resume — Data Analytics | March 2026 – Present]", DOCUMENTS),
    "[My resume — Data Analytics | March 2026 – Present]" +
      '(#cite "[My resume — Data Analytics | March 2026 – Present]")',
  );
});

test("several citations in one bracket are all rewritten", () => {
  // Observed in a real answer, and the reason the rewrite is not anchored to the
  // start of the bracket: half a rewrite reads worse than none.
  assert.equal(
    linkCitations("[Job #4 — EXPERIENCE, Job #1 — SUMMARY]", DOCUMENTS),
    '[Job #4 (Kargo) — EXPERIENCE, Job #1 (Gamma) — SUMMARY](#cite "[Job #4 — EXPERIENCE, Job #1 — SUMMARY]")',
  );
});

test("a bracket naming no indexed document stays plain text", () => {
  // An invented citation has to keep looking invented. Phase 8b measured the
  // model naming `Job #6 — Requirements`, a section that does not exist; a chip
  // is a claim the source resolved, and dressing up a wrong one hides it.
  const prose = "as noted [elsewhere] and [Job #9 — REQUIREMENTS]";
  assert.equal(linkCitations(prose, DOCUMENTS), prose);
});

test("an unfinished citation mid-stream is not turned into anything", () => {
  assert.equal(linkCitations("Python is required [Job #4 — EXPER", DOCUMENTS), "Python is required [Job #4 — EXPER");
});

test("a bracket does not swallow the rest of the answer across a newline", () => {
  const text = "first [Job #4 — EXPERIENCE\nsecond [Job #1 — SUMMARY]";
  assert.equal(
    linkCitations(text, DOCUMENTS),
    'first [Job #4 — EXPERIENCE\nsecond [Job #1 (Gamma) — SUMMARY](#cite "[Job #1 — SUMMARY]")',
  );
});

test("Job #1 does not match inside Job #10", () => {
  const documents = [...DOCUMENTS, { label: "Job #10", company: "Tenth", role_title: null }];
  assert.equal(
    linkCitations("[Job #10 — SUMMARY]", documents),
    '[Job #10 (Tenth) — SUMMARY](#cite "[Job #10 — SUMMARY]")',
  );
});

test("nothing indexed leaves the answer untouched", () => {
  assert.equal(linkCitations("[Job #4 — EXPERIENCE]", []), "[Job #4 — EXPERIENCE]");
});
