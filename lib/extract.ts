/**
 * Structured extraction at ingest, so a broad question does not have to read the
 * corpus to compare it.
 *
 * The problem this solves is arithmetic. A question naming no posting draws
 * three sections from every document, which is ~1,940 characters each, and the
 * generation harness measured attribution collapsing at 64 labelled excerpts --
 * so the app breaks at about 21 documents. A profile is 219 characters, which
 * moves that wall by roughly a factor of nine, and the facts a comparison
 * actually turns on ("which of these are remote?") become columns rather than
 * text that has to win a similarity contest to be seen at all.
 *
 * Measured against LlamaExtract before it was written up: see CLAUDE.md. Three
 * findings shape the schema below and none of them were guesses.
 */

/**
 * Pinned rather than left at `latest`, same rule as CHAT_MODEL and RERANK_MODEL:
 * a profile that changes under an eval run makes the run uncomparable. The v2
 * surface reports the version it resolved, and it is stored with the result.
 */
export const EXTRACT_TIER = process.env.EXTRACT_TIER ?? "cost_effective";

/**
 * `cost_effective` and not `agentic`, measured. Both tiers score 12/12 on the
 * four documents that state least, with zero invented values, using the schema
 * below; `agentic` costs 15 credits a page against 5 and bought nothing here.
 * The honest limit on that: four documents and three fields, over text-native
 * PDFs the user restructured with explicit headings. A scanned or multi-column
 * document is where a stronger tier would earn its price, and this corpus has
 * none.
 */
const BASE = "https://api.cloud.llamaindex.ai";

/**
 * The rules the schemas below are built on, each of which cost a failed run.
 *
 * **Null is not reachable.** A field declared `["string", "null"]` comes back as
 * `""` when the document says nothing, which is indistinguishable from an
 * extraction that failed. So every field that can be absent is a string whose
 * absence is the literal value `unstated`, and `unstated` is a member of every
 * enum.
 *
 * **A nullable object breaks nested extraction.** A `compensation` object typed
 * `["object", "null"]` came back `{}` on all four documents while the reasoning
 * trace said "The posting states: '$180,000 – $300,000 base + benefits &
 * equity'" -- it had the answer and dropped it. Everything here is flat.
 *
 * **Enums are honoured, prose prohibitions are not.** A description saying
 * "never put 'unstated' in this array" produced `["unstated"]`; one saying "do
 * not send 0" produced `0`. Anything that must not happen has to be impossible
 * to express, not forbidden in a sentence -- which is why numbers are strings
 * here and cast in `numeric()` below.
 *
 * The schema LlamaCloud's own "design with agent" produced fails all three: it
 * marks `location` and `work_arrangement` required, offers no `unstated` in the
 * enum, and nothing nullable. Asked about a posting that states no location it
 * answered "on-site" with confidence 0.955 while its own reasoning read "The job
 * description does not specify if the role is remote, hybrid, or on-site." The
 * `agentic` tier does not rescue it: same invention, same two documents.
 */
