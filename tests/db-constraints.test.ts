// contracts §0: the hand-written migration's exclusion constraints exist (drizzle-kit does not know them).
// Needs a migrated DB at DATABASE_URL; skipped when it is not set.
import { loadEnvConfig } from "@next/env";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

loadEnvConfig(process.cwd());
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("database constraints", () => {
  const sql = postgres(url!, { max: 1 });
  afterAll(() => sql.end());

  it("has bookings_no_overlap and maintenance_no_overlap", async () => {
    const rows = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE contype = 'x' ORDER BY conname`;
    expect(rows.map((r) => r.conname)).toEqual(["bookings_no_overlap", "maintenance_no_overlap"]);
  });
});
