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

  try {
    const result = await ingest({
      file,
      kind: kind as DocumentKind,
      label: label.trim(),
    });
    return Response.json(result, { status: 201 });
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
