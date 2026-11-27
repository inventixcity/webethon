import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    // Same `@/` alias as tsconfig.json.
    alias: [{ find: /^@\//, replacement: `${src}/` }],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
