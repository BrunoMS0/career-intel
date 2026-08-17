import { test } from "node:test";
import assert from "node:assert/strict";
import { identityParts, scopeFor, segmentByIdentity } from "./scope.ts";

// The corpus, as far as this rule is concerned. Kept here rather than read from
// the database so the suite stays offline: what is under test is the matching,
// not the eight rows.
const CORPUS = [
  { label: "Job #1", company: "Gamma", role_title: "AI Engineer — Core AI Systems" },
  {
    label: "Job #2",
    company: "eJam",
    role_title: "Mid-Level AI Product / Creative-Tools Engineer",
  },
  {
    label: "Job #3",
    company: "Afficiency",
    role_title: "AI Prompt Engineer / AI Application Engineer",
  },
  { label: "Job #4", company: "Kargo", role_title: "Agentic AI Engineer" },
  { label: "Job #5", company: "Golden Analytics", role_title: "AI Engineer" },
  { label: "Job #6", company: "Newpage", role_title: "Forward Deployed Engineer" },
  { label: "Job #7", company: null, role_title: "Senior E-Commerce Developer" },
];

const scope = (query: string) => scopeFor(query, CORPUS);

test("a label still resolves exactly as it did", () => {
  assert.deepEqual(scope("what skills am I missing for Job #3?"), ["Job #3"]);
  assert.deepEqual(scope("¿qué habilidades me faltan para job 3?"), ["Job #3"]);
});

test("a company resolves the posting the label used to", () => {
  // The twin questions, which is the whole point of the change: word for word
  // the scoped version, naming the posting the way a person would.
  assert.deepEqual(scope("what skills am I missing for the Afficiency role?"), ["Job #3"]);
  assert.deepEqual(scope("which of my projects should I talk about in a Kargo interview?"), [
    "Job #4",
  ]);
  assert.deepEqual(
    scope("how does my experience line up with what Golden Analytics asks for?"),
    ["Job #5"],
  );
});

test("a role title resolves it too, and a posting with no company has only that", () => {
  assert.deepEqual(scope("am I a good fit for the Senior E-Commerce Developer role?"), [
    "Job #7",
  ]);
  assert.deepEqual(
    scope("how should I prepare for an interview for the Forward Deployed Engineer role?"),
    ["Job #6"],
  );
});

test("a title two postings share resolves to both, not to one and not to all", () => {
  assert.deepEqual(scope("what does the AI engineer role require?"), ["Job #1", "Job #5"]);
});

test("a broad question narrows to nothing", () => {
  // The control. Six questions in the eval set need every posting in play, and
  // a rule that quietly scopes one of them is worse than no rule at all.
  for (const query of [
    "which of these jobs are remote?",
    "am I a good fit for any of these?",
    "compare all the postings for me",
    "what do all these roles have in common?",
    "which role fits me best?",
    "what should I learn next to be more competitive?",
  ]) {
    assert.deepEqual(scope(query), [], query);
  }
});

test("a part under five characters is not matched on", () => {
  // "eJam" squashes to four characters and sits inside ordinary Spanish words
  // ("dejamos", "manejamos"), so it is dropped rather than allowed to misfire.
  assert.deepEqual(identityParts(CORPUS[1]), [
    "job2",
    "midlevelaiproduct",
    "creativetoolsengineer",
  ]);
  assert.deepEqual(scope("¿qué proyectos manejamos con IA?"), []);
});

test("a double title matches under either of its names", () => {
  assert.deepEqual(identityParts(CORPUS[2]), [
    "job3",
    "afficiency",
    "aipromptengineer",
    "aiapplicationengineer",
  ]);
  assert.deepEqual(scope("what does the AI application engineer job ask for?"), ["Job #3"]);
});

test("a document with no identity at all still answers to its label", () => {
  const bare = [{ label: "Job #8", company: null, role_title: null }];
  assert.deepEqual(scopeFor("what does Job #8 pay?", bare), ["Job #8"]);
  assert.deepEqual(scopeFor("what does the data scientist role pay?", bare), []);
});

// segmentByIdentity exists so the composer can show which words the search will
// act on. Its whole value is agreeing with scopeFor, so most of these assert the
// two together rather than the segments alone.

const highlighted = (text: string) =>
  segmentByIdentity(text, CORPUS)
    .filter((segment) => segment.label)
    .map((segment) => `${segment.text}=${segment.label}`);

test("a label is marked whole, punctuation and spacing included", () => {
  assert.deepEqual(segmentByIdentity("what about Job #3 here", CORPUS), [
    { text: "what about ", label: null },
    { text: "Job #3", label: "Job #3" },
    { text: " here", label: null },
  ]);
});

test("what gets marked is exactly what the retriever would scope to", () => {
  for (const question of [
    "what skills am I missing for Job #3?",
    "¿qué habilidades me faltan para job 3?",
    "how much does the Afficiency role pay?",
    "which of these jobs are remote?",
    "give me a recipe for pasta carbonara",
  ]) {
    const marked = [
      ...new Set(segmentByIdentity(question, CORPUS).map((s) => s.label).filter(Boolean)),
    ];
    assert.deepEqual(marked.sort(), scopeFor(question, CORPUS).sort(), question);
  }
});

test("a question naming nothing is one plain run", () => {
  assert.deepEqual(segmentByIdentity("which of these roles fits me best?", CORPUS), [
    { text: "which of these roles fits me best?", label: null },
  ]);
});

test("the company is marked where the user actually typed it", () => {
  assert.deepEqual(highlighted("how much does the Afficiency role pay?"), ["Afficiency=Job #3"]);
});

test("two postings named in one question are marked separately", () => {
  assert.deepEqual(highlighted("compare Job #1 and Job #4"), ["Job #1=Job #1", "Job #4=Job #4"]);
});

test("overlapping parts of one document do not double-mark", () => {
  // "AI Engineer" is a part of Job #5 and sits inside Job #4's "Agentic AI
  // Engineer", so the runs collide. Whichever match starts first owns the text,
  // and the run is never emitted twice.
  const segments = segmentByIdentity("the Agentic AI Engineer role", CORPUS);
  assert.equal(segments.map((s) => s.text).join(""), "the Agentic AI Engineer role");
});

test("every segment concatenates back to the question", () => {
  for (const question of [
    "what about Job #3 here",
    "how much does the Afficiency role pay?",
    "  spaced   out  Job #1  ",
    "",
  ]) {
    assert.equal(
      segmentByIdentity(question, CORPUS)
        .map((segment) => segment.text)
        .join(""),
      question,
    );
  }
});
