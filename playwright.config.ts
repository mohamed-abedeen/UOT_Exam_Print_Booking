// End-to-end tests (step 5.2): `npm run test:e2e`. Builds the app and starts it on its own port against its own
// database ("<dev database>_e2e", see e2e/env.ts), so neither the dev server nor the dev data is touched.
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, e2eDatabaseUrl, PORT } from "./e2e/env";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  // One database: the flows share it, one at a time, in file order.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure", locale: "ar" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 600_000,
    env: { DATABASE_URL: e2eDatabaseUrl(), NODE_ENV: "production" },
  },
});
