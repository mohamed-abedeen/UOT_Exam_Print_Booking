import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Next.js gives "server-only" a meaning only inside its own bundler; in tests it is an empty module.
      { find: /^server-only$/, replacement: `${root}tests/helpers/empty.ts` },
      { find: /^@\//, replacement: root },
    ],
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    // DB tests share one test database (DATABASE_URL + "_test", made by tests/global-setup.ts): one file at a time.
    fileParallelism: false,
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
