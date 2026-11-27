// Before every e2e run: create the e2e database if missing, migrate it, empty it, seed it (db/seed.ts) and
// open the day: every weekday working and the hours 00:00–23:50, so a booking for today works at any time.
import { execFileSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { E2E_PASSWORD, e2eDatabaseUrl, isE2eDatabase } from "./env";

export default async function globalSetup(): Promise<void> {
  const target = e2eDatabaseUrl();
  if (!isE2eDatabase(target)) throw new Error("e2e: refusing to touch a database whose name does not end in _e2e");
  const name = decodeURIComponent(new URL(target).pathname.slice(1));

  const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const found = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (found.length === 0) await admin.unsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }

  const sql = postgres(target, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
    const tables = await sql<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const names = tables.map((t) => `"${t.tablename}"`).join(", ");
    await sql.unsafe(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);

    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "db/seed.ts"], {
      env: { ...process.env, DATABASE_URL: target, SEED_PASSWORD: E2E_PASSWORD },
      stdio: "inherit",
    });

    await sql`UPDATE users SET must_change_password = false`;
    for (const [key, value] of [
      ["work_start", "00:00"],
      ["work_end", "23:50"],
      ["working_weekdays", [0, 1, 2, 3, 4, 5, 6]],
    ] as const) {
      await sql`UPDATE settings SET value = ${JSON.stringify(value)}::jsonb WHERE key = ${key}`;
    }
  } finally {
    await sql.end();
  }
}
