import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

process.env.DATABASE_URL ??= "postgresql://test";
process.env.SUPABASE_URL ??= "https://project.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "anon";
process.env.VOTER_TOKEN_SECRET ??= "test-secret-with-enough-entropy";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DATABASE_URL: "postgresql://test",
          SUPABASE_URL: "https://project.supabase.co",
          SUPABASE_ANON_KEY: "anon",
          VOTER_TOKEN_SECRET: "test-secret-with-enough-entropy",
        },
      },
    }),
  ],
  test: {
    include: ["src/worker.test.ts"],
  },
});
