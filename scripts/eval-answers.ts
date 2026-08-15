import { google } from "@ai-sdk/google";
import { generateText } from "ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "../lib/db.ts";
import { assessRetrieval, REFUSAL } from "../lib/guardrail.ts";
import { buildPrompt, type Excerpt } from "../lib/prompt.ts";
import { retrieve } from "../lib/retrieval.ts";

/**
 * Measures the answers: given whatever context it received, did the model stay
 * inside it. The other half of the harness measures whether the right context
 * arrived at all, and the two fail independently -- "the document does not say
 * whether Job #2 is remote" is a faithful answer when the location line never
 * reached the model and a defect when it did. Only the retrieval numbers tell
 * those apart, which is why they were measured first.
 *
 * Two variants run against the same questions:
 *
 *   retrieval  what the app does -- scope, per-document budget, the 0.40
 *              guardrail, and a model call only for what survives it
 *   full       every section of every document in the prompt, no retrieval and
 *              no guardrail. The corpus is 34.7k characters, about 8.7k tokens,
 *              so it fits in the context window many times over. This is the
 *              variant that asks whether retrieval is load-bearing at this size
 *              or whether it is answering a question the corpus does not pose.
 *
 * `full` still sends sections rather than raw documents so the citation format
 * survives: exactly one variable changes between the two, which is whether
 * anything was filtered out.
 *
 * Every answer is cached in eval/answers.json as it arrives. A pass that dies
 * halfway resumes instead of restarting, which was mandatory when the free tier
 * capped the day at 20 requests and is merely prudent now that it does not.
 *
 *   pnpm answers            the retrieval variant
 *   pnpm answers --full     both variants, cached ones skipped
 *   pnpm answers --verbose  print every answer, not just the failing ones
 */

const QUESTIONS = "eval/questions.json";
const ANSWERS = "eval/answers.json";
const SEPARATOR = " — ";
const CHAT_MODEL = process.env.CHAT_MODEL ?? "gemma-4-31b-it";

type Question = {
  id: string;
  q: string;
  class: "answerable" | "absent" | "domain" | "unrelated" | "injection";
  refuse: boolean;
  evidence: string[];
  must?: string[];
  anyOf?: string[];
  mustNot?: string[];
  admitsAbsence?: boolean;
  why: string;
};

type Answer = {
  text: string;
  /** True when the guardrail answered without spending a model call. */
  refused: boolean;
  /** "label — section" of everything the model was shown. */
  sections: string[];
  chars: number;
};

/**
 * Saying a document does not contain something, in the shapes a model actually
 * writes it. Deliberately not an LLM judge: that would double the calls and add
 * a second model to trust, and this rule is mechanical enough to match by hand.
 * Its failures are visible because the report prints the answer next to it.
 */
const ADMITS_ABSENCE =
  /(does not|doesn'?t|do not|don'?t)\s+(state|say|mention|specify|list|include|provide|indicate|describe)|not\s+(stated|specified|mentioned|listed|provided|indicated|disclosed|described)|no\s+(information|mention|details|indication|reference)|nothing\s+(in|about)|silent on|there is no/i;

/** Squashed so a citation written with a hyphen still matches one with a dash. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

const verbose = process.argv.includes("--verbose");

/**
 * How many times to answer each question. Every number this harness has ever
 * reported came from one sample, so a score of 29/31 carried an error bar
 * nobody had computed -- and the model swap showed the bar is not obviously
 * small: two different models tied 17/20 while failing different questions.
 * `--repeat=3` answers each question three times under its own cache key and
 * reports which ones land the same way every time.
 *
 * Only questions that reach the model are repeated. The other 8 are decided by
 * the distance threshold, which is arithmetic and cannot come out differently.
 */
const repeat = Math.max(
  1,
  Number(process.argv.find((arg) => arg.startsWith("--repeat="))?.split("=")[1] ?? 1),
);
const repeats = Array.from({ length: repeat - 1 }, (_, i) => `retrieval#${i + 2}`);
const variants = [
  "retrieval",
  ...(process.argv.includes("--full") ? ["full"] : []),
  ...repeats,
];

const questions: Question[] = JSON.parse(readFileSync(QUESTIONS, "utf8"));
const answers: Record<string, Answer> = existsSync(ANSWERS)
  ? JSON.parse(readFileSync(ANSWERS, "utf8"))
  : {};

/** Every section of every document, which is the `full` variant's context. */
const wholeCorpus = await sql<Excerpt[]>`
  select d.label, c.section, string_agg(c.content, E'\n' order by c.position) as content
  from chunks c join documents d on d.id = c.document_id
  group by d.label, c.section
  order by d.label, min(c.position)
`;

// ------------------------------------------------------------------- answering

