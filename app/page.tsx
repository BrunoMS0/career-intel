import { sql } from "@/lib/db";
import { Workspace, type DocumentSummary } from "./workspace";

// The document list is read per request; a cached shell would keep showing a
// stale corpus after an upload.
export const dynamic = "force-dynamic";

export default async function Page() {
  const documents = await sql<DocumentSummary[]>`
    select d.id, d.kind, d.label, d.company, d.role_title, count(c.id)::int as chunks
    from documents d
    left join chunks c on c.document_id = d.id
    group by d.id
    order by d.kind, d.label
  `;

  return <Workspace documents={documents} />;
}
