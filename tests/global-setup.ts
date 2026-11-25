// Runs once before the test run: creates the test database if it is missing and applies the migrations.
// Without DATABASE_URL nothing is done and the DB tests skip themselves.
import { loadEnvConfig } from "@next/env";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { testDatabaseUrl } from "./helpers/test-db";

export default async function setup(): Promise<void> {
  loadEnvConfig(process.cwd());
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) return;
  const testUrl = testDatabaseUrl(baseUrl);
  const name = decodeURIComponent(new URL(testUrl).pathname.slice(1));

  const admin = postgres(baseUrl, { max: 1 });
  try {
    const found = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (found.length === 0) await admin.unsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }

  const client = postgres(testUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  } finally {
    await client.end();
  }
}