export const JOB_SCHEMA = {
  type: "object",
  description:
    "A comparable profile of one job posting. Postings differ wildly in what they state and many omit basic facts; this schema is built so that a fact the document does not state comes back as the explicit value 'unstated' rather than as a guess. Never infer a value from context, from the company, from the city, or from what similar postings usually say. Every field below has a legal way to say the document is silent -- use it.",
  required: [
    "company",
    "role_title",
    "work_mode",
    "employment_type",
    "seniority",
    "location_as_written",
    "salary_min",
    "salary_max",
    "salary_as_written",
    "profile",
  ],
  properties: {
    company: {
      type: "string",
      description:
        "Hiring company exactly as the document names it. The single word 'unstated' when the document describes the employer without naming it.",
    },
    role_title: { type: "string", description: "Job title as written. 'unstated' when there is none." },
    seniority: {
      type: "string",
      enum: ["intern", "junior", "mid", "senior", "staff", "lead", "principal", "manager", "unstated"],
      description:
        "Normalised seniority. 'unstated' unless the posting names a level in its title or body. A years-of-experience figure is not a seniority level and must not be converted into one.",
    },
    location_as_written: {
      type: "string",
      description:
        "Every place of work the document names, verbatim and joined with ' | ' if there are several, e.g. 'San Francisco' or '175 Greenwich St, New York, NY 10007'. The single word 'unstated' when the document names no place, including when it only says the role is remote.",
    },
    work_mode: {
      type: "string",
      enum: ["remote", "hybrid", "onsite", "unstated"],
      description:
        "How the work is performed, and the single most important field in this schema. 'remote' only where the document says the role is remote or remote-first. 'hybrid' where it mixes office and elsewhere, including 'in-office 4-5 days/week, hybrid flexibility'. 'onsite' only where the document requires attendance and offers no remote option. 'unstated' where the document is silent, says 'Not specified', or only names a city: naming a city is NOT evidence of onsite. If you find yourself reasoning that the document does not specify, the answer is 'unstated'.",
    },
    employment_type: {
      type: "string",
      enum: ["full_time", "part_time", "contract", "internship", "temporary", "unstated"],
      description: "'unstated' where the document does not say.",
    },
    salary_min: {
      type: "string",
      description:
        "Lower bound of the stated pay range, as digits only with no separators, currency symbol or words, e.g. '180000'. The single word 'unstated' when the document states no figure. Never '0': zero means a salary of zero.",
    },
    salary_max: {
      type: "string",
      description:
        "Upper bound of the stated pay range, as digits only with no separators, currency symbol or words, e.g. '300000'. The single word 'unstated' when the document states no figure. Never '0': zero means a salary of zero.",
    },
    salary_currency: {
      type: "string",
      description:
        "ISO code such as USD, EUR, PEN when the document makes it determinable. 'unstated' otherwise. Do not infer a currency from the country.",
    },
    salary_period: {
      type: "string",
      enum: ["year", "month", "hour", "unstated"],
      description: "'unstated' when no figure or no period is given.",
    },
    salary_as_written: {
      type: "string",
      description:
        "The compensation sentence verbatim, so the parsed numbers can be checked against the source. 'unstated' when the document mentions no compensation at all. When it mentions pay without figures, e.g. 'competitive salary and equity', put that phrase here and set salary_min and salary_max to 'unstated'.",
    },
    has_equity: {
      type: "string",
      enum: ["yes", "no", "unstated"],
      description:
        "'yes' only where equity, stock or options are explicitly offered. 'no' only where the document explicitly says there is none. 'unstated' otherwise.",
    },
    min_years_experience: {
      type: "string",
      description:
        "Smallest number of years of overall professional experience the document requires, digits only, e.g. '3'. 'unstated' when it requires none. Where several figures cover different areas, take the one for overall experience.",
    },
    education_required: {
      type: "string",
      description:
        "Degree and field required, as written, e.g. \"Bachelor's degree in Computer Science or related\". 'unstated' when the document asks for no formal education.",
    },
    must_have_skills: {
      type: "array",
      items: { type: "string" },
      description:
        "Skills the document presents as required. Keep its own wording: do not normalise 'React.js' to 'React' or expand abbreviations. Empty array when the document separates nothing as required.",
    },
    nice_to_have_skills: {
      type: "array",
      items: { type: "string" },
      description: "Skills marked preferred, bonus, a plus, or nice to have. Empty array when none are marked.",
    },
    technologies: {
      type: "array",
      items: { type: "string" },
      description:
        "Concrete named languages, frameworks, libraries, cloud services, databases and products, from anywhere in the document, verbatim and deduplicated.",
    },
    profile: {
      type: "string",
      description:
        "At most 300 characters, stating what the role does, the seniority and terms, and the two or three defining requirements. Written to be read side by side with the profiles of other postings, so it reports rather than sells, and mentions only what the document states.",
    },
  },
} as const;

/** Same three rules, candidate side. */
export const RESUME_SCHEMA = {
  type: "object",
  description:
    "A comparable profile of one candidate resume. Resumes vary enormously in layout, language and what they state; this schema is built so that a fact the document does not state comes back as the explicit value 'unstated' rather than as a guess. Never infer a value, never total up dates to invent a figure the document does not give, and never carry a skill over from a job title. Every field below has a legal way to say the document is silent -- use it.",
  required: ["full_name", "headline", "years_experience_total", "highest_education", "profile"],
  properties: {
    full_name: { type: "string", description: "Candidate name as written. 'unstated' when the document does not name them." },
    headline: {
      type: "string",
      description: "The professional title the candidate gives themselves, e.g. 'Fullstack Engineer'. 'unstated' when there is none.",
    },
    years_experience_total: {
      type: "string",
      description:
        "Total years of professional experience, digits only, only when the document states a figure, e.g. '3'. 'unstated' when the document gives no total -- do not add up the date ranges yourself.",
    },
    highest_education: {
      type: "string",
      description: "Highest degree and field as written, e.g. \"Bachelor's in Computer Engineering, PUCP\". 'unstated' when the document lists no education.",
    },
    languages: {
      type: "array",
      items: { type: "string" },
      description:
        "Human languages the document says the candidate speaks, with level if stated. Empty array when it lists none. Programming languages do not belong here.",
    },
    technologies: {
      type: "array",
      items: { type: "string" },
      description:
        "Every concrete language, framework, library, cloud service, database and product named anywhere in the document, verbatim and deduplicated.",
    },
    domains: {
      type: "array",
      items: { type: "string" },
      description:
        "Industries or problem areas the candidate has worked in, e.g. 'insurance', 'e-commerce', 'data analytics'. Empty array when none are identifiable from what is stated.",
    },
    profile: {
      type: "string",
      description:
        "At most 300 characters covering seniority, core stack, strongest domains and education. Written to be read next to a job posting's profile, so it reports rather than sells, and states only what the document states.",
    },
  },
} as const;

