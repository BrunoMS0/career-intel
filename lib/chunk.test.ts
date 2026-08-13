import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkDocument, enrich } from "./chunk.ts";

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

test("enrich prefixes lineage without touching the stored content", () => {
  const chunk = { section: "REQUIREMENTS", content: "- 5+ years of React" };
  assert.equal(
    enrich(chunk, "Job #2"),
    "Job #2 — REQUIREMENTS: - 5+ years of React",
  );
  assert.equal(chunk.content, "- 5+ years of React");
});
