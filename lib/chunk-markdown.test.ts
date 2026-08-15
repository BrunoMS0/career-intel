import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown } from "./chunk-markdown.ts";

test("splits on markdown headings", () => {
  const sections = chunkMarkdown(`# Role summary
Build things.

# Requirements
- 5+ years of React`).map((c) => c.section);

  assert.deepEqual(sections, ["Role summary", "Requirements"]);
});

test("text before the first heading lands in Overview", () => {
  const chunks = chunkMarkdown(`Acme Corp — Remote

# Requirements
- TypeScript`);

  assert.equal(chunks[0].section, "Overview");
  assert.match(chunks[0].content, /Acme Corp/);
});

test("headings with no body are content, not sections", () => {
  // Job #1: every entry of a skills list came back promoted to a heading. They
  // have to stay inside the section they interrupted, or the skills vanish from
  // it and each becomes an empty label.
  const chunks = chunkMarkdown(`# Technical Skills
Exposure to:

# Git/GitHub

# Azure DevOps

# Desired Competencies
Ownership.`);

  assert.deepEqual(chunks.map((c) => c.section), ["Technical Skills", "Desired Competencies"]);
  assert.match(chunks[0].content, /Git\/GitHub/);
  assert.match(chunks[0].content, /Azure DevOps/);
});

test("a heading repeated across a page break makes one section", () => {
  // Job #6: pages are joined, and the page that split a section repeats its
  // heading at the top.
  const chunks = chunkMarkdown(`# Build with AI
First half.

# Build with AI
Second half.`);

  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /First half/);
  assert.match(chunks[0].content, /Second half/);
});

test("ligature glyphs and escaped ampersands are repaired", () => {
  const chunks = chunkMarkdown(`# Data &#x26; Integration
Experience deᶠⁱning workᶠˡows.`);

  assert.equal(chunks[0].section, "Data & Integration");
  assert.match(chunks[0].content, /defining workflows/);
});

test("a ligature that swallowed a space still reads as one word", () => {
  // Job #2's benefits section came back titled "Beneᶠⁱ ts".
  assert.equal(chunkMarkdown("# Beneᶠⁱ ts\n- PTO")[0].section, "Benefits");
});

test("a trailing colon is not part of the section name", () => {
  assert.equal(chunkMarkdown("# Compensation range:\n- 180k")[0].section, "Compensation range");
});

test("a table split across chunks keeps its header on both", () => {
  // Afficiency's skills table is long enough to split, and the second piece
  // otherwise opens on bare rows with nothing naming the columns.
  const row = (area: string) => `| ${area} | ${"technology, ".repeat(40)} |`;
  const chunks = chunkMarkdown(`# Technical Skills
| Area | Technologies |
| --- | --- |
${row("Front-end")}
${row("Back-end")}
${row("Databases")}
${row("Cloud")}`);

  assert.ok(chunks.length > 1, "table should have split");
  for (const chunk of chunks) {
    assert.match(chunk.content, /\| Area \| Technologies \|/);
  }
});

test("a section without a table is left alone", () => {
  const chunks = chunkMarkdown(`# Requirements\n- Python\n- Go`);
  assert.equal(chunks[0].content, "- Python\n- Go");
});

test("a small subtree becomes one section under its parent", () => {
  // This used to be the canary for flattening. The parser does state depth once
  // it is asked to, so the rule is now the one described in chunk-markdown.ts:
  // a parent that fits in a chunk keeps its children inside it. Job #3's six
  // technology groups are this shape, and splitting them cost retrieval two of
  // three expected sections.
  const chunks = chunkMarkdown(`# What You Bring
## Required
- Python

## Preferred
- Go`);

  assert.deepEqual(
    chunks.map((c) => c.section),
    ["What You Bring"],
  );
  assert.match(chunks[0].content, /## Required[\s\S]*## Preferred/);
});

test("a subtree too big for one chunk gives its children their own sections", () => {
  // The resume's employers: each entry is substantial and has to stay separate,
  // because "what did I build at RedMuqui" is answered by exactly one of them.
  const entry = (name: string) => `## ${name}\n${"- did things there. ".repeat(40)}`;
  const chunks = chunkMarkdown(`# Experience\n${entry("Acme")}\n${entry("Globex")}`);

  assert.deepEqual(
    chunks.map((c) => c.section),
    ["Acme", "Globex"],
  );
});

test("an empty heading is a parent when something deeper follows it", () => {
  // Flat, "What You'll Do" and a skills-list entry promoted to a heading look
  // identical. Depth is what tells them apart.
  const promoted = chunkMarkdown(`# Skills
Exposure to:

# Git/GitHub

# Azure DevOps

# Benefits
- Equity`).map((c) => c.section);

  assert.deepEqual(promoted, ["Skills", "Benefits"]);
});

test("bold and italic markers are stripped from section names", () => {
  // A revision of the corpus set its headings in bold. The markers arrived
  // inside the section name, which enrich() embeds and the model cites back.
  const sections = chunkMarkdown(`# **ABOUT THE ROLE**
We build things.

# *Required*
- TypeScript`).map((c) => c.section);

  assert.deepEqual(sections, ["ABOUT THE ROLE", "Required"]);
});
