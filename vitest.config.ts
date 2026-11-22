import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    pool: "vmThreads",
    include: ["src/**/*.test.{ts,tsx}"],
    css: { include: [/\.css\?raw$/] },
    setupFiles: ["src/test-setup.ts"],
  },
});
