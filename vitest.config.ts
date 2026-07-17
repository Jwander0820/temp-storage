import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          TURNSTILE_SECRET_KEY: "test-turnstile-secret",
          DELETE_TOKEN_PEPPER: "test-delete-token-pepper-32-bytes-minimum",
          IP_HASH_PEPPER: "test-ip-hash-pepper-32-bytes-minimum",
          ADMIN_TOKEN: "test-admin-token-32-bytes-minimum",
          UPLOAD_ACCESS_CODE: "",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
