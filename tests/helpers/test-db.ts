// Tests never touch the development database: they use a second one, "<name>_test", on the same server.
import postgres from "postgres";

const SUFFIX = "_test";

export function testDatabaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith(SUFFIX)) url.pathname += SUFFIX;
  return url.toString();
}

/** Empties every table of the test database. Refuses any database whose name does not end in "_test". */
export async function resetTestDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith(SUFFIX)) throw new Error("resetTestDb: not a test database");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const names = tables.map((t) => `"${t.tablename}"`).join(", ");
    if (names) await sql.unsafe(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  } finally {
    await sql.end();
  }
}
