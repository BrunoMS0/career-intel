import { sql } from "@/lib/db";
import { ingest, IngestError, type DocumentKind } from "@/lib/ingest";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const KINDS: DocumentKind[] = ["resume", "job"];
/** Partial unique index in db/schema.sql that allows a single resume. */
const RESUME_CONSTRAINT = "documents_single_resume_idx";

export async function GET() {
  const documents = await sql`
    select d.id, d.kind, d.label, d.filename, d.created_at,
           count(c.id)::int as chunks
    from documents d
    left join chunks c on c.document_id = d.id
    group by d.id
    order by d.created_at
  `;
  return Response.json(documents);
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  const kind = form.get("kind");
  const label = form.get("label");

  // Everything here crosses a trust boundary: it is whatever the browser sent.
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "file is required" }, { status: 400 });
  }
  if (file.type !== "application/pdf") {
    return Response.json({ error: "file must be a PDF" }, { status: 415 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ error: "file must be under 10MB" }, { status: 413 });
  }
  if (typeof kind !== "string" || !KINDS.includes(kind as DocumentKind)) {
    return Response.json(
      { error: `kind must be one of: ${KINDS.join(", ")}` },
      { status: 400 },
    );
  }
  if (typeof label !== "string" || !label.trim()) {
    return Response.json({ error: "label is required" }, { status: 400 });
  }

  // Checked here rather than left to the unique index, because reaching the
  // index costs a LlamaParse round trip and an embedding call for every chunk
  // first -- a duplicate label would spend all of that to fail on the insert.
  //
  // Case-insensitive, which is stricter than the index on purpose: resolveScope
  // squashes case, so "Job #1" and "job #1" are one scope key and a question
  // naming either would pull both documents. The index stays as the race guard
  // below.
  //
  // A resume is exempt against the resume already indexed, since uploading one
  // replaces it inside the same transaction and frees whatever label it held.
  const clash = await sql`
    select 1 from documents
    where lower(label) = lower(${label.trim()})
      and ${kind === "resume" ? sql`kind <> 'resume'` : sql`true`}
  `;
  if (clash.length > 0) {
    return Response.json({ error: `label "${label.trim()}" is already taken` }, { status: 409 });
  }

  const identity = (field: unknown) =>
    // Only postings carry one. The resume is in scope for every question, so an
    // identity would be dead data that the "/" menu would then have to hide.
    kind === "job" && typeof field === "string" && field.trim() ? field.trim() : null;

  const company = identity(form.get("company"));
  const roleTitle = identity(form.get("role_title"));

  try {
    const result = await ingest({
      file,
      kind: kind as DocumentKind,
      label: label.trim(),
      company,
      roleTitle,
    });
    // Said, not enforced: an anonymous posting works, it is just only findable
    // by a label nobody outside this app would type.
    const anonymous = kind === "job" && !company && !roleTitle;
    return Response.json(
      anonymous
        ? {
            ...result,
            warning: [
              result.warning,
              `No company or role title, so this posting only answers to "${label.trim()}".`,
            ]
              .filter(Boolean)
              .join(" "),
          }
        : result,
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof IngestError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if ((error as { code?: string }).code === "23505") {
      // Two different uniques land here, and saying the wrong one sends the
      // user off renaming a file that was never the problem.
      // Uploading a resume replaces the existing one, so this only fires when
      // two uploads race and both clear the way for themselves.
      if ((error as { constraint_name?: string }).constraint_name === RESUME_CONSTRAINT) {
        return Response.json(
          { error: "another resume was indexed at the same time. Try again." },
          { status: 409 },
        );
      }
      // documents.label is unique so queries can scope to "Job #2" unambiguously.
      return Response.json(
        { error: `label "${label}" is already taken` },
        { status: 409 },
      );
    }
    throw error;
  }
}
