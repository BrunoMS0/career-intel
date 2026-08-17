# Measurements

Everything below comes from the configuration on this branch, measured over the
**46 questions** in `eval/questions.json` against a corpus of **8 documents, 72
chunks, 70 sections, 41,399 characters** (7 job postings and 1 resume).

## What runs

```
NARROW    = true     a question naming a posting narrows to that posting plus the
                     resume, and a cross-encoder reorders the candidates before
                     the per-document budget
COLLAPSE  = false    broad questions receive sections, not document profiles
trim               out of the answer path -- measured and rejected, see section 6
```

| piece | choice |
| --- | --- |
| Embeddings | `gemini-embedding-001`, 1536 dims, asymmetric `taskType` |
| Chat model | `gemma-4-31b-it` |
| Cross-encoder | Cohere `rerank-v3.5`, scoped questions only |
| Store | Postgres 17 + pgvector 0.8.6, no vector index |
| Refusal threshold | cosine distance 0.387 |
| Budget | 4 chunks per document at 3 documents or fewer, 3 above that. The resume always 4 |

---

# 1. Retrieval

`pnpm eval`

| metric | value | what it measures |
| --- | --- | --- |
| **Evidence recall** | **36 / 47** = 76.6% | of the sections labelled by hand as required, how many reached the model |
| **Coverage** | **complete** | every question received something from every document it needs |
| **Guardrail** | **46 / 46** | every question fell on the side it should: answer or refuse |
| **Drift** | **0.0000** | no distance moved against the recorded baseline |
| Context | 3,200 to 17,581 chars, median 5,991 | |

### The guardrail, by class

| class | questions | refused | expected | best-hit range |
| --- | --- | --- | --- | --- |
| answerable | 31 | 0 | 0 | 0.2348 – 0.3589 |
| absent | 7 | 1 | 1 | 0.2739 – 0.4150 |
| domain | 3 | 3 | 3 | 0.4040 – 0.4244 |
| unrelated | 3 | 3 | 3 | 0.5019 – 0.5179 |
| injection | 2 | 1 | 1 | 0.3705 – 0.4474 |

The empty band runs **0.3705 to 0.4040** and the threshold sits at **0.387**, in
the middle of it. The highest question that must pass is a prompt injection,
which clears on purpose so the system prompt refuses it rather than the
threshold.

### The 11 evidence sections that do not arrive

`Job #3 — QUALIFICATIONS` is 3 of them, and it is arguable: the question asks
what skills are missing and that section states a degree and years of
experience. The expectation is what is mislabelled, not the ranking.

---

# 2. Precision

Measured over what was actually sent, with ground truth taken from **what the
model cited** across the three passes.

| metric | value | what it measures |
| --- | --- | --- |
| **From the right document** | **77.2%** | of the sections sent, how many come from a document the question needs |
| **How much gets used (micro)** | **29.4%** | of everything sent, what fraction the model cited |
| **How much gets used (macro)** | **32.6%** | the same, averaged per question |

### Context by question shape

| | questions | sections | characters |
| --- | --- | --- | --- |
| scoped (names a posting) | 20 | 8.3 | 5,210 |
| broad (names none) | 11 | 24.5 | 15,376 |
| **all** | **31** | **14.1** | **8,817** |

The gap between those two rows is where the whole cost sits, and it is what two
phases tried to close.

---

# 3. Grounded

| metric | value |
| --- | --- |
| **Valid citations** | **532 of 532 = 100%** |
| Invented citations | **0** |
| Answers with no citation at all | 2 of 93 |

A citation is valid when it names a section the model was actually shown. Zero
invented across 532 citations over three full passes.

---

# 4. Generation

`pnpm answers --repeat=3` — all 46 questions, three times through.

| | value |
| --- | --- |
| **Score** | **42 to 43 of 46** |
| Model calls | 38 per pass (8 refused for free by the threshold) |
| Average context | 8,625 characters |
| Reproducibility | 33 of 38 landed the same way all three times |

| class | clean |
| --- | --- |
| answerable | 27 / 31 |
| absent | 7 / 7 |
| domain | 3 / 3 |
| unrelated | 3 / 3 |
| injection | 2 / 2 |

**Everything that is not answerable is perfect**: the 7 questions whose answer
the document does not contain are admitted as absent, the 3 out-of-corpus and 3
off-topic ones are refused, and both prompt injections hold.

### How each answer is graded

| rule | what it demands |
| --- | --- |
| `must` | things that have to appear, e.g. `remote-jobs` must name Job #6 |
| `mustNot` | things that cannot appear, e.g. never claim Job #2 states no location |
| `anyOf` | at least one of several |
| `admitsAbsence` | if the document does not state it, the answer has to say so |
| citations | every citation must name a section that was shown |

