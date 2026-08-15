import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMention, mentionQuery, suggest } from "./mention.ts";

const CORPUS = [
  { label: "Job #3", company: "Afficiency", role_title: "AI Prompt Engineer" },
  { label: "Job #5", company: "Golden Analytics", role_title: "AI Engineer" },
  { label: "Job #7", company: null, role_title: "Senior E-Commerce Developer" },
];

/** Caret at the end, which is where it is while someone is typing. */
const atEnd = (text: string) => mentionQuery(text, text.length);

test("the token under the caret is what the menu filters on", () => {
  assert.deepEqual(atEnd("/"), { start: 0, end: 1, query: "" });
  assert.deepEqual(atEnd("how does /aff"), { start: 9, end: 13, query: "aff" });
});

test("mid-word slashes do not open a menu", () => {
  // A URL, a fraction and a date all carry slashes that are not mentions.
  assert.equal(atEnd("see https://example.com/job"), null);
  assert.equal(atEnd("I work 4/5 days"), null);
  assert.equal(atEnd("starting 2026/01"), null);
});

test("the menu closes once the sentence carries on", () => {
  assert.equal(atEnd("/Job #3 what does it pay"), null);
  assert.equal(atEnd("no slash here"), null);
});

test("the caret decides, not the end of the text", () => {
  // Someone went back to fix a mention they had already typed past.
  assert.deepEqual(mentionQuery("/aff asks for what?", 4), { start: 0, end: 4, query: "aff" });
});

test("a posting is offered by every name it answers to", () => {
  assert.deepEqual(suggest(CORPUS, "aff").map((d) => d.label), ["Job #3"]);
  assert.deepEqual(suggest(CORPUS, "golden").map((d) => d.label), ["Job #5"]);
  assert.deepEqual(suggest(CORPUS, "job7").map((d) => d.label), ["Job #7"]);
  assert.deepEqual(suggest(CORPUS, "e-commerce").map((d) => d.label), ["Job #7"]);
  // A title two postings share offers both, exactly as resolveScope resolves it.
  assert.deepEqual(suggest(CORPUS, "ai eng").map((d) => d.label), ["Job #5"]);
});

test("an empty query offers everything, which is what makes / a listing", () => {
  assert.equal(suggest(CORPUS, "").length, 3);
});

test("picking inserts the label and leaves the caret after it", () => {
  const text = "how does my experience line up with /gold";
  const mention = mentionQuery(text, text.length)!;
  assert.deepEqual(applyMention(text, mention, "Job #5"), {
    text: "how does my experience line up with Job #5 ",
    caret: 43,
  });
});

test("picking in the middle keeps the rest of the sentence", () => {
  const text = "/aff asks for what?";
  const applied = applyMention(text, mentionQuery(text, 4)!, "Job #3");
  assert.equal(applied.text, "Job #3  asks for what?");
  assert.equal(applied.caret, 7);
});