export type Extraction = Record<string, unknown>;

const absent = (value: unknown) =>
  value === undefined || value === null || value === "" || value === "unstated";

/** The sentinel is a string, so every number arrives as one and is cast here. */
export function numeric(value: unknown): number | null {
  if (absent(value)) return null;
  const parsed = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const list = (value: unknown) => (Array.isArray(value) ? value.filter((item) => !absent(item)) : []);

/**
 * What a broad question receives in place of a posting's three sections.
 *
 * The structured facts go above the prose, because they are the half a
 * comparison turns on and the half the prose reliably omits: `remote-jobs` fails
 * today by asserting Job #2 and Job #3 state no location, and both do. A field
 * the document leaves unstated is printed as such rather than dropped -- an
 * omitted line reads as an oversight, "unstated" reads as a fact about the
 * posting, and telling those apart is the whole product.
 */
export function profileExcerpt(extract: Extraction | null, profile: string | null): string | null {
  if (!extract && !profile) return null;
  const data = extract ?? {};
  const value = (key: string) => (absent(data[key]) ? "unstated" : String(data[key]));
  const lines: string[] = [];

  if ("work_mode" in data || "location_as_written" in data) {
    lines.push(`Work mode: ${value("work_mode")} | Location: ${value("location_as_written")}`);
    lines.push(`Employment: ${value("employment_type")} | Seniority: ${value("seniority")}`);
    const min = numeric(data.salary_min);
    const max = numeric(data.salary_max);
    const pay = min
      ? `${min}${max && max !== min ? `–${max}` : ""} ${value("salary_currency")} per ${value("salary_period")}`
      : value("salary_as_written");
    lines.push(`Compensation: ${pay} | Equity: ${value("has_equity")}`);
    lines.push(
      `Requires: ${numeric(data.min_years_experience) ?? "unstated"} years | Education: ${value("education_required")}`,
    );
    const must = list(data.must_have_skills);
    if (must.length) lines.push(`Required: ${must.join(", ")}`);
    const tech = list(data.technologies);
    if (tech.length) lines.push(`Technologies: ${tech.join(", ")}`);
  } else if ("headline" in data || "highest_education" in data) {
    lines.push(`Headline: ${value("headline")} | Experience: ${value("years_experience_total")} years`);
    lines.push(`Education: ${value("highest_education")}`);
    const tech = list(data.technologies);
    if (tech.length) lines.push(`Technologies: ${tech.join(", ")}`);
    const domains = list(data.domains);
    if (domains.length) lines.push(`Domains: ${domains.join(", ")}`);
  }

  if (profile) lines.push(profile);
  return lines.length ? lines.join("\n") : null;
}

/**
 * One extraction, against the v2 surface.
 *
 * v1 (`/api/v1/extraction/run`) is the one the installed SDK wraps and it takes
 * `extraction_mode` instead of `tier`; it also *silently ignores* a `tier` key,
 * which is worth knowing because passing one there succeeds, changes nothing and
 * never warns. v1 does have `use_reasoning`, which returns why each field got
 * its value and is what made every bug above findable -- reach for it when a
 * field comes back wrong, not in the ingest path.
 */
export async function extractDocument(
  file: Uint8Array,
  filename: string,
  kind: "resume" | "job",
): Promise<{ extract: Extraction; profile: string | null; version: string | null }> {
  const key = process.env.LLAMA_CLOUD_API_KEY;
  if (!key) throw new Error("LLAMA_CLOUD_API_KEY is required for structured extraction");

  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };

  const form = new FormData();
  form.append("upload_file", new Blob([file as BlobPart], { type: "application/pdf" }), filename);
  const uploaded = await call("/api/v1/files", { method: "POST", body: form });

  let job = await call("/api/v2/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file_input: uploaded.id,
      configuration: {
        data_schema: kind === "resume" ? RESUME_SCHEMA : JOB_SCHEMA,
        tier: EXTRACT_TIER,
        extraction_target: "per_doc",
        cite_sources: true,
        confidence_scores: true,
      },
    }),
  });

  for (let i = 0; i < 150 && !["COMPLETED", "SUCCESS", "FAILED", "ERROR", "CANCELLED"].includes(job.status); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    job = await call(`/api/v2/extract/${job.id}`);
  }
  if (!["COMPLETED", "SUCCESS"].includes(job.status)) {
    throw new Error(`extraction ${job.status}: ${job.error_message ?? "no detail"}`);
  }

  const extract: Extraction = job.extract_result ?? {};
  const profile = absent(extract.profile) ? null : String(extract.profile);
  return { extract, profile, version: job.configuration?.version ?? null };
}