async function answer(question: Question, variant: string): Promise<Answer> {
  let sections: Excerpt[] = wholeCorpus;

  if (variant !== "full") {
    const retrieved = await retrieve(question.q);
    // Only this variant has distances, so only it can refuse for free. The full
    // variant pays a model call for the carbonara question, which is one of the
    // things this comparison is here to price.
    if (assessRetrieval(retrieved).weak) {
      return { text: REFUSAL, refused: true, sections: [], chars: 0 };
    }
    sections = retrieved;
  }

  const { text } = await generateText({
    model: google(CHAT_MODEL),
    system: buildPrompt(sections),
    prompt: question.q,
    // One retry, not three. The free tier answers 503 "high demand" in bursts
    // and every attempt counts against the same 20 requests a day, so riding a
    // burst out in-process costs four quota units per question and can spend a
    // whole day's allowance without caching a single answer -- measured, phase
    // 6. Rerunning is the cheaper retry: the cache makes it free.
    maxRetries: 1,
  });

  return {
    text: text.trim(),
    refused: false,
    sections: sections.map((section) => `${section.label}${SEPARATOR}${section.section}`),
    chars: sections.reduce((sum, section) => sum + section.content.length, 0),
  };
}

let stopped = process.argv.includes("--report");
for (const variant of variants) {
  // A pass can be cut short by a quota at any point, so the order decides what a
  // partial run is worth. Under retrieval the free refusals go first, since they
  // cost nothing and would otherwise be the ones left unmeasured. Under full
  // nothing is free, so the answerable questions go first: they are the ones
  // that decide whether retrieval is load-bearing, and the rest can wait a day.
  //
  // A repeat pass goes first to whatever the first pass got wrong: those are the
  // questions whose result a conclusion is written on, so they are the ones a
  // truncated repeat would most regret leaving at one sample.
  const isRepeat = variant.startsWith("retrieval#");
  const base = (question: Question) => answers[`retrieval:${question.id}`];
  const first = (question: Question) =>
    isRepeat
      ? Number(check(question, base(question)).length === 0)
      : variant === "full"
        ? Number(question.class !== "answerable")
        : Number(!question.refuse);

  const pending = questions
    // The threshold decides the refusals and it is arithmetic, so repeating them
    // would spend nothing and measure nothing. A question the first pass never
    // reached is not a repeat either -- it is still owed its first sample.
    .filter((question) => !isRepeat || (!question.refuse && base(question)))
    .filter((question) => !answers[`${variant}:${question.id}`])
    .sort((a, b) => first(a) - first(b));
  if (pending.length === 0 || stopped) continue;

  console.log(`\n${variant}: ${pending.length} of ${questions.length} to answer`);
  for (const [index, question] of pending.entries()) {
    try {
      const result = await answer(question, variant);
      answers[`${variant}:${question.id}`] = result;
      writeFileSync(ANSWERS, JSON.stringify(answers, null, 1));
      console.log(
        `  ${String(index + 1).padStart(2)}/${pending.length}  ${question.id.padEnd(20)}` +
          `${result.refused ? "refused, no model call" : `${result.chars} chars in`}`,
      );
    } catch (error) {
      // Reported, not fatal: the answers already cached are worth grading, and
      // the run resumes from here.
      console.error(
        `\nstopped at ${question.id}: ${error instanceof Error ? error.message : error}\n` +
          `${Object.keys(answers).length} answers cached. rerun to continue.`,
      );
      stopped = true;
      break;
    }
  }
}

// -------------------------------------------------------------------- checking

// A declaration, not a const: the run order of a repeat pass calls check() to
// find what the first pass got wrong, and that happens above this line.
function matches(pattern: string, text: string) {
  return new RegExp(pattern, "i").test(text);
}

function check(question: Question, result: Answer): string[] {
  const problems: string[] = [];
  const { text } = result;

  if (question.refuse && result.refused) return problems; // canned, nothing to grade

  for (const pattern of question.must ?? []) {
    if (!matches(pattern, text)) problems.push(`missing "${pattern}"`);
  }
  if (question.anyOf && !question.anyOf.some((pattern) => matches(pattern, text))) {
    problems.push(`none of ${question.anyOf.map((p) => `"${p}"`).join(", ")}`);
  }
  for (const pattern of question.mustNot ?? []) {
    if (matches(pattern, text)) problems.push(`says "${pattern}"`);
  }
  if (question.admitsAbsence && !ADMITS_ABSENCE.test(text)) {
    problems.push("never says the document does not state it");
  }

  // A citation naming a section the model was not shown is invented, which is
  // the one failure mode the excerpts themselves cannot cause.
  //
  // Containment in *either* direction, because both failures the runs turned up
  // are shapes the format rule does not ask for and does not forbid either.
  //
  // The citation can be longer than the section: four sources inside one
  // bracket. Grading that as invented would fail a correct answer for
  // punctuation, and section names carry commas of their own ("React, Postgres,
  // Vercel, Supabase") so splitting on them is worse.
  //
  // It can also be shorter. Asked which role fits best, a model cited
  // "[My resume — Data Analytics]" for the section "My resume — Data Analytics
  // | March 2026 – Present" -- the right section with the date suffix dropped.
  // That is a section it was shown, named short, which is the opposite of the
  // thing this check exists to catch. The corpus invites it: seven section
  // names carry a date or a second dash of their own.
  const shown = result.sections.map(squash);
  const cited = [...text.matchAll(/\[([^\]\n]+)\]/g)]
    .map((match) => match[1])
    .filter((citation) => /[—–-]/.test(citation));
  for (const citation of cited) {
    const key = squash(citation);
    if (!shown.some((section) => key.includes(section) || section.includes(key))) {
      problems.push(`cites "${citation}", never shown`);
    }
  }
  if (question.class === "answerable" && cited.length === 0) {
    problems.push("no citations at all");
  }

  return problems;
}

