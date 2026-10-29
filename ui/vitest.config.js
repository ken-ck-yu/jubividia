import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// The tests run the real Worker code inside workerd (Miniflare) with a local R2 simulation.
// Nothing here talks to Cloudflare or RunPod: both are replaced by in-process fakes.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
  test: {
    include: ["test/**/*.test.js"],
    testTimeout: 20000,
  },
});
