import postgres from "postgres";

// Next's dev server re-evaluates modules on every change, which would leak a
// new connection pool each time. Cache the client on globalThis to avoid that.
const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

export const sql = globalForDb.sql ?? postgres(process.env.DATABASE_URL);

if (process.env.NODE_ENV !== "production") globalForDb.sql = sql;