// --------------------------------------------------------------------- reports

for (const variant of variants.filter((v) => !v.startsWith("retrieval#"))) {
  const graded = questions
    .map((question) => ({ question, result: answers[`${variant}:${question.id}`] }))
    .filter((row) => row.result)
    .map((row) => ({ ...row, problems: check(row.question, row.result) }));

  const failed = graded.filter((row) => row.problems.length > 0);
  const calls = graded.filter((row) => !row.result.refused).length;
  const context = graded.filter((row) => !row.result.refused).map((row) => row.result.chars);

  console.log(`\n\n${variant.toUpperCase()} — ${graded.length - failed.length}/${graded.length} clean`);
  console.log(
    `  ${calls} model calls, ${graded.length - calls} refused for free, ` +
      `${Math.round(context.reduce((a, b) => a + b, 0) / context.length)} chars of context on average\n`,
  );

  for (const { question, result, problems } of graded) {
    if (!verbose && problems.length === 0) continue;
    console.log(`  ${problems.length ? "FAIL" : "ok  "}  ${question.id}  (${question.class})`);
    if (problems.length) console.log(`        ${problems.join("; ")}`);
    if (verbose || problems.length) {
      console.log(
        `        ${result.text.replace(/\s+/g, " ").slice(0, 200)}${result.text.length > 200 ? "…" : ""}`,
      );
    }
  }

  for (const klass of ["answerable", "absent", "domain", "unrelated", "injection"]) {
    const group = graded.filter((row) => row.question.class === klass);
    if (group.length === 0) continue;
    console.log(
      `  ${klass.padEnd(12)} ${group.filter((row) => row.problems.length === 0).length}/${group.length}`,
    );
  }
}

// --------------------------------------------------------- decision: is 29/31 one number or a range

if (repeats.length > 0) {
  const runs = ["retrieval", ...repeats];

  console.log(`\n\nVARIANCE — the same question answered up to ${repeat} times\n`);
  console.log("  A refusal is arithmetic and is not repeated; it counts once in every run.\n");

  const rows = questions
    .filter((question) => !question.refuse)
    .map((question) => {
      const results = runs.map((run) => answers[`${run}:${question.id}`]).filter(Boolean);
      return {
        question,
        of: results.length,
        clean: results.filter((result) => check(question, result).length === 0).length,
      };
    })
    .filter((row) => row.of > 1)
    .sort((a, b) => a.clean / a.of - b.clean / b.of);

  const flipped = rows.filter((row) => row.clean > 0 && row.clean < row.of);
  for (const { question, clean, of } of rows) {
    if (clean === of) continue;
    console.log(
      `  ${clean}/${of} clean  ${question.id.padEnd(20)}` +
        (clean === 0 ? "fails every time" : "FLIPS between runs"),
    );
  }
  console.log(
    `  ${rows.length - rows.filter((row) => row.clean < row.of).length}/${rows.length} repeated questions landed the same way every time`,
  );
  console.log(
    flipped.length === 0
      ? `  nothing flipped: every failure is a failure every time, so the score is a number and not a sample`
      : `  ${flipped.length} flipped: ${flipped.map((row) => row.question.id).join(", ")} -- the score is a range`,
  );

  // The per-run totals, so the headline can be quoted with its spread. A refusal
  // has no repeat of its own and is graded from the first pass in every run.
  const scores = runs.map((run) => {
    const graded = questions
      .map((question) => ({
        question,
        result: question.refuse
          ? answers[`retrieval:${question.id}`]
          : answers[`${run}:${question.id}`],
      }))
      .filter((row) => row.result);
    return {
      run,
      clean: graded.filter((row) => check(row.question, row.result).length === 0).length,
      of: graded.length,
    };
  });
  console.log("");
  for (const { run, clean, of } of scores) console.log(`  ${run.padEnd(14)} ${clean}/${of}`);
  const totals = scores.map((score) => score.clean);
  console.log(
    `  the app scores ${Math.min(...totals)} to ${Math.max(...totals)} of ${scores[0].of}`,
  );
}

console.log(`\nfull answers in ${ANSWERS}`);
await sql.end();
