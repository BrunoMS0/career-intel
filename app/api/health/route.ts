import { sql } from "@/lib/db";

/**
 * Proves the whole data path is wired: the container is up, pgvector is
 * installed, and schema.sql actually ran.
 */
export async function GET() {
  try {
    const [ext] = await sql<{ version: string }[]>`
      select extversion as version from pg_extension where extname = 'vector'
    `;
    const [docs] = await sql<{ count: number }[]>`
      select count(*)::int as count from documents
    `;

    return Response.json({
      ok: true,
      pgvector: ext?.version ?? null,
      documents: docs.count,
      // Presence only. Validating the key would mean an API call per ping.
      googleKey: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: (error as Error).message },
      { status: 503 },
    );
  }
}
