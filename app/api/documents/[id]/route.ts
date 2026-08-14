import { sql } from "@/lib/db";

/** Postgres rejecting a malformed uuid, which can only mean no such document. */
const INVALID_UUID = "22P02";

/**
 * Removes a document and, through `on delete cascade`, every chunk indexed from
 * it. Works for a resume or a posting alike; the UI needs both.
 *
 * Replacing a resume does not need this: uploading a new one already swaps it.
 * This is for taking a document out without putting another in.
 */
export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/documents/[id]">,
) {
  const { id } = await ctx.params;

  try {
    const [document] = await sql<{ label: string; kind: string }[]>`
      delete from documents where id = ${id}
      returning label, kind
    `;

    if (!document) {
      return Response.json({ error: "no document with that id" }, { status: 404 });
    }
    return Response.json({ deleted: document.label, kind: document.kind });
  } catch (error) {
    if ((error as { code?: string }).code === INVALID_UUID) {
      return Response.json({ error: "no document with that id" }, { status: 404 });
    }
    throw error;
  }
}
