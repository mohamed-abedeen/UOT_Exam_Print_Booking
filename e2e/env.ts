// Shared by the Playwright config, its global setup and the specs. Test values only: the e2e database is
// "<dev database>_e2e", emptied and re-seeded on every run, and the server on PORT is started by Playwright.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

export const PORT = 3100;
export const BASE_URL = `http://localhost:${PORT}`;
export const E2E_PASSWORD = "e2e-Password-123";
const SUFFIX = "_e2e";

export function e2eDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set (see .env.example): the e2e database is derived from it");
  const url = new URL(base);
  if (!url.pathname.endsWith(SUFFIX)) url.pathname += SUFFIX;
  return url.toString();
}

export const isE2eDatabase = (url: string) => new URL(url).pathname.endsWith(SUFFIX);
