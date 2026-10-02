import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Minimal test config: node environment, @/* path alias mirroring
// tsconfig.json. No production code changes; test files live alongside
// sources as src/**/*.test.ts.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
