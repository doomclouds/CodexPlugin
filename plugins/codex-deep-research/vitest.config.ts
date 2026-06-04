import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["runner/tests/**/*.test.ts"],
    environment: "node",
  },
});
