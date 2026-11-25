// The app's database handle. Created on first use, so importing this file never needs DATABASE_URL (next build).
import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  return drizzle(postgres(url, { max: 10 }), { schema });
}

export type Db = ReturnType<typeof create>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything a query can run on: the pool or an open transaction. */
export type Executor = Db | Tx;

// One pool per process; kept on globalThis so dev hot reload does not open a new pool on every edit.
const holder = globalThis as unknown as { __uotDb?: Db };

export function getDb(): Db {
  return (holder.__uotDb ??= create());
}
