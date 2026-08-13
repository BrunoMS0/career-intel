import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkDocument, enrich, unlabeledShare } from "./chunk.ts";

const JOB = `Senior Frontend Engineer
Acme Corp — Remote

REQUIREMENTS
- 5+ years building production React applications
- Strong TypeScript, comfortable with generics

Benefits
- Health insurance
- 4 weeks PTO`;

test("splits on both known and all-caps headings", () => {
  const sections = chunkDocument(JOB).map((c) => c.section);
  assert.deepEqual(sections, ["Overview", "REQUIREMENTS", "Benefits"]);
});

test("text before the first heading lands in Overview", () => {
  const overview = chunkDocument(JOB).find((c) => c.section === "Overview");
  assert.match(overview!.content, /Senior Frontend Engineer/);
  assert.match(overview!.content, /Acme Corp/);
});

test("a title-case job title is not treated as a heading", () => {
  // The regression that matters: title case would split Experience into one
  // section per employer, and every bullet would lose the fact it is experience.
  const resume = `EXPERIENCE
Senior Frontend Engineer
Acme Corp, 2020-2024
- Led the migration to React 18`;

  const sections = new Set(chunkDocument(resume).map((c) => c.section));
  assert.deepEqual([...sections], ["EXPERIENCE"]);
});

test("detects the second-person headings job postings use", () => {
  // Straight from a real posting. The apostrophe is Word's U+2019, and none of
  // these are in the vocabulary list -- they match by phrasing pattern.
  const headings = [
    "What You’ll Do",
    "What You Bring",
    "What We Offer",
    "What We're Looking For",
    "Who You Are",
    "Your Mission",
  ];

  for (const heading of headings) {
    const sections = chunkDocument(`Intro line.\n${heading}\n- a requirement`).map((c) => c.section);
    assert.deepEqual(sections, ["Overview", heading], `missed: ${heading}`);
  }
});

test("detects an invented section name when a list starts under it", () => {
  // From a real posting. No vocabulary would ever cover these.
  for (const heading of ["Focus", "Skill Set", "This Role Offers", "Backend & DevOps"]) {
    const sections = chunkDocument(`Intro line.\n${heading}\n● Own complete product slices`).map(
      (c) => c.section,
    );
    assert.deepEqual(sections, ["Overview", heading], `missed: ${heading}`);
  }
});

test("does not promote a bullet item that reads like a title", () => {
  // "● Competitive Salary and Stock Option Plan" is title case and sits above
  // another bullet, so only the list marker tells it apart from a heading.
  const posting = [
    "Benefits",
    "● Competitive Salary and Stock Option Plan",
    "● Short Term & Long Term Disability",
    "● Paid time off and company holidays",
  ].join("\n");

  const sections = new Set(chunkDocument(posting).map((c) => c.section));
  assert.deepEqual([...sections], ["Benefits"]);
});

test("does not promote a wrapped bullet line sitting above the next bullet", () => {
  const posting = [
    "REQUIREMENTS",
    "● Build and maintain vector stores using tools such as FAISS,",
    "Chroma, Weaviate, or pgvector",
    "● Optimize retrieval strategies including hybrid search",
  ].join("\n");

  const sections = new Set(chunkDocument(posting).map((c) => c.section));
  assert.deepEqual([...sections], ["REQUIREMENTS"]);
});

test("does not promote an employer line that happens to precede bullets", () => {
  const resume = "EXPERIENCE\nSenior Frontend Engineer\nAcme Corp, 2020-2024\n- Led the migration to React 18";
  const sections = new Set(chunkDocument(resume).map((c) => c.section));
  assert.deepEqual([...sections], ["EXPERIENCE"]);
});

test("ignores a metadata row carrying a vocabulary word", () => {
  const posting = "Employment Type: Full-time\nLocation: Remote\nREQUIREMENTS\n- 5+ years of React";
  const sections = chunkDocument(posting).map((c) => c.section);
  assert.deepEqual(sections, ["Overview", "REQUIREMENTS"]);
});

test("does not mistake a sentence starting with You for a heading", () => {
  const posting = "REQUIREMENTS\nYou will own the component library\nYour code ships weekly, reviewed by peers.";
  const sections = new Set(chunkDocument(posting).map((c) => c.section));
  assert.deepEqual([...sections], ["REQUIREMENTS"]);
});

test("falls back to one Overview section when no headings exist", () => {
  const flat = "just a line of text\nand another one\nwith no structure at all";
  const chunks = chunkDocument(flat);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].section, "Overview");
});

test("splits an oversized section but keeps its heading on every piece", () => {
  const bullet = "- Built and shipped a production service handling real traffic\n";
  const chunks = chunkDocument(`REQUIREMENTS\n${bullet.repeat(60)}`);

  assert.ok(chunks.length > 1, "expected the section to be split");
  assert.ok(chunks.every((c) => c.section === "REQUIREMENTS"));
  // MAX_CHARS plus the MIN_CHARS a folded tail may add.
  assert.ok(chunks.every((c) => c.content.length <= 1200 + 120));
  assert.deepEqual(
    chunks.map((c) => c.position),
    chunks.map((_, i) => i),
  );
});

test("does not leave a stray short tail chunk", () => {
  const line = "- a reasonably long bullet line here\n";
  // 100 lines spill into a fourth piece with only a little text left over.
  const chunks = chunkDocument(`REQUIREMENTS\n${line.repeat(100)}`);

  assert.ok(chunks.length > 1, "expected the section to be split");
  assert.ok(
    chunks.every((c) => c.content.length >= 120),
    `short chunk among: ${chunks.map((c) => c.content.length).join(", ")}`,
  );
});

test("reports a document whose layout was not recognised", () => {
  const unstructured = "a line of text\nand another one\nwith no structure at all";
  assert.equal(unlabeledShare(chunkDocument(unstructured)), 1);

  // A preamble before the first heading is normal and must not trip the alarm.
  assert.ok(unlabeledShare(chunkDocument(JOB)) < 0.5);
  assert.equal(unlabeledShare([]), 0);
});

test("enrich prefixes lineage without touching the stored content", () => {
  const chunk = { section: "REQUIREMENTS", content: "- 5+ years of React" };
  assert.equal(
    enrich(chunk, "Job #2"),
    "Job #2 — REQUIREMENTS: - 5+ years of React",
  );
  assert.equal(chunk.content, "- 5+ years of React");
});
