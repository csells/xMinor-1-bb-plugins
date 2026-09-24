import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Mirrors `paths: { "@/*": ["./*"] }` in tsconfig.json, which esbuild reads
  // during `bb plugin build` but vitest does not.
  resolve: { alias: { "@": rootDir } },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    environment: "node",
  },
});
