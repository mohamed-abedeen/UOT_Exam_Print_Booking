// Runs in every test file before its imports: points DATABASE_URL at the test database and replaces the
// Next.js request APIs the auth code uses (cookies / headers, redirect, connection) with in-memory fakes.
import { loadEnvConfig } from "@next/env";
import { vi } from "vitest";
import { testDatabaseUrl } from "./helpers/test-db";

loadEnvConfig(process.cwd());
if (process.env.DATABASE_URL) process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL);

vi.mock("next/headers", async () => {
  const { cookies, headers } = await import("./helpers/fake-request");
  return { cookies, headers };
});
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/navigation", async () => {
  const { redirect } = await import("./helpers/fake-request");
  return { redirect };
});