No LLM judge: it would double the calls and add a second model to trust. The
report prints each answer beside its expectation, so what a string cannot judge
gets read.

### The 4 that fail

| question | clean | why |
| --- | --- | --- |
| `remote-jobs` | 0/3 | the check demands all 7 postings named and `lib/prompt.ts` allows 4 bullets. The check and the prompt contradict each other |
| `summarize` | 0/3 | the check demands an employer name; the one-page resume summarises by capability. The check is what is wrong |
| `llm-rag-job4` | 1/3 | a compound question ("LLMs **and** RAG"). The prompt says "if it is not there, say so **and stop**", and the model stops before answering the half it can |
| `interview-prep-job3` | 2/3 | sampling |

None of the four is a retrieval failure. Two are the test, one is the prompt,
one is the model rolling dice.

---

# 5. Latency

Measured stage by stage against the real server, best of two runs.

| question | scope (SQL) | embedding | retrieve total | model | **total** |
| --- | --- | --- | --- | --- | --- |
| scoped, `what skills do I need for Job #2?` | 2 ms | 382 ms | **1,135 ms** | **52,707 ms** | **53.8 s** |
| broad, `which role fits me best?` | 2 ms | 435 ms | **861 ms** | **49,780 ms** | **50.6 s** |
| refused, `give me a recipe for pasta carbonara` | 1 ms | 610 ms | **540 ms** | 0 ms | **0.5 s** |

**The model is 98% of the time.** All of retrieval — resolving the scope,
embedding the question, searching, reranking, expanding to sections — fits in
just over a second.

### And it is not the context size

| call | time |
| --- | --- |
| trivial, no context | 3,860 ms |
| 6k of context, 3-character answer | 3,120 ms |
| 16k of context, 3-character answer | 3,417 ms |

Sending 16,000 characters costs the same as sending nothing. The ~50 seconds are
**output tokens**: the real answers generate 550 to 650 characters, and at ~12
characters a second that is the 50 s.

Practical consequence: **trimming context does not improve latency.** What would
is a paid tier, streaming to the user, or shorter answers.

What the refusal threshold does buy: an off-topic question answers in **0.5
seconds instead of 50**, because it never reaches the model. 8 of 46 land there.

---

# 6. Measured and rejected

Five rules that looked good and lost against the numbers. Each is written up in
`CLAUDE.md` with its evidence.

| rule | what it promised | what it measured |
| --- | --- | --- |
| **Relative threshold** instead of absolute | adapt to each question | the margins of good and bad questions overlap: it refuses carbonara and also "am I a good fit for any of these?" |
| **Document spread** as a second filter | spot the document that does not hold the answer | catches 1 of 6 for free; catching all 6 costs refusing 7 valid questions |
| **Reranking every** question | recover 4 sections that never arrive | recovered 1 of 4, and broke `remote-jobs` from 4/6 to 1/6. It stayed only on scoped questions |
| **A profile per document** instead of sections | cut the cost of broad questions 9x | cut cost 51% and the score did not move; then it lost instances (WebGL) and was switched off |
| **Trimming to 7 sections** after the budget | half the context with no evidence lost | evidence identical at 35/45, **and 3 to 4 answers worse**: 42–43 against 38–40 |

### The trim is the most informative of the five

```
                     no trim       with trim
answers             42–43 / 46    38–40 / 46
sections              13.8          7.0
context              8,625 ch      4,206 ch     -51%
evidence recall      35/45         35/45        identical
```

Section-level recall **cannot see that failure**. No single section is the
evidence for "which role fits me best" — the question needs every posting
present — so the metric stayed flat while the answers got worse. The three that
broke hardest are the comparisons: `good-fit` 3/3 → 0/3, `best-fit` 3/3 → 0/3,
`roles-common` 3/3 → 1/3.

### And what the scope is worth, measured by accident

The trim was first run with the scope switched off. Same rule, no scope: **27 to
28 of 46**. Eleven points, which is what narrowing the search buys when the
question names a posting.

---

# 7. Summary

| | |
| --- | --- |
| Evidence recall | 36/47 = 76.6% |
| Document coverage | complete |
| Precision, right document | 77.2% |
| Precision, how much gets used | 29.4% micro / 32.6% macro |
| Grounded | 532/532 valid citations, 0 invented |
| Guardrail | 46/46 |
| Drift | 0.0000 |
| **Generation** | **42 to 43 of 46**, 33/38 reproducible |
| Latency, retrieval | ~1 second |
| Latency, model | ~50 seconds (free tier, output tokens) |
| Latency, refused question | 0.5 seconds |
